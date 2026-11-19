/**
 * Background Jobs Extension - fire-and-forget work with controlled re-injection.
 *
 * A single tool, `background`, with a queue of detached jobs the model can:
 *   - start (fire-and-forget: spawned detached from the turn; output captured to a log)
 *   - choose the delivery of the result:
 *       notify       - host notification when the job finishes (no stream interaction)
 *       wait         - inject the result at the NEXT turn boundary (agent_before_settle)
 *       interrupt    - immediately inject the result as a custom message that
 *                      triggers a new turn (pi.sendMessage, triggerTurn)
 *   - choose whether intermediate "updates" are also delivered, and control WHAT
 *     counts as an update: `update_filter` is a regex source - only lines that
 *     match are treated as update events (e.g. "DONE|FAIL|error" reports only
 *     those lines). Default: no updates (finished-only). `update_mode` picks
 *     per-update delivery (notify | wait | interrupt); finished delivery is
 *     always whatever `on_finish` says.
 *   - check status, tail a job's output, and kill a running job.
 *
 * Why: long builds/tests/mines stall a turn when awaited inline, and the model
 * otherwise resorts to `bash` hacks (sleep, polling) that the loop protocol
 * then has to babysit. This gives the model an actual scheduler primitive.
 *
 * Storage: job records live in .pi-jobs/jobs.json (atomic temp+rename write,
 * owner-dir normalized); output logs in .pi-jobs/logs/<id>.log (appended by the
 * child's stdio plumbing, capped at 1 MiB - kept to the TAIL when a job is
 * chatty, the same discipline as the harness's output capping).
 *
 * Re-injection: the extension watches running jobs with a 500ms poller (meta
 * watch on Windows + poll everywhere: fs.watch on a directory does not fire for
 * child-exit, so exit is *detected* by poll - simple, portable, and correct).
 * On finish (or a matching update line) the configured delivery runs:
 *   notify    -> ctx.ui.notify (or the host notification path)
 *   wait      -> queue for the next agent_before_settle, injected as a custom
 *                message WITHOUT triggering a turn (model sees it when it next runs)
 *   interrupt -> pi.sendMessage({ customType: "background-job", ... }, { triggerTurn: true })
 *
 * Conventions copied from goal.ts: singleLine()/clipField for every persisted and
 * rendered string (C0/ESC can't reach the terminal or the prompt), atomic
 * temp+rename writes per record file, module caches keyed by cwd, nothing unbounded
 * (log bytes, update line count, pending-injection queue, job count all capped),
 * safeNotify semantics (works headless: falls back to a queued line the next tool
 * result reports).
 *
 * This extension is deliberately standalone - no import from goal.ts (both files
 * are loaded by the same pi; they share nothing but the conventions).
 */

import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const JOBS_DIR = ".pi-jobs";
const LOGS_SUBDIR = "logs";
const JOBS_FILE = "jobs.json";

/** Cap on one job's retained log (tail is kept when a job exceeds it). */
const MAX_LOG_BYTES = 1024 * 1024;
/** Hard cap on tracked jobs; oldest finished are pruned. */
const MAX_JOBS = 32;

/** Round-42 bounded-io budget: 32 records x clipped fields fit in a tiny fraction of this. */
const MAX_JOBS_FILE_BYTES = 256 * 1024;
/** Poll interval for exit detection + update matching. */
const POLL_MS = 500;
/** Longest a finished job's record is kept before pruning. */
const RETAIN_MS = 24 * 60 * 60_000;
/** Max pending wait-deliveries queued (older dropped, with a note). */
const MAX_PENDING = 16;

type Delivery = "notify" | "wait" | "interrupt";
type JobStatus = "running" | "finished" | "failed" | "killed";

interface JobRecord {
	id: string;
	command: string;
	/** Argv of the command for display/kill; the spawn itself took a shell line. */
	startedAt: number;
	endedAt?: number;
	status: JobStatus;
	exitCode?: number;
	/** Configured finished-delivery. */
	onFinish: Delivery;
	/** When false (default): no updates, finished-only. */
	updates: boolean;
	/** Delivery for a matching update line. */
	updateMode: Delivery;
	/** Regex source; a line matching it counts as an update. */
	updateFilter?: string;
	/** Last reported update line index (offset into the full log). */
	lastUpdateLine?: number;
	logFile: string;
	/** Windows-free internal bookkeeping: pid of the spawned child. */
	pid?: number;
}

/** Collapse to one line, stripping C0/DEL (same contract as goal.ts's singleLine). */
function safeLine(text: string): string {
	return text.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
	const single = safeLine(text);
	return single.length <= max ? single : `${single.slice(0, max - 1)}… [truncated]`;
}

/**
 * Round-84 secret scrub (the goal.ts doctrine, minimal port): command lines render
 * into tool results and notifications; a command (planted via a hand-edited
 * jobs.json or typed with a real header/token in it) must not leak credentials.
 * Same pattern families as goal.ts SECRET_PATTERNS; applied at EVERY command
 * render point (status row, finish notify, pending queue).
 */
function scrubCommand(text: string): string {
	let out = text;
	out = out.replace(/(?:sk|xox[bap]|AIza)[-_]?[A-Za-z0-9-]{12,}|sk-ant-(?:api03-)?[A-Za-z0-9-]{16,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|(?:rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9-]{16,}|nvapi-[A-Za-z0-9-]{20,}|hf_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}/g, "[redacted]");
	out = out.replace(/(?:AKIA|ASIA)[0-9A-Z]{16}/g, "[redacted]");
	out = out.replace(/github_pat_[0-9A-Za-z_]{16,}/g, "[redacted]");
	out = out.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "[redacted]");
	return out;
}


function jobsDir(cwd: string): string {
	return path.join(cwd, JOBS_DIR);
}

function jobsFile(cwd: string): string {
	return path.join(jobsDir(cwd), JOBS_FILE);
}

/**
 * Atomic temp+rename write for the jobs record (same discipline as goal.ts:
 * a torn jobs.json must never exist; readers see old or new, never half).
 * rename-over-open read handle is safe (readers reopen per read).
 */
function atomicWrite(filePath: string, content: string): void {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
	fs.writeFileSync(tmp, content, "utf8");
	try {
		fs.renameSync(tmp, filePath);
	} catch (err) {
		try { fs.unlinkSync(tmp); } catch { /* best effort */ }
		throw err;
	}
}

function loadJobs(cwd: string): JobRecord[] {
	try {
		// Round-42 hardening: the jobs file is host-writable (hand-edited .pi-goal/jobs.json).
		// The write path caps at MAX_JOBS records x clip(400) commands, so anything larger
		// than this budget is hostile or corrupted - read a bounded HEAD, not the whole file
		// (the goal.ts readHead doctrine; a hostile 200MB jobs.json used to be read whole).
		const st = fs.statSync(jobsFile(cwd));
		if (st.size > MAX_JOBS_FILE_BYTES) return [];
		const raw = fs.readFileSync(jobsFile(cwd), "utf8");
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter(isJobRecord) : [];
	} catch {
		return [];
	}
}

function isJobRecord(value: unknown): value is JobRecord {
	if (typeof value !== "object" || value === null) return false;
	const r = value as Record<string, unknown>;
	return (
		typeof r.id === "string" &&
		typeof r.command === "string" &&
		typeof r.startedAt === "number" &&
		(r.status === "running" || r.status === "finished" || r.status === "failed" || r.status === "killed")
	);
}

function saveJobs(cwd: string, jobs: JobRecord[]): void {
	// Prune-to-cap policy: finished jobs (oldest first) drop when over the cap.
	let kept = jobs.filter((j) => j.status === "running");
	const done = jobs
		.filter((j) => j.status !== "running")
		.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
	const room = MAX_JOBS - kept.length;
	kept = kept.concat(done.slice(0, Math.max(0, room)));
	atomicWrite(jobsFile(cwd), JSON.stringify(kept, null, 2));
}

/** Raw-bytes tail of a file (log capping in the pump). */
function readFileTail(filePath: string, keepBytes: number): Buffer {
	try {
		const size = fs.statSync(filePath).size;
		if (size <= keepBytes) return fs.readFileSync(filePath);
		const fd = fs.openSync(filePath, "r");
		try {
			const buf = Buffer.allocUnsafe(keepBytes);
			const read = fs.readSync(fd, buf, 0, keepBytes, size - keepBytes);
			return buf.subarray(0, read);
		} finally { fs.closeSync(fd); }
	} catch {
		return Buffer.alloc(0);
	}
}

/** The tail of a job log, capped. Used for every model-facing log read. */
function readLogTail(logFile: string, maxBytes = 16_384): { text: string; total: number } {
	try {
		const st = fs.statSync(logFile);
		if (st.size <= maxBytes) return { text: fs.readFileSync(logFile, "utf8"), total: st.size };
		const fd = fs.openSync(logFile, "r");
		try {
			const buf = Buffer.allocUnsafe(maxBytes);
			const read = fs.readSync(fd, buf, 0, maxBytes, st.size - maxBytes);
			return { text: buf.subarray(0, read).toString("utf8"), total: st.size };
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return { text: "", total: 0 };
	}
}

// ---------------------------------------------------------------------------
// Per-cwd live state: the poller, pending wait-deliveries, running children.
// Module-level caches keyed by cwd - same pattern as goal.ts's taskCountCache.
// ---------------------------------------------------------------------------

interface LiveJob {
	child: ReturnType<typeof spawn>;
	record: JobRecord;
	/** New output since the last poll, for update matching. */
	lastSize: number;
}

const live = new Map<string, { jobs: Map<string, LiveJob>; pending: string[]; timer?: NodeJS.Timeout }>();

function liveFor(cwd: string): { jobs: Map<string, LiveJob>; pending: string[]; timer?: NodeJS.Timeout } {
	let entry = live.get(cwd);
	if (!entry) {
		entry = { jobs: new Map(), pending: [] };
		live.set(cwd, entry);
	}
	return entry;
}

/**
 * Read the freshly-appended part of a job's log (from lastSize to now).
 * Returns the new text and the new total; on shrink (tail-rotation) returns
 * nothing so the matcher waits for the next append.
 */
function readNewLines(logFile: string, lastSize: number): { text: string; newSize: number } {
	try {
		const size = fs.statSync(logFile).size;
		if (size <= lastSize) return { text: "", newSize: lastSize };
		const len = Math.min(size - lastSize, MAX_LOG_BYTES);
		const fd = fs.openSync(logFile, "r");
		try {
			const buf = Buffer.allocUnsafe(len);
			const read = fs.readSync(fd, buf, 0, len, lastSize);
			return { text: buf.subarray(0, read).toString("utf8"), newSize: size };
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return { text: "", newSize: lastSize };
	}
}

export default function backgroundJobsExtension(pi: ExtensionAPI): void {
	let latestCtx: ExtensionContext | undefined;
	let shuttingDown = false;

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		startPoller(pi, ctx, safeCwd(ctx));
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		for (const [cwd, entry] of live) {
			if (entry.timer) clearTimeout(entry.timer);
			for (const lj of entry.jobs.values()) {
				try { lj.child.kill(); } catch { /* already gone */ }
			}
		}
		live.clear();
	});

	function safeCwd(ctx?: ExtensionToolContext | ExtensionContext): string {
		try {
			const c = (ctx as { cwd?: string } | undefined)?.cwd;
			if (c && typeof c === "string") return c;
		} catch { /* stale ctx */ }
		return latestCtx?.cwd ?? process.cwd();
	}

	function notify(cwd: string, message: string): void {
		if (shuttingDown) return;
		try {
			if (latestCtx?.hasUI) {
				latestCtx.ui.notify(clip(message, 300), "info");
				return;
			}
		} catch { /* stale ctx */ }
		// Headless (or print mode): queue for the next tool result to report.
		const entry = liveFor(cwd);
		if (entry.pending.length < MAX_PENDING) entry.pending.push(clip(message, 300));
	}

	/** Deliver a finished/update message per the configured mode. */
	function deliver(cwd: string, job: JobRecord, body: string, mode: Delivery): void {
		const clean = safeLine(body);
		if (!clean) return;
		if (mode === "notify") {
			notify(cwd, `[job ${job.id}] ${clip(clean, 240)}`);
			return;
		}
		if (mode === "wait") {
			// Queue for the next settle boundary; cap prevents a chatty job
			// from flooding the next request.
			const entry = liveFor(cwd);
			if (entry.pending.length >= MAX_PENDING) {
				notify(cwd, `[job ${job.id}] update dropped: pending queue full`);
				return;
			}
			entry.pending.push(`Background job ${job.id} (${clip(scrubCommand(job.command), 80)}):\n${clean}`);
			return;
		}
		// interrupt: inject as a custom message that triggers a turn.
		// The turn itself is model-visible; triggering while a run is already
		// active is fine - pi queues it as a starting-run message.
		pi.sendMessage(
			{
				customType: "background-job",
				content: `Background job ${job.id} (${clip(scrubCommand(job.command), 120)}):\n${clean}`,
				display: true,
			},
			{ triggerTurn: true },
		);
	}

	/** Exit + update detection. Poll, not watch: child exit is not a dir event. */
	function startPoller(piUnused: ExtensionAPI, ctx: ExtensionContext | undefined, cwd: string): void {
		void piUnused;
		void ctx;
		const entry = liveFor(cwd);
		if (entry.timer) return;
		entry.timer = setInterval(() => {
			if (shuttingDown) return;
			pollOnce(cwd);
		}, POLL_MS);
		entry.timer.unref?.();
	}

	function pollOnce(cwd: string): void {
		const entry = liveFor(cwd);
		if (entry.jobs.size === 0) return;
		const jobs = loadJobs(cwd);

		function patchRecord(job: JobRecord): void {
			const idx = jobs.findIndex((j) => j.id === job.id);
			if (idx >= 0) jobs[idx] = job;
			saveJobs(cwd, jobs);
		}

		for (const [id, lj] of [...entry.jobs]) {
			const record = lj.record;

			// Update matching: new text since last poll, lines that match the filter.
			if (record.updates) {
				const { text, newSize } = readNewLines(record.logFile, lj.lastSize);
				lj.lastSize = newSize;
				if (text && record.updateFilter) {
					let filter: RegExp | undefined;
					try {
						filter = new RegExp(record.updateFilter, "i");
					} catch {
						filter = undefined;
					}
					if (filter) {
						for (const line of text.split(/\r?\n/)) {
							if (!line.trim() || !filter.test(line)) continue;
							deliver(cwd, record, line.trim(), record.updateMode);
						}
					}
				}
			} else {
				// Not tracking updates, but keep lastSize honest for finish reads.
				// Guarded: the log may not exist yet for a single tick, or the record
				// may outlive its file on a manual clean.
				try {
					lj.lastSize = fs.statSync(record.logFile).size;
				} catch {
					/* absent log: nothing new to read */
				}
			}

			// Exit detection: exitCode/killSignal field on the ChildProcess.
			const exited = (lj.child.exitCode !== null && lj.child.exitCode !== undefined) || lj.child.killed;
			if (!exited) continue;

			const code = lj.child.exitCode;
			record.status = code === 0 ? "finished" : lj.child.killed ? "killed" : "failed";
			record.endedAt = Date.now();
			record.exitCode = code ?? null ?? undefined;
			patchRecord(record);
			entry.jobs.delete(id);

			const { text } = readLogTail(record.logFile, 4000);
			const summary =
				(record.status === "finished"
					? `finished (exit 0).`
					: record.status === "killed"
						? `was killed.`
						: `FAILED (exit ${code}).`) +
				(text ? ` Last output:\n${text.trim().split("\n").slice(-12).join("\n")}` : " (no output)");
			deliver(cwd, record, summary, record.onFinish);
			if (entry.jobs.size === 0 && entry.pending.length === 0) {
				// No live jobs left: stop polling for this cwd until a new job.
				clearTimeout(entry.timer as unknown as NodeJS.Timeout);
				entry.timer = undefined;
			}
		}
	}

	pi.on("agent_before_settle", async (_event, ctx) => {
		// wait-deliveries: inject pending messages as custom entries (no turn).
		// They become visible to the model on its next run.
		const cwd = safeCwd(ctx);
		const entry = liveFor(cwd);
		if (entry.pending.length === 0) return;
		const messages = entry.pending.splice(0, entry.pending.length);
		const joined = messages.join("\n\n").slice(0, 6000);
		return {
			type: "custom_message",
			customType: "background-job",
			content: safeLine(joined).replace(/ {2,}/g, " "),
		};
	});

	const BackgroundParams = Type.Object({
		action: StringEnum(["start", "status", "log", "kill", "drain", "tail"] as const, {
			description: "\"start\" a fire-and-forget job, \"status\" lists jobs, \"log\" reads one job's output tail, \"kill\" stops a running job, \"drain\" blocks until all tracked jobs finish (bounded), \"tail\" follows one job until it exits.",
		}),
		command: Type.Optional(Type.String({ description: "(start) Shell command line to run detached in the working directory." })),
		job: Type.Optional(Type.String({ description: 'Job id (or unique prefix): required for "log", "kill", "tail"; optional for "status".' })),
		on_finish: Type.Optional(StringEnum(["notify", "wait", "interrupt"] as const, {
			description: '(start) How the result is delivered when the job ends: "notify" = host notification only; "wait" = injected at the next turn boundary, no new turn; "interrupt" = injected immediately, triggers a new turn. Default "wait".',
		})),
		updates: Type.Optional(Type.Boolean({ description: "(start) Also deliver matching lines while the job runs (default false).", })),
		update_mode: Type.Optional(StringEnum(["notify", "wait", "interrupt"] as const, {
			description: '(start) Delivery for matching update lines. Default "wait".',
		})),
		update_filter: Type.Optional(Type.String({
			description: '(start) A regex source; only lines matching it count as updates, e.g. "DONE|FAIL|passed|error". Ignored when updates=false (then NOTHING counts as an update). Keep it cheap - every new line of output is tested against it.',
		})),
		minutes: Type.Optional(Type.Number({ description: '(drain) Bound the wait: poll until jobs finish or N minutes pass (default 30). Returns the remaining running ids either way.' })),
		after_bytes: Type.Optional(Type.Number({ description: "(log) How many tail bytes to read (default 16k, max 64k)." })),
	});

	pi.registerTool({
		name: "background",
		label: "Background jobs",
		description:
			"Run long work (builds, test sweeps, servers, mines) detached from the turn, with the result re-injected on your terms. " +
			"start: fire-and-forget; on_finish picks notify/wait/interrupt. updates + update_filter deliver matching lines while it runs. " +
			"status/log/kill manage jobs; drain waits (bounded) for all to finish.",
		promptSnippet: "Fire-and-forget long jobs with controlled re-injection (background tool)",
		promptGuidelines: [
			"Use `background` start for anything that runs longer than the tool call should: builds, test sweeps, long servers.",
			"Pick on_finish: notify (host only), wait (next turn sees it), interrupt (triggers a new turn immediately).",
			"With updates=true pass update_filter — only lines matching it arrive during the run.",
		],
		parameters: BackgroundParams,
		async execute(
			_toolCallId: string,
			params: {
				action: "start" | "status" | "log" | "kill" | "drain" | "tail";
				command?: string;
				job?: string;
				on_finish?: Delivery;
				updates?: boolean;
				update_mode?: Delivery;
				update_filter?: string;
				minutes?: number;
				after_bytes?: number;
			},
			ctx?: ExtensionToolContext,
		) {
			const cwd = safeCwd(ctx);

			const summary = (j: JobRecord): string =>
				`[${j.id}] ${j.status}${j.endedAt ? ` after ${Math.round((j.endedAt - j.startedAt) / 1000)}s` : ""} exit=${j.exitCode ?? "—"} :: ${clip(scrubCommand(j.command), 100)}`;

			switch (params.action) {
				case "start": {
					const command = (params.command ?? "").trim();
					if (!command) return makeResult("start needs a `command`.", { action: "start", job: "", ok: false });
					// validate update_filter compiles; refuse silently-broken filters
					if (params.updates && params.update_filter) {
						try {
							new RegExp(params.update_filter, "i");
						} catch (err) {
							return makeResult(`update_filter does not compile: ${clip(String(err), 120)}`, { action: "start", job: "", ok: false });
						}
					}
					const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
					fs.mkdirSync(path.join(jobsDir(cwd), LOGS_SUBDIR), { recursive: true });
					const logFile = path.join(jobsDir(cwd), LOGS_SUBDIR, `${id}.log`);
				// Create the log up front: the pump only appends, so a silent job (no
				// output) must still have a readable (empty) log for status/finish reads.
				fs.writeFileSync(logFile, "");
					const record: JobRecord = {
						id,
						command: clip(command, 400),
						startedAt: Date.now(),
						status: "running",
						onFinish: params.on_finish ?? "wait",
						updates: params.updates ?? false,
						updateMode: params.update_mode ?? (params.on_finish ?? "wait"),
						...(params.update_filter ? { updateFilter: clip(params.update_filter, 200) } : {}),
						logFile,
					};
					// shell:true with the command AS the file: node's own shell-line
					// handling. spawn("cmd", ["/c", line]) was measured broken on Windows for
					// lines with inner quotes (node re-quotes the argv element, cmd eats the
					// inner quotes: child exit 0 with NO output, no error - a silent lie).
					// shell:true composes the same cmd /d /s /c "line" form cmd itself
					// expects, so quoted commands work identically to a terminal.
					const child = spawn(command, {
						cwd,
						shell: true,
						detached: process.platform !== "win32", // POSIX: own process group, survives parent.
						stdio: ["ignore", "pipe", "pipe"],
						windowsHide: true,
					});
						for (const stream of [child.stdout, child.stderr]) {
							stream?.on("data", (chunk: Buffer) => {
								try {
									// Cap-aware append: past the cap the file is rewritten to its tail
									// (a chatty job cannot grow the log unboundedly).
									fs.appendFileSync(logFile, chunk);
									if (fs.statSync(logFile).size > MAX_LOG_BYTES) {
										const keep = readFileTail(logFile, MAX_LOG_BYTES / 2);
										try { fs.writeFileSync(logFile, keep); } catch { /* pump race: fine */ }
									}
								} catch { /* log full/locked: drop the chunk, not the job */ }
							});
						}
						child.stdout?.resume();
						child.stderr?.resume();
						child.unref();
						record.pid = child.pid;
						// Persist BEFORE arming the live map, so a reload/restore sees the record.
						const jobs = loadJobs(cwd);
						jobs.push(record);
						saveJobs(cwd, jobs);
						const entry = liveFor(cwd);
						entry.jobs.set(id, {
							child,
							record,
							lastSize: 0,
						});
						startPoller(pi, ctx as unknown as ExtensionContext, cwd);
						return makeResult(
							`Started ${id} (${record.onFinish} on finish${record.updates ? `, ${record.updateMode} on update` : ""}). Detached; use background status/log/kill to manage.`,
							{ action: "start", job: id, ok: true },
						);
				}
				case "status": {
					const jobs = loadJobs(cwd);
					if (jobs.length === 0) return makeResult("No background jobs tracked here.", { action: "status", jobs: [], ok: true });
					const lines = jobs.map(summary);
					return makeResult(lines.join("\n"), { action: "status", jobs: jobs.map((j) => ({ id: j.id, status: j.status })), ok: true });
				}
				case "log": {
					const target = findJob(cwd, params.job);
					if (!target) return makeResult('No job matching `job` (use background status).', { action: "log", ok: false });
					const { text, total } = readLogTail(target.logFile, Math.min(Math.max(params.after_bytes ?? 16_384, 512), 65_536));
					return makeResult(
						`[${target.id}] ${target.status} — ${total} bytes total; showing the tail:\n${text || "(no output yet)"}`,
						{ action: "log", job: target.id, ok: true },
					);
				}
				case "kill": {
					const target = findJob(cwd, params.job);
					if (!target) return makeResult('No job matching `job` (use background status).', { action: "kill", ok: false });
					const entry = liveFor(cwd);
					const lj = entry.jobs.get(target.id);
					let killed = false;
					if (lj) {
						try { lj.child.kill(); killed = true; } catch { /* already exiting */ }
					} else if (target.pid) {
						killed = tryKillPid(target.pid);
					}
					const jobs = loadJobs(cwd);
					const rec = jobs.find((j) => j.id === target.id);
					if (rec) {
						rec.status = "killed";
						rec.endedAt = Date.now();
						saveJobs(cwd, jobs);
					}
					// The poller will notice the corpse at the next tick; update the live map now.
					if (lj) entry.jobs.delete(target.id);
					return makeResult(`${target.id} kill ${killed ? "sent" : "requested"} (pid ${target.pid ?? "?"}).`, { action: "kill", job: target.id, ok: killed });
				}
				case "tail": {
					const target = findJob(cwd, params.job);
					if (!target) return makeResult('No job matching `job` (use background status).', { action: "tail", ok: false });
					// Second mode for update study: newer lines than the record remembers (no turn; return now)
					const { text, total } = readLogTail(target.logFile, Math.min(params.after_bytes ?? 32_768, 65_536));
					return makeResult(`[${target.id}] tail (${total} bytes total):\n${text || "(no output yet)"}`, { action: "tail", job: target.id, ok: true });
				}
				default: {
					const entry = liveFor(cwd);
					// drain: bounded wait INSIDE the tool call (the model asked to wait),
					// so a hung job cannot pin the session forever - the deadline always returns.
					const minutes = Math.min(Math.max(params.minutes ?? 30, 0.1), 120);
					const deadline = Date.now() + minutes * 60_000;
					pollOnce(cwd); // immediate pass so drain-after-finish reports instantly
					while (entry.jobs.size > 0 && Date.now() < deadline) {
						await new Promise((resolve) => setTimeout(resolve, 200));
						pollOnce(cwd);
						if (shuttingDown) break;
					}
					const running = [...entry.jobs.keys()];
					return makeResult(
						running.length
							? `Drain window (${minutes}m) elapsed; still running: ${running.join(", ")}`
							: `All tracked jobs finished.`,
						{ action: "drain", running, ok: running.length === 0 },
					);
				}
			}
		},
	});
}

/** Belt-and-braces pid kill for jobs whose child object is gone (reload). */
function tryKillPid(pid: number): boolean {
	try {
		if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
		else process.kill(pid, "SIGTERM");
		return true;
	} catch {
		return false;
	}
}

function findJob(cwd: string, idPrefix?: string): JobRecord | undefined {
	if (!idPrefix) return undefined;
	const jobs = loadJobs(cwd);
	return jobs.find((j) => j.id === idPrefix) ?? (jobs.filter((j) => j.id.startsWith(idPrefix)).length === 1 ? jobs.find((j) => j.id.startsWith(idPrefix)) : undefined);
}

function makeResult(text: string, details: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}
