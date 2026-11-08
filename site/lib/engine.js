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
  stage_no_contact: "Closed, no contact",
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
// A closed list of patterns, not an understanding of English. Anything it does not recognise is
// "unclear": nothing automatic happens and the advisor reads her words.

const SHOP = "(?:the|my)\\s+(?:shop|office|work|front|business)";
const FULL_STOP = [
  /\b(?:do not|don't|dont|never)\s+(?:contact|reach out to|get in touch with)\s+(?:me|us)\b/,
  /\b(?:do not|don't|dont|never)\s+(?:reach out|get in touch)\b(?!\s+(?:to|with)\s+(?:my|the)\b)/,
  /\b(?:do not|don't|dont)\s+want\s+to\s+be\s+(?:contacted|reached)\b/,
  /\b(?:do not|don't|dont|never)\s+(?:text|call|phone|email|message)\s+(?:me\s+|us\s+)?(?:or|and|nor|,)\s*(?:text|call|phone|email|message)\b/,
  /\b(?:stop|quit)\s+(?:contacting|calling|bothering)\b/,
  /\b(?:take|remove|delete)\s+me\s+(?:off|from)\b/,
  /\bleave me alone\b/,
  /\blose my number\b/,
  /\bno (?:phone )?calls?\s*(?:,|or|and|nor)\s*(?:no\s+)?(?:texts?|texting|sms)\b/,
  /\bno (?:texts?|texting|sms)\s*(?:,|or|and|nor)\s*(?:no\s+)?(?:phone )?calls?\b/,
  /\bno (?:phone )?calls?\b[^.?!]*\bno (?:texts?|texting|sms)\b/,
  /\bno (?:more )?(?:contact|follow[- ]?ups?)\b/,
];
const BARE_STOP = ["stop", "stop it", "stop please", "please stop", "unsubscribe", "remove me"];
const NO_TEXT = [
  new RegExp("\\bno (?:more )?(?:texts?|texting|sms)\\b(?!\\s+(?:to|on)\\s+" + SHOP + ")"),
  new RegExp("\\b(?:do not|don't|dont|never|stop|can't|cannot)\\s+(?:text|texting|sms)\\b(?!\\s+(?:to\\s+)?" + SHOP + ")"),
  /\b(?:do not|don't|dont|never|stop)\s+send(?:ing)?\s+(?:me\s+)?(?:any\s+|a\s+)?(?:texts?|sms)\b/,
  /\b(?:do not|don't|dont)\s+want\s+(?:any\s+|more\s+)?(?:texts?|texting|sms)\b/,
  /\b(?:not|never) by text\b/,
  /\b(?:rather|prefer)\s+not\s+(?:to\s+)?(?:get|receive|have)\s+(?:any\s+)?texts?\b/,
  /\bskip the texts?\b/,
  /\bcalls? only\b/,
];
const NO_CALL = [
  new RegExp("\\b(?:do not|don't|dont|never|stop)\\s+(?:call|calling|phone)\\b(?!\\s+" + SHOP + ")"),
  /\b(?:do not|don't|dont)\s+want\s+(?:any\s+|more\s+)?(?:phone\s+)?calls?\b/,
  /\bno (?:phone )?calls?\b/,
  /\btexts? only\b/,
];
const TIME_LIMIT = /\b(?:before|after|until|till|unless|during|between|today|tonight|tomorrow|this week|next week|this month|on weekends?|at work|in the (?:morning|afternoon|evening)|mornings?|afternoons?|evenings?)\b/;
const NO_OPPOSITION = [
  /\bjust (?:exploring|looking|curious)\b/,
  /\bnot ready\b/,
  /\bget back to you\b/,
  /\bthinking about it\b/,
  /\b(?:call|phone)\s+(?:me|my cell|my mobile)\b/,
  /\b(?:you|advisor|someone) can (?:call|text|phone)\b/,
  /\bdon't mind (?:texts?|calls?)\b/,
  /\b(?:texts?|phone calls?|calls?) (?:is|are) (?:fine|ok|okay|good)\b/,
  /\btext (?:me|my cell)\b/,
];

export function readContactInstruction(ownerWords) {
  const text = plain(ownerWords).trim();
  const bare = text.replace(/[.,!]/g, "").trim();
  const hit = (rules) => rules.some((r) => r.test(text));
  const full = hit(FULL_STOP) || BARE_STOP.includes(bare);
  const noText = hit(NO_TEXT);
  const noCall = hit(NO_CALL);
  if ((full || noText || noCall) && TIME_LIMIT.test(text)) return { kind: "unclear", call: "hold", sms: "hold" };
  if (full || (noText && noCall)) return { kind: "no_contact", call: "block", sms: "block" };
  if (noText) return { kind: "no_texts", call: "allow", sms: "block" };
  if (noCall) return { kind: "no_calls", call: "block", sms: "allow" };
  if (hit(NO_OPPOSITION)) return { kind: "none", call: "allow", sms: "allow" };
  return { kind: "unclear", call: "hold", sms: "hold" };
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
// A list of patterns, not a proof. replay.mjs holds the sentences it has been tried against.

const NUM_WORD = "zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|half|point|and|a";
const AMOUNT = new RegExp("\\b(?:(?:" + NUM_WORD + "|\\d[\\d,]*(?:\\.\\d+)?)[ -]+)+(?:million|thousand|grand|mil)\\b|\\b\\d[\\d,.]*\\s*(?:m|k)\\b|\\b\\d{1,3}(?:,\\d{3})+\\b", "g");
const MULTIPLE = /\b(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s*(?:to|or|-)\s*(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten))?\s*(?:x\b|times\b)/;
const PRICE_WORD = /\b(?:worth|sells? for|sell it for|sale price|selling price|asking price|price|priced|valued?|valuation|fetch|go for|get for|bring in|offer|pay|pays|paid)\b/;
const NEGATED = /\b(?:not|no|can't|cannot|won't|doesn't|does not|isn't|don't|do not|unable|never)\b/;
const SELL_TALK = /\b(?:sell|sells|selling|worth|price|value|get for|go for)\b/;

function amountsIn(text) {
  return (text.match(AMOUNT) || []).map((a) => a.trim().replace(/^(?:a|and)\s+(?=[a-z\d]+\s)/, ""));
}

export function proposesPrice(ownerWords, declared) {
  const text = plain(ownerWords);
  if (MULTIPLE.test(text)) return true;
  const amounts = amountsIn(text);
  if (amounts.some((a) => a !== declared)) return true;
  return amounts.length > 0 && SELL_TALK.test(text);
}

// Saying that a promise cannot be made is not a promise.
const HONEST_REFUSAL = /\b(?:can't|cannot|can not|won't|unable to|not able to)\s+(?:promise|guarantee|say)\b[^.?!]*/g;

const SECRECY = [
  /\b(?:no one|nobody|none of them|your (?:staff|team|employees)|they)\b[^.?!]*\b(?:will|would|won't|will not|'ll|never)\b[^.?!]*\b(?:find out|know|hear|learn)\b/,
  /\b(?:i|we) (?:can |will |do )?(?:guarantee|promise)\b|\bguaranteed\b|\b(?:completely confidential|totally confidential|fully confidential|strictly confidential|100 percent|stays? between (?:us|you and me|you and i)|nothing\s+is\s+shared|never\s+(?:be\s+)?shared)\b/,
  /\b(?:we|i)\s+(?:won't|will not|never|wouldn't|would never)\s+(?:tell|share|disclose|mention|say)\b/,
  /\b(?:keep|keeps|kept)\b[^.?!]*\b(?:private|secret|confidential)\b|\b(?:all|everything|always)\s+(?:is\s+|stays\s+|remains\s+)?(?:confidential|private|secret)\b/,
];
const BLOCKS = [
  { reason: "gives tax or legal advice", re: /\b(?:capital gains|tax (?:bill|rate|advice|break|hit|strategy|benefit)s?|write[- ]?offs?|deduct(?:ion|ible)?s?|asset sale|stock sale|s corp|c corp|llc|legally|you should restructure|structure the (?:sale|deal)|holding company|set (?:it|the company|this) up as)\b|\b(?:pay less|lower|reduce|save|minimi[sz]e)\b[^.?!]*\btax(?:es)?\b/ },
  { reason: "asks for documents", re: /\b(?:send|bring|upload|email|share|forward|gather|pull together|have ready|have)\b[^.?!]*\b(?:tax returns?|returns|financials|p&l|profit and loss|statements?|documents?|paperwork)\b/ },
  { reason: "cites a page aloud", re: /\b(?:article|our guide|our site|our website|blog post|podcast)\b/ },
  { reason: "uses a size bracket as a price", re: /\b(?:six|seven|eight)[- ]figures?\b/ },
  { reason: "states a value", re: /\b(?:value|price|sell|list|worth)\b[^.?!]*\b(?:at|for|around|about)\s+(?:about\s+|around\s+|roughly\s+)?(?:\d|one|two|three|four|five|six|seven|eight|nine|ten)\b/, negatable: true },
  { reason: "states a value", re: /\b(?:worth|value|valued|sell|sells|priced)\b[^.?!]*\b(?:what you do in sales|your (?:sales|revenue|earnings))\b/, negatable: true },
];

export function checkReply(reply, ctx) {
  const context = ctx || {};
  const declared = context.declared || "";
  const text = plain(reply);
  const withoutRefusals = text.replace(HONEST_REFUSAL, "");
  if (SECRECY.some((re) => re.test(withoutRefusals))) return { ok: false, reason: "promises secrecy" };
  for (const block of BLOCKS) {
    if (!block.negatable) {
      if (block.re.test(text)) return { ok: false, reason: block.reason };
      continue;
    }
    if (clauses(text).some((c) => block.re.test(c) && !NEGATED.test(c))) return { ok: false, reason: block.reason };
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
      if (clauses(sentence).some((c) => PRICE_WORD.test(c) && !NEGATED.test(c) && !c.startsWith("because"))) return { ok: false, reason: "ties sales to a sale price" };
    }
    for (const clause of clauses(sentence)) {
      const withoutAsking = clause.replace(/\bwhat (?:you|it|your business|the business|a business) (?:could|might|would|can) (?:sell|go) for\b/g, "");
      const predicts = /\b(?:you|you'd|it|it'd|it's|your (?:business|company)|this business)\b[^.?!]*\b(?:could|should|would|will|might|may|can|'d)\s*(?:probably\s+|likely\s+|easily\s+)?(?:sell for|fetch|bring|be worth|go for|get)\b/.test(withoutAsking)
        || /\b(?:businesses|companies|shops|firms)\b[^.?!]*\b(?:sells?|go|goes|trades?)\s+(?:for|at)\b/.test(withoutAsking)
        || /\b(?:it's|it is)\s+(?:probably\s+|likely\s+)?worth\b/.test(withoutAsking)
        || /\b(?:a year's|one year's|annual)\s+(?:sales|revenue|earnings|profit)\b/.test(withoutAsking);
      if (predicts && !NEGATED.test(withoutAsking)) return { ok: false, reason: "predicts a sale price" };
    }
  }
  if (context.lastOwner && proposesPrice(context.lastOwner, declared)) {
    const endorses = /\b(?:yes|yeah|yep|sure|correct|exactly|right|fair|true|agreed|absolutely|definitely|probably|likely|reasonable|ballpark|neighborhood|close|in the range|on track|not far off|that works|makes sense|good estimate|solid estimate|sounds good|what i'd expect|what i would expect)\b/;
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

export function makeClient(transport, log, sharedLedger) {
  const ledger = sharedLedger || new Map();
  async function send(method, path, payload) {
    const request = {
      headers: { authorization: "Bearer mock-token", version: versionFor(path) },
      body: payload && payload.body, query: payload && payload.query,
    };
    let response;
    try {
      response = await transport(method, path, request);
    } catch (error) {
      response = { status: 503, body: { message: "no answer from the CRM" } };
    }
    log.push({ method, path, version: request.headers.version, query: request.query, body: request.body, status: response.status, response: response.body });
    return response;
  }
  // The API documents no idempotency header, so a repeated event is caught here, by call and action.
  // The promise goes in the ledger before the answer comes back, so two events in flight send one request.
  // The ledger lives in memory: a restart forgets it.
  function once(key, method, path, payload) {
    if (ledger.has(key)) return ledger.get(key);
    const pending = send(method, path, payload).then((response) => {
      if (response.status >= 300) ledger.delete(key);
      return response;
    });
    ledger.set(key, pending);
    return pending;
  }
  return { send, once };
}

// ---------- The call ----------

// Replays the part of the call heard so far against a CRM, then applies what the owner asked for.
// heard: the turn ids heard to the end. ownerWords: her final answer, or null if she has not given one.
// options.saying: { id, text }, the owner turn in progress and the words said so far.
// options.callId and options.ledger: for a repeated event or a later call.
// Nothing is written until there is a number to match on, or a final answer to record.
export async function runCall(conversation, heard, ownerWords, transport, options) {
  const opts = options || {};
  const log = [];
  const client = makeClient(transport, log, opts.ledger);
  const call = opts.callId || SCENE.callId;
  const saying = opts.saying || null;
  const { fields, problems } = readExtraction(conversation.extraction, conversation.turns);
  const nameTurn = fields.name ? fields.name.turn : null;
  const knows = (key) => {
    const field = fields[key];
    if (!field) return false;
    if (heard.includes(field.turn)) return true;
    return Boolean(saying && saying.id === field.turn && READERS[key + "_turn"](saying.text));
  };
  const labelSaid = (label) => heard.includes(nameTurn) || Boolean(saying && saying.id === nameTurn && saying.text.toLowerCase().includes(label.toLowerCase()));
  const result = {
    fields, problems, log, heardFields: {}, contactId: null, opportunityId: null, stageId: null, attempts: [],
    instruction: null, preferenceRecorded: null, taskBody: null, crmFailed: false, ownerWords: ownerWords || null,
  };
  for (const key of Object.keys(fields)) {
    if (typeof fields[key] === "string" ? labelSaid(fields[key]) : knows(key)) result.heardFields[key] = fields[key];
  }

  const finalAnswer = ownerWords !== null && ownerWords !== undefined;
  if (!knows("cell") && !finalAnswer) return result;

  const fail = (response) => {
    if (response.status >= 300) result.crmFailed = true;
    return response.status < 300;
  };
  const instruction = finalAnswer ? readContactInstruction(ownerWords) : null;
  result.instruction = instruction;

  const contactBody = { locationId: SCENE.locationId, source: "Simulated inbound call", timezone: SCENE.timezone };
  if (fields.name) Object.assign(contactBody, { firstName: fields.name.first, lastName: fields.name.last });
  if (knows("cell")) contactBody.phone = fields.cell.e164;
  const upsert = await client.once(call + ":contact", "POST", "/contacts/upsert", { body: contactBody });
  let contactId = null;
  if (fail(upsert)) {
    contactId = upsert.body.contact.id;
    result.contactId = contactId;
    const who = fields.name ? fields.name.first + " " + fields.name.last : "Owner";
    const opportunity = await client.once(call + ":opportunity", "POST", "/opportunities/", {
      body: { pipelineId: SCENE.pipelineId, locationId: SCENE.locationId, contactId, status: "open", pipelineStageId: "stage_new_inbound", name: who + ", " + (fields.sector || "owner") + " inbound" },
    });
    if (fail(opportunity)) {
      result.opportunityId = opportunity.body.opportunity.id;
      result.stageId = "stage_new_inbound";
    }
    if (knows("sales")) {
      fail(await client.once(call + ":declared-sales", "PUT", "/contacts/" + contactId, {
        body: { customFields: [{ id: "field_declared_sales", field_value: fields.sales.phrase }, { id: "field_sale_horizon", field_value: fields.horizon || "" }] },
      }));
    }
    if (knows("price_question")) {
      fail(await client.once(call + ":price-question", "POST", "/contacts/" + contactId + "/notes", { body: { title: "Question to handle", body: fields.price_question.question } }));
      if (result.opportunityId && fail(await client.once(call + ":stage-review", "PUT", "/opportunities/" + result.opportunityId, { body: { pipelineStageId: "stage_advisor_review" } }))) {
        result.stageId = "stage_advisor_review";
      }
    }
    if (knows("recurring")) {
      fail(await client.once(call + ":recurring", "POST", "/contacts/" + contactId + "/notes", { body: { title: "Recurring work", body: fields.recurring.phrase } }));
    }
  }
  if (!finalAnswer) return result;

  const update = dndPayload(instruction);
  if (update) {
    const saved = contactId ? await client.once(call + ":dnd", "PUT", "/contacts/" + contactId, { body: update }) : { status: 503 };
    result.preferenceRecorded = fail(saved);
  }
  if (instruction.kind === "unclear" && contactId) {
    fail(await client.once(call + ":unclear", "POST", "/contacts/" + contactId + "/notes", { body: { title: "Last answer, for an advisor to read", body: ownerWords } }));
  }
  const stageId = instruction.kind === "no_contact" ? "stage_no_contact" : instruction.kind === "unclear" ? "stage_advisor_review" : "stage_advisor_callback";
  if (result.opportunityId) {
    const moved = await client.once(call + ":stage-final", "PUT", "/opportunities/" + result.opportunityId, {
      body: instruction.kind === "no_contact" ? { pipelineStageId: stageId, status: "abandoned" } : { pipelineStageId: stageId },
    });
    if (fail(moved)) result.stageId = stageId;
  }

  // Every call plans the same two follow-ups. Her words stop them here even if the CRM write failed.
  // Each one also reads the contact back, so an opposition from an earlier call still holds.
  const readBack = contactId ? await client.send("GET", "/contacts/" + contactId) : { status: 503 };
  const contact = fail(readBack) ? readBack.body.contact : null;
  const gate = (mine, channel) => {
    if (mine === "hold") return "held";
    if (mine === "block" || (contact && dndBlocks(contact, channel))) return "blocked";
    return contact ? "go" : "not_run";
  };

  const textGate = gate(instruction.sms, "SMS");
  if (textGate !== "go") {
    result.attempts.push({ channel: "text", outcome: textGate, sent: false });
  } else {
    const sms = await client.once(call + ":text", "POST", "/conversations/messages", {
      body: { type: "SMS", subType: {}, contactId, status: "pending", message: "Thanks for calling. An advisor has your notes." },
    });
    result.attempts.push({ channel: "text", outcome: fail(sms) ? "sent" : "failed", sent: sms.status < 300 });
  }

  const callGate = gate(instruction.call, "Call");
  if (callGate !== "go") {
    result.attempts.push({ channel: "callback", outcome: callGate, sent: false });
  } else {
    const reader = fields.shop_line ? fields.shop_line.reader : null;
    const number = fields.cell ? "Call her cell, " + fields.cell.display + (reader ? ", not the shop line. Her " + reader + " reads those texts." : ".") : "No number given.";
    const first = fields.name ? fields.name.first : "the owner";
    const task = await client.once(call + ":callback", "POST", "/contacts/" + contactId + "/tasks", {
      body: { title: "Call " + first, body: number, dueDate: SCENE.callbackDue, completed: false },
    });
    const created = fail(task);
    result.attempts.push({ channel: "callback", outcome: created ? "created" : "failed", sent: created });
    if (created) {
      const stored = await client.send("GET", "/contacts/" + contactId + "/tasks");
      if (fail(stored)) {
        const found = stored.body.tasks.find((t) => t.id === task.body.task.id);
        result.taskBody = found ? found.body : null;
      }
    }
  }
  return result;
}

// ---------- The card the advisor opens ----------

const TEXT_LINE = {
  blocked: "Text attempt stopped, nothing sent.", sent: "Text sent.", failed: "Text failed, nothing sent.",
  held: "No automatic text.", not_run: "Text not tried, the CRM did not answer.",
};
const CALLBACK_LINE = {
  blocked: "No callback task.", created: "Callback task open.", failed: "Callback task could not be created.",
  held: "No callback task.", not_run: "No callback task, the CRM did not answer.",
};

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
    number: null, numberLine: null, task: run.taskBody, followUp: null, stamp: null, warning: null,
    stage: run.stageId ? STAGES[run.stageId] : null,
    valuation: null,
  };
  if (f.cell) {
    card.number = f.cell.display;
    card.numberLine = f.cell.display + ". Her cell." + (reader ? " Not the shop line, her " + reader + " reads those texts." : "");
  }
  if (run.taskBody) card.numberLine = run.taskBody;
  if (!text || !callback) return card;

  const stopped = text.outcome === "blocked" && callback.outcome === "blocked";
  if (stopped) {
    const later = run.ownerWords && /\bget back to you\b/i.test(run.ownerWords) ? " She will get back to the firm herself." : "";
    card.number = "None";
    card.numberLine = "None. She asked not to be contacted." + later;
    card.stamp = "Do not contact";
  } else if (text.outcome === "blocked") {
    card.stamp = "No texts";
  } else if (callback.outcome === "blocked") {
    card.stamp = "No calls";
  } else if (kind === "unclear") {
    card.stamp = "Review";
  }
  const lines = callback.outcome === "blocked" ? [CALLBACK_LINE[callback.outcome], TEXT_LINE[text.outcome]] : [TEXT_LINE[text.outcome], CALLBACK_LINE[callback.outcome]];
  card.followUp = kind === "unclear" ? "No automatic follow-up. Her last answer needs an advisor's review." : lines.join(" ");
  if (run.preferenceRecorded === false) {
    card.warning = "Her request could not be saved in the CRM. Check it before anyone follows up.";
    card.followUp = card.warning + " " + card.followUp;
  } else if (run.crmFailed && !run.contactId) {
    card.warning = "The CRM did not answer. Nothing was saved.";
    card.followUp = card.warning + " " + card.followUp;
  }
  return card;
}

export function clock(seconds) {
  const s = Math.floor(seconds);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

// The words of a turn said by this moment of the audio, cut at a word. Speech is close enough to
// even within one short turn for this to fill the card as she talks.
export function textSoFar(turn, now) {
  if (now >= turn.end) return turn.text;
  if (now <= turn.start) return "";
  const n = Math.floor((turn.text.length * (now - turn.start)) / (turn.end - turn.start));
  if (turn.text[n] === " ") return turn.text.slice(0, n);
  return turn.text.slice(0, Math.max(turn.text.lastIndexOf(" ", n), 0));
}

// ---------- If she picks a time herself ----------

function slotParts(iso) {
  const format = new Intl.DateTimeFormat("en-US", { timeZone: SCENE.timezone, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
  const parts = Object.fromEntries(format.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return {
    date: parts.weekday + ", " + parts.month + " " + parts.day,
    time: parts.hour + ":" + parts.minute + " " + (parts.dayPeriod.toUpperCase() === "AM" ? "a.m." : "p.m."),
  };
}

export function speakSlot(iso) {
  const p = slotParts(iso);
  return p.date + " at " + p.time;
}

// Says the date once when the times offered fall on the same day.
export function speakSlots(slots) {
  const parts = slots.map(slotParts);
  if (parts.every((p) => p.date === parts[0].date)) return parts[0].date + " at " + parts.map((p) => p.time).join(" or ");
  return slots.map(speakSlot).join(" or ");
}

// She asks for a slot she was offered. Someone else takes it first. The assistant says nothing is
// booked until the CRM returns an appointment id. The same event then arrives a second time.
export async function runBooking(transport) {
  const log = [];
  const client = makeClient(transport, log);
  const spoken = [];
  const key = (startTime) => SCENE.callId + ":appointment:" + startTime;
  const owner = (await client.send("POST", "/contacts/upsert", { body: { locationId: SCENE.locationId, firstName: "Dana", lastName: "Walker", phone: "+19185550142", timezone: SCENE.timezone } })).body.contact;
  const rival = (await client.send("POST", "/contacts/upsert", { body: { locationId: SCENE.locationId, firstName: "Other", lastName: "Caller", phone: "+19185550199", timezone: SCENE.timezone } })).body.contact;

  const readSlots = async () => {
    const days = (await client.send("GET", "/calendars/" + SCENE.calendarId + "/free-slots", {
      query: { startDate: Date.parse("2026-11-17T00:00:00-06:00"), endDate: Date.parse("2026-11-18T00:00:00-06:00"), timezone: SCENE.timezone },
    })).body;
    return Object.values(days).flatMap((d) => d.slots);
  };
  const book = (contactId, startTime, eventKey) => client.once(eventKey, "POST", "/calendars/events/appointments", {
    body: { calendarId: SCENE.calendarId, locationId: SCENE.locationId, contactId, startTime, title: "Confidential call with an advisor" },
  });

  const noTime = "I could not find an open time, so nothing is booked.";
  const offered = await readSlots();
  if (!offered.length) {
    spoken.push({ who: "assistant", line: noTime });
    return { spoken, appointment: null, retried: null, log, firstAttemptStatus: null };
  }
  const chosen = offered[0];
  spoken.push({ who: "assistant", line: "I can offer " + speakSlots(offered.slice(0, 2)) + ", Central time." });
  spoken.push({ who: "owner", line: "The first one, please." });

  await book(rival.id, chosen, "another-call:appointment");
  const first = await book(owner.id, chosen, key(chosen));
  let appointment = null;
  if (first.status < 300 && first.body.id) {
    appointment = first.body;
  } else {
    const fresh = await readSlots();
    if (fresh.length) {
      spoken.push({ who: "assistant", line: "That time was just taken. I can offer " + speakSlots(fresh.slice(0, 1)) + " instead, Central time." });
      spoken.push({ who: "owner", line: "That works." });
      const second = await book(owner.id, fresh[0], key(fresh[0]));
      if (second.status < 300 && second.body.id) appointment = second.body;
    }
  }
  if (appointment) spoken.push({ who: "assistant", line: "You are booked for " + speakSlot(appointment.startTime) + ", Central time.", afterId: appointment.id });
  else spoken.push({ who: "assistant", line: noTime });

  const retried = appointment ? await book(owner.id, appointment.startTime, key(appointment.startTime)) : null;
  return { spoken, appointment, retried: retried ? retried.body : null, log, firstAttemptStatus: first.status };
}

export const BOOKING_SLOTS = ["2026-11-17T10:30:00-06:00", "2026-11-17T11:00:00-06:00", "2026-11-17T14:00:00-06:00"];
