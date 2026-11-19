import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

// Conformer regression battery (cycle 69): pins the three invariants from cycles 59/61/66/67 -
// repairs malformed time-title separators, never touches clean files (md5 differential),
// and refuses alias links at both dir and day-file level (pentest round 18).

const conformer = path.join(import.meta.dirname, "conform-diary.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conform-suite-"));
let failed = 0;
const check = (name, cond, detail = "") => {
  console.log(`  ${cond ? "ok " : "FAIL "} ${name}${detail ? " - " + detail : ""}`);
  if (!cond) failed++;
};

try {
  // 1) clean file: byte-identical (md5 differential)
  const d1 = path.join(tmp, "t1");
  fs.mkdirSync(d1);
  fs.writeFileSync(path.join(d1, "2026-01-01.md"), "# D\n\n## 10:00 — good\n- kind: work\n- what: y\n");
  const before = fs.readFileSync(path.join(d1, "2026-01-01.md"));
  execFileSync(process.execPath, [conformer, d1], { stdio: "pipe" });
  const after = fs.readFileSync(path.join(d1, "2026-01-01.md"));
  check("clean file untouched (md5 differential)", Buffer.compare(before, after) === 0);

  // 2) malformed separator: repaired
  const d2 = path.join(tmp, "t2");
  fs.mkdirSync(d2);
  fs.writeFileSync(path.join(d2, "2026-01-01.md"), "# D\n\n## 10:00 --- bad sep\n- kind: work\n- what: y\n");
  execFileSync(process.execPath, [conformer, d2], { stdio: "pipe" });
  const fixed = fs.readFileSync(path.join(d2, "2026-01-01.md"), "utf8");
  check("malformed separator repaired", fixed.includes("## 10:00 " + String.fromCharCode(8212) + " bad sep"));

  // 3) legit --- in prose: NOT corrupted (cycle 61's false positive class)
  const d3 = path.join(tmp, "t3");
  fs.mkdirSync(d3);
  const EM = String.fromCharCode(8212);
  fs.writeFileSync(
    path.join(d3, "2026-01-01.md"),
    "# D\n\n## 10:00 " + EM + " title with --- inside prose\n- kind: work\n",
  );
  execFileSync(process.execPath, [conformer, d3], { stdio: "pipe" });
  const prose = fs.readFileSync(path.join(d3, "2026-01-01.md"), "utf8");
  check("legit --- in prose preserved", prose.includes("title with --- inside prose"));

  // 4) junction at the dir: refused, victim intact (round 18)
  const d4 = path.join(tmp, "t4");
  fs.mkdirSync(d4);
  fs.mkdirSync(path.join(d4, "vic"));
  fs.writeFileSync(path.join(d4, "vic", "2026-01-01.md"), "## 10:00 --- victim\nsecret\n");
  fs.symlinkSync(path.join(d4, "vic"), path.join(d4, "junc"), "junction");
  let refused = false;
  try {
    execFileSync(process.execPath, [conformer, path.join(d4, "junc")], { stdio: "pipe" });
  } catch {
    refused = true;
  }
  const victim = fs.readFileSync(path.join(d4, "vic", "2026-01-01.md"), "utf8");
  check("journaled diary dir refused", refused);
  check("victim intact through refused junction", victim.includes("## 10:00 --- victim"));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(failed === 0 ? "conformer battery: 5/5" : `conformer battery: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
