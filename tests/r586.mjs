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
// r586: day-file backup ring battery (sandbox cwd only - the 583 lesson):
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "r586-"));
process.chdir(CWD);
const mod = await jiti.import(path.join(HOME, ".pi", "agent", "extensions", "goal.ts"));
const tools = {};
const pi = { on: () => () => {}, registerCommand: () => {}, registerTool: (d) => { if (d?.name) tools[d.name] = d; }, registerEntryRenderer: () => {}, registerShortcut: () => {}, registerFlag: () => {}, getFlag: () => undefined, appendEntry: () => {}, sendMessage: () => {}, sendUserMessage: () => {}, exec: async () => ({ stdout: "" }), events: { on: () => {}, emit: () => {} } };
await mod.default(pi);
const ctx = { hasUI: true, mode: "tui", isIdle: () => true, cwd: CWD, sessionManager: { getBranch: () => [] }, ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (c,t)=>String(t), bold:(t)=>String(t) } } };
const w = async (title, i) => tools.diary.execute("c586" + i, { action: "write", title: title, what: "x", how: "x", why: "y", kind: "work" }, ctx);
const dayFile = path.join(CWD, "goal-diary", "2026-11-19.md");

// R1: first write creates bak-0:
await w("first entry", 1);
check("R1_bak0_created", fs.existsSync(dayFile + ".bak-0"));
const bak0Size1 = fs.statSync(dayFile + ".bak-0").size;
// R2: second write within the hour does NOT change bak-0 (ring fresh):
await w("second entry", 2);
check("R2_hourly_gate_stable", fs.statSync(dayFile + ".bak-0").size === bak0Size1);
// R3: age bak-0 backwards >1h, write -> ring rotates: bak-1 exists (old bak-0), bak-0 fresh:
const HOUR = 3_600_000;
const old = new Date(Date.now() - 2 * HOUR);
fs.utimesSync(dayFile + ".bak-0", old, old);
await w("third entry", 3);
check("R3_bak1_rotated", fs.existsSync(dayFile + ".bak-0") && fs.existsSync(dayFile + ".bak-1"));
check("R3b_bak1_is_old_ring", fs.statSync(dayFile + ".bak-1").size === bak0Size1);
check("R3c_bak0_is_fresh", fs.statSync(dayFile + ".bak-0").size === fs.statSync(dayFile).size);
// R4: two more agings -> bak-2 present (ring depth 3):
for (let k = 0; k < 2; k++) {
  const old2 = new Date(Date.now() - 2 * HOUR);
  fs.utimesSync(dayFile + ".bak-0", old2, old2);
  await w("aging entry " + k, 4 + k);
}
check("R4_ring_depth3", fs.existsSync(dayFile + ".bak-2"));
// R5 (SEMANTICS-CORRECT SPEC, 586 lesson): the backup call runs AFTER the append, so at an
// aged boundary with a new write the copy MUST happen (live drifted) - that is the feature.
// The no-copy case is the zero-writes hour (identical content), unreachable via the write
// action itself; instead simulate by calling appends NOT at all and re-verifying the mtime
// gate skipped (R2 proved it). Here: assert the boundary copy preserved the last-hour state:
const old3 = new Date(Date.now() - 2 * HOUR);
fs.utimesSync(dayFile + ".bak-0", old3, old3);
await w("boundary entry", 6);
const bak0txt2 = fs.readFileSync(dayFile + ".bak-0", "utf8");
check("R5_boundary_copy_captures_history", bak0txt2.includes("aging entry 1") && bak0txt2.includes("boundary entry"));
check("R5b_ring_rotated_on_boundary", fs.statSync(dayFile + ".bak-1").size > 0);
// R6: crash-image: overwrite the live file (the 583 scenario) -> bak-0 still holds the last hour:
fs.writeFileSync(dayFile, "DESTROYED");
check("R6_backup_survives_overwrite", fs.readFileSync(dayFile + ".bak-0", "utf8").includes("aging entry"));
try { fs.rmSync(CWD, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {}
for (const l of LOG) console.log(l);
process.exit(0);
