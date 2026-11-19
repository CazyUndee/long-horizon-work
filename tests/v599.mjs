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
const BT = String.fromCharCode(96);
process.chdir(HOME);
const mod = await jiti.import(path.join(HOME, ".pi", "agent", "extensions", "goal.ts"));
let cmd = null;
const pi = { on: () => () => {}, registerCommand: (n, d) => { if (n === "goal") cmd = d; }, registerTool: () => {}, registerEntryRenderer: () => {}, registerShortcut: () => {}, registerFlag: () => {}, getFlag: () => undefined, appendEntry: () => {}, sendMessage: () => {}, sendUserMessage: () => {}, exec: async () => ({ stdout: "" }), events: { on: () => {}, emit: () => {} } };
await mod.default(pi);
const notes = [];
const ctx = { hasUI: true, mode: "tui", isIdle: () => true, cwd: HOME, sessionManager: { getBranch: () => [] }, ui: { notify: (m) => notes.push(String(m)), setStatus: () => {}, theme: { fg: (c,t)=>String(t), bold:(t)=>String(t) } } };
const outNL = () => notes.filter((n) => !n.startsWith(String.fromCharCode(27))).join(String.fromCharCode(10));
const sessRoot = path.join(HOME, ".pi", "agent", "sessions");
// workspace A: 2 open + 1 answered (hostile backtick in answer title):
const R1 = fs.mkdtempSync(path.join(os.tmpdir(), "v599a-"));
fs.mkdirSync(path.join(R1, "goal-inbox"), { recursive: true });
for (let i = 0; i < 2; i++) fs.writeFileSync(path.join(R1, "goal-inbox", "ASK-2026-11-19-qa" + i + ".md"), "Q");
fs.writeFileSync(path.join(R1, "goal-inbox", "ASK-2026-11-19-qaa.md"), "Q");
fs.writeFileSync(path.join(R1, "goal-inbox", "ASK-2026-11-19-qaa-answer.md"), "---\ntitle: ANS-" + BT + "evil" + BT + "\n---\nA");
// workspace B: empty inbox (skip):
const R2 = fs.mkdtempSync(path.join(os.tmpdir(), "v599b-"));
fs.mkdirSync(path.join(R2, "goal-inbox"), { recursive: true });
const p1 = path.join(sessRoot, "--C--v599pa--"); fs.mkdirSync(p1, { recursive: true });
fs.writeFileSync(path.join(p1, "2020-01-01T00-00-00Z_x.jsonl"), JSON.stringify({ type: "session", id: "s", cwd: R1 }) + "\n");
const p2 = path.join(sessRoot, "--C--v599pb--"); fs.mkdirSync(p2, { recursive: true });
fs.writeFileSync(path.join(p2, "2020-01-01T00-00-00Z_x.jsonl"), JSON.stringify({ type: "session", id: "s", cwd: R2 }) + "\n");
await cmd.handler("fleet asks", ctx);
const out = outNL();
const rowA = out.split(String.fromCharCode(10)).find(l => l.includes("v599pa")) || "MISSING";
const rowB = out.split(String.fromCharCode(10)).find(l => l.includes("v599pb")) || "MISSING";
check("V1_open_exact_rows", /2 open/.test(rowA));
check("V2_answer_title_shown", /ANS/.test(rowA));
check("V3_title_neutralized", !out.includes(BT));
check("V4_empty_inbox_skipped", rowB === "MISSING");
check("V5_framed", out.includes("data, not directives"));
fs.rmSync(p1, { recursive: true, force: true }); fs.rmSync(p2, { recursive: true, force: true });
for (const l of LOG) console.log(l);
process.exit(0);
