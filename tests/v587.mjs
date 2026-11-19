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
// v587: the diary restore battery - 583-incident replay through the OPERATOR COMMAND:
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "v587-"));
process.chdir(CWD);
const mod = await jiti.import(path.join(HOME, ".pi", "agent", "extensions", "goal.ts"));
let cmd = null;
const tools = {};
const pi = { on: () => () => {}, registerCommand: (n, d) => { if (n === "goal") cmd = d; }, registerTool: (d) => { if (d?.name) tools[d.name] = d; }, registerEntryRenderer: () => {}, registerShortcut: () => {}, registerFlag: () => {}, getFlag: () => undefined, appendEntry: () => {}, sendMessage: () => {}, sendUserMessage: () => {}, exec: async () => ({ stdout: "" }), events: { on: () => {}, emit: () => {} } };
await mod.default(pi);
const notes = [];
const ctx = { hasUI: true, mode: "tui", isIdle: () => true, cwd: CWD, sessionManager: { getBranch: () => [] }, ui: { notify: (m) => notes.push(String(m)), setStatus: () => {}, theme: { fg: (c,t)=>String(t), bold:(t)=>String(t) } } };
const outNL = () => notes.filter((n) => !n.startsWith(String.fromCharCode(27))).join(NLc);
const dayFile = path.join(CWD, "goal-diary", "2026-11-19.md");

// seed: 3 entries + let the ring build bak-0 (age it to force a rotation cycle):
await tools.diary.execute("c1", { action: "write", title: "v587 original A", what: "x", how: "x", why: "y", kind: "work" }, ctx);
await tools.diary.execute("c2", { action: "write", title: "v587 original B", what: "x", how: "x", why: "y", kind: "work" }, ctx);
const bak0 = dayFile + ".bak-0";
check("P1_ring_seeded", fs.existsSync(bak0));

// T1: bare 'restore' lists slots:
notes.length = 0;
await cmd.handler("diary restore", ctx);
const listOut = outNL();
check("T1_lists_slots", listOut.includes("bak-0") && listOut.includes("recorded data"));
// T2: malformed slot name refused:
notes.length = 0;
await cmd.handler("diary restore nonsense", ctx);
check("T2_malformed_refused", outNL().includes("slot must look like"));
// T3: nonexistent slot (valid shape) refused honestly:
notes.length = 0;
await cmd.handler("diary restore 2026-11-19.md.bak-2", ctx);
check("T3_missing_slot_refused", outNL().includes("no slot"));
// T4: THE 583 REPLAY: destroy the live file, restore from bak-0:
fs.writeFileSync(dayFile, "DESTROYED");
notes.length = 0;
await cmd.handler("diary restore 2026-11-19.md.bak-0", ctx);
const resOut = outNL();
check("T4_restore_recovered", /recovered 1 entries/.test(resOut)); // bak-0 is the array-of-first-write snapshot; entry B came after (hourly gate)
check("T4b_crashed_preserved", (fs.readdirSync(path.join(CWD, "goal-diary"))).some(f => f.includes(".crashed-")));
const dayTxt = fs.readFileSync(dayFile, "utf8");
check("T4c_first_entry_back", dayTxt.includes("v587 original A")); // B is post-snapshot: correctly absent from the restore (the .crashed copy has it)
check("T4d_destroyed_gone", !dayTxt.includes("DESTROYED"));
// T5: no-slot workspace is honest (fresh sandbox CWD):
const CWD2 = fs.mkdtempSync(path.join(os.tmpdir(), "v587b-"));
const ctx2 = { ...ctx, cwd: CWD2 };
notes.length = 0;
await cmd.handler("diary restore", ctx2);
check("T5_dirless_honest", outNL().includes("no diary directory"));
fs.rmSync(CWD2, { recursive: true, force: true });
// T6: diary health after restore:
notes.length = 0;
await cmd.handler("diary doctor", ctx);
check("T6_doctor_green", /healthy|parseable/.test(outNL()));
for (const d of [CWD, CWD2]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {} }
for (const l of LOG) console.log(l);
process.exit(0);
