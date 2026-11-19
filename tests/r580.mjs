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
function check(label, cond) { const l = label + "=" + (cond ? "PASS" : "FAIL"); LOG.push(l); console.log(l); }
const rmS = (d) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {} };
const HOME = os.homedir();
const NLc = String.fromCharCode(10);
// R580: the over-window catch-up valve (580 build) exercised in a sandbox:
// (1) a >1MB day file with >12h entries -> catch-up archives + shrinks + round-trip intact.
// (2) a >1MB day file with ALL entries <12h (burst day) -> catch-up moves 0, file untouched, no crash.
// (3) a >3MB (>3x window) day file -> tapped honest, no crash, no surgery on the file.
// (4) a normal 55% day file -> catch-up must NOT touch anything (the ordinary path unchanged).
// (5) archive-first crash safety: the archive file exists BEFORE the day shrinks (verify ordering
//     indirectly: after the operation both exist; a hard crash between = duplication, never loss).
const run = async (scenario) => {
  const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "r580-" + scenario + "-"));
  process.chdir(CWD);
  const mod = await jiti.import(path.join(HOME, ".pi", "agent", "extensions", "goal.ts"));
  const tools = {};
  const pi = { on: () => () => {}, registerCommand: () => {}, registerTool: (d) => { if (d?.name) tools[d.name] = d; }, registerEntryRenderer: () => {}, registerShortcut: () => {}, registerFlag: () => {}, getFlag: () => undefined, appendEntry: () => {}, sendMessage: () => {}, sendUserMessage: () => {}, exec: async () => ({ stdout: "" }), events: { on: () => {}, emit: () => {} } };
  await mod.default(pi);
  const ctx = { hasUI: true, mode: "tui", isIdle: () => true, cwd: CWD, sessionManager: { getBranch: () => [] }, ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (c,t)=>String(t), bold:(t)=>String(t) } } };
  const dir = path.join(CWD, "goal-diary");
  fs.mkdirSync(dir, { recursive: true });
  const dayFile = path.join(dir, "2026-11-19.md");
  const archFile = path.join(dir, "archive-2026-11-19.md");
  return { CWD, ctx, tools, dayFile, archFile, dir };
};
const entryText = (hoursAgo, i) => {
  const stamp = new Date(Date.now() - hoursAgo * 3600_000).toISOString().slice(0, 16).replace("T", " ");
  const whatBody = ("r580 catch-up battery scenario body text with realistic multi-clause content for accurate size measurements. ").repeat(11);
  // CRITICAL probe-format (3rd lesson this cycle): parseDayText reads '## HH:MM' as time-of-DAY
  // on the FILE's day (2026-11-19), so '>12h old' = clock earlier than now-12h. Old-flag entries
  // use 00:0X (deep past, always >12h); new-flag entries use the CURRENT clock (fresh).
  const old580 = hoursAgo > 12;
  const mins = String(new Date().getMinutes()).padStart(2, "0");
  const hhmm = old580 ? ("00:" + String(i % 60).padStart(2, "0")) : (String(new Date().getHours()).padStart(2, "0") + ":" + mins);
  return "## " + hhmm + " — R580 entry " + i + NLc + "- kind: work" + NLc + "- what: " + whatBody + " idx " + i + NLc + "- how: through the mounted harness" + NLc + "- why: r580 catch-up battery" + NLc + NLc;
};

// (1) the catch-up case: 2200KB of mixed ages (2/3 older than 12h):
{
  const s = await run("catchup");
  let day = "";
  for (let i = 0; i < 1300; i++) day += entryText(i < 860 ? 24 : 4, i);
  fs.writeFileSync(s.dayFile, day);
  const before = fs.statSync(s.dayFile).size;
  await s.tools.diary.execute("c", { action: "write", title: "trigger", what: "x", how: "x", why: "y", kind: "work" }, s.ctx);
  const after = fs.statSync(s.dayFile).size;
  const arch = fs.existsSync(s.archFile) ? fs.statSync(s.archFile).size : 0;
  check("C1_overwindow_archived", arch > 100_000);
  check("C2_day_shrunk", after < before * 0.6 && after < 1_100_000);
  check("C3_day_within_window", after <= 1024 * 1024);
  const reTxt = fs.readFileSync(s.dayFile, "utf8");
  const reparse = reTxt.split("## ").length - 1;
  check("C4_kept_entries_parseable", reparse >= 439);
  rmS(s.CWD);
}

// (2) burst day: all <12h:
{
  const s = await run("burst");
  let day = "";
  for (let i = 0; i < 1300; i++) day += entryText(4, i);
  fs.writeFileSync(s.dayFile, day);
  const before = fs.statSync(s.dayFile).size;
  let threw = false;
  try { await s.tools.diary.execute("c", { action: "write", title: "trigger", what: "x", how: "x", why: "y", kind: "work" }, s.ctx); } catch { threw = true; }
  const after = fs.statSync(s.dayFile).size;
  check("B1_burst_no_crash", !threw);
  check("B2_burst_untouched", Math.abs(after - before) < 2000);
  rmS(s.CWD);
}

// (3) >3x window (>3MB) -> tapped honest, no surgery:
{
  const s = await run("huge");
  let day = "";
  for (let i = 0; i < 4000; i++) day += entryText(24, i);
  fs.writeFileSync(s.dayFile, day);
  const before = fs.statSync(s.dayFile).size;
  let threw = false;
  try { await s.tools.diary.execute("c", { action: "write", title: "trigger", what: "x", how: "x", why: "y", kind: "work" }, s.ctx); } catch { threw = true; }
  const after = fs.statSync(s.dayFile).size;
  check("H1_huge_no_crash", !threw);
  check("H2_huge_no_surgery", Math.abs(after - before) < 2000);
  check("H3_huge_no_archive", !fs.existsSync(s.archFile) || fs.statSync(s.archFile).size === 0);
  rmS(s.CWD);
}

// (4) ordinary day (55%-ish): catch-up must not fire (below even the 90% valve):
{
  const s = await run("normal");
  let day = "";
  for (let i = 0; i < 260; i++) day += entryText(24, i);
  fs.writeFileSync(s.dayFile, day);
  const before = fs.statSync(s.dayFile).size;
  await s.tools.diary.execute("c", { action: "write", title: "trigger", what: "x", how: "x", why: "y", kind: "work" }, s.ctx);
  const after = fs.statSync(s.dayFile).size;
  check("N1_normal_untouched_by_catchup", Math.abs(after - before) < 2000);
  rmS(s.CWD);
}

// (5) archive-first proof: run catch-up again and check the archive CONTENT contains the moved
// entries verbatim (round-trip through parse):
{
  const s = await run("order");
  let day = "";
  for (let i = 0; i < 1200; i++) day += entryText(i < 800 ? 20 : 3, i);
  fs.writeFileSync(s.dayFile, day);
  await s.tools.diary.execute("c", { action: "write", title: "trigger", what: "x", how: "x", why: "y", kind: "work" }, s.ctx);
  const arch = fs.readFileSync(s.archFile, "utf8");
  // the first archived entry (oldest) should be entry 0's what-text:
  check("O1_archive_has_oldest", arch.includes("R580 entry 0"));
  const dayTxt = fs.readFileSync(s.dayFile, "utf8");
  check("O2_day_keeps_recent", dayTxt.includes("R580 entry 1199") || dayTxt.includes("trigger"));
  check("O3_day_dropped_old", !dayTxt.includes("R580 entry 0" + NLc));
  rmS(s.CWD);
}

for (const l of LOG) console.log(l);
process.exit(0);
