# Build stamp - long-horizon-work 1.0.0

Gates run at package-build time against THIS tree (extensions/ copies):

- suite.mjs: **97/97 passed** (forward order)
- suite.mjs --reverse: **97/97 passed** (order-independence)
- Rationale for each remaining battery (kept standing in tests/): holder
  (daemon holder source), conformer (diary repair), race226 (cross-process
  diary appends), race250 (inbox vs answers-reader), bg (background-jobs).

Built: 2026-11-19 19:20 UTC
Suite resolver: this tree, PACKAGE layout (tests/../extensions/goal.ts), via the
dual-layout EXT in suite.mjs (dev layout goal-tests/../goal.ts still supported).

The suite bootstrap resolves pi + jiti from the LIVE ~/.pi/agent/install release
(current-version discovery), so re-run gates after installing the package to
re-verify on your exact runtime:

    node tests/suite.mjs
