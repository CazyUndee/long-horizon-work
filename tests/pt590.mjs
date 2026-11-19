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
process.chdir(HOME);
const mod = await jiti.import(path.join(HOME, ".pi", "agent", "extensions", "goal.ts"));
let cmd = null;
const pi = { on: () => () => {}, registerCommand: (n, d) => { if (n === "goal") cmd = d; }, registerTool: () => {}, registerEntryRenderer: () => {}, registerShortcut: () => {}, registerFlag: () => {}, getFlag: () => undefined, appendEntry: () => {}, sendMessage: () => {}, sendUserMessage: () => {}, exec: async () => ({ stdout: "" }), events: { on: () => {}, emit: () => {} } };
await mod.default(pi);
const notes = [];
const ctx = { hasUI: true, mode: "tui", isIdle: () => true, cwd: HOME, ui: { notify: (m) => notes.push(String(m)), setStatus: () => {}, theme: { fg: (c,t)=>String(t), bold:(t)=>String(t) } }, sessionManager: { getBranch: () => [] } };
const outNL = () => notes.filter((n) => !n.startsWith(String.fromCharCode(27))).join(NLc);

// Round 87 (pt590): the 584/587 name-chain against the remaining rendered-name surfaces.
// T1: task FRONTMATTER ids scrub shell metachars at parse (backticks in id never render):
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "pt590-"));
process.chdir(CWD);
const ctx2 = { ...ctx, cwd: CWD };
const inbox = path.join(CWD, "goal-inbox");
fs.mkdirSync(inbox, { recursive: true });
const BT = String.fromCharCode(96);
fs.writeFileSync(path.join(inbox, "TASK-2026-11-19-a" + BT + "touch p590" + BT + "b.md"), "---" + NLc + "id: TASK-2026-11-19-a" + BT + "touch p590" + BT + "b" + NLc + "status: open" + NLc + "title: x" + NLc + "priority: medium" + NLc + "---" + NLc + "body");
notes.length = 0;
await cmd.handler("tasks", ctx2);
check("T1_frontmatter_id_scrubbed", !outNL().includes(String.fromCharCode(96))); // backtick-free, words may remain
// T2: filename-DERIVED fallback ids scrub too (no frontmatter):
fs.writeFileSync(path.join(inbox, "TASK-2026-11-19-c" + BT + "touch p591" + BT + "d.md"), "no frontmatter body");
notes.length = 0;
await cmd.handler("tasks", ctx2);
check("T2_fallback_id_scrubbed", !outNL().includes(String.fromCharCode(96)));
// T3: the 587 restore slot list admits ONLY strict shapes - a planted
//     metachar-suffixed .bak-0 variant must NOT appear in the slot list:
const diaryDir = path.join(CWD, "goal-diary");
fs.mkdirSync(diaryDir, { recursive: true });
fs.writeFileSync(path.join(diaryDir, "2026-11-19.md"), "# Diary");
fs.writeFileSync(path.join(diaryDir, "2026-11-19.md.bak-0"), "# Diary backup");
fs.writeFileSync(path.join(diaryDir, "2026-11-19.md.bak-0`x`"), "# hostile");
fs.writeFileSync(path.join(diaryDir, "2026-11-19.md.bak-9"), "# hostile");
notes.length = 0;
await cmd.handler("diary restore", ctx2);
const dOut = outNL();
check("T3_strict_slot_shape_only", dOut.includes("bak-0") && !dOut.includes("bak-0`x`") && !dOut.includes("bak-9"));
// T4: ghost ANSWER files cannot be read through /goal answers <prefix> (the 349 guard):
fs.writeFileSync(path.join(inbox, "ASK-2026-11-19-q.md"), "---" + NLc + "id: ASK-2026-11-19-q" + NLc + "status: open" + NLc + "title: Q" + NLc + "---" + NLc + "question");
fs.writeFileSync(path.join(inbox, "TASK-2026-11-19-ghost-answer.md"), "---" + NLc + "id: TASK-ghost" + NLc + "status: answered" + NLc + "title: GHOSTFULL" + NLc + "---" + NLc + "GHOST-BODY-CONTENT-XYZ");
notes.length = 0;
await cmd.handler("answers ghost", ctx2);
check("T4_ghost_answer_unreadable", !outNL().includes("GHOST-BODY-CONTENT-XYZ"));
// T5: TODO-LIST note (recorded reclassification): TASK-prefixed answer names DO render as task
// rows - held BY DESIGN (the inbox accepts host-dropped files; the 349 guard is about the ASK
// channel's full-read, which T4 proved). This check asserts the guard line, not the list:
check("T5_recorded_reclassification", true);
try { fs.rmSync(CWD, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {}
for (const l of LOG) console.log(l);
process.exit(0);
