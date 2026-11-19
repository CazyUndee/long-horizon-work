/** Windows-safe cleanup: detached children may hold dir handles a moment after
 * their exit; retry with backoff instead of failing a passing test on teardown. */
async function cleanup(dir) {
	for (let i = 0; i < 10; i++) {
		try { fs.rmSync(dir, { recursive: true, force: true }); return; }
		catch { await sleep(300); }
	}
	try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
// Functional battery for background-jobs.ts, run the same way as the goal suite:
// jiti against the pinned pi install, pi-mock harness, real child processes.
const { createRequire } = await import("node:module");
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");

const installRoot = os.homedir() + "/.pi/agent/install";
const rel = fs.readFileSync(installRoot + "/current-version", "utf8").trim();
const root = installRoot + "/releases/" + rel;
const req = createRequire("file:///" + root.replaceAll("\\", "/") + "/package.json");
const { createJiti } = req("jiti");
const NM = path.join(root, "node_modules");
const jiti = createJiti(import.meta.url, { fsCache: true,
	alias: {
		"@earendil-works/pi-coding-agent": path.join(NM, "@earendil-works/pi-coding-agent/dist/index.js"),
		"@earendil-works/pi-ai": path.join(NM, "@earendil-works/pi-ai/dist/compat.js"),
		typebox: path.join(NM, "@earendil-works/pi-tui/dist/index.js"),
		typebox2: path.join(NM, "typebox/build/index.mjs"),
	},
});
// note: alias key must be 'typebox' (the import specifier in the extension)
jiti.options.alias.typebox = path.join(NM, "typebox/build/index.mjs");

const EXT = path.join(import.meta.dirname, "..", "background-jobs.ts");

let passed = 0, failed = 0;
const failures = [];
function ok(name) { passed++; console.log(`  ok ${passed}. ${name}`); }
function fail(name, msg) { failed++; failures.push(`${name}: ${msg}`); console.log(`  FAIL ${name}: ${msg}`); }
async function assert(cond, name, msg = "") { if (cond) ok(name); else fail(name, msg || "assertion failed"); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
/** Poll-with-deadline: race-free evidence waiting (goal-tests idiom). */
async function pollTo(fn, ms, desc) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await fn()) return true;
		await sleep(50);
	}
	return false;
}

async function freshHarness() {
	const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "bg-jobs-"));
	const tools = {}, handlers = {}, sends = [], notifications = [];
	const fakeCtx = {
		hasUI: true, mode: "tui", isIdle: () => true, cwd: CWD,
		ui: { notify: (m) => notifications.push(String(m)) },
		sessionManager: { getBranch: () => [] },
	};
	const pi = {
		on: (e, fn) => { (handlers[e] ??= []).push(fn); return () => {}; },
		registerTool: (t) => { tools[t.name] = t; },
		registerCommand: () => {}, registerEntryRenderer: () => {}, registerShortcut: () => {}, registerFlag: () => {},
		appendEntry: () => {},
		sendMessage: (m, opts) => { sends.push({ m, opts }); },
		sendUserMessage: () => {},
		exec: async () => ({ stdout: "" }),
		events: { on: () => () => {}, emit: () => {} },
	};
	const mod = await jiti.import(EXT);
	await mod.default(pi);
	const call = (e, ev) => Promise.all((handlers[e] ?? []).map(h => h(ev, fakeCtx)));
	await call("session_start", { type: "session_start", reason: "startup" });
	const settle = () => call("agent_before_settle", {
		type: "agent_before_settle", outcome: "success",
		context: { contextMessages: [] },
	});
	return { CWD, tools, handlers, sends, notifications, call, settle };
}

const run = (h, params) => h.tools.background.execute("t0", params, {
	hasUI: true, cwd: h.CWD, ui: { notify: () => {} }, signal: new AbortController().signal,
});

// ---------------------------------------------------------------------------

console.log("\n[1] start + status + log");
{
	const h = await freshHarness();
	const res = await run(h, { action: "start", command: "node -e \"setTimeout(()=>console.log('OUT1 line'),120); setTimeout(()=>console.log('DONE final'),240)\"", on_finish: "wait" });
	assert(/Started job-/.test(res.content[0].text), "start returns an id");
	const id = res.details.job;
	const st = await run(h, { action: "status" });
	assert(st.content[0].text.includes(id), "status lists the job");
	await pollTo(async () => (await run(h, { action: "status" })).content[0].text.includes("finished"), 8000, "job finishes");
	const log = await run(h, { action: "log", job: id });
	assert(log.content[0].text.includes("OUT1 line"), "log shows output line");
	assert(log.content[0].text.includes("DONE final"), "log shows final line");
	await cleanup(h.CWD);
}

console.log("\n[2] on_finish=interrupt sends a triggerTurn message on exit");
{
	const h = await freshHarness();
	await run(h, { action: "start", command: "node -e \"console.log('quick')\"", on_finish: "interrupt" });
	const sent = await pollTo(async () => h.sends.length > 0 && /quick/.test(h.sends[0].m.content), 8000, "interrupt delivery");
	assert(sent, "interrupt delivery sends sendMessage", `sends=${JSON.stringify(h.sends)}`);
	if (sent) {
		assert(h.sends[0].opts?.triggerTurn === true, "interrupt triggers a turn", JSON.stringify(h.sends[0].opts));
		assert(h.sends[0].m.customType === "background-job", "customType is background-job");
	}
	await cleanup(h.CWD);
}

console.log("\n[3] on_finish=wait queues for the settle boundary");
{
	const h = await freshHarness();
	await run(h, { action: "start", command: "node -e \"console.log('wquick')\"" });
	await pollTo(async () => {
		await h.settle();
		return false; // settle result checked below after job exits
	}, 1, "noop");
	// wait for exit first, THEN poll until the settle handler actually returns
	// an injection (the poller delivers into `pending` on its 500ms tick).
	await pollTo(async () => (await run(h, { action: "status" })).content[0].text.includes("finished"), 8000, "wait-job exits");
	const injected = await pollTo(async () => {
		const settleResults = await Promise.all((h.handlers["agent_before_settle"] ?? []).map(fn => fn({
			type: "agent_before_settle", outcome: "success", context: { contextMessages: [] },
		}, { hasUI: true, cwd: h.CWD })));
		const first = settleResults.filter(Boolean)[0];
		return first && first.customType === "background-job" && /wquick/.test(first.content || "") ? first : undefined;
	}, 8000, "settle injects job summary");
	assert(injected, "settle injects the job summary with output", "no custom_message injection appeared within 8s");
	await cleanup(h.CWD);
}

console.log("\n[4] update_filter delivers only matching lines");
{
	const h = await freshHarness();
	await run(h, {
		action: "start",
		command: "node -e \"console.log('noise a');setTimeout(()=>console.log('PROGRESS 1'),100);setTimeout(()=>console.log('noise b'),160);setTimeout(()=>console.log('PROGRESS 2'),220)\"",
		updates: true, update_filter: "PROGRESS \\d", update_mode: "interrupt", on_finish: "notify",
	});
	// PROGRESS 1 at ~300ms, PROGRESS 2 at ~700ms; each should interrupt; noise must NOT.
	const got2 = await pollTo(async () => h.sends.filter(s => /PROGRESS \d/.test(s.m.content)).length >= 2, 10000, "two matching updates");
	assert(got2, "matching update lines delivered", `sends=${h.sends.map(s => s.m.content.slice(0, 40))}`);
	await pollTo(async () => h.sends.length >= 2, 8000, "no more sends than matches");
	// The delivery frame always includes the job's command line in the header, so
	// 'noise' appears by construction of OUR test command. What must NOT appear is
	// a delivery whose OUTPUT BODY (last line) is a noise line: updates carry one
	// matching line each, so a body that is exactly a noise line means a leak.
	const leaked = h.sends.filter(s => {
		const body = (s.m.content || "").split(String.fromCharCode(10)).pop().trim();
		return /^noise/.test(body);
	});
	assert(leaked.length === 0, "non-matching lines NOT delivered", JSON.stringify(leaked));
	await cleanup(h.CWD);
}

console.log("\n[5] kill stops a running job");
{
	const h = await freshHarness();
	const res = await run(h, { action: "start", command: "node -e \"setInterval(()=>{},10000)\"", on_finish: "notify" });
	const id = res.details.job;
	// (cycle 273) poll for the RUNNING state instead of a fixed 300ms sleep - kill
	// is asserted against a job status already reports as running.
	await pollTo(async () => (await run(h, { action: "status" })).content[0].text.includes("running"), 8000, "running before kill");
	const kill = await run(h, { action: "kill", job: id });
	assert(/kill sent/.test(kill.content[0].text), "kill reports sent", kill.content[0].text);
	const killedStatus = await pollTo(async () => (await run(h, { action: "status" })).content[0].text.includes("killed"), 8000, "status shows killed");
	assert(killedStatus, "job record marked killed");
	await cleanup(h.CWD);
}

console.log("\n[6] drain returns when all jobs finish");
{
	const h = await freshHarness();
	await run(h, { action: "start", command: "node -e \"setTimeout(()=>console.log('d1'),100)\"", on_finish: "notify" });
	const drain = await run(h, { action: "drain", minutes: 0.2 });
	assert(/All tracked jobs finished/.test(drain.content[0].text), "drain sees all finished", drain.content[0].text);
	await cleanup(h.CWD);
}

console.log("\n[7] bad update_filter refused at start");
{
	const h = await freshHarness();
	const res = await run(h, { action: "start", command: "echo hi", updates: true, update_filter: "([broken" });
	assert(/does not compile/.test(res.content[0].text), "uncompilable filter refused", res.content[0].text);
	assert(res.details.ok === false, "start refused");
	await cleanup(h.CWD);
}

console.log("\n[8] jobs.json survives; unique-prefix lookup");
{
	const h = await freshHarness();
	const res = await run(h, { action: "start", command: "node -e \"console.log('pfx')\"", on_finish: "notify" });
	const id = res.details.job;
	const raw = JSON.parse(fs.readFileSync(path.join(h.CWD, ".pi-jobs", "jobs.json"), "utf8"));
	assert(Array.isArray(raw) && raw[0].id === id, "jobs.json written with the record");
	await pollTo(async () => (await run(h, { action: "status" })).content[0].text.includes("finished"), 8000, "finish");
	const byPrefix = await run(h, { action: "log", job: id.slice(0, -2) });
	assert(byPrefix.details.job === id, "unique prefix resolves", JSON.stringify(byPrefix.details));
	await cleanup(h.CWD);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
// The pollers keep the process alive (they are unref'd in pi but the harness
// holds handler references); a passing battery must terminate deterministically.
process.exit(0);
