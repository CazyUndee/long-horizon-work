// Cycle 250 reliability battery: concurrent inbox mutation vs answers reader.
// 2 writer processes create/answer/delete ASK files in a loop while this reader runs
// /goal answers 60 times; the reader must never throw and never render a secret planted
// by a writer (scrub must hold under mutation).
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "race250-"));
const CHILD = `
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
const NLC = String.fromCharCode(10);
const CWD = process.argv[2];
process.chdir(CWD);
const mod = await jiti.import(os.homedir() + "/.pi/agent/extensions/goal.ts");
let cmd = null;
const fakeCtx = { hasUI: false, mode: "tui", isIdle: () => true, cwd: CWD,
  ui: { notify: () => {}, setStatus: () => {}, theme: { fg:(c,t)=>String(t), bg:(c,t)=>String(t), bold:(t)=>String(t) } },
  sessionManager: { getBranch: () => [] } };
const pi = { on: () => () => {}, registerCommand: (n, d) => { if (n === "goal") cmd = d; },
  registerTool: () => {}, registerEntryRenderer: () => {}, registerShortcut: () => {}, registerFlag: () => {},
  getFlag: () => undefined, appendEntry: () => {}, sendMessage: () => {}, sendUserMessage: () => {},
  exec: async () => ({ stdout: "" }), events: { on: () => () => {}, emit: () => {} } };
await mod.default(pi);
const KEY = "sk-ant-api03-R250W" + process.argv[3] + "X" + "A".repeat(20);
const inbox = path.join(CWD, "goal-inbox");
for (let round = 0; round < 40; round++) {
  const name = "ASK-2026-01-01-w" + process.argv[3] + "r" + round + "-q";
  fs.writeFileSync(path.join(inbox, name + ".md"), "---" + NLC + "id: " + name + NLC + "title: leak " + KEY + NLC + "status: open" + NLC + "---" + NLC + NLC + "body" + NLC);
  fs.writeFileSync(path.join(inbox, name + "-answer.md"), "ans " + KEY + NLC);
  // half the time delete the pair again (race the reader's readdir):
  if (round % 2 === 0) {
    try { fs.unlinkSync(path.join(inbox, name + ".md")); } catch {}
    try { fs.unlinkSync(path.join(inbox, name + "-answer.md")); } catch {}
  }
}
process.exit(0);
`;
const childPath = path.join(CWD, "writer.mjs");
fs.writeFileSync(childPath, CHILD);
fs.mkdirSync(path.join(CWD, "goal-inbox"), { recursive: true });

const writers = await Promise.all([0, 1].map((id) => new Promise((res) => {
  const c = spawn(process.execPath, [childPath, CWD, String(id)], { stdio: ["ignore", "inherit", "inherit"] });
  c.on("exit", (code) => { if (code !== 0) { try { console.error("WRITER FILE DUMP ON FAILURE, line 27-31:"); const ls = fs.readFileSync(childPath, "utf8").split(String.fromCharCode(10)); for (let k = 26; k < 32; k++) console.error((k+1) + " " + JSON.stringify(ls[k])); } catch {} } });
  c.on("exit", (code) => res(code));
})));

// Reader (this process): load the ext and hammer /goal answers.
const { createRequire } = await import("node:module");
const _require = createRequire(process.env.HOME + "/.pi/agent/install/releases/1.3.0/package.json");
const { createJiti } = _require("jiti");
const NM = process.env.HOME + "/.pi/agent/install/releases/1.3.0/node_modules";
const jiti = createJiti(import.meta.url, { fsCache: true, alias: {
  "@earendil-works/pi-coding-agent": NM + "/@earendil-works/pi-coding-agent/dist/index.js",
  "@earendil-works/pi-ai": NM + "/@earendil-works/pi-ai/dist/compat.js",
  "@earendil-works/pi-tui": NM + "/@earendil-works/pi-tui/dist/index.js",
  typebox: NM + "/typebox/build/index.mjs",
}});
process.chdir(CWD);
const mod = await jiti.import(os.homedir() + "/.pi/agent/extensions/goal.ts");
let cmd = null;
let crashed = false, secretLeak = false;
const KEY_RE = /sk-ant-api03-R250W[01]X/;
const fakeCtx = { hasUI: true, mode: "tui", isIdle: () => true, cwd: CWD,
  ui: { notify: (m) => { const s = String(m); if (KEY_RE.test(s)) secretLeak = true; }, setStatus: () => {},
    theme: { fg:(c,t)=>String(t), bg:(c,t)=>String(t), bold:(t)=>String(t) } },
  sessionManager: { getBranch: () => [] } };
const pi = { on: () => () => {}, registerCommand: (n, d) => { if (n === "goal") cmd = d; },
  registerTool: () => {}, registerEntryRenderer: () => {}, registerShortcut: () => {}, registerFlag: () => {},
  getFlag: () => undefined, appendEntry: () => {}, sendMessage: () => {}, sendUserMessage: () => {},
  exec: async () => ({ stdout: "" }), events: { on: () => () => {}, emit: () => {} } };
await mod.default(pi);
for (let i = 0; i < 60; i++) {
  try { await cmd.handler("answers", fakeCtx); } catch (e) { crashed = true; console.error("READER THREW:", String(e).slice(0, 100)); break; }
}
console.log("writers_exit=" + writers.join(","));
console.log("reader_crashed=" + crashed);
console.log("secret_leaked=" + secretLeak);
console.log("PASS=" + (!crashed && !secretLeak && writers.every((c) => c === 0)));
for (let i = 0; i < 10; i++) { try { fs.rmSync(CWD, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 300)); } }
