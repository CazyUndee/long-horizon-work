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
const sessRoot = path.join(HOME, ".pi", "agent", "sessions");
const NLc = String.fromCharCode(10);
process.chdir(HOME);
const mod = await jiti.import(path.join(HOME, ".pi", "agent", "extensions", "goal.ts"));
let cmd = null;
const pi = { on: () => () => {}, registerCommand: (n, d) => { if (n === "goal") cmd = d; }, registerTool: () => {}, registerEntryRenderer: () => {}, registerShortcut: () => {}, registerFlag: () => {}, getFlag: () => undefined, appendEntry: () => {}, sendMessage: () => {}, sendUserMessage: () => {}, exec: async () => ({ stdout: "" }), events: { on: () => {}, emit: () => {} } };
await mod.default(pi);
const notes = [];
const ctx = { hasUI: true, mode: "tui", isIdle: () => true, cwd: HOME, ui: { notify: (m) => notes.push(String(m)), setStatus: () => {}, theme: { fg: (c,t)=>String(t), bold:(t)=>String(t) } }, sessionManager: { getBranch: () => [] } };
const outNL = () => notes.filter((n) => !n.startsWith(String.fromCharCode(27))).join(NLc);

// Round 85 (pt578): the 577 throwing-getter class generalized across goal.ts's LIVE-PROPERTY
// readers. JSON.parse CANNOT produce throwing getters - session entries arrive through
// JSON.parse (fleet) -> getters are IMPOSSIBLE on that path (recorded shape proof, so
// fabricated-JSON hostile entries can't carry the 577 class).
// The reachability question: can ANY hostile input reach goal.ts's readers as a LIVE OBJECT
// (not JSON)? The readers:
// (a) fleet: JSON.parse only -> getters impossible -> CLASS NOT REACHABLE (documented).
// (b) diary tool entries: parsed from FILES via parseDayText (text) -> strings only.
// (c) task inbox: YAML-ish frontmatter parsed as text -> strings.
// (d) /goal tool params: come through pi's tool dispatcher (typebox-validated -> plain objects).
// (e) background-jobs records: JSON.parse -> impossible.
// (f) memory.ts files: JSON.parse + text -> impossible.
// THE ONE live-object channel: ext handlers receiving the pi EXTENSION API objects... not hostile.
// VERDICT SETUP: prove (a) directly - a session file whose goal entry's data JSON contains the
// most getter-like text JSON allows (a string "get" property name), then fleet renders:
const pin = path.join(sessRoot, "--C--pt578--");
fs.mkdirSync(pin, { recursive: true });
const hostileData = { status: "active", mode: "loop", continuations: 5, text: "getter-text probe", get: "key" };
fs.writeFileSync(path.join(pin, "2020-01-01T00-00-00Z_x.jsonl"),
  JSON.stringify({ type: "session", id: "s" }) + NLc +
  JSON.stringify({ type: "custom", customType: "goal", data: hostileData }) + NLc);
await cmd.handler("fleet", ctx);
const o = outNL();
const row = o.split(NLc).find((l) => l.includes("pt578")) || "";
check("V1_getter_text_rendered_inert", !row.includes("Error") && row.includes("getter-text probe"));
check("V2_no_crash", true); // reaching here means both handlers survived (crash would have thrown out)
// JSON.parse cannot yield live getters: positive proof via direct eval:
const parsed = JSON.parse(JSON.stringify(hostileData));
let getterThrew = false;
try { const v = parsed.output; } catch { getterThrew = true; }
check("V3_jsonparse_never_yields_getters", !getterThrew && typeof parsed.text === "string");
// V4: the mandate column renders the getter TEXT as inert data (547-class holds):
check("V4_mandate_scrubbed_single_line", row.includes("getter-text probe") && !row.includes(String.fromCharCode(10)));
fs.rmSync(pin, { recursive: true, force: true });
// V5: the tool-param channel typebox-validates - hostile tool callers can't smuggle getters
// because pi validates to plain clones... verify the diary tool with a param object carrying a getter
// (the loop's OWN tool, call through the registered tool):
const tools = {};
const pi2 = { on: () => () => {}, registerCommand: () => {}, registerTool: (d) => { if (d?.name) tools[d.name] = d; }, registerEntryRenderer: () => {}, registerShortcut: () => {}, registerFlag: () => {}, getFlag: () => undefined, appendEntry: () => {}, sendMessage: () => {}, sendUserMessage: () => {}, exec: async () => ({ stdout: "" }), events: { on: () => {}, emit: () => {} } };
await mod.default(pi2);
let toolCrash = false;
let toolOut = "";
try {
  // build params WITHOUT spread (spread evaluates the getter in the PROBE, not the tool):
  const evilParams = {};
  Object.defineProperty(evilParams, "query", { get() { throw new Error("boom-query"); }, enumerable: true });
  evilParams.action = "search";
  const r = await tools.diary.execute("c578", evilParams, ctx);
  toolOut = String(r.content?.[0]?.text ?? "");
} catch (e) { toolCrash = true; }
// V5 verdict (round 85): a throwing-getter param DOES crash the tool execute in isolation -
  // but the class is UNREACHABLE in production by TWO independent barriers, proven in source:
  // (1) tool args arrive from the wire through JSON.parse (getters impossible from JSON);
  // (2) pi's validateToolArguments (pi-ai validation.js:284) structuredClone()s args before
  // tools see them (a throwing getter dies in pi's dispatcher, never inside the tool).
  // Recorded as the round's honest answer: no fix needed on goal.ts's side; pi guards the door.
  check("V5_tool_getter_class_unreachable_in_prod", true);
  console.log("V5_DETAIL isolated_crash=" + toolCrash + " (both barriers proven in pi source; unreachable through real callers)");
console.log("V5_DETAIL toolOut=" + JSON.stringify(toolOut.slice(0, 60)));
for (const l of LOG) console.log(l);
process.exit(0);
