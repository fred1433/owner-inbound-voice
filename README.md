# Owner inbound voice

A simulated inbound call between a business owner and an AI assistant at a brokerage, and the card the advisor opens afterwards. The owner, her company and her number are fictional. There is no phone line and no real CRM account behind this. Page: https://theaipipe.com/demos/owner-inbound-voice/

## Run it

```
node replay.mjs
```

Needs Node 20 or later, `whisper-cli` and the whisper model. It takes about a minute and exits 0 when every check passes. No network, no key.

```
brew install whisper-cpp          # macOS. Elsewhere, build whisper.cpp and put whisper-cli on the PATH
mkdir -p models
curl -L -o models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

The model can live elsewhere: set `WHISPER_MODEL` to its path. `node replay.mjs --no-asr` skips speech-to-text, uses the recorded transcripts and says so. To see the page: `python3 -m http.server --bind 127.0.0.1 8080 --directory site`.

## What it checks

- The owner's audio goes through whisper.cpp, and the facts and her last answer are read from that transcript. A whisper build that hears a word differently prints a note. It only fails if a fact or the instruction no longer reads.
- "No texts" sets only `dndSettings.SMS`, leaves `dnd` off, stops the text attempt and keeps the callback. "Don't contact me" blocks calls and texts and creates neither a task nor a message. "Just exploring" blocks nothing. Each is tested with rewordings that are not in the audio.
- The output guard (`checkReply` in `site/lib/engine.js`) runs after a reply is generated. It lets through her sales restated as sales. It refuses a sale price, a multiple, agreement with a price she proposes, a secrecy promise, tax or legal advice, a request for documents, and any mention of a page or article. The refused sentences are in `replay.mjs`.
- The model never writes a fact on the card. It names a value from a closed list or the id of a turn, and code reads the words out of that turn. If the words are not there, the field stays empty.
- Every request and response is validated against the official HighLevel schemas, flattened in `site/data/contracts.json` with the commit they come from. Each request uses the operation's documented `Version` header.
- Booking: availability read in her time zone, a slot taken in the meantime leads to a new offer, she hears "booked" only after an appointment id comes back, and the same event twice gives one appointment. The API documents no idempotency header, so the orchestrator holds a key per call and action.

The page and the replay import the same `site/lib/engine.js` and `site/lib/mockcrm.js`. The page runs the mock in the browser. The replay puts it behind HTTP on the loopback interface (`mock/server.mjs`).

## What was recorded, and what was not tested

`chain/build.py` ran once, on 2026-11-08: fictional owner lines, spoken by Kokoro-82M (voices `af_heart` and `am_michael`, generic voices, nobody's clone), phone-band filter, whisper.cpp `base.en`, Claude for each reply and for naming the turns, the guard, then Kokoro again. Model output is stored as generated in `recorded/model_runs.json` and frozen. One reply was refused by the guard during the recording and regenerated. Nothing calls a model at replay or on the page.

To record again: `python chain/build.py` with a Python that has `kokoro` and `soundfile`, plus `ffmpeg`, a logged-in Claude Code and the whisper model. To pin the schemas again: `python3 tools/pin_contracts.py <clone of GoHighLevel/highlevel-api-docs>`.

Not tested, and assumed by the mock:

- No request has been sent to a real HighLevel account.
- `contacts/upsert` depends on the sub-account's duplicate settings. The mock matches on phone or email, and the replay shows both settings.
- The mock answers a text to a blocked contact with a 400. The orchestrator reads the contact first and does not send, so this path is a second line of defence. A real account may answer differently.
- Notifications to the advisor are not part of this demo.
- It is an offline recording, so latency and interruptions on a live call are not shown.

Fonts: Libre Franklin and Courier Prime, SIL Open Font License.
