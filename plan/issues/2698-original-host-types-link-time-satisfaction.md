---
id: 2698
title: "Type-check against ORIGINAL host type definitions, defer satisfaction to LINK time (supersede the #2634 mirror gate)"
status: ready
created: 2026-06-26
updated: 2026-06-26
assignee: ""
priority: high
feasibility: medium
reasoning_effort: high
task_type: architecture
area: host-interop
language_feature: node-api-compat
goal: platform
sprint: Backlog
es_edition: n/a
related: [2736, 2634, 1772, 2655, 2657, 2684, 2696, 2528, 2645, 2624, 2603, 2094, 1524]
supersedes_verdict_of: 2634
origin: "Stakeholder directive (2026-06-26) reversing the #2634 'reject real @types/node' verdict: type against the REAL host surface, move the satisfiability error from type-check-time to link-time-used-only."
---

# #2698 — Original host types + link-time satisfaction

> **Scoping issue (architecture). Do NOT implement from this file alone — it
> defines the model, the feasibility verdict, and the dev-sized slices.** Slices
> S1/S3/S4 are senior-dev; S2/S5/S6 are dev. See ordering at the end.

> **AXIS UNIFICATION (#2736, foundation — LANDED).** The two host axes have been
> collapsed into a single user-facing `--target {wasi, node, deno, web}`:
>
> - `--target web` (the **default**) — WasmGC / JS-host browser surface (DOM
>   ambient globals);
> - `--target node` — a real **Node** host (Node ambient surface, no DOM);
> - `--target deno` — a real **Deno** host (Deno ambient surface, no DOM);
> - `--target wasi` — standalone WASI Preview 1 (as today).
>
> The old `--platform node|web|deno` flag is now a **deprecated alias** that maps
> onto `--target` (one-line deprecation warning). The backend-lowering names
> (`gc`/`linear`/`standalone`) remain orthogonal `--target` values. Throughout
> this issue, read every `--platform <x>` below as `--target <x>`. The remaining
> #2698 slices layer onto that axis: **S1** = real `@types/node` under
> `--target node`, **S2** = real Deno lib under `--target deno`, **S3** = the
> link-satisfaction registry keyed on the host (`hostMode`), **S4** = the
> link-time used+unsatisfiable gate.

## Stakeholder model (captured verbatim)

1. **Type-check against the ORIGINAL type definitions**, not our hand-authored
   minimal mirrors: real `@types/node` for a Node host, Deno's real
   `lib.deno.ns.d.ts` (`deno types`) for a Deno host, the real surface for the
   WASI case where possible. A program sees the FULL real host API, not just the
   members we currently lower.
2. **Satisfaction is deferred to LINK time** — these members are host _imports_.
   Under a native Node/Deno host the real runtime provides them; under WASI our
   `.wat` shim / direct-lowering (#2655/#2657) provides the subset it can. The
   claim "since these are imports it should work" is the key thing this issue
   validates.
3. **Complain ONLY when an import is genuinely (a) USED in the module AND
   unsatisfiable at link time, OR (b) compiled into the module and missing.**
   NOT a compile-time rejection from a capability map. Type-checking no longer
   gates on "can we lower it"; that becomes a link-time, _used-only_ check.

This separates **what type-checks** (the real surface) from **what we can
lower/satisfy** (target-dependent), moving the error from type-check-time to
link-time-used-unsatisfiable.

---

## Feasibility verdict (read this first)

**The reversal is architecturally feasible, but the stakeholder's "it's just
imports, it should work" intuition is only HALF correct — and the half that is
wrong is exactly the half the #2634 verdict was protecting.**

- **The link/runtime half is correct and already largely built.** A host import
  _is_ a link-time interface: `ALWAYS_ALLOWED_IMPORT_MODULES` already treats
  `node:fs` like `wasi_snapshot_preview1` ("declares WHAT, not HOW; bound at link
  by the `.wat` shim / native WASI / real `node:fs`"), and
  `scanForLeakedHostImports` (#2094) already implements "complain if a host
  import in the finished binary can't be satisfied." So the **used + unsatisfiable
  at link** check is not new infrastructure — it is a generalization of code that
  already ships.

- **The type-check half is NOT free, and the #2634 cost is REAL.** To type-check
  `fs.readFileSync(path, opts)` against its _original_ overloads, the checker must
  have those overloads in scope — which means **loading the real `.d.ts`**. You
  cannot get the original type without loading the original definition. Measured
  on this box (`@types/node@22.19.13`): **70 `.d.ts` files, ~49,700 lines**;
  `fs.d.ts` alone is 4,461 lines. That is the heaviness the #2634 verdict cited,
  and it is accurate.

- **"Resolve only the imported members" does NOT bound the cost.** The tempting
  cheap path — scan imports, pull only the imported members' signatures — fails
  because `@types/node` signatures are **not self-contained**. `fs.readFileSync`
  references `PathOrFileDescriptor`, `ObjectEncodingOptions`, `BufferEncoding`,
  `Abortable`, `Buffer`, `NodeJS.ArrayBufferView`, … which transitively drag in
  `buffer.d.ts`, the `NodeJS` namespace (`globals.d.ts`), the stream/event types,
  etc. — i.e. most of the graph. You cannot extract one function's _real_
  signature without its transitive type closure, and that closure for even a few
  `fs` members spans the bulk of `@types/node`. So member-only extraction is a
  mirage; you load the **full graph or nothing**.

- **Therefore the only way to honor "type against the ORIGINAL definitions" is to
  load the full real graph — gated STRICTLY on host-mode** (`--target node` /
  `--target deno`) so the default / web / test262 path never pays the parse
  cost. This is the design pivot vs #2634: #2634's verdict was _correct under its
  constraint_ (don't make every compile load `@types/node`; keep type == runtime).
  The stakeholder is **changing the constraint**: fidelity is now worth the cost
  _for node/deno-targeted compiles only_, AND type is explicitly **decoupled**
  from runtime (type = full real surface; runtime = what link can satisfy).

- **Deno is EASIER than Node.** `deno types` emits a single, largely
  self-contained `lib.deno.ns.d.ts` (`declare namespace Deno { … }`) with far less
  transitive `declare module` graph. It loads cleanly as an _ambient lib
  composite_ (exactly like the DOM / no-DOM composites in #2528), not as a module
  graph. The stakeholder's model is realized most cleanly for Deno.

- **WASI has no "original" TS surface.** Raw `wasi_snapshot_preview1` is a
  witx/wit interface, not a `.d.ts`. The directive's "where possible" caveat
  acknowledges this: for the WASI target there is **no separate TS type lib** —
  programs type against the `node:fs` / Deno surfaces and lowering targets WASI.
  The link-satisfaction registry, not a type lib, is what represents "WASI can
  satisfy fd-based `readSync`/`writeSync` but not path-based `openSync`."

- **Packaging obstacle (real, must be slice-scoped).** The checker also runs in
  the **browser playground** and the **standalone CLI**, where there is no
  `node_modules` — lib `.d.ts` are bundled into `globalThis.__js2wasmTsLibFiles`
  (`scripts/build-standalone-cli.mjs`, `scripts/runner-bundle.mjs`). To type
  against real `@types/node` there, a `@types/node` snapshot (~1–2 MB) must be
  bundled, OR those builds keep the hand-authored mirror as a fallback. This is a
  deliberate per-build decision (S5).

**Bottom line:** ship it, gated hard on host-mode. The capability map is
**demoted** from a _type gate_ to a _link-satisfaction registry_ and survives in
that role; the hand-authored type mirror is **superseded** for `--target
node`/`deno` (kept only as the no-`node_modules` fallback); the #1772 P2-a
compile-time call-site rejection is **transformed** into one feeder of a unified
link-time used+unsatisfiable check built on top of `scanForLeakedHostImports`.

---

## What is SUPERSEDED vs KEPT (reconciliation)

| Piece (on main)                                                                                                                                            | Fate under #2698                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node-capability-map.ts` **type-surface emission** (`buildModuleDecls`, the `decls` mirror strings, `NODE_FS_SUPPORT_DECLS`, `FS_*_DECLS`)                 | **SUPERSEDED for `--target node`** by real-`@types/node` loading. Mirror **retained only as the no-`node_modules`/browser fallback** until S5 bundles a snapshot.                                   |
| `node-capability-map.ts` **provider/satisfiability registry** (`NodeProvider`, `CapabilityTarget`, `providersFor`, `isMemberSatisfiable`, `isKnownMember`) | **KEPT and PROMOTED** to the authority for the link-time gate. Generalized to be host-mode-keyed (node/deno/wasi), not `node:fs`-only.                                                              |
| `buildNodeEnvDts` synthetic `.d.ts` injection (`src/checker/index.ts`)                                                                                     | **KEPT as the fallback path**; bypassed for mapped modules when real-types loading is active under `--target node`. The bare-`process` / permissive-`any` branches stay.                            |
| #1772 P2-a **compile-time** call-site gate in `tryCompileNodeFsCall` (`isMemberSatisfiable === false` → `ctx.errors.push`)                                 | **TRANSFORMED**: the call-site early-error is removed; its _data source_ (the registry) feeds the unified link-time check instead. (File owned by the #2696 fixer — sequence S4 after #2696 lands.) |
| `scanForLeakedHostImports` + `isHostImportAllowed` (#2094, `host-import-allowlist.ts`)                                                                     | **KEPT and GENERALIZED** into the single "used + unsatisfiable at link" mechanism — it already does (b) compiled-in-but-missing; S4 routes node/deno member satisfiability through it too.          |
| `--target` host axis, `resolveEmulateNode`, `defaultLibNameForPlatform` (#2528/#2645/#2736)                                                                | **KEPT and EXTENDED** — the host-mode is the gate that decides whether to load real types and which provider set is active. `--platform`→`--target` unification + `--target deno` landed in #2736.  |

---

## Implementation Plan

### Model definitions (precise)

- **"used"** = a host member that is **referenced AND reachable** — i.e. codegen
  emitted (or would emit) an import for it. The operational proxy: **the import
  survives into the finished binary's import section** (after dead-import
  elimination). A member that is _type-imported but never called_
  (`import { openSync } from "node:fs"` with no call) is **NOT used** → emits no
  import → never errors. This is the central semantic shift: it type-checks
  against the real surface and stays silent unless actually invoked.
- **"unsatisfiable at link"** = the active **link target** (host-mode × flags:
  `{ wasi, allowFs, linkNodeShims, hostMode }`) offers **no provider** for the
  used member — `providersFor(member, linkTarget).length === 0`.
- **(a) used + unsatisfiable** = used (import compiled in) AND no provider for the
  link target → structured error: "`node:fs.openSync` is used but no provider
  satisfies it under `--target wasi` (no filesystem); pass `--allow-fs` or use
  fd-based `readSync`/`writeSync`."
- **(b) compiled-in-but-missing** = an import present in the finished binary whose
  module/name the link target cannot bind at all (today: the `env`-not-on-
  allowlist / non-`env`-host-module leaks from `scanForLeakedHostImports`).
  (a) and (b) are the SAME finished-binary scan with two reason codes.

### Slices (dev-sized)

#### S3 — Link-satisfaction registry (FOUNDATION, do first) · senior-dev

Refactor `node-capability-map.ts` into a **host-mode-keyed link-satisfaction
registry**, decoupled from type-surface emission.

- Extend `NodeProvider` with deno/wasi providers as needed; generalize
  `CapabilityTarget` → `LinkTarget { wasi, allowFs, linkNodeShims, hostMode:
"node"|"deno"|"web" }`.
- Keep `providersFor` / `isMemberSatisfiable` / `isKnownMember`; add a
  module-agnostic lookup keyed by `(hostMode, module, member)` so deno members
  (`Deno.readSync`, `Deno.writeSync`, …) and node members share one registry.
- **Move the `decls`/mirror strings to a SEPARATE fallback module**
  (`node-types-mirror.ts`) so the registry no longer carries type text — it
  becomes pure satisfiability data. `buildModuleDecls` moves with the mirror.
- No behavior change yet: the checker and `node-fs-api.ts` keep calling the same
  exported functions (re-exported), so this slice is byte-neutral. Add a unit
  test asserting registry queries are unchanged.

#### S1 — Real `@types/node` loading under `--target node` · senior-dev

In `src/checker/index.ts` `analyze`/`analyzeMulti` compiler-host:

- When `platform === "node"`, **resolve `node:<mod>` specifiers against the real
  `@types/node`** via `ts.resolveModuleName` (point `typeRoots`/module resolution
  at the resolved `@types/node` dir; the package is present at
  `node_modules/.pnpm/@types+node@*/…`). The checker's `getSourceFile` /
  `fileExists` / `readFile` must serve those `.d.ts` (today they hard-stop at lib
  files + the synthetic node-env root — extend them to serve `@types/node` files
  when host-mode is node).
- **Gate strictly**: unset platform / `--target web` → unchanged (no real-types
  load, mirror/synthetic path as today, **byte-neutral for test262/web**).
- For mapped modules under `--target node`, **bypass the synthetic
  `buildNodeEnvDts` injection** and let real resolution provide the surface; keep
  `buildNodeEnvDts` as the fallback when `@types/node` can't be resolved
  (browser / no `node_modules` until S5).
- Cache the parsed `@types/node` SourceFiles (like `LIB_SOURCE_FILES`) so the
  ~50k-line parse is paid **once per process**, not per file.
- **Risk**: `@types/node` references `lib.dom`-free globals + its own `NodeJS`
  namespace; verify the no-DOM composite (#2528) + `@types/node` co-resolve
  without duplicate-global clashes. Reuse the existing dup-identifier rebuild
  fallback pattern.

#### S2 — Real Deno surface under `--target deno` · dev

- ~~Add `--target deno` to `AnalyzeOptions.platform` and the CLI.~~ **DONE in
  #2736** — `--target deno` is accepted and routes through `AnalyzeOptions.platform
= "deno"`, currently sharing the node-emulation / no-DOM ambient surface. S2's
  remaining work is swapping that placeholder surface for the real Deno lib:
- Snapshot `lib.deno.ns.d.ts` (`deno types`; `deno` CLI is present at
  `~/.deno/bin/deno`) into the repo (e.g. `vendor/deno/lib.deno.ns.d.ts`) and
  load it as an **ambient lib composite** alongside the no-DOM ES base (mirror the
  `DOM_FREE_LIB_NAME` composite machinery — it's self-contained, so this is the
  simple ambient-lib path, NOT a module graph).
- `resolveEmulateNode` already composes deno into the node-emulation path
  (#2736, placeholder); once the real Deno lib loads, decide whether deno keeps
  the node-emulation injection or gets its own Deno-namespace plumbing.
- Register Deno's std-IO members in the S3 registry with their providers
  (fd-based → `wasi-fd` / native deno host).

#### S4 — Unify the link-time used+unsatisfiable gate · senior-dev

_(sequence AFTER #2696 lands — it owns `node-fs-api.ts` / `raw-wasi-api.ts`.)_

- **Remove** the #1772 P2-a compile-time call-site rejection in
  `tryCompileNodeFsCall` (`isMemberSatisfiable === false → ctx.errors.push`).
- **Generalize `scanForLeakedHostImports`** into the single finished-binary check:
  for each live import, classify via the S3 registry under the active `LinkTarget`:
  - present-but-no-provider for a _mapped host member_ → **(a) used+unsatisfiable**
    (precise per-member message: which member, which target, which flag fixes it);
  - `env`-not-on-allowlist / non-`env`-host-module → **(b) compiled-in-but-missing**
    (today's leak messages).
- Route both through `buildLeakedHostImportError`-style structured errors so
  `result.success === false` (never a silent instantiation failure).
- **Net effect**: type-check no longer rejects unsatisfiable members; a program
  that _imports but never calls_ `openSync` compiles clean; only a _called_
  `openSync` under a provider-less target errors, and it errors at the
  finished-binary scan, not at call-site codegen.

#### S5 — Bundle real type snapshots for browser / standalone CLI · dev

- Decide per-build: bundle a `@types/node` + `lib.deno.ns.d.ts` snapshot into
  `__js2wasmTsLibFiles` (`build-standalone-cli.mjs`, `runner-bundle.mjs`,
  `preloadLibFiles`) so real-types loading works without `node_modules`, **OR**
  keep the S3-extracted mirror as the documented browser fallback.
- If bundling: measure the size delta; gate the snapshot load behind host-mode so
  web/default builds don't ship/parse it.

#### S6 — Tests + byte-neutrality · dev

- **Byte-neutrality**: default / `--target web` / test262 path byte-identical
  to pre-#2698 (the #1968 batch-byte-diff method) — proves no real-types load on
  the common path.
- `--target node`: a program using a real `@types/node` overload the mirror
  rejected now type-checks (e.g. an `fs` member outside `FS_MEMBERS`).
- **Used-only semantics**: `import { openSync } from "node:fs"` _without a call_
  compiles clean under `--target wasi`; _with_ a call → the (a) used+unsatisfiable
  error. (Regression-locks the central shift.)
- `--target deno`: a `Deno.readSync` program type-checks against the real
  namespace.
- (b) compiled-in-but-missing: an `env` leak still produces the structured error.

### Ordering

```
S3 (registry/foundation, byte-neutral)
   ├── S1 (node real types)  ──┐
   └── S2 (deno real types)  ──┤
                               ├── S4 (unify link gate; AFTER #2696) ── S6 (tests)
S5 (bundling) depends on S1/S2 ┘
```

S3 first (pure refactor, unblocks everything). S1 ∥ S2. S4 after S3 **and**
after #2696 settles `node-fs-api.ts`. S5 after S1/S2. S6 last (but its
byte-neutral harness can be scaffolded against S3).

### Removed / changed (call-outs for reviewers)

- **Removed**: the compile-time call-site `node:fs` rejection (#1772 P2-a) — moves
  to link-time, used-only.
- **Changed**: the capability map stops emitting type text (mirror split out);
  becomes the link registry. `buildNodeEnvDts` becomes a fallback, not the primary
  node-surface source under `--target node`.
- **Reversed**: the #2634 "reject literal `@types/node`" verdict — under the new
  host-mode-gated constraint, literal loading is the chosen design for
  `--target node`/`deno`.

## Acceptance

- `--target node` type-checks against real `@types/node`; `--target deno`
  against the real Deno namespace; default/web/test262 path **byte-neutral**.
- A _called_ unsatisfiable host member errors at link-scan time with a precise
  per-member message; an _imported-but-uncalled_ one compiles clean.
- The capability map survives as the link-satisfaction registry; the type mirror
  survives only as the no-`node_modules` fallback (or is replaced by a bundled
  snapshot, S5).
- `scanForLeakedHostImports` is the single mechanism for both error classes.

## Risks

- **Parse cost**: ~50k lines of `@types/node` per process under `--target node`
  — must be cached once and gated hard off the default path.
- **Global clashes**: `@types/node`'s `NodeJS` namespace + the no-DOM composite
  co-resolving; reuse the dup-identifier rebuild fallback.
- **#2696 file overlap**: S4 edits `node-fs-api.ts`; must land after #2696.
- **Browser packaging**: real-types loading is meaningless in the browser without
  S5; until then `--target node` in-browser falls back to the mirror.

## Residual (as of #2199, PO reconcile 2026-06-28)

NOT done — architecture scoping issue. The referencing PR landed the #2736/#2734 axis-unification FOUNDATION (--platform → --target {wasi,node,deno,web}). The actual #2698 slices remain: S1 (real @types/node under --target node), S2 (real Deno lib under --target deno), S3 (link-satisfaction registry keyed on hostMode), S4 (link-time used+unsatisfiable gate), S5/S6. Do NOT implement from this file alone; S1/S3/S4 are senior-dev. Stays ready.
