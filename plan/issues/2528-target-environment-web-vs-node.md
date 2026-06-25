---
id: 2528
title: "Target environment model (web vs node): scope the ambient global surface so e.g. window.stop isn't in a node host's lib"
status: done
completed: 2026-06-25
assignee: ttraenkler/sdev-2528-2645
sprint: Backlog
created: 2026-06-20
updated: 2026-06-25
priority: low
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: target-environment
goal: usability
related: [2520, 1044]
---

## Problem / proposal

The compiler loads the DOM lib (`lib.dom.d.ts`) for the ambient global surface
regardless of what the output actually targets. So a **node/WASI-style host** has
browser globals like `window`, `alert`, `scroll`, `stop`, `document` in scope —
which makes no sense for it, and (before #2520's gate) flooded it with host-import
warnings. Conversely a **web** target legitimately has those and not node's
`process`/`Buffer`.

Proposal: a way to declare the target **environment** — e.g. `--platform web|node`
(or `--env`) — that selects which ambient globals are in scope:

- `node` → node-style globals (`process`, `Buffer`, …) are **in scope with their
  types auto-provided**, so `process.stdin.read(...)` resolves with **no
  "Cannot find name 'process'" (TS2580) warning** — the user no longer needs a
  hand-written `declare const process` (which bundlers like `bun build` strip).
  DOM/window globals are *not* declared, so `window.stop` is a clear error.
- `web` → DOM globals + their types in scope; node-only globals are not.

The "auto-provide the environment's ambient types" part is the direct fix for the
`process` warnings on loopdive/js2#389: today `process` is *supported* under
`--target wasi` (lowered to WASI fd syscalls) but has no ambient type unless the
user declares one, so every use warns. A `node` environment should ship those
types so referencing `process` Just Works.

Today these are decoupled from `--target wasi`/`--standalone`, which describe the
*backend*, not the host environment.

## Why now / relation to #2520

#2520 added a referenced-names gate so unused ambient globals no longer register
as host imports — so the *noise* is already gone. This issue is the deeper model:
make the ambient surface itself correct per environment, so misuse (`window.stop`
in a node host) is a **type error** rather than a dropped import, and so the
right globals are available without `@types/node`-style setup.

## Open questions (route to architect/PO)

- Flag name/shape (`--platform web|node`, `--env`, or infer from `--target`?).
- How it maps to the TS `lib`/`types` program options and the `LIB_GLOBALS` /
  `DOM_ONLY_GLOBALS` sets in `src/codegen/index.ts`.
- Interaction with the dual-mode allowlist and the Node-builtins-as-host-imports
  work (#1044).
- Default when unspecified (today's behaviour = DOM in scope).

## Notes

Surfaced while investigating loopdive/js2#389 (a node/WASI Native Messaging host
that had `window.stop` etc. in scope). Lower priority now that #2520 removed the
warning noise; this is the correctness/ergonomics follow-up.

## Resolution (2026-06-25, with #2645)

Added a `--platform node|web` CLI flag + `CompileOptions.platform?: "web" | "node"`
(threaded CLI → `compile()` opts → `analyzeSource`/`analyzeMultiSource`/the
incremental language service). It scopes the **ambient global surface** —
orthogonal to the backend `--target`:

- The unconditional `lib.d.ts` composite (ES base + `lib.dom.d.ts`) is now built
  from a shared `ES_BASE_LIB_NAMES` list. A second composite,
  `lib.no-dom.d.ts` (`DOM_FREE_LIB_NAME`), is the same ES base **without**
  `lib.dom.d.ts`. The two are distinct cache keys / default-lib names so one
  process can compile both web and node programs without cross-contamination
  (`src/checker/index.ts`: `getLibSource`, `isKnownLibName`, `preloadLibFiles`).
- `getDefaultLibFileName` selects the composite per platform
  (`defaultLibNameForPlatform`): `--platform node` → DOM-free (so `window.stop`
  is a clear unresolved-name diagnostic), `--platform web` / unset → DOM.
- **Default is byte-neutral**: when `platform` is unset the DOM composite loads
  exactly as before and `emulateNode` is driven solely by its own option, so the
  common (web / test262) path is unchanged. Verified by a sha256 byte-equality
  test (unset == web == node for a DOM/node-free program) and a green
  `runTest262File` run.

Composition with the #1772 capability gate is #2645:
`emulateNode ||= platform === "node"` (`resolveEmulateNode` in the checker +
`effectiveEmulateNode` in `src/compiler.ts`), so `--platform node` implies the
Node-emulation injection path and the TS2580 message gate agrees. The per-member
`providersFor` gate stays the authority for importable `node:<mod>` members;
`--platform` only sets the ambient default.

Precedence vs `--target wasi`: independent axes. `--platform` wins for the
ambient surface; `--target` still governs the backend (so a DOM-only global
under `--target wasi` is still rejected by the existing WASI DOM-usage gate).
When `platform` is unset, a `wasi`/`standalone` target does **not** implicitly
drop the DOM ambient surface — that would change today's output; pass
`--platform node` explicitly.

Tests: `tests/issue-2528-2645-platform-node-web.test.ts`.
