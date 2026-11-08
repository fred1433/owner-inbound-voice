// The rule the page and the replay share. Nothing here knows which button was pressed:
// it reads the owner's words, writes to the CRM through a transport, and reads the result back.
// Amounts are kept in words. This file contains no literal currency sign on purpose.

import { dndBlocks } from "./mockcrm.js";

const DOLLAR = String.fromCharCode(36);
const SCENE = {
  callId: "call-0001", locationId: "loc_demo", pipelineId: "pipeline_owner_inbound", calendarId: "calendar_advisor",
  timezone: "America/Chicago", callbackDue: "2026-11-17T09:00:00-06:00",
};
export const STAGES = {
  stage_new_inbound: "New inbound",
  stage_advisor_review: "Advisor review",
  stage_advisor_callback: "Advisor callback",
  stage_no_contact: "Closed, owner asked for no contact",
};

// ---------- Words ----------

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function digitsToWords(raw) {
  const clean = raw.replace(/,/g, "");
  const [whole, part] = clean.split(".");
  const n = Number(whole);
  if (!Number.isInteger(n) || n > 10) return raw;
  return part ? ONES[n] + " point " + part.split("").map((d) => ONES[Number(d)]).join(" ") : ONES[n];
}

// A speech-to-text engine writes "two million" with a currency sign and digits. The CRM and the card
// keep the owner's words, so the transcript is put back into words before anything reads it.
export function normalizeTranscript(text) {
  const sign = "\\" + DOLLAR;
  let out = text.replace(/\s+/g, " ").trim();
  out = out.replace(new RegExp(sign + "?\\b(\\d+(?:\\.\\d+)?)\\s*(million|thousand)\\b", "gi"), (m, d, unit) => digitsToWords(d) + " " + unit.toLowerCase());
  out = out.replace(new RegExp(sign + "(\\d[\\d,]*(?:\\.\\d+)?)\\s*(M|K)\\b", "g"), (m, d, u) => digitsToWords(d) + (u === "M" ? " million" : " thousand"));
  out = out.split(DOLLAR).join("");
  out = out.replace(/\b(\d{3})[ .-]?(555)[ .-]?(01\d\d)\b/g, (m, a, b, c) => a + "-" + b + "-" + c);
  return out;
}

function plain(text) {
  return text.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ");
}

function clauses(sentence) {
  return sentence.split(/[,;:]|\bbut\b/).map((c) => c.trim()).filter(Boolean);
}

function sentences(text) {
  return text.split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter(Boolean);
}

// ---------- What the owner asked for ----------

const FULL_STOP = [
  /\b(?:do not|don't|dont|never|please don't)\s+(?:contact|reach out to|get in touch with)\s+(?:me|us)\b/,
  /\b(?:do not|don't|dont)\s+(?:call|phone)\s+(?:me|us)?\s*(?:or|and|,)\s*(?:text|email|message)\b/,
  /\b(?:stop|quit)\s+(?:contacting|calling|bothering)\b/,
  /\b(?:take|remove|delete)\s+me\s+(?:off|from)\b/,
  /\bleave me alone\b/,
  /\blose my number\b/,
  /\bno (?:calls?|phone calls?)\b[^.?!]*\bno (?:texts?|texting|sms)\b/,
  /\bno (?:more )?(?:contact|follow[- ]?ups?)\b/,
];
const NO_TEXT = [
  /\bno (?:more )?(?:texts?|texting|sms)\b/,
  /\b(?:do not|don't|dont|never|please don't|stop)\s+(?:text|texting|sms)\b/,
  /\b(?:do not|don't|dont|never|stop)\s+send(?:ing)?\s+(?:me\s+)?(?:any\s+|a\s+)?(?:texts?|sms)\b/,
  /\b(?:not|never) by text\b/,
  /\b(?:rather|prefer)\s+not\s+(?:to\s+)?(?:get|receive|have)\s+(?:any\s+)?texts?\b/,
  /\bskip the texts?\b/,
  /\bcalls? only\b/,
];
const NO_CALL = [
  /\b(?:do not|don't|dont|never|please don't|stop)\s+(?:call|calling|phone)\b(?!\s+(?:the|my)\s+(?:shop|office|work|front))/,
  /\bno (?:phone )?calls?\b/,
  /\btexts? only\b/,
];

export function readContactInstruction(ownerWords) {
  const text = plain(ownerWords);
  const hit = (rules) => rules.some((r) => r.test(text));
  if (hit(FULL_STOP)) return { kind: "no_contact", call: "block", sms: "block" };
  const sms = hit(NO_TEXT) ? "block" : "allow";
  const call = hit(NO_CALL) ? "block" : "allow";
  if (sms === "block" && call === "block") return { kind: "no_contact", call, sms };
  if (sms === "block") return { kind: "no_texts", call, sms };
  if (call === "block") return { kind: "no_calls", call, sms };
  return { kind: "none", call, sms };
}

// The CRM update each instruction produces. "No texts" leaves the global flag alone.
export function dndPayload(instruction) {
  const entry = (message) => ({ status: "active", message, code: "OWNER_REQUEST" });
  if (instruction.kind === "no_contact") {
    return { dnd: true, dndSettings: { Call: entry("Owner asked not to be contacted"), SMS: entry("Owner asked not to be contacted") } };
  }
  if (instruction.kind === "no_texts") return { dnd: false, dndSettings: { SMS: entry("Owner asked for no texts") } };
  if (instruction.kind === "no_calls") return { dnd: false, dndSettings: { Call: entry("Owner asked for no calls") } };
  return null;
}

// ---------- The output guard: runs after a reply is generated, before it can be spoken ----------

const NUM_WORD = "zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|half|point|and|a";
const AMOUNT = new RegExp("\\b(?:(?:" + NUM_WORD + "|\\d[\\d,]*(?:\\.\\d+)?)[ -]+)+(?:million|thousand|grand|mil)\\b|\\b\\d[\\d,.]*\\s*(?:m|k)\\b|\\b\\d{1,3}(?:,\\d{3})+\\b", "g");
const MULTIPLE = /\b(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s*(?:to|or|-)\s*(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten))?\s*(?:x\b|times\b)/;
const PRICE_WORD = /\b(?:worth|sells? for|sell it for|sale price|selling price|asking price|price|priced|valued?|valuation|fetch|go for|get for|bring in|offer)\b/;
const NEGATED = /\b(?:not|no|can't|cannot|won't|doesn't|does not|isn't|don't|do not|unable|never)\b/;

function amountsIn(text) {
  return (text.match(AMOUNT) || []).map((a) => a.trim().replace(/^(?:a|and)\s+(?=[a-z\d]+\s)/, ""));
}

export function proposesPrice(ownerWords, declared) {
  const text = plain(ownerWords);
  if (MULTIPLE.test(text)) return true;
  return amountsIn(text).some((a) => a !== declared);
}

const BLOCKS = [
  { reason: "promises secrecy", re: /\b(?:no one|nobody|none of them|your (?:staff|team|employees)|they)\b[^.?!]*\b(?:will|would|won't|will not|'ll|never)\b[^.?!]*\b(?:find out|know|hear|learn)\b/ },
  { reason: "promises secrecy", re: /\b(?:i|we) (?:can |will |do )?(?:guarantee|promise)\b|\bguaranteed\b|\b(?:completely confidential|totally confidential|fully confidential|strictly confidential|100 percent|stays? between us|nothing\s+is\s+shared|never\s+(?:be\s+)?shared)\b/ },
  { reason: "promises secrecy", re: /\b(?:keep|keeps|kept)\b[^.?!]*\b(?:private|secret|confidential)\b|\b(?:all|everything|always)\s+(?:is\s+|stays\s+|remains\s+)?(?:confidential|private|secret)\b/ },
  { reason: "gives tax or legal advice", re: /\b(?:capital gains|tax (?:bill|rate|advice|break|hit|strategy|benefit)s?|write[- ]?offs?|deduct(?:ion|ible)?s?|asset sale|stock sale|s corp|c corp|llc|legally|you should restructure|structure the (?:sale|deal))\b/ },
  { reason: "asks for documents", re: /\b(?:send|bring|upload|email|share|forward|gather|pull together|have ready)\b[^.?!]*\b(?:tax returns?|financials|p&l|profit and loss|statements?|documents?|paperwork)\b/ },
  { reason: "cites a page aloud", re: /\b(?:article|our guide|our site|our website|blog post|podcast)\b/ },
  { reason: "uses a size bracket as a price", re: /\b(?:six|seven|eight)[- ]figures?\b/ },
];

export function checkReply(reply, ctx) {
  const context = ctx || {};
  const declared = context.declared || "";
  const text = plain(reply);
  for (const block of BLOCKS) {
    if (block.re.test(text)) return { ok: false, reason: block.reason };
  }
  if (text.includes(DOLLAR)) return { ok: false, reason: "states a currency amount" };
  if (MULTIPLE.test(text) || /\bmultiple (?:of|on|for|would|is|applied)\b|\byour multiple\b/.test(text)) return { ok: false, reason: "applies a multiple" };
  if (/\b(?:twice|double|half|one and a half)\b[^.?!]*\b(?:sales|revenue|earnings|profit|cash flow)\b/.test(text)) return { ok: false, reason: "applies a multiple" };
  for (const sentence of sentences(text)) {
    const amounts = amountsIn(sentence);
    for (const amount of amounts) {
      if (amount !== declared) return { ok: false, reason: "states an amount the owner did not declare as sales" };
    }
    if (amounts.length > 1) return { ok: false, reason: "states more than one amount" };
    if (amounts.length === 1) {
      const isRestatement = /\b(?:in|of)\s+(?:annual\s+|yearly\s+)?(?:sales|revenue)\b/.test(sentence);
      if (!isRestatement) return { ok: false, reason: "states an amount without saying it is sales" };
      if (clauses(sentence).some((c) => PRICE_WORD.test(c) && !NEGATED.test(c))) return { ok: false, reason: "ties sales to a sale price" };
    }
    for (const clause of clauses(sentence)) {
      const withoutAsking = clause.replace(/\bwhat (?:you|it|your business|the business|a business) (?:could|might|would|can) (?:sell|go) for\b/g, "");
      const predicts = /\b(?:you|you'd|it|it'd|your (?:business|company)|this business)\b[^.?!]*\b(?:could|should|would|will|might|may|can|'d)\s*(?:probably\s+|likely\s+|easily\s+)?(?:sell for|fetch|bring|be worth|go for|get)\b/.test(withoutAsking)
        || /\b(?:businesses|companies|shops|firms)\b[^.?!]*\b(?:sells?|go|goes|trades?)\s+(?:for|at)\b/.test(withoutAsking)
        || /\b(?:a year's|one year's|annual)\s+(?:sales|revenue|earnings|profit)\b/.test(withoutAsking);
      if (predicts && !NEGATED.test(withoutAsking)) return { ok: false, reason: "predicts a sale price" };
    }
  }
  if (context.lastOwner && proposesPrice(context.lastOwner, declared)) {
    const endorses = /\b(?:yes|yeah|yep|sure|correct|exactly|right|fair|true|agreed|absolutely|definitely|probably|likely|reasonable|ballpark|neighborhood|close|in the range|on track|not far off|that works|makes sense|good estimate|solid estimate|sounds good)\b/;
    for (const sentence of sentences(text)) {
      if (endorses.test(sentence) && !NEGATED.test(sentence)) return { ok: false, reason: "endorses the owner's price" };
    }
  }
  return { ok: true, reason: "" };
}

export const GUARD_FALLBACK = "I can't put a price on your business. An advisor can walk through that with you.";

// ---------- What the model is allowed to say about the call ----------
// The model picks a value from a closed list or the id of a turn. Code then reads the words out of
// that turn. If the words are not in the turn it named, the field stays empty.

const SECTORS = { hvac: "HVAC", roofing: "Roofing", plumbing: "Plumbing", electrical: "Electrical", other: "Other" };
const HORIZONS = { now: "Now", six_to_twelve_months: "Six to twelve months", one_to_two_years: "One to two years", just_exploring: "Just exploring" };
const EXTRACTION_KEYS = ["sector", "horizon", "name_turn", "sales_turn", "price_question_turn", "recurring_turn", "cell_turn", "shop_line_turn"];

const READERS = {
  name_turn(text) {
    const m = text.match(/\b(?:[Ii]t's|[Ii]t is|[Tt]his is|I'm|I am|[Mm]y name is)\s+([A-Z][a-z]+)\s+([A-Z][a-z]+)\b/);
    return m ? { first: m[1], last: m[2] } : null;
  },
  sales_turn(text) {
    const m = text.match(/\babout\s+([a-z]+(?:\s+point\s+[a-z]+)?\s+(?:million|thousand))\s+in\s+(?:annual\s+)?(?:sales|revenue)\b/i);
    return m ? { phrase: m[0], amount: m[1].toLowerCase() } : null;
  },
  price_question_turn(text) {
    const q = sentences(text).filter((s) => s.endsWith("?") && /\b(?:sell|worth|price|value)\b/i.test(s));
    return q.length ? { question: q[q.length - 1] } : null;
  },
  recurring_turn(text) {
    const s = sentences(text);
    const i = s.findIndex((x) => /\b(?:maybe|about|roughly|around)\s+(?:a|one)\s+(?:third|quarter|half|fifth)\b/i.test(x));
    return i >= 0 ? { phrase: s[i] } : null;
  },
  cell_turn(text) {
    const m = text.match(/\b(\d{3})-(555)-(01\d\d)\b/);
    return m && /\bcell\b/i.test(text) ? { display: "(" + m[1] + ") " + m[2] + "-" + m[3], e164: "+1" + m[1] + m[2] + m[3] } : null;
  },
  shop_line_turn(text) {
    if (!/\bshop line\b/i.test(text)) return null;
    const m = text.match(/\b(?:my\s+)?(office manager|bookkeeper|staff|team|employees?|dispatcher)\b[^.?!]*\btexts?\b/i);
    return m ? { reader: m[1].toLowerCase() } : null;
  },
};

export function readExtraction(raw, turns) {
  const problems = [];
  const fields = {};
  const keys = Object.keys(raw || {});
  for (const key of keys) if (!EXTRACTION_KEYS.includes(key)) problems.push("unexpected field " + key);
  if (raw && raw.sector !== undefined) {
    if (SECTORS[raw.sector]) fields.sector = SECTORS[raw.sector];
    else problems.push("sector not in the list");
  }
  if (raw && raw.horizon !== undefined) {
    if (HORIZONS[raw.horizon]) fields.horizon = HORIZONS[raw.horizon];
    else problems.push("horizon not in the list");
  }
  for (const key of Object.keys(READERS)) {
    const id = raw ? raw[key] : undefined;
    if (id === undefined || id === null) continue;
    const turn = turns.find((t) => t.id === id);
    if (!turn || turn.speaker !== "owner") {
      problems.push(key + " names no owner turn");
      continue;
    }
    const value = READERS[key](turn.text);
    if (!value) {
      problems.push(key + " names a turn that does not say it");
      continue;
    }
    fields[key.replace("_turn", "")] = Object.assign({ turn: id }, value);
  }
  return { fields, problems };
}

// ---------- Talking to the CRM ----------

function versionFor(path) {
  return path.startsWith("/calendars") || path.startsWith("/conversations") ? "2021-04-15" : "2021-07-28";
}

export function makeClient(transport, log) {
  const ledger = new Map();
  async function send(method, path, payload) {
    const request = {
      headers: { authorization: "Bearer mock-token", version: versionFor(path) },
      body: payload && payload.body, query: payload && payload.query,
    };
    const response = await transport(method, path, request);
    log.push({ method, path, version: request.headers.version, query: request.query, body: request.body, status: response.status, response: response.body });
    return response;
  }
  // The API documents no idempotency header, so a retried event is caught here, by call and action.
  async function once(key, method, path, payload) {
    if (ledger.has(key)) return ledger.get(key);
    const response = await send(method, path, payload);
    if (response.status < 300) ledger.set(key, response);
    return response;
  }
  return { send, once };
}

// ---------- The call ----------

// Replays the part of the call heard so far against a CRM, then applies what the owner asked for.
// heard: the turn ids heard. ownerWords: the words of her final answer, or null if she has not given one.
export async function runCall(conversation, heard, ownerWords, transport) {
  const log = [];
  const client = makeClient(transport, log);
  const call = SCENE.callId;
  const { fields, problems } = readExtraction(conversation.extraction, conversation.turns);
  const knows = (key) => fields[key] && heard.includes(fields[key].turn);
  const result = { fields, problems, log, heardFields: {}, contactId: null, opportunityId: null, stageId: null, attempts: [], instruction: null };
  for (const key of Object.keys(fields)) if (typeof fields[key] === "string" ? knows("name") : knows(key)) result.heardFields[key] = fields[key];

  if (!knows("name")) return result;

  const upsert = await client.once(call + ":contact", "POST", "/contacts/upsert", {
    body: { locationId: SCENE.locationId, firstName: fields.name.first, lastName: fields.name.last, source: "Simulated inbound call", timezone: SCENE.timezone },
  });
  const contactId = upsert.body.contact.id;
  result.contactId = contactId;

  const opportunity = await client.once(call + ":opportunity", "POST", "/opportunities/", {
    body: {
      pipelineId: SCENE.pipelineId, locationId: SCENE.locationId, contactId, status: "open", pipelineStageId: "stage_new_inbound",
      name: fields.name.first + " " + fields.name.last + ", " + (fields.sector || "owner") + " inbound",
    },
  });
  result.opportunityId = opportunity.body.opportunity.id;
  result.stageId = "stage_new_inbound";

  if (knows("sales")) {
    await client.once(call + ":declared-sales", "PUT", "/contacts/" + contactId, {
      body: { customFields: [{ id: "field_declared_sales", field_value: fields.sales.phrase }, { id: "field_sale_horizon", field_value: fields.horizon || "" }] },
    });
  }
  if (knows("price_question")) {
    await client.once(call + ":price-question", "POST", "/contacts/" + contactId + "/notes", { body: { title: "Question to handle", body: fields.price_question.question } });
    await client.once(call + ":stage-review", "PUT", "/opportunities/" + result.opportunityId, { body: { pipelineStageId: "stage_advisor_review" } });
    result.stageId = "stage_advisor_review";
  }
  if (knows("recurring")) {
    await client.once(call + ":recurring", "POST", "/contacts/" + contactId + "/notes", { body: { title: "Recurring work", body: fields.recurring.phrase } });
  }
  if (knows("cell")) {
    await client.once(call + ":cell", "PUT", "/contacts/" + contactId, { body: { phone: fields.cell.e164 } });
  }
  if (ownerWords === null || ownerWords === undefined) return result;

  const instruction = readContactInstruction(ownerWords);
  result.instruction = instruction;
  const update = dndPayload(instruction);
  if (update) await client.once(call + ":dnd", "PUT", "/contacts/" + contactId, { body: update });
  const stageId = instruction.kind === "no_contact" ? "stage_no_contact" : "stage_advisor_callback";
  await client.once(call + ":stage-final", "PUT", "/opportunities/" + result.opportunityId, {
    body: instruction.kind === "no_contact" ? { pipelineStageId: stageId, status: "abandoned" } : { pipelineStageId: stageId },
  });
  result.stageId = stageId;

  // Every call plans the same two follow-ups. Each one reads the contact back first, then either runs or stops.
  const contact = (await client.send("GET", "/contacts/" + contactId)).body.contact;
  if (dndBlocks(contact, "SMS")) {
    result.attempts.push({ channel: "text", outcome: "blocked", sent: false });
  } else {
    const sms = await client.once(call + ":text", "POST", "/conversations/messages", {
      body: { type: "SMS", subType: {}, contactId, status: "pending", message: "Thanks for calling. An advisor has your notes." },
    });
    result.attempts.push({ channel: "text", outcome: sms.status < 300 ? "sent" : "failed", sent: sms.status < 300 });
  }
  if (dndBlocks(contact, "Call")) {
    result.attempts.push({ channel: "callback", outcome: "blocked", sent: false });
  } else {
    const task = await client.once(call + ":callback", "POST", "/contacts/" + contactId + "/tasks", {
      body: { title: "Call " + fields.name.first + " on her cell", body: "Number: " + (fields.cell ? fields.cell.display : "none given"), dueDate: SCENE.callbackDue, completed: false },
    });
    result.attempts.push({ channel: "callback", outcome: task.status < 300 ? "created" : "failed", sent: task.status < 300 });
  }
  return result;
}

// ---------- The card the advisor opens ----------

export function cardFrom(run, conversation) {
  const f = run.heardFields;
  const at = (id) => {
    const turn = conversation.turns.find((t) => t.id === id);
    return turn ? clock(turn.start) : "";
  };
  const text = run.attempts.find((a) => a.channel === "text");
  const callback = run.attempts.find((a) => a.channel === "callback");
  const kind = run.instruction ? run.instruction.kind : null;
  const reader = f.shop_line ? f.shop_line.reader : null;
  const card = {
    name: f.name ? f.name.first + " " + f.name.last : null,
    business: f.sector || null,
    horizon: f.horizon || null,
    sales: f.sales ? f.sales.phrase : null,
    recurring: f.recurring ? f.recurring.phrase : null,
    question: f.price_question ? f.price_question.question : null,
    questionAt: f.price_question ? at(f.price_question.turn) : null,
    number: null, numberNote: null, followUp: null, stamp: null,
    stage: run.stageId ? STAGES[run.stageId] : null,
    valuation: null,
  };
  if (f.cell) {
    card.number = f.cell.display;
    card.numberNote = reader ? "Her cell. Not the shop line, her " + reader + " reads those texts." : "Her cell.";
  }
  if (kind === "no_contact") {
    card.number = "None";
    card.numberNote = "She asked not to be contacted. She will get back to the firm herself.";
    card.followUp = "No callback task. Text attempt stopped, nothing sent.";
    card.stamp = "Do not contact";
  } else if (kind === "no_texts") {
    card.followUp = (text && text.outcome === "blocked" ? "Text attempt stopped, nothing sent." : "Text sent.") + " " + (callback && callback.outcome === "created" ? "Callback task open." : "No callback task.");
    card.stamp = "No texts";
  } else if (kind === "no_calls") {
    card.followUp = "Callback stopped, no task. " + (text && text.sent ? "Text sent." : "No text sent.");
    card.stamp = "No calls";
  } else if (kind === "none") {
    card.followUp = (text && text.sent ? "Text sent." : "No text sent.") + " " + (callback && callback.outcome === "created" ? "Callback task open." : "No callback task.");
  }
  return card;
}

export function clock(seconds) {
  const s = Math.floor(seconds);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

// ---------- If she picks a time herself ----------

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function speakSlot(iso) {
  const [date, time] = iso.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const weekday = DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  let hour = Number(time.slice(0, 2));
  const minutes = time.slice(3, 5);
  const suffix = hour >= 12 ? "p.m." : "a.m.";
  if (hour > 12) hour -= 12;
  return weekday + ", " + MONTHS[m - 1] + " " + d + " at " + hour + ":" + minutes + " " + suffix;
}

// She asks for a slot she was offered. Someone else takes it first. The assistant says nothing is
// booked until the CRM returns an appointment id. The same event then arrives a second time.
export async function runBooking(transport) {
  const log = [];
  const client = makeClient(transport, log);
  const spoken = [];
  const key = SCENE.callId + ":appointment";
  const owner = (await client.send("POST", "/contacts/upsert", { body: { locationId: SCENE.locationId, firstName: "Dana", lastName: "Walker", phone: "+19185550142", timezone: SCENE.timezone } })).body.contact;
  const rival = (await client.send("POST", "/contacts/upsert", { body: { locationId: SCENE.locationId, firstName: "Other", lastName: "Caller", phone: "+19185550199", timezone: SCENE.timezone } })).body.contact;

  const readSlots = async () => {
    const days = (await client.send("GET", "/calendars/" + SCENE.calendarId + "/free-slots", {
      query: { startDate: Date.UTC(2026, 10, 17), endDate: Date.UTC(2026, 10, 18), timezone: SCENE.timezone },
    })).body;
    return Object.values(days).flatMap((d) => d.slots);
  };
  const book = (contactId, startTime, eventKey) => client.once(eventKey, "POST", "/calendars/events/appointments", {
    body: { calendarId: SCENE.calendarId, locationId: SCENE.locationId, contactId, startTime, title: "Confidential call with an advisor" },
  });

  const offerLine = (slots, lead) => lead + slots.slice(0, 2).map(speakSlot).join(" or ") + ", Central time.";
  const noTime = "I could not find an open time. An advisor will call you with one.";
  const offered = await readSlots();
  if (!offered.length) {
    spoken.push({ who: "assistant", line: noTime });
    return { spoken, appointment: null, retried: null, log, firstAttemptStatus: null };
  }
  const chosen = offered[0];
  spoken.push({ who: "assistant", line: offerLine(offered, "I can offer ") });
  spoken.push({ who: "owner", line: "The first one, please." });

  await book(rival.id, chosen, "another-call:appointment");
  const first = await book(owner.id, chosen, key);
  let appointment = null;
  if (first.status < 300 && first.body.id) {
    appointment = first.body;
  } else {
    const fresh = await readSlots();
    if (fresh.length) {
      spoken.push({ who: "assistant", line: offerLine(fresh.slice(0, 1), "That time was just taken. I can offer ") });
      spoken.push({ who: "owner", line: "That works." });
      const second = await book(owner.id, fresh[0], key);
      if (second.status < 300 && second.body.id) appointment = second.body;
    }
  }
  if (appointment) spoken.push({ who: "assistant", line: "You are booked for " + speakSlot(appointment.startTime) + ", Central time.", afterId: appointment.id });
  else spoken.push({ who: "assistant", line: noTime });

  const retried = appointment ? await book(owner.id, appointment.startTime, key) : null;
  return { spoken, appointment, retried: retried ? retried.body : null, log, firstAttemptStatus: first.status };
}

export const BOOKING_SLOTS = ["2026-11-17T10:30:00-06:00", "2026-11-17T11:00:00-06:00", "2026-11-17T14:00:00-06:00"];
