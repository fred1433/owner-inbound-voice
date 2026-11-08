// A stand-in for the CRM's HTTP API. It is not the real service: it checks each request and each
// of its own responses against the pinned API schemas, and keeps its data in memory.
// The page calls handle() directly; mock/server.mjs puts the same function behind HTTP for the replay.

export function validate(schema, value, path, strict) {
  if (!schema) return [];
  const errors = [];
  if (value === null || value === undefined) {
    if (value === null && !schema.nullable) errors.push(path + ": null not allowed");
    return errors;
  }
  if (schema.anyOf || schema.oneOf) {
    const options = schema.anyOf || schema.oneOf;
    if (!options.some((s) => validate(s, value, path, strict).length === 0)) errors.push(path + ": matches no allowed shape");
  }
  for (const s of schema.allOf || []) errors.push(...validate(s, value, path, strict));
  if (schema.type) {
    const actual = Array.isArray(value) ? "array" : typeof value;
    if (actual !== schema.type && !(schema.type === "integer" && actual === "number")) {
      errors.push(path + ": expected " + schema.type + ", got " + actual);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(path + ": value not in the allowed list");
  if (Array.isArray(value)) value.forEach((v, i) => errors.push(...validate(schema.items, v, path + "[" + i + "]", strict)));
  if (typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (value[key] === undefined) errors.push(path + "." + key + ": required");
    }
    const props = schema.properties || {};
    for (const [key, v] of Object.entries(value)) {
      if (props[key]) errors.push(...validate(props[key], v, path + "." + key, strict));
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...validate(schema.additionalProperties, v, path + "." + key, strict));
      } else if (strict && schema.properties) errors.push(path + "." + key + ": not in the schema");
    }
  }
  return errors;
}

function route(method, path) {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "contacts") {
    if (parts.length === 2 && parts[1] === "upsert" && method === "POST") return { op: "POST /contacts/upsert" };
    if (parts.length === 2 && (method === "GET" || method === "PUT")) return { op: method + " /contacts/{contactId}", id: parts[1] };
    if (parts.length === 3 && parts[2] === "tasks" && method === "POST") return { op: "POST /contacts/{contactId}/tasks", id: parts[1] };
    if (parts.length === 3 && parts[2] === "notes" && method === "POST") return { op: "POST /contacts/{contactId}/notes", id: parts[1] };
  }
  if (parts[0] === "opportunities") {
    if (parts.length === 1 && method === "POST") return { op: "POST /opportunities/" };
    if (parts.length === 2 && method === "PUT") return { op: "PUT /opportunities/{id}", id: parts[1] };
  }
  if (parts[0] === "conversations" && parts[1] === "messages" && parts.length === 2 && method === "POST") {
    return { op: "POST /conversations/messages" };
  }
  if (parts[0] === "calendars") {
    if (parts[2] === "free-slots" && parts.length === 3 && method === "GET") return { op: "GET /calendars/{calendarId}/free-slots", id: parts[1] };
    if (parts[1] === "events" && parts[2] === "appointments" && parts.length === 3 && method === "POST") return { op: "POST /calendars/events/appointments" };
  }
  return null;
}

export function dndBlocks(contact, channel) {
  if (contact.dnd === true) return true;
  const entry = (contact.dndSettings || {})[channel];
  return Boolean(entry && entry.status && entry.status !== "inactive");
}

export function createMockCrm(contracts, options) {
  const opts = options || {};
  const state = {
    contacts: new Map(), opportunities: new Map(), notes: [], tasks: [], messages: [], appointments: [],
    slots: (opts.slots || []).slice(), allowDuplicateContact: Boolean(opts.allowDuplicateContact),
  };
  const violations = [];
  let counter = 0;
  const nextId = (prefix) => prefix + "_" + String(++counter).padStart(4, "0");

  function reply(contract, status, body) {
    if (status < 300) {
      const schema = contract.responses[String(status)];
      const errors = validate(schema, body, "response", false);
      if (errors.length) violations.push({ kind: "response", errors });
    }
    return { status, body };
  }

  function handle(method, path, request) {
    const req = request || {};
    const headers = req.headers || {};
    const found = route(method, path);
    if (!found) return { status: 404, body: { message: "unknown route" } };
    const contract = contracts.ops[found.op];
    if (!headers.authorization || !headers.authorization.startsWith("Bearer ")) return { status: 401, body: { message: "missing bearer token" } };
    if (headers.version !== contract.version) {
      violations.push({ kind: "request", op: found.op, errors: ["Version header must be " + contract.version] });
      return { status: 400, body: { message: "Version header must be " + contract.version } };
    }
    for (const q of contract.query) {
      if (q.required && (!req.query || req.query[q.name] === undefined)) {
        violations.push({ kind: "request", op: found.op, errors: ["query " + q.name + " required"] });
        return { status: 400, body: { message: "query parameter " + q.name + " is required" } };
      }
    }
    const errors = contract.body ? validate(contract.body, req.body === undefined ? {} : req.body, "body", true) : [];
    if (errors.length) {
      violations.push({ kind: "request", op: found.op, errors });
      return { status: 422, body: { message: errors.join("; ") } };
    }
    const body = req.body || {};

    switch (found.op) {
      case "POST /contacts/upsert": {
        // The real endpoint's behaviour depends on the sub-account's duplicate settings.
        // This mock matches on phone or email unless allowDuplicateContact is set.
        const existing = state.allowDuplicateContact ? null : [...state.contacts.values()].find(
          (c) => (body.phone && c.phone === body.phone) || (body.email && c.email === body.email));
        if (existing) {
          Object.assign(existing, body);
          return reply(contract, 200, { new: false, contact: existing });
        }
        const contact = Object.assign({ id: nextId("contact"), dnd: false, dndSettings: {}, customFields: [] }, body);
        state.contacts.set(contact.id, contact);
        return reply(contract, 200, { new: true, contact });
      }
      case "GET /contacts/{contactId}": {
        const contact = state.contacts.get(found.id);
        if (!contact) return { status: 400, body: { message: "unknown contact" } };
        return reply(contract, 200, { contact });
      }
      case "PUT /contacts/{contactId}": {
        const contact = state.contacts.get(found.id);
        if (!contact) return { status: 400, body: { message: "unknown contact" } };
        const merged = Object.assign({}, contact, body);
        if (body.dndSettings) merged.dndSettings = Object.assign({}, contact.dndSettings, body.dndSettings);
        state.contacts.set(found.id, merged);
        return reply(contract, 200, { succeded: true, contact: merged });
      }
      case "POST /contacts/{contactId}/tasks": {
        if (!state.contacts.has(found.id)) return { status: 400, body: { message: "unknown contact" } };
        const task = Object.assign({ id: nextId("task"), contactId: found.id }, body);
        state.tasks.push(task);
        return reply(contract, 201, { task });
      }
      case "POST /contacts/{contactId}/notes": {
        if (!state.contacts.has(found.id)) return { status: 400, body: { message: "unknown contact" } };
        const note = Object.assign({ id: nextId("note"), contactId: found.id }, body);
        state.notes.push(note);
        return reply(contract, 201, { note });
      }
      case "POST /opportunities/": {
        const opportunity = Object.assign({ id: nextId("opportunity") }, body);
        state.opportunities.set(opportunity.id, opportunity);
        return reply(contract, 201, { opportunity });
      }
      case "PUT /opportunities/{id}": {
        const opportunity = state.opportunities.get(found.id);
        if (!opportunity) return { status: 400, body: { message: "unknown opportunity" } };
        Object.assign(opportunity, body);
        return reply(contract, 200, { opportunity });
      }
      case "POST /conversations/messages": {
        const contact = state.contacts.get(body.contactId);
        if (!contact) return { status: 400, body: { message: "unknown contact" } };
        // How a real account answers a blocked send was not tested here. The mock refuses it.
        if (body.type === "SMS" && dndBlocks(contact, "SMS")) return { status: 400, body: { message: "contact has opted out of this channel" } };
        const message = Object.assign({ id: nextId("message") }, body);
        state.messages.push(message);
        return reply(contract, 200, { conversationId: nextId("conversation"), messageId: message.id, msg: "accepted by the mock" });
      }
      case "GET /calendars/{calendarId}/free-slots": {
        const taken = new Set(state.appointments.map((a) => a.startTime));
        const days = {};
        for (const slot of state.slots) {
          if (taken.has(slot)) continue;
          const day = slot.slice(0, 10);
          (days[day] = days[day] || { slots: [] }).slots.push(slot);
        }
        return reply(contract, 200, days);
      }
      case "POST /calendars/events/appointments": {
        const taken = state.appointments.some((a) => a.startTime === body.startTime);
        if (taken || !state.slots.includes(body.startTime)) return { status: 400, body: { message: "the slot you have selected is no longer available" } };
        const appointment = Object.assign({ id: nextId("appointment"), appointmentStatus: "confirmed" }, body);
        state.appointments.push(appointment);
        return reply(contract, 200, appointment);
      }
      default:
        return { status: 404, body: { message: "unknown route" } };
    }
  }

  return { handle, state, violations };
}
