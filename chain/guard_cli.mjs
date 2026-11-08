// Used by chain/build.py so the recording goes through the same guard as the page and the replay.
// Usage: node chain/guard_cli.mjs   (reads one JSON object on stdin: { reply, declared, lastOwner } or { normalize })
import { checkReply, normalizeTranscript } from "../site/lib/engine.js";

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    console.error("Usage: echo '{\"reply\":\"...\",\"declared\":\"two million\"}' | node chain/guard_cli.mjs");
    process.exit(2);
  }
  if (input.normalize !== undefined) console.log(JSON.stringify({ text: normalizeTranscript(input.normalize) }));
  else console.log(JSON.stringify(checkReply(input.reply, { declared: input.declared, lastOwner: input.lastOwner })));
});
