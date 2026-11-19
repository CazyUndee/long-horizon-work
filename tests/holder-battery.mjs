// Holder battery (cycle 74): extracts DAEMON_HOLDER_SOURCE from the live goal.ts,
// syntax-checks it, and functionally verifies the two paths that matter:
//   1) a legitimate spawn writes a valid {pid} handoff through aw() and spawns the child;
//   2) a mid-flight junction at the meta dir makes the handoff write drop (round 19).
// Run by the suite as a subprocess section - every holder-source edit is now gated.
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";

const goalTs = path.join(import.meta.dirname, "..", "goal.ts");
const src = fs.readFileSync(goalTs, "utf8");
const i = src.indexOf("const DAEMON_HOLDER_SOURCE = [");
const j = src.indexOf("].join(", i);
if (i < 0 || j < 0) {
  console.error("FAIL: DAEMON_HOLDER_SOURCE not found in goal.ts");
  process.exit(1);
}
const seg = src.slice(src.indexOf("[", i), j);
const lits = [];
for (const line of seg.split("\r\n")) {
  const t = line.trim().replace(/,$/, "");
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    lits.push(t.slice(1, -1).replace(/\\"/g, '"'));
  }
}
const holderJS = lits.join("\n");
// syntax gate:
fs.writeFileSync(path.join(os.tmpdir(), "holder-battery-check.js"), holderJS);
import { execFileSync } from "node:child_process";
try {
  execFileSync(process.execPath, ["--check", path.join(os.tmpdir(), "holder-battery-check.js")], { stdio: "pipe" });
} catch (e) {
  console.error("FAIL: holder source does not parse: " + String(e.stderr ?? "").slice(0, 150));
  process.exit(1);
}

let failed = 0;
const check = (name, cond) => {
  console.log(`  ${cond ? "ok " : "FAIL "} ${name}`);
  if (!cond) failed++;
};

const base = fs.mkdtempSync(path.join(os.tmpdir(), "holder-battery-"));
try {
  const fake = path.join(base, "fake.js");
  fs.writeFileSync(fake, "setTimeout(() => process.exit(0), 4000); setInterval(() => {}, 500);"); // deadman: self-exit (holder kill is TerminateProcess - no exit hooks on Windows)\n");

  // Poll-with-deadline instead of fixed sleeps: under load a fixed 350ms can miss the
  // 80ms-interval tick, producing flaky FAILs (cycle 88 finding). Polls every 60ms up
  // to 4s for the predicate - timing-robust on loaded machines.
  const pollTo = async (pred, ms = 8000) => { const dl = Date.now() + ms; while (Date.now() < dl) { if (pred()) return true; await new Promise((r) => setTimeout(r, 60)); } return pred(); };
  // 1) legit path: handoff pid written, child spawned
  const meta1 = path.join(base, "m1");
  fs.mkdirSync(meta1);
  const argFile = path.join(meta1, "daemon-args.json");
  fs.writeFileSync(argFile, JSON.stringify([process.execPath, fake]));
  let child = spawn(process.execPath, ["-e", holderJS, argFile, path.join(meta1, "daemon.log"), base], { stdio: "ignore" });
  await pollTo(() => { try { const h = JSON.parse(fs.readFileSync(argFile, "utf8")); return typeof h.pid === "number" && h.pid > 0; } catch { return false; } });
  try { child.kill(); } catch {}
  let hand = null;
  try { hand = JSON.parse(fs.readFileSync(argFile, "utf8")); } catch {}
  check("legit handoff {pid} written", typeof hand?.pid === "number" && hand.pid > 0);
  check("legit daemon.log created", fs.existsSync(path.join(meta1, "daemon.log")));

  // 2) aliased meta dir from t=0 (deterministic form of the round-19 mid-flight race:
  // the holder reads the attacker-supplied args through the link - fine - but the
  // {pid} write must DROP rather than land in the victim dir).
  const meta2 = path.join(base, "m2");
  const vic = path.join(base, "vic");
  fs.mkdirSync(vic);
  fs.symlinkSync(vic, meta2, "junction");
  const argFile2 = path.join(meta2, "daemon-args.json");
  fs.writeFileSync(argFile2, JSON.stringify([process.execPath, fake]));
  child = spawn(process.execPath, ["-e", holderJS, argFile2, path.join(meta2, "daemon.log"), base], { stdio: "ignore" });
  // Perf (cycle 267): poll the holder's exit instead of a fixed 600ms sleep - the
  // aliased-path holder self-exits as soon as its realpath guard trips (~60-120ms);
  // under load the fixed sleep both cost more AND raced late evidence (cycles 88/89).
  await new Promise((res) => child.once("exit", () => res()));
  try { child.kill(); } catch {}
  const through = fs.readFileSync(argFile2, "utf8");
  check("handoff dropped through junction", !/"pid"/.test(through));

  // 3) capper works in place (cycle 79): an over-cap plain log must be halved by the
  // r+ copy-down + ftruncate capper even while the child holds the log fd open.
  const meta3 = path.join(base, "m3");
  fs.mkdirSync(meta3);
  const argFile3 = path.join(meta3, "daemon-args.json");
  fs.writeFileSync(argFile3, JSON.stringify([process.execPath, fake]));
  const logPath3 = path.join(meta3, "daemon.log");
  fs.writeFileSync(logPath3, "L".repeat(8 * 1024 * 1024 + 100));
  const fast = holderJS.replace("60 * 60 * 1000", "80");
  child = spawn(process.execPath, ["-e", fast, argFile3, logPath3, base], { stdio: "ignore" });
  await pollTo(() => { try { return fs.statSync(logPath3).size < 8 * 1024 * 1024; } catch { return false; } }, 10000);
  try { child.kill(); } catch {}
  check("over-cap log halved in place", fs.statSync(logPath3).size < 8 * 1024 * 1024);

} finally {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(os.tmpdir(), "holder-battery-check.js"), { force: true }); } catch {}
}

console.log(failed === 0 ? "holder battery: 5/5 (4 functional + syntax)" : `holder battery: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
