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
const NLc = String.fromCharCode(10);
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CR = String.fromCharCode(13);
process.chdir(HOME);
const mod = await jiti.import(path.join(HOME, ".pi", "agent", "extensions", "goal.ts"));
let cmd = null;
const pi = { on: () => () => {}, registerCommand: (n, d) => { if (n === "goal") cmd = d; }, registerTool: () => {}, registerEntryRenderer: () => {}, registerShortcut: () => {}, registerFlag: () => {}, getFlag: () => undefined, appendEntry: () => {}, sendMessage: () => {}, sendUserMessage: () => {}, exec: async () => ({ stdout: "" }), events: { on: () => {}, emit: () => {} } };
await mod.default(pi);
const notes = [];
const ctx = { hasUI: true, mode: "tui", isIdle: () => true, cwd: HOME, sessionManager: { getBranch: () => [] }, ui: { notify: (m) => notes.push(String(m)), setStatus: () => {}, theme: { fg: (c,t)=>String(t), bold:(t)=>String(t) } } };
const allOf = () => notes.join("|");
const sessRoot = path.join(HOME, ".pi", "agent", "sessions");

// Round 90: the C0/OSC double-net over every cross-workspace title render.
// W1: hostile diary title (today + activity renders):
const R1 = fs.mkdtempSync(path.join(os.tmpdir(), "pt602-"));
fs.mkdirSync(path.join(R1, "goal-diary"), { recursive: true });
fs.writeFileSync(path.join(R1, "goal-diary", "2026-11-19.md"),
  "# Diary" + NLc + NLc + "## 23:59 \u2014 PT602 " + ESC + "]777;notify;d" + BEL + "X" + CR + "R" + NLc +
  "- kind: work" + NLc + "- what: m" + NLc + "- how: x" + NLc + "- why: y" + NLc + NLc);
// W2: hostile answer title (asks render):
const R2 = fs.mkdtempSync(path.join(os.tmpdir(), "pt602b-"));
fs.mkdirSync(path.join(R2, "goal-inbox"), { recursive: true });
fs.writeFileSync(path.join(R2, "goal-inbox", "ASK-2026-11-19-z.md"), "Q");
fs.writeFileSync(path.join(R2, "goal-inbox", "ASK-2026-11-19-z-answer.md"), "---" + NLc + "title: A" + ESC + "]777;notify;a" + BEL + "B" + CR + "C" + NLc + "---" + NLc + "A");
const pin = (name, cwd) => { const d = path.join(sessRoot, "--C--" + name + "--"); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "2020-01-01T00-00-00Z_x.jsonl"), JSON.stringify({ type: "session", id: "s", cwd }) + NLc); };
pin("pt602w1", R1);
pin("pt602w2", R2);
notes.length = 0;
await cmd.handler("fleet today 24", ctx);
check("W1_today_no_ESC", !allOf().includes(ESC));
check("W1b_today_no_CR", !allOf().includes(CR));
notes.length = 0;
await cmd.handler("fleet activity 3", ctx);
check("W2_activity_no_ESC", !allOf().includes(ESC));
check("W2b_activity_no_BEL", !allOf().includes(BEL));
notes.length = 0;
await cmd.handler("fleet asks", ctx);
check("W3_asks_no_ESC", !allOf().includes(ESC));
check("W3b_asks_no_BEL", !allOf().includes(BEL));
// control: a clean workspace's rows still render (channel not degraded to empty by the hostile neighbors):
fs.rmSync(path.join(sessRoot, "--C--pt602w1--"), { recursive: true, force: true });
fs.rmSync(path.join(sessRoot, "--C--pt602w2--"), { recursive: true, force: true });
const R3 = fs.mkdtempSync(path.join(os.tmpdir(), "pt602c-"));
fs.mkdirSync(path.join(R3, "goal-diary"), { recursive: true });
fs.writeFileSync(path.join(R3, "goal-diary", "2026-11-19.md"), "# Diary" + NLc + NLc + "## 23:59 \u2014 CLEANOK title" + NLc + "- kind: work" + NLc + "- what: m" + NLc + "- how: x" + NLc + "- why: y" + NLc + NLc);
pin("pt602w3", R3);
notes.length = 0;
await cmd.handler("fleet today 24", ctx);
check("W4_clean_still_renders", allOf().includes("CLEANOK"));
fs.rmSync(path.join(sessRoot, "--C--pt602w3--"), { recursive: true, force: true });
for (const l of LOG) console.log(l);
process.exit(0);
