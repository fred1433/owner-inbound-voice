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
  BOOKING_SLOTS, GUARD_FALLBACK, cardFrom, checkReply, normalizeTranscript, readContactInstruction, readExtraction, runBooking, runCall,
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
async function playCall(words, heard) {
  const server = await startMockServer(contracts, {});
  const run = await runCall(conversation, heard || allHeard, words, server.transport);
  const contact = run.contactId ? server.crm.state.contacts.get(run.contactId) : null;
  const out = { run, contact, state: server.crm.state, violations: server.crm.violations, card: cardFrom(run, conversation) };
  await server.close();
  return out;
}
const attempt = (r, channel) => r.run.attempts.find((a) => a.channel === channel);

const noTextCases = [conversation.branches.call.owner.text, "Call me on my cell, but please don't text.", "No text messages, a phone call is fine.", "I'd rather not get any texts."];
for (const words of noTextCases) {
  const r = await playCall(words);
  check("no texts: \"" + words + "\"", r.run.instruction.kind === "no_texts", r.run.instruction.kind);
  check("  SMS set, global flag left off", r.contact.dnd === false && r.contact.dndSettings.SMS && r.contact.dndSettings.SMS.status === "active" && !r.contact.dndSettings.Call);
  check("  text attempted and stopped, none sent", attempt(r, "text").outcome === "blocked" && r.state.messages.length === 0);
  check("  callback stays active, on her cell", r.state.tasks.length === 1 && r.state.tasks[0].body.includes("(918) 555-0142"));
  check("  card: stamp and number", r.card.stamp === "No texts" && r.card.number === "(918) 555-0142");
}
const stopCases = [conversation.branches.stop.owner.text, "Take me off your list.", "Please stop calling me.", "Never contact me again."];
for (const words of stopCases) {
  const r = await playCall(words);
  check("no contact: \"" + words + "\"", r.run.instruction.kind === "no_contact", r.run.instruction.kind);
  check("  calls and SMS both blocked in the CRM", r.contact.dnd === true && r.contact.dndSettings.Call.status === "active" && r.contact.dndSettings.SMS.status === "active");
  check("  no callback task and no message", r.state.tasks.length === 0 && r.state.messages.length === 0);
  check("  both attempts recorded as stopped", attempt(r, "text").outcome === "blocked" && attempt(r, "callback").outcome === "blocked");
  check("  card: stamp and no number", r.card.stamp === "Do not contact" && r.card.number === "None");
}
const openCases = ["I'm just exploring.", "I'm not ready to sell yet.", "I don't mind texts.", "You can text me.", "Don't call the shop line, call my cell.", "I'll get back to you."];
for (const words of openCases) {
  const r = await playCall(words);
  check("no opposition: \"" + words + "\"", r.run.instruction.kind === "none", r.run.instruction.kind);
  check("  flags stay off, text and callback both run", r.contact.dnd === false && Object.keys(r.contact.dndSettings).length === 0 && r.state.messages.length === 1 && r.state.tasks.length === 1);
}
{
  const r = await playCall("Don't call me, just text.");
  check("no calls: \"Don't call me, just text.\"", r.run.instruction.kind === "no_calls" && r.state.tasks.length === 0 && r.state.messages.length === 1, r.run.instruction.kind);
}
{
  const r = await playCall(null, ["A0", "O1"]);
  check("part of the call heard: name and sales only, no follow-up yet", r.card.name === "Dana Walker" && r.card.sales && !r.card.question && r.run.attempts.length === 0);
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
];
for (const [reply, lastOwner] of refused) {
  const v = checkReply(reply, { declared, lastOwner });
  check("refused: " + reply, !v.ok, "it passed");
}
for (const turn of conversation.turns.concat(Object.values(conversation.branches).map((b) => b.assistant))) {
  if (turn.speaker !== "assistant") continue;
  const v = checkReply(turn.text, { declared });
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
  check("the slot she chose had just been taken: the CRM refused it", out.firstAttemptStatus === 400);
  check("a new time is offered", lines.some((l) => l.startsWith("That time was just taken.")));
  const bookedAt = out.spoken.findIndex((s) => s.line.startsWith("You are booked"));
  check("she hears she is booked only after an appointment id came back", bookedAt === out.spoken.length - 1 && Boolean(out.spoken[bookedAt].afterId));
  check("startTime carries a UTC offset", /-06:00/.test(out.appointment.startTime));
  const hers = server.crm.state.appointments.filter((a) => a.contactId === out.appointment.contactId);
  check("the same event twice: one appointment", hers.length === 1 && out.retried.id === out.appointment.id);
  check("no contract violation in the booking", server.crm.violations.length === 0, JSON.stringify(server.crm.violations));
  await server.close();
  const failing = await startMockServer(contracts, { slots: [] });
  const none = await runBooking(failing.transport);
  check("no open time at all: nothing is confirmed, an advisor follows up", failing.crm.state.appointments.length === 0 && !none.spoken.some((l) => l.line.includes("booked")));
  await failing.close();
  const oneSlot = await startMockServer(contracts, { slots: BOOKING_SLOTS.slice(0, 1) });
  const lost = await runBooking(oneSlot.transport);
  check("the only slot is taken: nothing is confirmed", lost.appointment === null && !lost.spoken.some((l) => l.line.includes("booked")));
  await oneSlot.close();
}

console.log("\n" + passes + " checks passed, " + failures + " failed." + (skipAsr ? " Speech-to-text skipped." : ""));
process.exit(failures ? 1 : 0);
