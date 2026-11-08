#!/usr/bin/env python3
"""Flatten the operations this demo uses from a local clone of the official HighLevel API docs.
Usage: python3 tools/pin_contracts.py <path-to-clone>
Writes site/data/contracts.json: request and response schemas, with references resolved,
descriptions and examples dropped, the Version header of each operation and the commit they come from."""
import json
import pathlib
import subprocess
import sys

REF = chr(36) + "ref"
KEEP = {"type", "properties", "required", "enum", "items", "anyOf", "allOf", "oneOf", "additionalProperties", "nullable"}
OPS = {
    "contacts": [("POST", "/contacts/upsert"), ("GET", "/contacts/{contactId}"), ("PUT", "/contacts/{contactId}"),
                 ("POST", "/contacts/{contactId}/tasks"), ("GET", "/contacts/{contactId}/tasks"), ("POST", "/contacts/{contactId}/notes")],
    "opportunities": [("POST", "/opportunities/"), ("PUT", "/opportunities/{id}")],
    "conversations": [("POST", "/conversations/messages")],
    "calendars": [("GET", "/calendars/{calendarId}/free-slots"), ("POST", "/calendars/events/appointments")],
}


def resolve(doc, node, seen=()):
    if isinstance(node, list):
        return [resolve(doc, x, seen) for x in node]
    if not isinstance(node, dict):
        return node
    if REF in node:
        name = node[REF].split("/")[-1]
        if name in seen:
            return {"type": "object"}
        return resolve(doc, doc["components"]["schemas"][name], seen + (name,))
    out = {}
    for key, value in node.items():
        if key == "properties":
            out[key] = {k: resolve(doc, v, seen) for k, v in value.items()}
        elif key == "additionalProperties" and isinstance(value, bool):
            out[key] = value
        elif key in KEEP:
            out[key] = resolve(doc, value, seen)
    return out


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    clone = pathlib.Path(sys.argv[1])
    commit = subprocess.check_output(["git", "-C", str(clone), "rev-parse", "HEAD"], text=True).strip()
    result = {"source": "github.com/GoHighLevel/highlevel-api-docs", "commit": commit, "ops": {}}
    for app, ops in OPS.items():
        doc = json.loads((clone / "apps" / (app + ".json")).read_text())
        for method, path in ops:
            op = doc["paths"][path][method.lower()]
            version = next(p["schema"]["enum"][0] for p in op["parameters"] if p["name"] == "Version")
            body = op.get("requestBody", {}).get("content", {}).get("application/json", {}).get("schema")
            responses = {}
            for code, resp in op["responses"].items():
                schema = resp.get("content", {}).get("application/json", {}).get("schema")
                if code.startswith("2") and schema:
                    responses[code] = resolve(doc, schema)
            query = [{"name": p["name"], "required": bool(p.get("required"))} for p in op["parameters"] if p["in"] == "query"]
            result["ops"][method + " " + path] = {
                "version": version, "file": "apps/" + app + ".json", "query": query,
                "body": resolve(doc, body) if body else None, "responses": responses,
            }
    text = json.dumps(result, separators=(",", ":"), sort_keys=True)
    if chr(36) in text:
        sys.exit("a dollar sign survived the flattening")
    pathlib.Path("site/data/contracts.json").write_text(text)
    print("pinned", len(result["ops"]), "operations at", commit)


if __name__ == "__main__":
    main()
