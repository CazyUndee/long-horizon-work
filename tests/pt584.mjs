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
const notes = [];
const pi = { on: () => () => {}, registerCommand: (n, d) => { if (n === "goal") cmd = d; }, registerTool: () => {}, registerEntryRenderer: () => {}, registerShortcut: () => {}, registerFlag: () => {}, getFlag: () => undefined, appendEntry: () => {}, sendMessage: () => {}, sendUserMessage: () => {}, exec: async () => ({ stdout: "" }), events: { on: () => {}, emit: () => {} } };
await mod.default(pi);
const ctx = { hasUI: true, mode: "tui", isIdle: () => true, cwd: HOME, ui: { notify: (m) => notes.push(String(m)), setStatus: () => {}, theme: { fg: (c,t)=>String(t), bold:(t)=>String(t) } }, sessionManager: { getBranch: () => [] } };
const outNL = () => notes.filter((n) => !n.startsWith(String.fromCharCode(27))).join(NLc);

// Round 86 (pt584): /goal sessions open prints a COPY-PASTE launch line whose filename part is
// host-writable. NTFS forbids " (breakout impossible) but ALLOWS $ ` % & - inside the printed
// double quotes, $VAR/`cmd` expand in POSIX shells and %VAR% in cmd.exe. This probe documents
// CURRENT behavior, then the fix must refuse or sanity-print metachar names.
const safePath = "--" + HOME.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
const projDir = path.join(HOME, ".pi", "agent", "sessions", safePath);
const planted = [];
for (const nm of ["pt584-$EVIL.jsonl", "pt584-`touch pwned`.jsonl", "pt584-%PATH%.jsonl", "pt584-a&b.jsonl"]) {
  try { fs.writeFileSync(path.join(projDir, nm), "{}"); planted.push(nm); } catch {}
}
check("P0_plantable", planted.length === 4);
// resolve each evil name individually (unique substring "pt584-$" etc.) and inspect the print:
const results = [];
for (const probe of ["pt584-$", "pt584-`", "pt584-%", "pt584-a&"]) {
  notes.length = 0;
  await cmd.handler("sessions open " + probe, ctx);
  const out = outNL();
  const launch = out.split(NLc).find((l) => l.includes("--session")) || "";
  results.push([probe, launch]);
  console.log("DUMP " + probe + " -> " + JSON.stringify(launch.slice(0, 130)));
}
// VERDICT helper: does the printed line contain the RAW metachar (unescaped)?
const rawLeak = results.some(([, l]) => /[\$`%&]/.test(l));
check("V1_raw_metachar_printed", rawLeak ? "LEAK" : "PASS");
// V2: each refusal carries the honest warning text:
  let refusedAll = true;
  for (const probe of ["pt584-$", "pt584-`", "pt584-%", "pt584-a&"]) {
    notes.length = 0;
    await cmd.handler("sessions open " + probe, ctx);
    const o2 = outNL();
    if (!/refused.*metacharacters|metacharacters/i.test(o2)) refusedAll = false;
  }
  check("V2_refused_with_warning", refusedAll);
  // V3: a LEGIT filename still prints a launch line:
  fs.writeFileSync(path.join(projDir, "pt584-legit.jsonl"), "{}");
  notes.length = 0;
  await cmd.handler("sessions open pt584-legit", ctx);
  const o3 = outNL();
  const legitLaunch = o3.split(NLc).find((l) => l.includes("--session")) || "";
  check("V3_legit_prints", legitLaunch.includes("pt584-legit.jsonl"));
  for (const nm of [...planted, "pt584-legit.jsonl"]) { try { fs.rmSync(path.join(projDir, nm), { force: true }); } catch {} }
  for (const l of LOG) console.log(l);
  process.exit(0);
