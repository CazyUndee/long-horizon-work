// crlf-install.cjs - the standardized goal.ts installer (cycle 534).
// The rule, learned the hard way (467: six failed rounds; 522/523/525 escape-eater; 533: 5793 bare LFs):
// 1. NEVER hand-roll string splices in python heredocs - require() THIS file and use its helpers.
// 2. Every write goes through saveGoalTS(), which:
//    - reads the file, splits on \r\n, accepts whole-line insert/replaces/indices,
//    - ALWAYS writes back \r\n-joined text (CRLF invariant held by construction, not by gate),
//    - refuses if the resulting text holds a bare LF (gate-checked BEFORE write).
// 3. The user of this module composes lines; this module owns the file discipline.
// Usage:
//   const { load, save, insertBefore, insertAfter, replaceLine, nextIdx } = require("./crlf-install.cjs");
//   const lines = load(); insertAfter(lines, idx, "...line..."); save(lines);
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const GOAL = path.join(os.homedir(), ".pi", "agent", "extensions", "goal.ts");
const NL = "\r\n";

function load() {
  const t = fs.readFileSync(GOAL, "utf8");
  return t.split(NL);
}

function save(lines) {
  const text = lines.join(NL);
  if (/(?<!\r)\n/.test(text)) {
    throw new Error("crlf-install: bare LF in composed text - refusing to write (compose whole lines)");
  }
  fs.writeFileSync(GOAL, text);
  return { bytes: Buffer.byteLength(text), lines: lines.length };
}

/** find a single line by exact or predicate match; throws if not found or not unique */
function findLine(lines, match) {
  const idxs = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (typeof match === "function" ? match(ln, i) : ln.includes(match)) idxs.push(i);
  }
  if (idxs.length === 0) throw new Error("crlf-install: line not found: " + String(match).slice(0, 60));
  if (idxs.length > 1) throw new Error("crlf-install: ambiguous (" + idxs.length + " matches): " + String(match).slice(0, 60));
  return idxs[0];
}

function insertAfter(lines, idx, block) {
  const arr = Array.isArray(block) ? block : [block];
  lines.splice(idx + 1, 0, ...arr);
  return idx + arr.length;
}
function insertBefore(lines, idx, block) {
  const arr = Array.isArray(block) ? block : [block];
  lines.splice(idx, 0, ...arr);
  return idx + arr.length;
}
function replaceLine(lines, idx, newline) {
  lines[idx] = newline;
  return idx + 1;
}

module.exports = { GOAL, NL, load, save, findLine, insertAfter, insertBefore, replaceLine };
