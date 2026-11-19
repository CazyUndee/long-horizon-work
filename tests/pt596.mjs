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
const NL = String.fromCharCode(10);
const RS = String.fromCharCode(8217); // right-quote - the neutralized backtick
process.chdir(HOME);
const mod = await jiti.import(path.join(HOME, ".pi", "agent", "extensions", "goal.ts"));
let cmd = null;
const pi = { on: () => () => {}, registerCommand: (n, d) => { if (n === "goal") cmd = d; }, registerTool: () => {}, registerEntryRenderer: () => {}, registerShortcut: () => {}, registerFlag: () => {}, getFlag: () => undefined, appendEntry: () => {}, sendMessage: () => {}, sendUserMessage: () => {}, exec: async () => ({ stdout: "" }), events: { on: () => {}, emit: () => {} } };
await mod.default(pi);
const notes = [];
const ctx = { hasUI: true, mode: "tui", isIdle: () => true, cwd: HOME, ui: { notify: (m) => notes.push(String(m)), setStatus: () => {}, theme: { fg: (c,t)=>String(t), bold:(t)=>String(t) } }, sessionManager: { getBranch: () => [] } };
const outNL = () => notes.filter((n) => !n.startsWith(String.fromCharCode(27))).join(NL);

// pt596 (round 89): hostile diary TITLES in cross-workspace fleet rows.
const sessRoot = path.join(HOME, ".pi", "agent", "sessions");
const E_root = fs.mkdtempSync(path.join(os.tmpdir(), "pt596-"));
fs.mkdirSync(path.join(E_root, "goal-diary"), { recursive: true });
// hostile title carrying the full 584 set; + a SECOND legit-prose entry within the today window:
const now = new Date();
const hh = String(now.getHours()).padStart(2, "0");
const mm = String(now.getMinutes()).padStart(2, "0");
fs.writeFileSync(path.join(E_root, "goal-diary", "2026-11-19.md"),
  "# Diary" + NL + NL +
  "## " + hh + ":" + mm + " \u2014 PT596 " + BT + "touch r89" + BT + " %PATH% | danger; semi" + NL +
  "- kind: work" + NL + "- what: m" + NL + "- how: x" + NL + "- why: y" + NL + NL +
  "## " + hh + ":" + mm + " \u2014 PT596 prose; semicolons > kept; 95% surely" + NL +
  "- kind: work" + NL + "- what: m" + NL + "- how: x" + NL + "- why: y" + NL + NL);
const pin = path.join(sessRoot, "--C--pt596--");
fs.mkdirSync(pin, { recursive: true });
fs.writeFileSync(path.join(pin, "2020-01-01T00-00-00Z_x.jsonl"), JSON.stringify({ type: "session", id: "s", cwd: E_root }) + "\n");

notes.length = 0;
await cmd.handler("fleet activity 3", ctx);
const a = outNL();
const hostileRow = a.split(NL).find(l => l.includes("touch r89")) || "NONE";
check("T1_activity_no_backtick", !a.includes(BT));
check("T2_activity_row_present", hostileRow.length > 10); // hostile title still visible (neutralized)
notes.length = 0;
await cmd.handler("fleet today 2", ctx);
const tOut = outNL();
check("T3_today_no_backtick", !tOut.includes(BT));
const proseRow = tOut.split(NL).find(l => l.includes("semicolons")) || "NONE";
check("T4_prose_kept_verbatim", proseRow.includes("prose; semicolons > kept; 95% surely"));
const proseActivityRow = a.split(NL).find(l => l.includes("semicolons")) || "NONE";
check("T5_prose_in_activity_too", proseActivityRow.includes("95% surely"));

fs.rmSync(pin, { recursive: true, force: true });
for (const l of LOG) console.log(l);
process.exit(0);
