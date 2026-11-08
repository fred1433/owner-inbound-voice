import { BOOKING_SLOTS, cardFrom, clock, runBooking, runCall } from "./lib/engine.js";
import { createMockCrm } from "./lib/mockcrm.js";

const byId = (id) => document.getElementById(id);
const audio = byId("audio");
const branchAudio = byId("branch-audio");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const narrow = () => window.matchMedia("(max-width: 620px)").matches;

const [contracts, conversation] = await Promise.all(
  ["data/contracts.json", "data/conversation.json"].map((u) => fetch(u).then((r) => r.json())));

const state = { heard: [], choice: null, listened: false, renderId: 0, lastStamp: null };
const typing = new WeakMap();

function localTransport() {
  const crm = createMockCrm(contracts, {});
  return (method, path, request) => Promise.resolve(crm.handle(method, path, request));
}

function typeInto(el, text) {
  const value = text || "";
  if (el.dataset.value === value) return;
  el.dataset.value = value;
  clearInterval(typing.get(el));
  if (reduceMotion || !value) {
    el.textContent = value;
    return;
  }
  let i = 0;
  el.textContent = "";
  const timer = setInterval(() => {
    i += 2;
    el.textContent = value.slice(0, i);
    if (i >= value.length) clearInterval(timer);
  }, 14);
  typing.set(el, timer);
}

function renderStamp(card) {
  const stamp = byId("stamp");
  if (!card.stamp) {
    stamp.hidden = true;
    state.lastStamp = null;
    return;
  }
  stamp.hidden = false;
  byId("stamp-text").textContent = card.stamp;
  stamp.classList.toggle("is-stop", card.stamp === "Do not contact");
  if (state.lastStamp !== card.stamp) {
    stamp.classList.remove("slam");
    void stamp.offsetWidth;
    stamp.classList.add("slam");
  }
  state.lastStamp = card.stamp;
}

function renderCard(card, run) {
  byId("card-hint").hidden = Boolean(card.name);
  byId("card").classList.toggle("filled", Boolean(card.name));
  typeInto(byId("card-name"), card.name);
  typeInto(byId("card-stage"), card.stage);
  typeInto(byId("f-question"), card.question ? card.question + " (at " + card.questionAt + ")" : "");
  typeInto(byId("f-number"), card.number ? card.number + ". " + card.numberNote : "");
  byId("f-number").classList.toggle("number-none", card.number === "None");
  typeInto(byId("f-followup"), card.followUp);
  typeInto(byId("f-valuation"), card.valuation);
  typeInto(byId("f-business"), card.business);
  typeInto(byId("f-sales"), card.sales);
  typeInto(byId("f-recurring"), card.recurring);
  typeInto(byId("f-horizon"), card.horizon);
  renderStamp(card);

  const f = run.heardFields;
  byId("tab-name").textContent = f.name ? f.name.last + ", " + f.name.first[0] + "." : "Owner inbound";
  typeInto(byId("slip-name"), card.name || " ");
  typeInto(byId("slip-phone"), f.cell ? f.cell.display : " ");
  byId("box-telephoned").classList.toggle("ticked", Boolean(card.name));
  const callback = run.attempts.find((a) => a.channel === "callback");
  byId("box-please").classList.toggle("ticked", Boolean(callback && callback.sent));
  byId("box-again").classList.toggle("ticked", Boolean(run.instruction && run.instruction.kind === "no_contact"));

  byId("request-count").textContent = run.log.length ? "(" + run.log.length + ")" : "";
  const list = byId("request-list");
  list.replaceChildren(...run.log.map((entry) => {
    const li = document.createElement("li");
    const head = document.createElement("b");
    const query = entry.query ? "?" + new URLSearchParams(entry.query).toString() : "";
    head.textContent = entry.method + " " + entry.path + query + ", Version " + entry.version + ", answered " + entry.status;
    li.append(head);
    if (entry.body) {
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(entry.body);
      li.append(pre);
    }
    return li;
  }));
}

async function refresh() {
  const id = ++state.renderId;
  const branch = state.choice ? conversation.branches[state.choice] : null;
  const run = await runCall(conversation, state.heard, branch ? branch.owner.text : null, localTransport());
  if (id !== state.renderId) return;
  renderCard(cardFrom(run, conversation), run);
  renderTranscriptBranch();
}

// ---------- Transcript ----------

function transcriptLine(turn, offset) {
  const li = document.createElement("li");
  li.dataset.id = turn.id;
  li.className = turn.speaker;
  const t = document.createElement("span");
  t.className = "t";
  t.textContent = clock(turn.start + offset);
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = turn.speaker === "owner" ? "Owner" : "Assistant";
  const said = document.createElement("span");
  said.className = "said";
  said.textContent = turn.text;
  li.append(t, who, said);
  return li;
}

function renderTranscriptBranch() {
  const list = byId("transcript");
  list.querySelectorAll("[data-branch]").forEach((n) => n.remove());
  if (!state.choice) return;
  const branch = conversation.branches[state.choice];
  const offset = conversation.duration + 0.45;
  for (const turn of [branch.owner, branch.assistant]) {
    const li = transcriptLine(turn, offset);
    li.dataset.branch = "1";
    list.append(li);
  }
}

function markNow(id) {
  document.querySelectorAll(".transcript .now").forEach((n) => n.classList.remove("now"));
  if (id) {
    const li = document.querySelector('.transcript [data-id="' + id + '"]');
    if (li) li.classList.add("now");
  }
}

// ---------- Playback ----------

function setLabels() {
  const playing = !audio.paused && !audio.ended;
  const midway = audio.currentTime > 0 && !audio.ended;
  byId("play-label").textContent = playing ? "Pause" : midway ? "Keep listening" : "Hear the owner";
  byId("play-glyph").setAttribute("d", playing ? "M4 3 H8 V17 H4 Z M12 3 H16 V17 H12 Z" : "M5 3 L17 10 L5 17 Z");
  byId("mini-play").textContent = playing ? "Pause" : "Play";
  byId("minibar").hidden = !(narrow() && state.listened && !audio.ended && (playing || midway));
}

function setTime() {
  const duration = conversation.duration;
  const now = Math.min(audio.currentTime, duration);
  byId("scrub").value = String((now / duration) * 100);
  byId("time").textContent = clock(now);
  byId("mini-time").textContent = clock(now);
  byId("mini-fill").style.width = (now / duration) * 100 + "%";
}

function onTime() {
  setTime();
  const now = audio.currentTime;
  const current = conversation.turns.find((t) => now >= t.start && now < t.end + 0.45);
  if (!audio.paused) markNow(current ? current.id : null);
  if (state.choice) return;
  const heard = conversation.turns.filter((t) => t.end <= now + 0.05).map((t) => t.id);
  if (heard.length !== state.heard.length) {
    state.heard = heard;
    refresh();
  }
}

function start() {
  branchAudio.pause();
  if (audio.ended || audio.currentTime === 0) {
    audio.currentTime = 0;
    clearChoice();
  }
  state.listened = true;
  byId("choice").classList.remove("due");
  audio.play();
  if (narrow()) byId("card").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
}

function toggle() {
  if (audio.paused || audio.ended) start();
  else audio.pause();
}

function clearChoice() {
  state.choice = null;
  state.heard = [];
  document.querySelectorAll('input[name="choice"]').forEach((i) => (i.checked = false));
  refresh();
}

function choose(key) {
  audio.pause();
  state.choice = key;
  state.heard = conversation.turns.map((t) => t.id);
  byId("choice").classList.remove("due");
  markNow(null);
  refresh();
  const branch = conversation.branches[key];
  if (state.listened) {
    branchAudio.src = branch.audio;
    branchAudio.play();
  }
  byId("minibar").hidden = true;
  if (narrow()) byId("card").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
}

byId("play").addEventListener("click", toggle);
byId("mini-play").addEventListener("click", toggle);
audio.addEventListener("timeupdate", onTime);
audio.addEventListener("play", setLabels);
audio.addEventListener("pause", setLabels);
audio.addEventListener("ended", () => {
  state.heard = conversation.turns.map((t) => t.id);
  if (!state.choice) byId("choice").classList.add("due");
  setLabels();
  markNow(null);
  refresh();
});
byId("scrub").addEventListener("input", (event) => {
  audio.currentTime = (Number(event.target.value) / 100) * conversation.duration;
  onTime();
  setLabels();
});
document.querySelectorAll('input[name="choice"]').forEach((input) => {
  input.addEventListener("change", () => choose(input.value));
});

// ---------- First paint ----------

byId("label-call").textContent = conversation.branches.call.choice;
byId("label-stop").textContent = conversation.branches.stop.choice;
byId("commit").textContent = contracts.commit.slice(0, 12);
byId("transcript").replaceChildren(...conversation.turns.map((t) => transcriptLine(t, 0)));
refresh();

async function renderBooking() {
  const crm = createMockCrm(contracts, { slots: BOOKING_SLOTS });
  const out = await runBooking((m, p, r) => Promise.resolve(crm.handle(m, p, r)));
  byId("booking").replaceChildren(...out.spoken.map((line) => {
    const li = document.createElement("li");
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = line.who === "owner" ? "Owner" : "Assistant";
    const said = document.createElement("span");
    said.textContent = line.line;
    if (line.afterId) {
      const small = document.createElement("small");
      small.textContent = "Said only after the mock CRM returned " + line.afterId + ".";
      said.append(small);
    }
    li.append(who, said);
    return li;
  }));
}
renderBooking();

async function renderSources() {
  try {
    const response = await fetch("sources.json");
    if (!response.ok) return;
    const data = await response.json();
    const box = byId("sources");
    const intro = document.createElement("p");
    intro.textContent = data.intro;
    const list = document.createElement("ul");
    for (const item of data.items) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = item.url;
      a.textContent = item.label;
      li.append(item.fact + " ", a);
      list.append(li);
    }
    box.append(intro, list);
    box.hidden = false;
  } catch {
    // The file is not part of the repository. The page works without it.
  }
}
renderSources();
