// Conform hand-written diary entries to the parser format, then verify.
// Run after ANY non-tool diary write:  node conform-diary.mjs [goal-diary-dir]
// (born from the recurring --- vs em-dash incidents; use the diary tool when possible)
import * as fs from "node:fs";
import * as path from "node:path";
const dir = process.argv[2] ?? "goal-diary";
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  console.error("Not a readable diary directory: " + dir);
  process.exit(2);
}
// Alias guard (pentest round 18, verified: a junction/symlink made this repair WRITE
// VICTIM CONTENT through the link): refuse to operate through an aliased diary dir -
// the same invariant the extension carries. Per-file links are skipped below.
try {
  if (fs.lstatSync(dir).isSymbolicLink()) {
    console.error("Refusing: the diary directory is a symlink/junction: " + dir);
    process.exit(2);
  }
} catch {
  /* lstat of an existing dir won't throw; nothing to do */
}
const EM = String.fromCharCode(8212);
const BS = String.fromCharCode(92);
const headingOk = new RegExp("^## " + BS + "d{2}:" + BS + "d{2} " + EM + " .*$");
let fixed = 0;
const problems = [];
for (const name of fs.readdirSync(dir).sort().reverse()) {
  if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
  const fp = path.join(dir, name);
  // File-level alias (day-file link, same class as the extension's round 12): skip.
  try {
    if (fs.lstatSync(fp).isSymbolicLink()) {
      problems.push(name + ": aliased day file - skipped");
      continue;
    }
  } catch {
    continue; // unreadable: nothing to conform
  }
  const text = fs.readFileSync(fp, "utf8");
  let fixedThisFile = false;
  let out = text
    .split(/\r?\n/)
    .map((line) => {
      // Repair ONLY the malformed time-title separator (## HH:MM --- ...): a bare
      // contains-check corrupted legitimate --- in title prose (verified false positive).
      const mr = /^(## \d{2}:\d{2}) ---+ (.*)$/.exec(line);
      if (line.startsWith("## ") && mr) {
        fixed++;
        fixedThisFile = true;
        return mr[1] + " " + EM + " " + mr[2];
      }
      return line;
    })
    .join("\r\n");
  if (!out.endsWith("\n")) {
    out += "\n";
    fixedThisFile = true;
    problems.push(name + ": appended missing trailing newline");
  }
  if (fixedThisFile || !text.endsWith("\n")) fs.writeFileSync(fp, out, "utf8");
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("## ") && !headingOk.test(line)) {
      problems.push(name + ": STILL unparseable heading: " + line.slice(0, 60));
    }
  }
}
console.log("headings repaired:", fixed);
console.log(problems.length ? "PROBLEMS:\n" + problems.join("\n") : "all headings parse");
process.exit(problems.length ? 1 : 0);
