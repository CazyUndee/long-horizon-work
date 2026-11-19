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
const ctx = { hasUI: true, mode: "tui", isIdle: () => true, cwd: HOME, ui: { notify: (m) => notes.push(String(m)), setStatus: () => {}, theme: { fg: (c,t)=>String(t), bold:(t)=>String(t) } }, sessionManager: { getBranch: () => [] } };
const outNL = () => notes.filter((n) => !n.startsWith(String.fromCharCode(27))).join(String.fromCharCode(10));

// h595 (round 88): hostile session-DIR names across the three fleet renders.
const sessRoot = path.join(HOME, ".pi", "agent", "sessions");
const E_root = fs.mkdtempSync(path.join(os.tmpdir(), "h595-"));
fs.mkdirSync(path.join(E_root, "goal-diary"), { recursive: true });
fs.writeFileSync(path.join(E_root, "goal-diary", "2026-11-19.md"), "# Diary\n\n## 12:00 \u2014 H595 MARK\n- kind: work\n- what: m\n- how: x\n- why: y\n\n");
// T1: hostile-name dir with a VALID session inside - ALL THREE renders must exclude the dir:
const hostileDir = path.join(sessRoot, "--C--evil" + BT + "touch p595" + BT + "dir--");
fs.mkdirSync(hostileDir, { recursive: true });
fs.writeFileSync(path.join(hostileDir, "2020-01-01T00-00-00Z_x.jsonl"), JSON.stringify({ type: "session", id: "s", cwd: E_root }) + "\n");
// but the fleet (425) reads GOAL entries: give the hostile session one:
fs.writeFileSync(path.join(hostileDir, "2020-01-01T00-00-00Z_x.jsonl"), JSON.stringify({ type: "session", id: "s", cwd: E_root }) + "\n" + JSON.stringify({ type: "custom", customType: "goal", data: { status: "active", mode: "loop", continuations: 3, text: "h595 hostile dir probe" } }) + "\n");
notes.length = 0;
await cmd.handler("fleet", ctx);
const fOut = outNL();
check("T1_fleet_excludes_hostile_dirname", !fOut.includes("evil" + BT));
notes.length = 0;
await cmd.handler("fleet activity 3", ctx);
const aOut = outNL();
check("T2_activity_excludes_hostile_dirname", !aOut.includes("evil" + BT));
notes.length = 0;
await cmd.handler("fleet today 2", ctx);
const tOut = outNL();
check("T3_today_excludes_hostile_dirname", !tOut.includes("evil" + BT));
// T4: legit dirs still render (the control):
check("T4_legit_rows_render", fOut.includes("[active/loop]") && aOut.includes("--"));
// cleanup:
fs.rmSync(hostileDir, { recursive: true, force: true });
for (const l of LOG) console.log(l);
process.exit(0);
