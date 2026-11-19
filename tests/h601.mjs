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
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "h601-"));
process.chdir(CWD);
const mod = await jiti.import(path.join(HOME, ".pi", "agent", "extensions", "goal.ts"));
const tools = {};
let cmd = null;
const pi = { on: () => () => {}, registerCommand: (n, d) => { if (n === "goal") cmd = d; }, registerTool: (d) => { if (d?.name) tools[d.name] = d; }, registerEntryRenderer: () => {}, registerShortcut: () => {}, registerFlag: () => {}, getFlag: () => undefined, appendEntry: () => {}, sendMessage: () => {}, sendUserMessage: () => {}, exec: async () => ({ stdout: "" }), events: { on: () => {}, emit: () => {} } };
await mod.default(pi);
const notes = [];
const ctx = { hasUI: true, mode: "tui", isIdle: () => true, cwd: CWD, sessionManager: { getBranch: () => [] }, ui: { notify: (m) => notes.push(String(m)), setStatus: () => {}, theme: { fg: (c,t)=>String(t), bold:(t)=>String(t) } } };
const outNL = () => notes.filter((n) => !n.startsWith(String.fromCharCode(27))).join(NLc);

// h601: readTaskFile hardening battery - the shared bounded task read under hostile shapes.
const inbox = path.join(CWD, "goal-inbox");
fs.mkdirSync(inbox, { recursive: true });
// T1: a hostile DIRECTORY named like a task file ('TASK-...md' as a dir):
fs.mkdirSync(path.join(inbox, "TASK-2026-11-19-dirit.md"), { recursive: true });
// T2: a normal task alongside:
fs.writeFileSync(path.join(inbox, "TASK-2026-11-19-good.md"), "---" + NLc + "id: TASK-good" + NLc + "status: open" + NLc + "title: good row" + NLc + "priority: medium" + NLc + "---" + NLc + "body");
// T3: a hostile ASK whose -answer is a DIRECTORY:
fs.writeFileSync(path.join(inbox, "ASK-2026-11-19-dirans.md"), "Q");
fs.mkdirSync(path.join(inbox, "ASK-2026-11-19-dirans-answer.md"), { recursive: true });
// T4: a legit ask + answer pair so the answer-latest path still works with dir-answer present:
fs.writeFileSync(path.join(inbox, "ASK-2026-11-19-real.md"), "Q");
fs.writeFileSync(path.join(inbox, "ASK-2026-11-19-real-answer.md"), "---" + NLc + "title: REAL ANSWER OK" + NLc + "---" + NLc + "A");

notes.length = 0;
await cmd.handler("tasks", ctx);
const tOut = outNL();
check("T1_dir_task_no_throw", tOut.length > 0 && !tOut.includes("could not"));
check("T1b_legit_task_still_listed", tOut.includes("good row"));
check("T1c_dir_task_not_a_row", !tOut.includes("dirit"));

// the asks view (fleet asks reads via the enumerator -> use local probes: run the arm with the pin):
const sessRoot = path.join(HOME, ".pi", "agent", "sessions");
const pin = path.join(sessRoot, "--C--h601pin--");
fs.mkdirSync(pin, { recursive: true });
fs.writeFileSync(path.join(pin, "2020-01-01T00-00-00Z_x.jsonl"), JSON.stringify({ type: "session", id: "s", cwd: CWD }) + NLc);
notes.length = 0;
await cmd.handler("fleet asks", ctx);
const aOut = outNL();
const rowPin = aOut.split(NLc).find((l) => l.includes("h601pin")) || "MISSING";
check("T2_ask_arm_survives_dir_answer", aOut.length > 0 && !aOut.includes("could not render"));
check("T2b_open_exact_with_dir_answer", /1 open/.test(rowPin)); // only the dir-answer ask is open (TASK-* files are not asks; real ask is answered)
check("T2c_real_answer_shown", /REAL ANSWER OK/.test(aOut));
fs.rmSync(pin, { recursive: true, force: true });
// cleanup sandbox:
try { fs.rmSync(CWD, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {}
for (const l of LOG) console.log(l);
process.exit(0);
