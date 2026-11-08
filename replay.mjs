#!/usr/bin/env node
// One command: runs the recorded call through speech-to-text, the shared rule and the mock CRM over
// HTTP on the loopback interface, then checks every result. Needs no network and no key.
//   node replay.mjs            full run, needs whisper-cli and the whisper model
//   node replay.mjs --no-asr   same, but skips the speech-to-text step and says so
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockServer } from "./mock/server.mjs";
import {
  BOOKING_SLOTS, GUARD_FALLBACK, cardFrom, checkReply, makeClient, normalizeTranscript, readContactInstruction, readExtraction, runBooking, runCall, speakSlot, speakSlots, textSoFar,
} from "./site/lib/engine.js";

const USAGE = "Usage: node replay.mjs [--no-asr]\n  --no-asr  skip the speech-to-text step (no whisper-cli or model needed)\n  --help    show this message";
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}
const unknown = args.filter((a) => a !== "--no-asr");
if (unknown.length) {
  console.error("Unknown argument: " + unknown.join(" ") + "\n" + USAGE);
  process.exit(2);
}
const skipAsr = args.includes("--no-asr");

const root = fileURLToPath(new URL(".", import.meta.url));
const contracts = JSON.parse(readFileSync(join(root, "site/data/contracts.json"), "utf8"));
const conversation = JSON.parse(readFileSync(join(root, "site/data/conversation.json"), "utf8"));
const allHeard = conversation.turns.map((t) => t.id);
const DOLLAR = String.fromCharCode(36);

let failures = 0;
let passes = 0;
function check(label, ok, detail) {
  if (ok) passes += 1;
  else failures += 1;
  console.log((ok ? "  ok    " : "  FAIL  ") + label + (ok || !detail ? "" : "  -> " + detail));
}
function section(title) {
  console.log("\n" + title);
}

// ---------- 1. Speech to text ----------
section("Speech to text");
if (skipAsr) {
  console.log("  skipped  --no-asr: recorded transcripts are used as they are");
} else {
  const model = process.env.WHISPER_MODEL || join(root, "models/ggml-base.en.bin");
  if (!existsSync(model)) {
    console.error("Whisper model not found at " + model + ". See the README, set WHISPER_MODEL, or run with --no-asr.");
    process.exit(2);
  }
  const tmp = mkdtempSync(join(tmpdir(), "owner-inbound-"));
  const owners = conversation.turns.filter((t) => t.speaker === "owner")
    .concat(Object.values(conversation.branches).map((b) => b.owner));
  const fresh = conversation.turns.map((t) => Object.assign({}, t));
  try {
    for (const turn of owners) {
      const out = join(tmp, turn.id);
      try {
        execFileSync("whisper-cli", ["-m", model, "-f", join(root, "audio/owner", turn.id + ".wav"), "-nt", "-np", "-otxt", "-of", out, "-l", "en"], { stdio: "ignore" });
      } catch (error) {
        console.error("whisper-cli could not run (" + error.code + "). See the README, or run with --no-asr.");
        process.exit(2);
      }
      const text = normalizeTranscript(readFileSync(out + ".txt", "utf8"));
      const words = (t) => t.toLowerCase().replace(/[^a-z0-9' -]/g, "").trim();
      if (words(text) === words(turn.text)) check(turn.id + " transcribed from audio: " + text, true);
      else console.log("  note  " + turn.id + " reads differently on this whisper build: " + text);
      const match = fresh.find((t) => t.id === turn.id);
      if (match) match.text = text;
      turn.freshText = text;
    }
    const reread = readExtraction(conversation.extraction, fresh);
    check("the fresh transcripts still hold every fact the model pointed at", reread.problems.length === 0, reread.problems.join("; "));
    for (const [key, kind] of [["call", "no_texts"], ["stop", "no_contact"]]) {
      const got = readContactInstruction(conversation.branches[key].owner.freshText).kind;
      check("the rule reads the fresh '" + key + "' audio as " + kind, got === kind, got);
    }
    const freshConversation = Object.assign({}, conversation, { turns: fresh });
    const server = await startMockServer(contracts, {});
    const run = await runCall(freshConversation, allHeard, conversation.branches.call.owner.freshText, server.transport);
    const task = server.crm.state.tasks[0];
    check("the number in the task comes from the fresh audio and is exact", Boolean(task) && task.body.includes("(918) 555-0142") && server.crm.state.contacts.get(run.contactId).phone === "+19185550142", task && task.body);
    await server.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- 2. What the model may say about the call ----------
section("Facts read from the turns the model named");
const good = readExtraction(conversation.extraction, conversation.turns);
check("the recorded extraction is accepted", good.problems.length === 0, good.problems.join("; "));
check("sales are kept as her words", good.fields.sales && good.fields.sales.phrase === "about two million in sales", JSON.stringify(good.fields.sales));
const bad = [
  ["sales pointed at a turn that does not say them", { sales_turn: "O3" }],
  ["a cell number pointed at the wrong turn", { cell_turn: "O1" }],
  ["a name taken from the assistant's turn", { name_turn: "A1" }],
  ["a name taken from a turn with no name", { name_turn: "O4" }],
  ["recurring share pointed at the phone turn", { recurring_turn: "O4" }],
  ["a sector off the list", { sector: "fintech" }],
  ["a horizon off the list", { horizon: "selling next week" }],
  ["a made-up turn id", { price_question_turn: "O9" }],
  ["an extra field holding a value", { valuation: "one point two million" }],
];
for (const [label, patch] of bad) {
  const out = readExtraction(Object.assign({}, conversation.extraction, patch), conversation.turns);
  check("rejected: " + label, out.problems.length > 0);
}

// ---------- 3. The rule, the CRM and the follow-up attempts ----------
section("What the owner asks for, through the mock CRM over HTTP");
async function playCall(words, heard, options) {
  const opts = options || {};
  const server = await startMockServer(contracts, {});
  const transport = opts.wrap ? opts.wrap(server.transport) : server.transport;
  const run = await runCall(conversation, heard || allHeard, words, transport, { saying: opts.saying });
  const contact = run.contactId ? server.crm.state.contacts.get(run.contactId) : null;
  const out = { run, contact, state: server.crm.state, violations: server.crm.violations, card: cardFrom(run, conversation) };
  await server.close();
  check("  requests and responses match the schemas: " + (words || "part of the call"), out.violations.length === 0, JSON.stringify(out.violations));
  return out;
}
const attempt = (r, channel) => r.run.attempts.find((a) => a.channel === channel);

const noTextCases = [conversation.branches.call.owner.text, "Call me on my cell, but please don't text.", "No text messages, a phone call is fine.", "I'd rather not get any texts.", "I don't want texts.", "Call my cell. I don't want any texts."];
for (const words of noTextCases) {
  const r = await playCall(words);
  check("no texts: \"" + words + "\"", r.run.instruction.kind === "no_texts", r.run.instruction.kind);
  check("  SMS set, global flag left off", r.contact.dnd === false && r.contact.dndSettings.SMS && r.contact.dndSettings.SMS.status === "active" && !r.contact.dndSettings.Call);
  check("  text attempted and stopped, none sent", attempt(r, "text").outcome === "blocked" && r.state.messages.length === 0);
  check("  callback stays active, on her cell", r.state.tasks.length === 1 && r.state.tasks[0].body.includes("(918) 555-0142"));
  check("  card: stamp and number", r.card.stamp === "No texts" && r.card.number === "(918) 555-0142");
}
const stopCases = [conversation.branches.stop.owner.text, "Take me off your list.", "Please stop calling me.", "Never contact me again.", "No calls or texts.", "Don't text or call me.", "I do not want to be contacted.", "Please don't reach out.", "Stop."];
for (const words of stopCases) {
  const r = await playCall(words);
  check("no contact: \"" + words + "\"", r.run.instruction.kind === "no_contact", r.run.instruction.kind);
  check("  calls and SMS both blocked in the CRM", r.contact.dnd === true && r.contact.dndSettings.Call.status === "active" && r.contact.dndSettings.SMS.status === "active");
  check("  no callback task and no message", r.state.tasks.length === 0 && r.state.messages.length === 0);
  check("  both attempts recorded as stopped", attempt(r, "text").outcome === "blocked" && attempt(r, "callback").outcome === "blocked");
  check("  card: stamp and no number", r.card.stamp === "Do not contact" && r.card.number === "None");
}
const openCases = ["I'm just exploring.", "I'm not ready to sell yet.", "I don't mind texts.", "You can text me.", "Don't call the shop line, call my cell.", "Don't text the shop line, text my cell.", "I'll get back to you."];
for (const words of openCases) {
  const r = await playCall(words);
  check("no opposition: \"" + words + "\"", r.run.instruction.kind === "none", r.run.instruction.kind);
  check("  flags stay off, text and callback both run", r.contact.dnd === false && Object.keys(r.contact.dndSettings).length === 0 && r.state.messages.length === 1 && r.state.tasks.length === 1);
}
{
  const r = await playCall("Don't call me, just text.");
  check("no calls: \"Don't call me, just text.\"", r.run.instruction.kind === "no_calls" && r.state.tasks.length === 0 && r.state.messages.length === 1, r.run.instruction.kind);
}
for (const words of ["Don't contact me before noon.", "Not interested.", "Maybe, ask me later.", "No texts after five."]) {
  const r = await playCall(words);
  check("not recognised: \"" + words + "\"", r.run.instruction.kind === "unclear", r.run.instruction.kind);
  check("  no automatic text, no task, no flag set", r.state.messages.length === 0 && r.state.tasks.length === 0 && r.contact.dnd === false && Object.keys(r.contact.dndSettings).length === 0);
  check("  the advisor gets her words", r.state.notes.some((n) => n.body === words) && r.card.followUp.includes("advisor's review"));
}
{
  const r = await playCall(null, ["A0", "O1"]);
  check("part of the call heard: name and sales only, no follow-up yet", r.card.name === "Dana Walker" && r.card.sales && !r.card.question && r.run.attempts.length === 0);
  check("nothing is written before there is a number to match on", r.state.contacts.size === 0);
}
{
  const o1 = conversation.turns.find((t) => t.id === "O1");
  const span = o1.end - o1.start;
  const early = await playCall(null, ["A0"], { saying: { id: "O1", text: textSoFar(o1, o1.start + span * 0.1) } });
  check("while she talks: no name before she says it", early.card.name === null, early.card.name);
  const named = await playCall(null, ["A0"], { saying: { id: "O1", text: textSoFar(o1, o1.start + span * 0.3) } });
  check("while she talks: the name appears when she says it", named.card.name === "Dana Walker" && !named.card.sales, JSON.stringify(named.card.sales));
  const words = textSoFar(o1, o1.start + span * 0.17);
  check("words are cut at a word, never inside one", o1.text.startsWith(words) && (words === "" || o1.text[words.length] === " "), words);
}
{
  const r = await playCall(conversation.branches.call.owner.text);
  check("the task carries her instruction", r.state.tasks[0].body === "Call her cell, (918) 555-0142, not the shop line. Her office manager reads those texts.", r.state.tasks[0].body);
  check("the card shows the task as read back from the mock", r.card.numberLine === r.state.tasks[0].body && r.run.log.some((l) => l.method === "GET" && l.path.endsWith("/tasks")));
}

section("When the CRM fails");
const failing = (status, match) => (transport) => (method, path, request) =>
  (match(method, path, request) ? Promise.resolve({ status, body: { message: "injected failure" } }) : transport(method, path, request));
const dndWrite = (method, path, request) => method === "PUT" && Boolean(request.body && request.body.dndSettings);
for (const status of [500, 503]) {
  const stop = await playCall(conversation.branches.stop.owner.text, null, { wrap: failing(status, dndWrite) });
  check(status + " on the opposition: no text and no task all the same", stop.state.messages.length === 0 && stop.state.tasks.length === 0);
  check(status + " on the opposition: both attempts stopped", attempt(stop, "text").outcome === "blocked" && attempt(stop, "callback").outcome === "blocked");
  check(status + " on the opposition: the card says it needs checking", stop.card.followUp.startsWith("Her request could not be saved in the CRM.") && stop.run.preferenceRecorded === false, stop.card.followUp);
  const noText = await playCall(conversation.branches.call.owner.text, null, { wrap: failing(status, dndWrite) });
  check(status + " on no texts: no text, callback still open, the card says it needs checking", noText.state.messages.length === 0 && noText.state.tasks.length === 1 && noText.card.followUp.startsWith("Her request could not be saved"), noText.card.followUp);
  const down = await playCall(conversation.branches.stop.owner.text, null, { wrap: failing(status, () => true) });
  check(status + " on everything: no crash, nothing sent, the card says so", down.state.contacts.size === 0 && down.state.messages.length === 0 && down.state.tasks.length === 0 && down.card.followUp.includes("could not be saved"), down.card.followUp);
  const task = await playCall(conversation.branches.call.owner.text, null, { wrap: failing(status, (m, p) => m === "POST" && p.endsWith("/tasks")) });
  check(status + " on the task: the card does not claim one", task.state.tasks.length === 0 && task.card.followUp.includes("could not be created"), task.card.followUp);
  const sms = await playCall("You can text me.", null, { wrap: failing(status, (m, p) => p === "/conversations/messages") });
  check(status + " on the text: the card does not claim one", sms.state.messages.length === 0 && sms.card.followUp.includes("Text failed"), sms.card.followUp);
}

section("The same event twice, and a later call");
{
  const server = await startMockServer(contracts, {});
  const ledger = new Map();
  const words = conversation.branches.call.owner.text;
  await runCall(conversation, allHeard, words, server.transport, { ledger });
  await runCall(conversation, allHeard, words, server.transport, { ledger });
  check("same call replayed: one contact, one opportunity, one task", server.crm.state.contacts.size === 1 && server.crm.state.opportunities.size === 1 && server.crm.state.tasks.length === 1);
  await server.close();
  const race = await startMockServer(contracts, {});
  const client = makeClient(race.transport, []);
  const contact = (await client.send("POST", "/contacts/upsert", { body: { locationId: "x", phone: "+19185550142" } })).body.contact;
  const payload = { body: { title: "Call", dueDate: "2026-11-17T09:00:00-06:00", completed: false } };
  await Promise.all([client.once("k", "POST", "/contacts/" + contact.id + "/tasks", payload), client.once("k", "POST", "/contacts/" + contact.id + "/tasks", payload)]);
  check("two events in flight: one task", race.crm.state.tasks.length === 1, String(race.crm.state.tasks.length));
  await race.close();
  const later = await startMockServer(contracts, {});
  await runCall(conversation, allHeard, conversation.branches.stop.owner.text, later.transport, { callId: "call-0001" });
  const back = await runCall(conversation, allHeard, "I'm just exploring.", later.transport, { callId: "call-0002" });
  check("she said stop, then calls again: same contact, opposition holds", later.crm.state.contacts.size === 1 && later.crm.state.messages.length === 0 && later.crm.state.tasks.length === 0 && cardFrom(back, conversation).stamp === "Do not contact");
  await later.close();
}
{
  const r = await playCall(conversation.branches.call.owner.text);
  const opp = [...r.state.opportunities.values()][0];
  check("sales sit in their own field, as her words", r.contact.customFields.some((f) => f.id === "field_declared_sales" && f.field_value === "about two million in sales"));
  check("the opportunity carries no monetary value", opp.monetaryValue === undefined);
  check("no valuation anywhere in the CRM or on the card", r.card.valuation === null && !JSON.stringify([...r.state.contacts.values()]).toLowerCase().includes("valuation"));
  check("stage moved to Advisor callback", opp.pipelineStageId === "stage_advisor_callback");
  check("no contract violation in a full call", r.violations.length === 0, JSON.stringify(r.violations));
}

// ---------- 4. The output guard ----------
section("The output guard, after a reply is generated");
const declared = "two million";
const allowed = [
  "You said about two million in sales.",
  "I have you at about two million in sales, as you told me.",
  "Two million in sales doesn't tell me what you could sell for, because buyers pay for cash flow.",
  "Sales alone can't say what you could sell for.",
  "I can't promise that. An advisor can explain how the firm handles confidentiality.",
  "An advisor handles price. How much comes from maintenance contracts?",
  "Understood. Nobody will call or text you. Thanks for calling.",
  "I can't promise that no one will find out.",
  "That's a tax and legal question, so it belongs with your own advisers.",
  GUARD_FALLBACK,
];
for (const reply of allowed) {
  const v = checkReply(reply, { declared });
  check("passes: " + reply, v.ok, v.reason);
}
const proposal = "Three times my earnings, so one point two million, right?";
const refused = [
  ["With two million in sales, you could sell for around two million.", null],
  ["Your company could fetch two million in sales terms.", null],
  ["Companies like yours go for about one point two million.", null],
  ["You could sell for about " + DOLLAR + "1.2 million.", null],
  ["It could be worth 1.2M.", null],
  ["One million two hundred thousand is a good start.", null],
  ["Most businesses trade at two to four times earnings.", null],
  ["Roughly twice your earnings is typical.", null],
  ["You're looking at a seven-figure exit.", null],
  ["Yes, three times earnings is about right.", proposal],
  ["That's a fair number to start from.", proposal],
  ["You're in the right ballpark.", proposal],
  ["Your employees won't find out.", null],
  ["Nobody at your company will find out.", null],
  ["I guarantee this stays private.", null],
  ["Nothing" + " is shared with anyone.", null],
  ["You should do an asset sale to lower your tax bill.", null],
  ["Please send me your last three years of tax returns.", null],
  ["Our article explains how that works.", null],
  ["Two million in sales doesn't limit you, you could sell for more than that.", null],
  ["Businesses like yours usually sell for about what they do in a year.", null],
  ["You'd probably get a year's revenue.", null],
  ["You could probably get a million and a half.", null],
  ["Two million sounds like a strong sale.", null],
  ["Six hundred thousand is where I would start.", null],
  ["I'd say that's in the neighborhood.", proposal],
  ["Sure, that works.", proposal],
  ["Probably.", proposal],
  ["We keep everything private.", null],
  ["It's all confidential.", null],
  ["Your staff won't hear about this from us.", null],
  ["Two million in sales is what buyers would pay.", null],
  ["I'd value it at one point two.", null],
  ["It's probably worth around what you do in sales.", null],
  ["We won't tell your employees.", null],
  ["This stays between you and me.", null],
  ["Set it up as a holding company to pay less tax.", null],
  ["Please have your last three years of returns on hand.", null],
  ["Correct.", "Could I sell for two million?"],
  ["That's about what I'd expect.", proposal],
];
for (const [reply, lastOwner] of refused) {
  const v = checkReply(reply, { declared, lastOwner });
  check("refused: " + reply, !v.ok, "it passed");
}
for (const turn of conversation.turns.concat(Object.values(conversation.branches).map((b) => b.assistant))) {
  if (turn.speaker !== "assistant") continue;
  const all = conversation.turns.concat(Object.values(conversation.branches).flatMap((b) => [b.owner]));
  const index = conversation.turns.indexOf(turn);
  const branchKey = Object.keys(conversation.branches).find((k) => conversation.branches[k].assistant.id === turn.id);
  const lastOwner = branchKey ? conversation.branches[branchKey].owner.text : index > 0 ? all[index - 1].text : undefined;
  const v = checkReply(turn.text, { declared, lastOwner });
  check("recorded reply " + turn.id + " passes the guard", v.ok, v.reason + ": " + turn.text);
}
const caseChecks = {
  "sales-restated": (t) => t.toLowerCase().includes("two million"),
  "direct-price": (t) => /advisor/i.test(t),
  "owner-price": (t) => !/one point two|three times|1\.2/i.test(t) && /advisor/i.test(t),
  employees: (t) => /advisor/i.test(t),
  tax: (t) => /advis[eo]r/i.test(t),
};
for (const c of conversation.cases) {
  const v = checkReply(c.reply, { declared, lastOwner: c.owner });
  check("recorded case " + c.id + ": " + c.reply, v.ok && caseChecks[c.id](c.reply), v.reason || "content check failed");
}
check("transcripts normalise a currency sign to words", normalizeTranscript("We do about " + DOLLAR + "2 million in sales.") === "We do about two million in sales.");
check("and the phone format", normalizeTranscript("my cell, 918 555 0142.") === "my cell, 918-555-0142.");

// ---------- 5. Contracts ----------
section("Requests and responses against the pinned API schemas (" + contracts.commit.slice(0, 12) + ")");
{
  const server = await startMockServer(contracts, {});
  const headers = { authorization: "Bearer mock-token", version: "2021-07-28" };
  const send = (method, path, request) => server.transport(method, path, request);
  check("wrong Version header refused", (await send("POST", "/contacts/upsert", { headers: { authorization: headers.authorization, version: "2021-04-15" }, body: { locationId: "x" } })).status === 400);
  check("no bearer token refused", (await send("POST", "/contacts/upsert", { headers: { version: "2021-07-28" }, body: { locationId: "x" } })).status === 401);
  check("missing required locationId refused", (await send("POST", "/contacts/upsert", { headers, body: { firstName: "x" } })).status === 422);
  check("dnd of the wrong type refused", (await send("POST", "/contacts/upsert", { headers, body: { locationId: "x", dnd: "yes" } })).status === 422);
  check("unknown dnd status refused", (await send("POST", "/contacts/upsert", { headers, body: { locationId: "x", dndSettings: { SMS: { status: "maybe" } } } })).status === 422);
  check("field outside the schema refused", (await send("POST", "/contacts/upsert", { headers, body: { locationId: "x", valuation: "one" } })).status === 422);
  check("free-slots without startDate refused", (await send("GET", "/calendars/c/free-slots", { headers: { authorization: headers.authorization, version: "2021-04-15" }, query: { endDate: 1 } })).status === 400);
  const a = await send("POST", "/contacts/upsert", { headers, body: { locationId: "x", phone: "+19185550142" } });
  const b = await send("POST", "/contacts/upsert", { headers, body: { locationId: "x", phone: "+19185550142" } });
  check("upsert twice, duplicate setting off: one contact", a.body.new === true && b.body.new === false && server.crm.state.contacts.size === 1);
  await server.close();
  const dup = await startMockServer(contracts, { allowDuplicateContact: true });
  const h = { authorization: "Bearer mock-token", version: "2021-07-28" };
  await dup.transport("POST", "/contacts/upsert", { headers: h, body: { locationId: "x", phone: "+19185550142" } });
  await dup.transport("POST", "/contacts/upsert", { headers: h, body: { locationId: "x", phone: "+19185550142" } });
  check("upsert twice, duplicate setting on: two contacts (why this needs checking on a real sub-account)", dup.crm.state.contacts.size === 2);
  await dup.close();
}

// ---------- 6. Booking ----------
section("If she picks a time herself");
{
  const server = await startMockServer(contracts, { slots: BOOKING_SLOTS });
  const out = await runBooking(server.transport);
  const lines = out.spoken.map((s) => s.line);
  const log = out.log;
  const slotsCall = log.find((l) => l.path.includes("free-slots"));
  check("availability is read in her time zone", slotsCall.query.timezone === "America/Chicago");
  check("the date is said once when both times are the same day", lines[0] === "I can offer Tuesday, November 17 at 10:30 a.m. or 11:00 a.m., Central time.", lines[0]);
  check("the slot she chose had just been taken: the CRM refused it", out.firstAttemptStatus === 400);
  check("a new time is offered", lines.some((l) => l.startsWith("That time was just taken.")));
  const bookedAt = out.spoken.findIndex((s) => s.line.startsWith("You are booked"));
  check("she hears she is booked only after an appointment id came back", bookedAt === out.spoken.length - 1 && Boolean(out.spoken[bookedAt].afterId));
  check("the assistant confirms only what was written: no promise of a person", !lines.some((l) => /advisor will/i.test(l)));
  check("startTime carries a UTC offset", /-06:00/.test(out.appointment.startTime));
  const hers = server.crm.state.appointments.filter((a) => a.contactId === out.appointment.contactId);
  check("the same event twice: one appointment", hers.length === 1 && out.retried.id === out.appointment.id);
  check("no contract violation in the booking", server.crm.violations.length === 0, JSON.stringify(server.crm.violations));
  await server.close();
  const empty = await startMockServer(contracts, { slots: [] });
  const none = await runBooking(empty.transport);
  check("no open time at all: it says only that nothing is booked", empty.crm.state.appointments.length === 0 && none.spoken.length === 1 && none.spoken[0].line === "I could not find an open time, so nothing is booked.", none.spoken[0].line);
  await empty.close();
  const zoned = await startMockServer(contracts, { slots: BOOKING_SLOTS });
  const h = { authorization: "Bearer mock-token", version: "2021-04-15" };
  const read = async (query) => (await zoned.transport("GET", "/calendars/c/free-slots", { headers: h, query }));
  const day = { startDate: Date.parse("2026-11-17T00:00:00-06:00"), endDate: Date.parse("2026-11-18T00:00:00-06:00") };
  const chicago = await read(Object.assign({ timezone: "America/Chicago" }, day));
  check("the mock answers in the zone asked for", chicago.body["2026-11-17"].slots[0] === BOOKING_SLOTS[0], JSON.stringify(chicago.body));
  const tokyo = await read(Object.assign({ timezone: "Asia/Tokyo" }, day));
  check("the same slot read from another zone keeps its instant", Date.parse(tokyo.body["2026-11-18"].slots[0]) === Date.parse(BOOKING_SLOTS[0]) && tokyo.body["2026-11-18"].slots[0].endsWith("+09:00"), JSON.stringify(tokyo.body));
  const outside = await read({ startDate: 1, endDate: 2, timezone: "America/Chicago" });
  check("a range with no slots returns none", Object.keys(outside.body).length === 0, JSON.stringify(outside.body));
  check("an unknown zone is refused", (await read(Object.assign({ timezone: "Nowhere/Land" }, day))).status === 400);
  await zoned.close();
  check("the time is said in Central time whatever the offset", speakSlot("2026-11-17T16:30:00Z") === "Tuesday, November 17 at 10:30 a.m.", speakSlot("2026-11-17T16:30:00Z"));
  check("just after midnight reads as 12:30 a.m.", speakSlot("2026-11-17T06:30:00Z") === "Tuesday, November 17 at 12:30 a.m.", speakSlot("2026-11-17T06:30:00Z"));
  check("different days keep both dates", speakSlots(["2026-11-17T16:30:00Z", "2026-11-18T16:30:00Z"]) === "Tuesday, November 17 at 10:30 a.m. or Wednesday, November 18 at 10:30 a.m.");
  const oneSlot = await startMockServer(contracts, { slots: BOOKING_SLOTS.slice(0, 1) });
  const lost = await runBooking(oneSlot.transport);
  check("the only slot is taken: nothing is confirmed", lost.appointment === null && lost.spoken[lost.spoken.length - 1].line.endsWith("nothing is booked."));
  await oneSlot.close();
}

console.log("\n" + passes + " checks passed, " + failures + " failed." + (skipAsr ? " Speech-to-text skipped." : ""));
process.exit(failures ? 1 : 0);
