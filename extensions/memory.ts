/**
 * Memory Extension - persistent, cross-session memory for pi agents.
 *
 * MEMORY DIRECTORY: <agent-dir>/memory/ (user-global, cwd-independent):
 *   memory/MEMORY.md          The index: one bullet per fact file.
 *   memory/<slug>.md           One fact per file: frontmatter (title/type/created)
 *                              + human-readable body. Searchable, greppable, git-able.
 *
 * DESIGN: the diary (goal.ts) answers "what did I do and why"; memory answers
 * "what do I know". Different lifecycle: memory is curated facts, written rarely,
 * read often; the diary is an append-only log. Memory is USER-GLOBAL (not per
 * project) because hardware facts, paths, and lessons apply everywhere.
 *
 * INJECTION: before_agent_start adds a system-prompt section listing the memory
 * index (bounded to 1200 chars) so the model always KNOWS what it knows; the
 * `memory` tool reads/writes entries. Bare MEMORY.md index never contains fact
 * bodies, so injection cost stays ~100-300 tokens.
 *
 * TOOL (model-facing):
 *   memory(action=save, title, text, type)   Write a fact file + index it.
 *   memory(action=read, title)               Read one fact file (title or slug prefix).
 *   memory(action=search, query)             Grep every fact (title + body), newest first.
 *   memory(action=list)                      List the index.
 *   memory(action=delete, title)             Remove a fact file + index line.
 *
 * SAFETY & INVARIANTS (goal.ts lessons applied, hardened cycles 1-4):
 *   - Every persisted string passes scrubSecrets + stripC0 (secrets and terminal
 *     controls never reach disk or the injected prompt, including hostile/host-dropped
 *     files - the read path sanitizes too).
 *   - Fields capped (title 120, body 8000, files 500); reads bounded (64KB).
 *   - Save: same-title = revision; same-slug different-title = suffix (no silent
 *     overwrite); slug 'memory' reserved (case-insensitive-fs index aliasing).
 *   - Read/delete: exact slug > exact title > unique prefix > REFUSE naming the
 *     candidates (ambiguity never silently operates on the wrong fact).
 *   - Atomic writes with unique tmp names + the Windows EPERM/EEXIST retry ladder;
 *     every save sweeps stray .tmp files and ADOPTS orphan facts (crash recovery).
 *   - writeIndex dedupes by slug (cross-process invariant: one row per fact).
 *   - The index line is the injection's source of truth; writeIndex regenerates it
 *     from tool data on every mutation (perf cycle 3: no per-fact reads on the
 *     per-request path). Host edits to fact frontmatter propagate on the next
 * SAFETY ADDITION (goal-loop round 26): an lstat alias guard on the memory dir
 * plus writeIndex/readIndex/injectSection and a tool-entry gate - a symlink/junction
 * at the memory dir makes every operation refuse (victim junk-writes, exfiltration
 * and deletion were all verified then closed). Pinned by suite section 'memory alias'.
 *     save/delete; edit the index line for instant propagation.
 *   - Caches stat-keyed: external edits are visible on the next request.
 *
 * Regression contract: goal-tests/suite.mjs "memory" sections load this file via
 * the same jiti harness as the goal battery. Run node goal-tests/suite.mjs after
 * any edit here.
 */

import type {
	ExtensionAPI,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---- constants -------------------------------------------------------------

const SYSTEM_SECTION = "memory";
const INDEX_FILE = "MEMORY.md";
const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 8000;
const MAX_FILES = 500;
const MAX_FILE_BYTES = 64 * 1024;
const INJECT_MAX_CHARS = 1200;
const MEMORY_TYPES = ["fact", "project", "hardware", "lesson", "reference", "path"] as const;

/** Credential shapes must never persist. Mirrors goal.ts SECRET_PATTERNS (kept in
 * sync by hand; the goal.ts set is the canonical one - this is the same list). */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
	{ name: "api-key", re: /(?:sk|xox[bap]|AIza)[-_]?[A-Za-z0-9-]{12,}|sk-ant-(?:api03-)?[A-Za-z0-9-]{16,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9-]{16,}|(?:rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}|nvapi-[A-Za-z0-9-]{20,}|hf_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|lfu_[A-Za-z0-9_-]{12,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|dop_v1_[a-f0-9]{32,}/g },
	{ name: "bearer", re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g },
	{ name: "kv-pair", re: /(?:KEY|TOKEN|SECRET|PASS(?:WORD)?|api[_-]?key|auth[_-]?token|access[_-]?key|password)["']?\s*[=:]\s*["']?[^\s]{8,}/gi },
	{ name: "conn-string", re: /\b[\w+.-]+:\/\/[^/\s:]{0,64}:[^@\s]{1,128}@/g },
	{ name: "pem", re: /-{5}BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-{5}/g },
];

function scrubSecrets(text: string): string {
	let out = text;
	for (const { re } of SECRET_PATTERNS) out = out.replace(re, "[redacted api-key]");
	return out;
}

const truncate = (s: string, n: number) => (s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "…");

/** Strip ALL C0 controls (ESC/BEL/NUL/...) plus DEL: goal.ts pentest-round-7 lesson -
 * persisted strings render through the TUI and flow into injected prompts; an embedded
 * ESC or BEL can corrupt terminal state or smuggle OSC sequences. Newlines survive
 * here (fact bodies are multi-line prose); sanitizeOneline also collapses whitespace. */
function stripC0(text: string): string {
	return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ");
}
function sanitizeOneline(text: string): string {
	return stripC0(text).replace(/\s+/g, " ").trim();
}

// ---- directory layout ------------------------------------------------------

/** True when the memory dir itself is a symlink/junction (attacker-planted): every
 * op would read or write through it into a victim directory - writes land junk,
 * reads exfiltrate victim fact files into model context. Verified against this
 * extension (goal-loop round 26); guard pattern from the goal extension's lattice. */
function memoryDirIsAliased(): boolean {
	try {
		return fs.lstatSync(memoryDir()).isSymbolicLink();
	} catch {
		return false; // absent dir: not an alias
	}
}

/** The memory dir is user-global: <agent-dir>/memory. The agent dir is the
 * parent of the extensions dir this file lives in... but that is not reliable
 * when loaded via --extension or packages. Use PI_AGENT_DIR env if set, else
 * ~/.pi/agent. (pi itself sets the agent dir at startup; env is the documented
 * interaction point and survives all load paths.) */
function memoryDir(): string {
	const base = process.env.PI_AGENT_DIR
		? path.join(process.env.PI_AGENT_DIR, "memory")
		: path.join(os.homedir(), ".pi", "agent", "memory");
	try { fs.mkdirSync(base, { recursive: true }); } catch {
		// unwritable: tools will return graceful errors; injection just shows nothing
	}
	return base;
}

const indexPath = () => path.join(memoryDir(), INDEX_FILE);

function slugify(title: string): string {
	const s = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return s || "note-" + Date.now().toString(36);
}

let tmpCounter = 0;

/** Atomic write (temp + rename): goal.ts cycle-12 lesson - an in-place 'w' open
 * truncates through attacker-planted hardlink aliases; rename swaps the entry. */
function atomicWrite(filePath: string, data: string): void {
	// Unique tmp name per write: two processes writing the same file both used
	// "X.tmp" and the loser's rename threw ENOENT (reliability cycle 4, witnessed).
	const tmp = filePath + ".tmp-" + process.pid + "-" + (tmpCounter++) + "-" + Math.random().toString(36).slice(2, 8);
	fs.writeFileSync(tmp, data, "utf8");
	try {
		fs.renameSync(tmp, filePath);
	} catch (err) {
		// Windows EPERM/EEXIST/EACCES/EBUSY (AV scan or a concurrent same-target
		// rename): goal.ts's retry ladder - up to ~50ms, then copy+unlink fallback.
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EPERM" || code === "EEXIST" || code === "EACCES" || code === "EBUSY") {
			let renamed = false;
			for (let i = 0; i < 5 && !renamed; i++) {
				try { fs.renameSync(tmp, filePath); renamed = true; }
				catch { const end = Date.now() + 10; while (Date.now() < end) {} }
			}
			if (renamed) return;
			try { fs.copyFileSync(tmp, filePath); } finally { try { fs.unlinkSync(tmp); } catch {} }
			return;
		}
		try { fs.unlinkSync(tmp); } catch {}
		throw err;
	}
}

function readBounded(p: string): string {
	try {
		return fs.readFileSync(p, "utf8").slice(0, MAX_FILE_BYTES);
	} catch {
		return "";
	}
}

// ---- index -------------------------------------------------------------------

interface IndexEntry {
	slug: string;
	title: string;
	summary: string;
	type: string;
}
/**gorized The index file is markdown: "- [Title](slug.md) — summary". Host-editable;
 * re-parsed every read with a short stat-keyed cache (the digest-cache lesson:
 * 4 stats beat 30, external edits must be visible next request). */
let indexCache: { key: string; entries: IndexEntry[]; dropped: number } | undefined;

function readIndex(): IndexEntry[] {
	if (memoryDirIsAliased()) return []; // alias guard: refuse victim reads
	const dir = memoryDir();
	let key = "";
	try {
		const st = fs.statSync(indexPath());
		key = String(st.mtimeMs) + ":" + st.size;
	} catch {
		return []; // no index yet
	}
	let indexDroppedNow = 0;
	if (indexCache && indexCache.key === key) {
		indexDroppedNow = indexCache.dropped;
		return indexCache.entries;
	}
	const out: IndexEntry[] = [];
	const text = readBounded(indexPath());
	// Perf cycle 3: the index line IS the entry's source of truth (writeIndex
	// regenerates it from tool data on every save/delete). Re-reading every fact
	// file for frontmatter here was N+1: 500 facts = 500 file reads per cache miss,
	// 208-505ms measured. The '## <type>' heading above each group carries the type.
	// Contract: host edits to a fact file's frontmatter propagate to the injection on
	// the next save/delete (or by editing the index line). C0-hygiene (cycle 1) still
	// applies — host-writable text flows into prompts, so sanitizeOneline everything.
	let currentType = "fact";
	for (const line of text.split("\n")) {
		const heading = /^##\s+(.+)$/.exec(line.trim());
		if (heading) { currentType = sanitizeOneline(heading[1]).slice(0, 20) || "fact"; continue; }
		const m = /^- \[(.+?)\]\(([^)]+\.md)\)(?: — (.*))?$/.exec(line);
		if (!m) {
			// Fail-safe visibility: a malformed index line (e.g. a hand-edit using a
			// hyphen instead of the spaced em dash, or a missing .md) would otherwise
			// vanish silently - the fact becomes unaddressable and nobody is told.
			// Headings, blanks and the title parse null and don't count.
			if (/^- \[/.test(line)) indexDroppedNow++;
			continue;
		}
		const slug = path.basename(m[2], ".md");
		out.push({ slug, title: sanitizeOneline(m[1]), summary: truncate(sanitizeOneline(m[3] || ""), 140), type: currentType });
	}
	indexCache = { key, entries: out, dropped: indexDroppedNow };
	return out;
}

/** Parse-drop count from the last readIndex pass (0 when no fresh parse ran or
 * the index is clean). Surfaces malformed hand-edits (fail-safe visibility). */
function readIndexDropped(): number {
	return indexCache?.dropped ?? 0;
}

/** Crash recovery at mutation time (reliability cycle 4), bounded and best-effort:
 * F1: stray *.tmp files from crashed atomic writes get swept (they are never valid data —
 *     the rename either completed or the tmp is garbage).
 * F4: fact files missing from the index (crash between fact-write and index-write, or a
 *     lost cross-process update) get ADOPTED: parsed frontmatter first, filename-slug
 *     fallback, so the fact is searchable/addressable again instead of half-dead.
 * Runs inside save(): the one moment we already hold write intent. */
function recoverDirectory(dir: string, entries: IndexEntry[]): void {
	try {
		for (const f of fs.readdirSync(dir)) {
			if (f.includes(".tmp-") || f.endsWith(".tmp")) {
				try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* best effort */ }
			}
		}
	} catch { /* dir unreadable: tools fail loudly elsewhere */ }
	try {
		const known = new Set(entries.map((e) => e.slug));
		const adopted = new Set<string>();
		for (const f of fs.readdirSync(dir)) {
			if (!f.endsWith(".md") || f === INDEX_FILE) continue;
			const slug = path.basename(f, ".md");
			if (known.has(slug)) continue;
			// orphan: parse enough frontmatter to adopt cleanly
			const head = readBounded(path.join(dir, f)).split("\n").slice(0, 8).join("\n");
			const fmTitle = sanitizeOneline(/^title:\s*(.+)$/m.exec(head)?.[1] ?? "");
			const fmType = /^type:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? "fact";
			const bodyLine = head.split("\n").find((l) => l && !l.startsWith("---") && !/^\w+:/.test(l) && !l.startsWith("#"));
			if (!adopted.has(slug)) { adopted.add(slug); entries.push({ slug, title: fmTitle || slug, summary: truncate(sanitizeOneline(bodyLine ?? ""), 140), type: sanitizeOneline(fmType).slice(0, 20) }); }
		}
	} catch { /* best effort */ }
}
function writeIndex(entries: IndexEntry[]): void {
	if (memoryDirIsAliased()) return; // alias guard: refuse victim writes
	// Cross-process invariant: one index row per slug. Concurrent writers can both
	// merge the same entry (or a retry overlap); last-write-wins here so the index
	// never carries duplicates that would poison resolveEntry's ambiguity check.
	const bySlug = new Map<string, IndexEntry>();
	for (const e of entries) bySlug.set(e.slug, e);
	const deduped = [...bySlug.values()];
	// stable order: type then title
	const sorted = [...deduped].sort((a, b) => (a.type + a.title).localeCompare(b.type + b.title));
	const lines = ["# Memory Index", ""];
	let lastType = "";
	for (const e of sorted) {
		if (e.type !== lastType) { lines.push("", "## " + e.type); lastType = e.type; }
		lines.push(`- [${e.title}](${e.slug}.md)${e.summary ? " — " + e.summary : ""}`);
	}
	atomicWrite(indexPath(), lines.join("\n") + "\n");
}

// ---- prompt injection ----------------------------------------------------------

let injectCache: { key: string; text: string } | undefined;

function injectSection(): string | undefined {
	if (memoryDirIsAliased()) return undefined; // alias guard
	const dir = memoryDir();
	let key = "";
	try {
		const st = fs.statSync(indexPath());
		key = String(st.mtimeMs) + ":" + st.size;
	} catch {
		return undefined; // no index file yet, nothing to inject
	}
	if (injectCache && injectCache.key === key) return injectCache.text;
	const entries = readIndex();
	if (entries.length === 0) return undefined;
	const lines = [
		"Persistent memory (user-global, ~/.pi/agent/memory/): facts you or past sessions saved.",
		"INDEX (use the `memory` tool with action \"read\"/\"search\" for details):",
	];
	let chars = 0;
	for (const e of entries) {
		const line = sanitizeOneline(`- [${e.type}] ${truncate(e.title, 80)}${e.summary ? " — " + truncate(e.summary, 90) : ""}`);
		if (chars + line.length > INJECT_MAX_CHARS) { lines.push("... (more in the index; `memory` action \"list\")"); break; }
		chars += line.length + 1;
		lines.push(line);
	}
	const text = lines.join("\n");
	injectCache = { key, text };
	return text;
}

/** Shared match resolution for read/delete (pentest cycle 2): exact slug > exact
 * title > unique prefix > REFUSE with candidates. A find()-first match silently
 * operated on the wrong fact when two share a prefix - data destruction class. */
function resolveEntry(entries: IndexEntry[], qRaw: string): { entry?: IndexEntry; ambiguous?: string[]; error?: string } {
	const q = sanitizeOneline(qRaw).toLowerCase();
	if (!q) return { error: "empty query" };
	const exactSlug = entries.find((e) => e.slug === q);
	if (exactSlug) return { entry: exactSlug };
	const exactTitle = entries.find((e) => e.title.toLowerCase() === q);
	if (exactTitle) return { entry: exactTitle };
	const pref = entries.filter((e) => e.slug.startsWith(q) || e.title.toLowerCase().startsWith(q));
	if (pref.length === 1) return { entry: pref[0] };
	if (pref.length > 1) return { ambiguous: pref.map((e) => e.slug) };
	const incl = entries.filter((e) => e.title.toLowerCase().includes(q));
	if (incl.length === 1) return { entry: incl[0] };
	if (incl.length > 1) return { ambiguous: incl.map((e) => e.slug) };
	return {};
}

// ---- extension ---------------------------------------------------------------

export default function memoryExtension(pi: ExtensionAPI): void {
	// Cache invalidation signal between processes: none needed - stat-keyed per request.

	pi.on("before_agent_start", async (event) => {
		const text = injectSection();
		if (text) event.systemPromptOptions.sections[SYSTEM_SECTION] = text;
	});

	const Params = Type.Object({
		action: Type.Optional(StringEnum(["save", "read", "search", "list", "delete"])),
		title: Type.Optional(Type.String({ description: "Fact title (save/read/delete): short, distinctive" })),
		text: Type.Optional(Type.String({ description: "Fact body (save): the knowledge worth keeping" })),
		type: Type.Optional(StringEnum([...MEMORY_TYPES])),
		query: Type.Optional(Type.String({ description: "Search term (action=\"search\")" })),
	});

	pi.registerTool({
		name: "memory",
		label: "Memory",
		description:
			"Persistent cross-session memory (~/.pi/agent/memory/): save facts worth keeping - project paths, " +
			"machine/hardware info, API quirks, lessons learned, useful references. " +
			"action=\"save\" (title, text, type) writes a fact file and indexes it; " +
			"action=\"read\" fetches one fact; action=\"search\" greps all facts; action=\"list\" shows the index. " +
			"Memory is user-global: entries apply in every project and survive restarts.",
		promptSnippet: "Save and recall durable facts (paths, hardware, lessons) with `memory`",
		promptGuidelines: [
			"Save a memory when you learn a durable, reusable fact: where a project lives, how this machine is set up, a provider quirk, a lesson that cost time. Save the lesson once, not the struggle.",
			"Before long or unfamiliar work in a new area, `memory` action \"search\" for what past sessions already learned.",
			"Do not save volatile state, secrets (they are scrubbed anyway), or things already in the diary (that is the event log; memory is the knowledge base).",
			"One fact per save; a specific title beats a broad one. type= one of: path, project, hardware, lesson, fact, reference.",
		],
		parameters: Params,
		executionMode: "sequential",
		async execute(_toolCallId: string, params: any, _ctx?: ExtensionToolContext) {
			const action = params.action ?? "save";
			const dir = memoryDir();
			if (memoryDirIsAliased()) {
				return { content: [{ type: "text", text: "Refusing: memory directory is a symlink/junction - no reads, writes, search or delete through it." }], details: { action, message: "aliased" }, isError: true };
			}

			// ---- list ----
			if (action === "list") {
				const entries = readIndex();
				return {
					content: [{
						type: "text",
						text: (entries.length
							? entries.map((e) => sanitizeOneline(`- [${e.type}] ${e.title}${e.summary ? " — " + e.summary : ""}`)).join("\n")
							: "Memory index is empty.") +
							(readIndexDropped() > 0
								? `\n\nWARNING: ${readIndexDropped()} index line(s) malformed and skipped - those facts are NOT addressable until the index line matches '- [title](slug) — summary' (spaced em dash). Fix the MEMORY.md line(s).`
								: ""),
					}],
					details: { action, message: "listed" },
				};
			}

			// ---- save ----
			if (action === "save") {
				const title = truncate(scrubSecrets(sanitizeOneline(String(params.title ?? ""))), MAX_TITLE_CHARS);
				const body = truncate(scrubSecrets(stripC0(String(params.text ?? "")).trim()), MAX_BODY_CHARS);
				if (!title || !body) {
					return { content: [{ type: "text", text: "Save needs a title and text." }], details: { action, message: "missing fields" }, isError: true };
				}
				const type = MEMORY_TYPES.includes(params.type) ? params.type : "fact";
				// update-in-place if the slug matches an existing file (same-title = revision)
				let slug = slugify(title);
				// Reserve: on case-insensitive filesystems slug 'memory' aliases the MEMORY.md index itself.
				if (slug.toLowerCase() === INDEX_FILE.replace(/\.md$/, "").toLowerCase()) {
					slug = slug + "-fact";
				}
				// Pentest cycle 2 (A): same-slug with DIFFERENT title is a collision with an
				// unrelated fact - suffix until free instead of silently overwriting it.
				const entriesSoFar = readIndex();
				const owner = entriesSoFar.find((e) => e.slug === slug);
				if (owner && owner.title.toLowerCase() !== title.toLowerCase()) {
					let i = 2;
					while (entriesSoFar.some((e) => e.slug === slug + "-" + i)) i++;
					slug = slug + "-" + i;
				}
				const filePath = path.join(dir, slug + ".md");
				const created = new Date().toISOString();
				const file =
					`---\ntitle: ${title.replace(/\n/g, " ")}\ntype: ${type}\ncreated: ${created}\n---\n\n${body}\n`;
				try {
					const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".md") && n !== INDEX_FILE) : [];
					if (names.length >= MAX_FILES && !fs.existsSync(filePath)) {
						return { content: [{ type: "text", text: `Memory full (${MAX_FILES} files). Delete something first.` }], details: { action, message: "full" }, isError: true };
					}
					atomicWrite(filePath, file);
				} catch (err) {
					return { content: [{ type: "text", text: `Failed to write memory: ${err instanceof Error ? err.message : String(err)}` }], details: { action, message: "write failed" }, isError: true };
				}
				// index upsert
				const droppedAtRead = readIndexDropped(); // captured BEFORE writeIndex erases malformed lines
				const entries = readIndex().filter((e) => e.slug !== slug);
				// Reliability cycle 4 (F1+F4): in-memory index merge is unsafe across
				// processes, and both crash windows leave disk residue. Recover-bounded:
				// sweep stray .tmp (crashed atomic writes), then adopt orphan facts (files
				// missing from the index after a crash between fact-write and index-write).
				recoverDirectory(dir, entries);
				entries.push({ slug, title, summary: truncate(body.replace(/\s+/g, " "), 140), type });
				writeIndex(entries);
				// F3 lost-update check: a concurrent process may have rotated the index
				// between our read and write (its record clobbered by ours). Re-read once;
				// if a DIFFERENT record vanished, merge it back (bounded to one retry).
				const after = readIndex();
				if (!after.some((e) => e.slug === slug)) {
						// ours vanished too (we lost to a later writer): adopt-and-merge
						const merged = after.filter((e) => !e.slug.startsWith(slug));
						merged.push({ slug, title, summary: truncate(body.replace(/\s+/g, " "), 140), type });
						writeIndex(merged);
				}
				return {
					content: [{
						type: "text",
						text: `Memory saved: "${title}" (${type}, ${slug}.md). It is now in every future session's prompt index and searchable with action "search".` +
							(droppedAtRead > 0 ? ` WARNING: ${droppedAtRead} malformed index line(s) just ERASED by this save's index regeneration - if those were real facts, their files may still exist; re-save them or fix the hand-edited line format ('- [title](slug) — summary').` : ""),
					}],
					details: { action, title, message: "saved" },
				};
			}

			// ---- read ----
			if (action === "read") {
				const { entry, ambiguous, error } = resolveEntry(readIndex(), String(params.title ?? params.query ?? ""));
				if (error) return { content: [{ type: "text", text: 'Read needs a title (slug-prefix match).' }], details: { action, message: "no title" }, isError: true };
				if (ambiguous) return { content: [{ type: "text", text: `Ambiguous: matches ${ambiguous.length} memories (${ambiguous.join(", ")}). Give more characters.` }], details: { action, message: "ambiguous" }, isError: true };
				if (!entry) return { content: [{ type: "text", text: 'No memory matching. action "list" shows the index.' }], details: { action, message: "not found" } };
				const body = stripC0(readBounded(path.join(dir, entry.slug + ".md")));
				return { content: [{ type: "text", text: body.trim() || "(empty file)" }], details: { action, title: entry.title, message: "read" } };
			}

			// ---- search ----
			if (action === "search") {
				const query = String(params.query ?? params.title ?? "").trim().toLowerCase();
				if (!query) return { content: [{ type: "text", text: 'Search needs a query.' }], details: { action, message: "no query" }, isError: true };
				const hits: string[] = [];
				try {
					const names = fs.readdirSync(dir).filter((n) => n.endsWith(".md") && n !== INDEX_FILE).sort();
					// newest-first-ish: reverse alpha by slug is fine (slugs are stable)
					for (const n of [...names].reverse()) {
						const raw = readBounded(path.join(dir, n));
						if (raw.toLowerCase().includes(query)) {
							const fmTitle = sanitizeOneline(/^title:\s*(.+)$/m.exec(raw)?.[1] ?? "") || n;
							hits.push(`- ${fmTitle} (${n})`);
						}
						if (hits.length >= 20) break;
					}
				} catch { /* dir unreadable */ }
				return {
					content: [{ type: "text", text: hits.length ? `Memory search "${String(query).slice(0, 60)} (of ${query.length})":\n${hits.join("\n")}` : `No memories match "${String(query).slice(0, 60)} (of ${query.length})".` }],
					details: { action, message: "searched" },
				};
			}

			// ---- delete ----
			if (action === "delete") {
				const { entry, ambiguous, error } = resolveEntry(readIndex(), String(params.title ?? ""));
				if (error) return { content: [{ type: "text", text: 'Delete needs a title.' }], details: { action, message: "no title" }, isError: true };
				if (ambiguous) return { content: [{ type: "text", text: `Ambiguous: matches ${ambiguous.length} memories (${ambiguous.join(", ")}). Refusing to delete - give more characters.` }], details: { action, message: "ambiguous" }, isError: true };
				if (!entry) return { content: [{ type: "text", text: 'No memory matching.' }], details: { action, message: "not found" }, isError: true };
				try { fs.rmSync(path.join(dir, entry.slug + ".md"), { force: true }); } catch { /* best effort */ }
				writeIndex(readIndex().filter((e) => e.slug !== entry.slug));
				return { content: [{ type: "text", text: `Memory deleted: "${scrubSecrets(String(entry.title)).slice(0, 60)}".` }], details: { action, title: entry.title, message: "deleted" } };
			}

			return { content: [{ type: "text", text: `Unknown action "${action}".` }], details: { action, message: "bad action" }, isError: true };
		},
	});
}