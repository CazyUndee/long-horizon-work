# long-horizon-work

A [pi](https://pi.dev) package for long-horizon work: everything an agent needs to run for
hours to days without an operator — persistent goals and autonomous improvement loops, durable
diary memory, cross-session memory, a host task inbox, detached fleets of agent workers,
long-running job control, and speed telemetry.

## What's inside

Five extensions, one package:

| Extension | What it does |
|---|---|
| **goal.ts** | The `/goal` system: single-shot goals and open-ended `improve` loops (`/goal loop <mandate>`), focus rotation (hardening → pentest → performance → reliability → capability → quality), pause/resume/cycles/summary/dashboard/health/doctor, cross-workspace `fleet` views with staleness verdicts, `today` morning briefing, `uptime` overnight verdict, `journal`/`notes` reads, session browser, a host task inbox with bell + OSC 777 notifications, and a detached daemon holder. Plus the `diary` tool — the loop's durable memory across compactions (write/search/amend; every cycle records what/how/why). |
| **memory.ts** | A persistent user-global memory file: facts, lessons, project paths, hardware quirks — searchable and indexed across sessions. |
| **background-jobs.ts** | The `background` tool family: fire-and-forget long jobs (builds, test sweeps, servers) with status/log/tail/kill management, and result re-injection on the agent's terms (notify / wait / interrupt). |
| **session-fleet.ts** | `/save` and `/load` for the *set* of open pi sessions: every running instance heartbeats its session file + cwd; `/save` snapshots the fleet, `/load [file]` restores all saved sessions as tabs in one terminal window (Windows Terminal first, per-window fallback), skipping already-open ones. Crashed instances self-clean from heartbeats. |
| **speed.ts** | `/speed` — the current model's average output tokens/sec, computed from the session's own assistant messages and timestamps. |

## Design notes

- **Loops never park on the operator.** Judgment is the loop's job: decide, act, record the
  reasoning. Only resource-gated items (credentials, admin/production access, purchase
  approvals, physical actions) become host tasks.
- **Loops don't self-stop.** A `loop`-mode goal runs until the operator pauses or clears it;
  auto-compaction at 80% keeps it alive through long nights.
- **Hostile-input hardening everywhere.** Every agent-, operator- or file-toucher-writable
  field is scrubbed, clipped, and capped at both parse and render boundaries; IO is tail-bounded
  on every read; alias/junction guards protect all read paths; caps (500-file, 60-workspace)
  bound every scan.
- **The diary is the heartbeat.** One recorded entry per cycle — it doubles as the liveness
  signal for `uptime` and the staleness verdict in `fleet`.

## Install

```bash
pi install git:github.com/CazyUndee/long-horizon-work
# or once published to npm:
pi install npm:long-horizon-work
# or from a local checkout:
pi install ./pi-goal-package
```

Personal installs live in `~/.pi/agent/settings.json`; use `--local` for project-scoped;

```bash
pi -e ./pi-goal-package   # try it for one invocation
```

## The standing test suite

Regression batteries ship in `tests/` and run against the extensions in either layout:

```bash
node tests/suite.mjs            # 97 sections; --reverse proves order-independence
node tests/holder-battery.mjs   # daemon holder source: parse, handoff, alias drop
node tests/conform-battery.mjs  # diary repair tool invariants
node tests/race226.mjs          # 4-process diary append race
node tests/race250.mjs          # inbox writers vs answers-reader race
node tests/bg-battery.mjs       # background-jobs functional battery
```

The suite resolves pi and jiti from the live `~/.pi/agent/install` tree (whichever release is
current), so it exercises the exact runtime the extensions load under. It finds the extensions
both in the dev layout (`goal-tests/../goal.ts`) and the package layout
(`tests/../extensions/goal.ts`); batteries accept a `PI_GOAL_EXT` env override.

`tests/crlf-install.cjs` is the standing installer for goal.ts edits: it refuses any save that
would introduce bare LF line endings (the extension is CRLF-pure) and requires unique line
anchors.

## Layout

```
pi-goal-package/
├── package.json            # pi manifest: five extensions; peer deps only
├── extensions/
│   ├── goal.ts             # /goal + diary + daemon + fleet views
│   ├── memory.ts           # persistent cross-session memory
│   ├── background-jobs.ts  # background job tool family
│   ├── session-fleet.ts    # detached session workers
│   └── speed.ts            # run telemetry
└── tests/                  # stand-alone regression batteries
```

Runtime dependencies: none beyond pi's host-provided packages (peer-declared).
No network access, no telemetry beyond local logs.

State lives in: `~/goal-diary/` (durable memory), `~/goal-inbox/` (host task inbox),
`~/.pi-goal/` per workspace (goal state + daemon info). All writes are queue-serialized and
tail-bounded.

## Requirements for running the test suite

The suite exercises the extension against the **pi runtime it will actually load under**: it
resolves pi + jiti from the live `~/.pi/agent/install` tree. That means running the batteries
requires a machine with pi installed (the developer/CI machine later, not a bare runner):
`pi` itself must be present. On a machine without pi, the extension still installs and loads
(the `peerDependencies` are host-provided at load time).
