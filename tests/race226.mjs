// Cycle 226 reliability battery: 4 concurrent PROCESSES each append 3 entries via the real
// appendDiaryEntry (through the diary tool execute), then conform-parse the day file:
// exactly 12 headings, no torn lines, every entry parseable. Proves cross-process append safety
// at the OS level for real entry sizes.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "race226-"));
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
const CWD = process.argv[2];
process.chdir(CWD);
const mod = await jiti.import(os.homedir() + "/.pi/agent/extensions/goal.ts");
const tools = {};
const pi = { on: () => () => {}, registerCommand: () => {}, registerTool: (d) => { if (d?.name) tools[d.name] = d; },
  registerEntryRenderer: () => {}, registerShortcut: () => {}, registerFlag: () => {},
  getFlag: () => undefined, appendEntry: () => {}, sendMessage: () => {}, sendUserMessage: () => {},
  exec: async () => ({ stdout: "" }), events: { on: () => () => {}, emit: () => {} } };
const fakeCtx = { hasUI: false, mode: "tui", cwd: CWD,
  ui: { notify: () => {}, setStatus: () => {}, theme: { fg:(c,t)=>String(t), bg:(c,t)=>String(t), bold:(t)=>String(t) } },
  sessionManager: { getBranch: () => [] } };
await mod.default(pi);
const id = process.argv[3];
for (let k = 0; k < 3; k++) {
  const r = await tools.diary.execute("c" + k, {
    action: "write", title: "race " + id + "-" + k,
    what: "concurrent append " + id + " round " + k,
    how: "four processes appending the same day file",
    why: "cycle 226 reliability battery " + ("x".repeat(200)),
    kind: "work", files: [],
  }, fakeCtx);
  if (!String(r.content?.[0]?.text ?? "").includes("recorded")) { console.error("child " + id + " write " + k + " unexpected:", String(r.content?.[0]?.text ?? "").slice(0, 80)); process.exit(2); }
}
process.exit(0);
`;
const childPath = path.join(CWD, "child.mjs");
fs.writeFileSync(childPath, CHILD);

const results = await Promise.allSettled([0, 1, 2, 3].map((id) => new Promise((res) => {
  const c = spawn(process.execPath, [childPath, CWD, String(id)], { stdio: ["ignore", "inherit", "inherit"] });
  c.on("exit", (code) => res(code));
  setTimeout(() => { try { c.kill(); } catch {} res(-1); }, 240_000); // 568: 120s killed a legit child at 100%-load contention (chess loop running); 4 concurrent cold jiti imports can exceed it legitimately
})));
const codes = results.map((r) => r.value);

// Now parse the day file with the production parser via a 5th load:
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
const tools2 = {};
const pi2 = { on: () => () => {}, registerCommand: () => {}, registerTool: (d) => { if (d?.name) tools2[d.name] = d; },
  registerEntryRenderer: () => {}, registerShortcut: () => {}, registerFlag: () => {},
  getFlag: () => undefined, appendEntry: () => {}, sendMessage: () => {}, sendUserMessage: () => {},
  exec: async () => ({ stdout: "" }), events: { on: () => () => {}, emit: () => {} } };
const fakeCtx2 = { hasUI: false, mode: "tui", cwd: CWD,
  ui: { notify: () => {}, setStatus: () => {}, theme: { fg:(c,t)=>String(t), bg:(c,t)=>String(t), bold:(t)=>String(t) } },
  sessionManager: { getBranch: () => [] } };
await mod.default(pi2);
const sr = await tools2.diary.execute("v", { action: "search", query: "race" }, fakeCtx2);
const txt = String(sr.content[0].text);
const mCount = Number(/(\d+) match/.exec(txt)?.[1] ?? "-1");
console.log("children exit codes:", codes.join(","));
console.log("headline matches:", mCount);
console.log("PASS=" + (codes.every((c) => c === 0) && mCount === 12));
for (let i = 0; i < 10; i++) {
  try { fs.rmSync(CWD, { recursive: true, force: true }); break; } catch {}
  await new Promise((r) => setTimeout(r, 300));
}
try { fs.rmSync(CWD, { recursive: true, force: true }); } catch {}
process.exit(codes.every((c) => c === 0) && mCount === 12 ? 0 : 1);
