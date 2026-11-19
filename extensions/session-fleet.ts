/**
 * Session Fleet Extension — /save and /load for the set of open pi sessions.
 *
 * Problem: several pi windows are open at once (several projects / agents).
 * On quit or reboot the user wants to snapshot WHICH sessions were open,
 * and later restore them all in ONE terminal window as multiple tabs.
 *
 * Design:
 *   - pi persists session content continuously; the fleet extension only has
 *     to record the FLEET SET: which session files were open + their cwds.
 *   - Every pi instance running this extension advertises itself with a
 *     heartbeat file at ~/.pi/agent/fleet/hb-<pid>.json (session file, cwd,
 *     model), refreshed every 30 s and on agent_start, removed on
 *     session_shutdown. Heartbeats older than ~90 s from a dead process are
 *     pruned, so crashed instances self-clean on the next save/load.
 *   - /save  → snapshots all live heartbeats (plus this session) into
 *              ~/.pi/agent/fleet/fleet.json; keeps a fleet-1..10 history.
 *   - /load [file] → spawns ONE Windows Terminal window with one tab per
 *              saved session (`wt new-tab -d <cwd> pi --session <file>`),
 *              skipping sessions that are already open right now. Without
 *              wt it falls back to spawning each session in its own window.
 *
 * Platform: Windows-first (wt). Persisted strings are singleLine()-sanitized
 * (same discipline as goal.ts: no C0/ESC/newlines reach the terminal or wt).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const FLEET_DIR = path.join(AGENT_DIR, "fleet");
const SNAPSHOT_FILE = path.join(FLEET_DIR, "fleet.json");
const HEARTBEAT_MS = 30_000;
const STALE_MS = 90_000; // 3 missed beats ⇒ dead unless pid is alive
const HISTORY_KEEP = 10;

/* ---------- small utils (goal.ts conventions) ---------- */

function singleLine(s: unknown): string {
	return String(s ?? "")
		.replace(/[\r\n\t]+/g, " ")
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.trim()
		.slice(0, 400);
}

function atomicWrite(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, text, "utf-8");
	fs.renameSync(tmp, file);
}

function whereFirst(cmd: string, extraArgs: string[] = []): string | null {
	const out = spawnSync("where", extraArgs.length ? [cmd, ...extraArgs] : [cmd], {
		encoding: "utf-8",
		shell: true,
	});
	if (out.status === 0 && out.stdout) {
		return out.stdout.split("\n").map((l) => l.trim()).filter(Boolean)[0] || null;
	}
	return null;
}

function pidAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	if (process.platform !== "win32") {
		try { process.kill(pid, 0); return true; } catch { return false; }
	}
	// On Windows, `tasklist /FI "PID eq N"` is the portable probe.
	const out = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf-8" });
	return !!(out.status === 0 && out.stdout && !/INFO:/i.test(out.stdout));
}

/* ---------- heartbeats ---------- */

interface Heartbeat {
	pid: number;
	sessionFile: string;
	cwd: string;
	model: string | null;
	updated: number; // epoch ms
}

function hbPath(pid: number): string {
	return path.join(FLEET_DIR, `hb-${pid}.json`);
}

function writeHeartbeat(hb: Heartbeat): void {
	atomicWrite(hbPath(hb.pid), JSON.stringify(hb));
}

function pruneDead(): void {
	fs.mkdirSync(FLEET_DIR, { recursive: true });
	const now = Date.now();
	for (const f of fs.readdirSync(FLEET_DIR)) {
		if (!f.startsWith("hb-") || !f.endsWith(".json")) continue;
		const full = path.join(FLEET_DIR, f);
		let hb: Heartbeat | null = null;
		try {
			const raw = readHeartbeatHead(full);
			if (!raw) { try { fs.unlinkSync(full); } catch {} continue; }
			const o = JSON.parse(raw);
			if (Number.isFinite(Number(o.pid)) && typeof o.sessionFile === "string") {
				hb = { pid: Number(o.pid), sessionFile: o.sessionFile, cwd: String(o.cwd ?? ""), model: o.model ?? null, updated: Number(o.updated) || 0 };
			}
		} catch {}
		if (!hb) { try { fs.unlinkSync(full); } catch {} continue; }
		const fresh = now - hb.updated < STALE_MS;
		if (!fresh && !pidAlive(hb.pid)) {
			try { fs.unlinkSync(full); } catch {}
		}
	}
}

/** Hardening (cycle 253): heartbeat files are host-writable (hand-dropped fleet dir);
 * a bounded HEAD read instead of whole-file - a hostile/huge hb-*.json used to incur an
 * unbounded read+parse (the same class bounded in goal.ts readHead and bg-jobs loadJobs).
 * Heartbeats are ~200 bytes; anything over 4KB is hostile or corrupted - treat as malformed. */
function readHeartbeatHead(fp: string): string | undefined {
	try {
		const st = fs.statSync(fp);
		if (st.size > 4096) return undefined;
		return fs.readFileSync(fp, "utf8");
	} catch {
		return undefined;
	}
}

function readLiveHeartbeats(): Heartbeat[] {
	pruneDead();
	const out: Heartbeat[] = [];
	for (const f of fs.readdirSync(FLEET_DIR)) {
		if (!f.startsWith("hb-") || !f.endsWith(".json")) continue;
		try {
			const raw = readHeartbeatHead(path.join(FLEET_DIR, f));
			if (!raw) continue;
			const o = JSON.parse(raw);
			const pid = Number(o.pid);
			if (!Number.isFinite(pid) || typeof o.sessionFile !== "string") continue;
			if (Date.now() - (Number(o.updated) || 0) >= STALE_MS && !pidAlive(pid)) continue;
			out.push({ pid, sessionFile: String(o.sessionFile), cwd: singleLine(o.cwd) || AGENT_DIR, model: o.model ? singleLine(o.model) : null, updated: Number(o.updated) || 0 });
		} catch {}
	}
	return out.sort((a, b) => b.updated - a.updated);
}

/* ---------- snapshots ---------- */

interface SavedSession {
	sessionFile: string;
	cwd: string;
	name: string | null;
}

function shiftHistory(): void {
	for (let i = HISTORY_KEEP; i >= 2; i--) {
		try { fs.renameSync(path.join(FLEET_DIR, `fleet-${i - 1}.json`), path.join(FLEET_DIR, `fleet-${i}.json`)); } catch {}
	}
	try { fs.renameSync(SNAPSHOT_FILE, path.join(FLEET_DIR, "fleet-1.json")); } catch {}
}

/* ---------- spawning ---------- */

/** Round-43 predicate: a session path/cwd is spawnable through shell:true only when
 * free of shell metacharacters. Exported for the regression suite (guards both spawn paths). */
export function spawnSafePath(v: string): boolean {
	return !/[&|;`$()<>^"%]/.test(v);
}

function spawnFleet(piExe: string, sessions: SavedSession[], useWt: boolean): string {
	if (useWt) {
		const parts: string[] = [];
		for (const s of sessions) {
			// Round-43 command-injection guard (wt path): session paths flow into a
			// shell:true spawn; a path NEVER legitimately contains shell metacharacters.
			// A heartbeat/snapshot carrying them is hostile (verified live: the injection
			// survived singleLine + /save into the real snapshot). Drop + warn, never spawn.
			if (!spawnSafePath(s.sessionFile) || !spawnSafePath(s.cwd.replace(/^"|"$/g, ""))) {
				console.error("[session-fleet] refused session with shell metacharacters (wt): " + s.sessionFile.slice(0, 80));
				continue;
			}
			const title = (s.name || path.basename(s.sessionFile, ".jsonl")).replace(/"/g, "");
			const seg = `new-tab --title "${title}" -d "${s.cwd}" "${piExe}" --session "${s.sessionFile}"`;
			parts.push(parts.length === 0 ? seg.replace(/^new-tab /, "") : seg);
		}
		const full = `wt ${parts.join(" ; ")}`;
		spawn(full, { shell: true, detached: true, stdio: "ignore", windowsHide: true }).unref();
		return full;
	}
	// fallback: one window per session
	for (const s of sessions) {
		// Round-43 guard (same as the wt path): never spawn shell-metacharacter paths.
		if (!spawnSafePath(s.sessionFile) || !spawnSafePath(s.cwd.replace(/^"|"$/g, ""))) {
			console.error("[session-fleet] refused to spawn session with shell metacharacters: " + s.sessionFile.slice(0, 80));
			continue;
		}
		spawn(`"${piExe}" --session "${s.sessionFile}"`, {
			shell: true,
			cwd: s.cwd,
			detached: true,
			stdio: "ignore",
			windowsHide: false,
		}).unref();
	}
	return `${sessions.length} separate pi windows`;
}

/* ---------- extension ---------- */

export default function (pi: ExtensionAPI) {
	let hbTimer: ReturnType<typeof setInterval> | null = null;

	interface CtxLike {
		cwd?: string;
		model?: { provider?: string; id?: string } | null;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		sessionManager?: any;
		ui?: { notify: (msg: string, level?: string) => void };
	}

	function selfHeartbeat(ctx: CtxLike): Heartbeat | null {
		try {
			const sessionFile: string | null = ctx.sessionManager?.getSessionFile?.() ?? null;
			if (!sessionFile) return null;
			return {
				pid: process.pid,
				sessionFile,
				cwd: singleLine(ctx.cwd ?? process.cwd()),
				model: ctx.model ? singleLine(`${ctx.model.provider}/${ctx.model.id}`) : null,
				updated: Date.now(),
			};
		} catch {
			return null;
		}
	}

	function beat(ctx: CtxLike): void {
		const hb = selfHeartbeat(ctx);
		if (hb) writeHeartbeat(hb);
	}

	function ensureTimer(ctx: CtxLike): void {
		beat(ctx);
		if (hbTimer) return;
		hbTimer = setInterval(() => beat(ctx), HEARTBEAT_MS);
		// keep the loop honest if the ctx goes stale: re-derive from scratch
		hbTimer.unref?.();
	}

	pi.on("agent_start", (_event: unknown, ctx: unknown) => {
		ensureTimer(ctx as CtxLike);
	});

	pi.on("session_shutdown", () => {
		if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
		try { fs.unlinkSync(hbPath(process.pid)); } catch {}
	});

	pi.registerCommand("save", {
		description: "Snapshot all open pi sessions for /load",
		handler: async (_args: string, ctx: CtxLike) => {
			ensureTimer(ctx);
			beat(ctx);
			const live = readLiveHeartbeats();
			if (live.length === 0) {
				ctx.ui?.notify("No live sessions found to save.", "warning");
				return;
			}
			const seen = new Set<string>();
			const sessions: SavedSession[] = [];
			let myName: string | null = null;
			try { myName = pi.getSessionName() || null; } catch {}
			for (const hb of live) {
				const sessionFile = singleLine(hb.sessionFile);
				if (!sessionFile || seen.has(sessionFile)) continue;
				seen.add(sessionFile);
				sessions.push({
					sessionFile,
					cwd: hb.cwd || AGENT_DIR,
					name: hb.pid === process.pid ? singleLine(myName) || null : null,
				});
			}
			shiftHistory();
			atomicWrite(SNAPSHOT_FILE, JSON.stringify({ savedAt: new Date().toISOString(), count: sessions.length, sessions }, null, 2));
			ctx.ui?.notify(`Fleet saved: ${sessions.length} session${sessions.length === 1 ? "" : "s"} → fleet.json`, "info");
		},
	});

	pi.registerCommand("load", {
		description: "Restore a /save snapshot as Windows Terminal tabs",
		handler: async (args: string, ctx: CtxLike) => {
			const a = (args || "").trim();
			const file = a || SNAPSHOT_FILE;
			if (!fs.existsSync(file)) {
				ctx.ui?.notify(a ? `No such fleet file: ${file}` : "No snapshot found. Run /save first.", "error");
				return;
			}
			interface Snap { sessions?: SavedSession[] }
			let snap: Snap;
			try { snap = JSON.parse(fs.readFileSync(file, "utf-8")); } catch {
				ctx.ui?.notify(`Fleet file unreadable: ${file}`, "error");
				return;
			}
			const all = (snap.sessions ?? []).filter((s) => s && typeof s.sessionFile === "string");
			const resumable = all.filter((s) => fs.existsSync(s.sessionFile));
			if (resumable.length === 0) {
				ctx.ui?.notify(`Snapshot has no resumable sessions (${all.length} missing).`, "error");
				return;
			}

			// skip sessions that are open right now (their own heartbeats)
			ensureTimer(ctx);
			beat(ctx);
			const liveSet = new Set(readLiveHeartbeats().map((hb) => hb.sessionFile));
			const toSpawn = resumable.filter((s) => !liveSet.has(s.sessionFile));
			const skippedOpen = resumable.length - toSpawn.length;
			if (toSpawn.length === 0) {
				ctx.ui?.notify(`All ${resumable.length} saved sessions are already open. Nothing to spawn.`, "info");
				return;
			}

			const piExe = whereFirst("pi");
			if (!piExe) { ctx.ui?.notify("pi not found on PATH.", "error"); return; }
			const useWt = process.platform === "win32" && !!whereFirst("wt");
			const desc = spawnFleet(piExe, toSpawn.map((s) => ({ sessionFile: s.sessionFile, cwd: s.cwd || AGENT_DIR, name: s.name })), useWt);
			const bits = [
				`Spawning ${toSpawn.length} tab${toSpawn.length === 1 ? "" : "s"}`,
				skippedOpen ? `skipped ${skippedOpen} already open` : "",
				all.length - resumable.length ? `${all.length - resumable.length} missing` : "",
			].filter(Boolean).join(", ");
			ctx.ui?.notify(`${bits}. (${useWt ? "wt window" : "fallback windows"})\n${desc}`, "info");
		},
	});
}
