import * as fs from "node:fs"; import * as path from "node:path"; import * as os from "node:os";
import { createRequire } from "node:module";
const _require = createRequire(process.env.HOME + "/.pi/agent/install/releases/1.3.0/package.json");
const { createJiti } = _require("jiti");
const NM = process.env.HOME + "/.pi/agent/install/releases/1.3.0/node_modules";
const jiti = createJiti(import.meta.url, { fsCache: true, alias: {
  "@earendil-works/pi-coding-agent": NM + "/@earendil-works/pi-coding-agent/dist/index.js",
  "@earendil-works/pi-ai": NM + "/@earendil-works/pi-ai/dist/compat.js",
  "@earendil-works/pi-tui": NM + "/@earendil-works/pi-tui/dist/index.js",
  typebox: NM + "/typebox/build/index.mjs",
}});
const LOG = [];
function check(label, cond) { LOG.push(label + "=" + (cond ? "PASS" : "FAIL")); }
const HOME = os.homedir();
const sessRoot = path.join(HOME, ".pi", "agent", "sessions");
const NLc = String.fromCharCode(10);
process.chdir(HOME);
const mod = await jiti.import(path.join(HOME, ".pi", "agent", "extensions", "goal.ts"));
let cmd = null;
const pi = { on: () => () => {}, registerCommand: (n, d) => { if (n === "goal") cmd = d; }, registerTool: () => {}, registerEntryRenderer: () => {}, registerShortcut: () => {}, registerFlag: () => {}, getFlag: () => undefined, appendEntry: () => {}, sendMessage: () => {}, sendUserMessage: () => {}, exec: async () => ({ stdout: "" }), events: { on: () => {}, emit: () => {} } };
await mod.default(pi);
const notes = [];
const ctx = { hasUI: true, mode: "tui", isIdle: () => true, cwd: HOME, ui: { notify: (m) => notes.push(String(m)), setStatus: () => {}, theme: { fg: (c,t)=>String(t), bold:(t)=>String(t) } }, sessionManager: { getBranch: () => [] } };
const outNL = () => notes.filter((n) => !n.startsWith(String.fromCharCode(27))).join(NLc);

// H583: hostile session-head cwd shapes feeding /goal fleet activity:
// build a pin session dir whose newest session's head line carries a hostile cwd, each with a
// REAL goal-diary to make the exfil visible if unguarded:
const mkPin = (name, cwdValue, diaryEntries) => {
  const d = path.join(sessRoot, "--C--" + name + "--");
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, "2020-01-01T00-00-00Z_x.jsonl");
  fs.writeFileSync(f, JSON.stringify({ type: "session", id: "s", cwd: cwdValue }) + NLc);
  // the goal-diary the hostile cwd points at:
  if (cwdValue) {
    const dd = path.join(cwdValue, "goal-diary");
    try {
      fs.mkdirSync(dd, { recursive: true });
      const day = "# Diary" + NLc + NLc + "## 12:00 \u2014 EXFIL " + name + NLc + "- kind: work" + NLc + "- what: secret-marker-" + name + NLc + "- how: x" + NLc + "- why: h583" + NLc + NLc;
      fs.writeFileSync(path.join(dd, "2026-11-19.md"), day);
    } catch {}
  }
  return d;
};
// A - traversal to Windows dir with a planted goal-diary (readable dir; planting in Windows dir
// may fail due to perms -> use a temp location with ..-traversal instead):
const A_root = fs.mkdtempSync(path.join(os.tmpdir(), "h583a-"));
// A hostile cwd: HOME-sibling via ..: resolves OUTSIDE the pin root but to a REAL dir we planted:
const hostileA = A_root + path.sep + ".." + path.sep + "h583a-victim";
fs.mkdirSync(path.join(A_root, "h583a-victim", "goal-diary"), { recursive: true });
fs.writeFileSync(path.join(A_root, "h583a-victim", "goal-diary", "2026-11-19.md"),
  "# Diary" + NLc + NLc + "## 12:00 \u2014 EXFIL A" + NLc + "- kind: work" + NLc + "- what: secret-marker-A" + NLc + "- how: x" + NLc + "- why: h583" + NLc + NLc);
mkPin("h583a", hostileA);
// B - UNC path (network-IO attempt):
mkPin("h583b", "\\\\some-host\\share\\proj");
// C - relative cwd:
mkPin("h583c", "relative/dir");
// D - cwd with embedded NUL/escape text (JSON can encode \u0000):
mkPin("h583d", "C:\\x\u0000y");
// E - control (a LEGIT local cwd: this HOME - already has a real diary):
const E_root = fs.mkdtempSync(path.join(os.tmpdir(), "h583e-"));
  fs.mkdirSync(path.join(E_root, "goal-diary"), { recursive: true });
  fs.writeFileSync(path.join(E_root, "goal-diary", "2026-11-19.md"), "# Diary" + NLc + NLc + "## 12:00 — EXFIL controlE" + NLc + "- kind: work" + NLc + "- what: secret-marker-e" + NLc + "- how: x" + NLc + "- why: h583" + NLc + NLc);
  mkPin("h583e", E_root.split(String.fromCharCode(92)).join("/"));

await cmd.handler("fleet activity", ctx);
const o = outNL();
check("E_control_renders", o.includes("EXFIL"));
const rowsWithPins = /--C--h583/.test(o);
// today, pre-fix, expect A's exfil visible:
console.log("DUMP_visited=" + JSON.stringify((o.split(NLc).filter(l => l.includes("h583a")).join(" | ")).slice(0, 200)));
check("A_traversal_blocked", !o.includes("EXFIL h583a"));
for (const d of ["--C--h583a--", "--C--h583b--", "--C--h583c--", "--C--h583d--", "--C--h583e--"]) { try { fs.rmSync(path.join(sessRoot, d), { recursive: true, force: true }); } catch {} }
try { fs.rmSync(A_root, { recursive: true, force: true }); } catch {}
try { fs.rmSync(E_root, { recursive: true, force: true }); } catch {}
for (const l of LOG) console.log(l);
process.exit(0);
