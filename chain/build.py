#!/usr/bin/env python3
"""Records the conversation once, through the whole chain:
owner's fictional line -> Kokoro voice -> phone-band filter -> whisper.cpp -> Claude reply -> output guard -> Kokoro voice.
Then Claude reads the transcript and names the turns that hold each fact.

Usage: python chain/build.py
Needs a Python with kokoro and soundfile, whisper-cli, ffmpeg, node and a logged-in Claude Code.
Writes audio/owner/*.wav, site/audio/*.mp3, site/data/conversation.json and recorded/model_runs.json.
Model replies are stored as they were generated. Nothing later calls a model again."""
import glob
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

if len(sys.argv) > 1:
    sys.exit(__doc__)
try:
    import numpy as np
    import soundfile as sf
    from kokoro import KPipeline
except ImportError as error:
    sys.exit("This Python cannot run the recording: " + str(error) + ". Install kokoro and soundfile, see the README.")

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = json.loads((ROOT / "chain/script.json").read_text())
SYSTEM = ROOT / "chain/assistant_prompt.md"
EXTRACT = ROOT / "chain/extraction_prompt.md"
MODEL = "sonnet"
OWNER_VOICE = "af_heart"
ASSISTANT_VOICE = "am_michael"
GAP = 0.45
RATE = 24000
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", str(ROOT / "models/ggml-base.en.bin"))


def claude_bin():
    versions = sorted(glob.glob(os.path.expanduser("~/.local/share/claude/versions/*")), key=os.path.getmtime)
    return versions[-1] if versions else shutil.which("claude")


def ask_claude(system_file, prompt):
    env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
    cmd = [claude_bin(), "-p", prompt, "--system-prompt-file", str(system_file), "--tools", "", "--strict-mcp-config",
           "--setting-sources", "", "--no-session-persistence", "--output-format", "json", "--model", MODEL]
    out = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=240)
    if out.returncode:
        sys.exit("claude failed: " + out.stderr[-400:])
    data = json.loads(out.stdout)
    return data["result"].strip(), data.get("modelUsage") and list(data["modelUsage"].keys())


def node_tool(payload):
    out = subprocess.run(["node", str(ROOT / "chain/guard_cli.mjs")], input=json.dumps(payload), capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


PIPE = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")


def speak(text, voice):
    parts = [audio.numpy() if hasattr(audio, "numpy") else audio for _, _, audio in PIPE(text, voice=voice, speed=1.0)]
    return np.concatenate(parts)


def to_phone_band(wav_in, wav_out):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav_in), "-af", "highpass=f=280,lowpass=f=3400,acompressor=threshold=-20dB:ratio=3",
                    "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(wav_out)], check=True)


def transcribe(wav):
    with tempfile.TemporaryDirectory() as tmp:
        base = pathlib.Path(tmp) / "t"
        subprocess.run(["whisper-cli", "-m", WHISPER_MODEL, "-f", str(wav), "-nt", "-np", "-otxt", "-of", str(base), "-l", "en"],
                       capture_output=True, check=True)
        return node_tool({"normalize": (base.with_suffix(".txt")).read_text()})["text"]


def history_text(turns):
    return "\n".join(("Owner: " if t["speaker"] == "owner" else "Assistant: ") + t["text"] for t in turns)


def guarded_reply(turns, declared, runs, label):
    last_owner = turns[-1]["text"]
    prompt = "The call so far:\n" + history_text(turns) + "\n\nSay your next line."
    for attempt in range(1, 4):
        reply, models = ask_claude(SYSTEM, prompt)
        verdict = node_tool({"reply": reply, "declared": declared, "lastOwner": last_owner})
        runs.append({"for": label, "attempt": attempt, "reply": reply, "guard": verdict, "models": models})
        if verdict["ok"]:
            return reply
        prompt += "\n\nYour previous line was refused because it " + verdict["reason"] + ". Say it again without doing that."
    sys.exit("guard refused every reply for " + label + "; rerun or adjust the prompt")


def main():
    if not pathlib.Path(WHISPER_MODEL).exists():
        sys.exit("whisper model not found at " + WHISPER_MODEL)
    (ROOT / "audio/owner").mkdir(parents=True, exist_ok=True)
    (ROOT / "site/audio").mkdir(parents=True, exist_ok=True)
    work = pathlib.Path(tempfile.mkdtemp())
    runs = []
    turns = [{"id": "A0", "speaker": "assistant", "text": SCRIPT["opening"], "source": "fixed"}]
    clips = {"A0": speak(SCRIPT["opening"], ASSISTANT_VOICE)}
    declared = "two million"

    def owner_turn(item):
        raw = work / (item["id"] + ".wav")
        sf.write(raw, speak(item["line"], OWNER_VOICE), RATE)
        band = ROOT / "audio/owner" / (item["id"] + ".wav")
        to_phone_band(raw, band)
        text = transcribe(band)
        data, rate = sf.read(band)
        return {"id": item["id"], "speaker": "owner", "text": text, "script": item["line"], "source": "whisper.cpp"}, data, rate

    for n, item in enumerate(SCRIPT["owner"], 1):
        turn, data, rate = owner_turn(item)
        turns.append(turn)
        clips[item["id"]] = (data, rate)
        reply = guarded_reply(turns, declared, runs, "A" + str(n))
        turns.append({"id": "A" + str(n), "speaker": "assistant", "text": reply, "source": "recorded model reply"})
        clips["A" + str(n)] = speak(reply, ASSISTANT_VOICE)
        print(item["id"], "->", turn["text"], "\nA" + str(n), "->", reply, flush=True)

    branches = {}
    for key, item in SCRIPT["choices"].items():
        turn, data, rate = owner_turn(item)
        reply = guarded_reply(turns + [turn], declared, runs, "A5" + key)
        closing = {"id": "A5" + key, "speaker": "assistant", "text": reply, "source": "recorded model reply"}
        clips[item["id"]] = (data, rate)
        clips[closing["id"]] = speak(reply, ASSISTANT_VOICE)
        branches[key] = {"choice": item["line"].rstrip("."), "owner": turn, "assistant": closing, "audio": "audio/branch-" + key + ".mp3"}
        print(item["id"], "->", turn["text"], "\n" + closing["id"], "->", reply, flush=True)

    cases = []
    base = [t for t in turns if t["id"] in ("A0", "O1", "A1")]
    for case in SCRIPT["cases"]:
        fake = {"id": "case", "speaker": "owner", "text": case["owner"]}
        reply = guarded_reply(base + [fake], declared, runs, "case:" + case["id"])
        cases.append({"id": case["id"], "owner": case["owner"], "reply": reply})
        print(case["id"], "->", reply, flush=True)

    raw_extraction, models = ask_claude(EXTRACT, "Transcript:\n" + "\n".join(t["id"] + " (" + t["speaker"] + "): " + t["text"] for t in turns))
    extraction = json.loads(raw_extraction)
    runs.append({"for": "extraction", "reply": raw_extraction, "models": models})

    def assemble(ids, out_mp3, times):
        cursor = 0.0
        pieces = []
        for i in ids:
            clip = clips[i]
            if isinstance(clip, tuple):
                resampled = work / (i + "_r.wav")
                subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(ROOT / "audio/owner" / (i + ".wav")), "-ar", str(RATE), "-ac", "1", str(resampled)], check=True)
                data, _ = sf.read(resampled)
            else:
                data = clip
            pieces.append(data)
            dur = len(data) / RATE
            times[i] = (round(cursor, 2), round(cursor + dur, 2))
            cursor += dur + GAP
            pieces.append(np.zeros(int(GAP * RATE)))
        mix = work / (out_mp3.stem + ".wav")
        sf.write(mix, np.concatenate(pieces[:-1]), RATE)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(mix), "-af", "loudnorm=I=-16:TP=-1.5", "-ar", "24000", "-ac", "1", "-b:a", "64k", str(out_mp3)], check=True)
        return round(cursor - GAP, 2)

    times = {}
    duration = assemble([t["id"] for t in turns], ROOT / "site/audio/conversation.mp3", times)
    for t in turns:
        t["start"], t["end"] = times[t["id"]]
    for key, branch in branches.items():
        btimes = {}
        branch["duration"] = assemble([branch["owner"]["id"], branch["assistant"]["id"]], ROOT / "site/audio" / ("branch-" + key + ".mp3"), btimes)
        for part in ("owner", "assistant"):
            branch[part]["start"], branch[part]["end"] = btimes[branch[part]["id"]]

    conversation = {"recordedOn": "2026-11-08", "duration": duration, "turns": turns, "branches": branches, "extraction": extraction, "cases": cases}
    (ROOT / "site/data/conversation.json").write_text(json.dumps(conversation, indent=1))
    (ROOT / "recorded/model_runs.json").write_text(json.dumps({"model": MODEL, "voices": {"owner": OWNER_VOICE, "assistant": ASSISTANT_VOICE}, "runs": runs}, indent=1))
    print("done, seconds:", duration, "model calls:", len(runs), "refused by guard:", sum(1 for r in runs if r.get("guard") and not r["guard"]["ok"]))


if __name__ == "__main__":
    main()
