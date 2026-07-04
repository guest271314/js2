---
id: 2783
title: "General --link <namespace> dynamic-linking flag (generalize --link-node-shims)"
status: done
sprint: 69
created: 2026-06-28
completed: 2026-06-28
assignee: ttraenkler/agent-a957b1b8ea8d85c4a
priority: medium
feasibility: hard
reasoning_effort: high
task_type: architecture
area: compiler
language_feature: module-linking
goal: platform
related: [2527, 2655, 2657, 2771, 2779, 389]
---

## Implementation (S1–S3 landed; S4 deferred)

S1–S3 of the Implementation Plan are landed. **S4 (generalize the codegen
branch sites) is deliberately deferred** as a follow-up — per the architect's
verdict it is YAGNI until a *second* concrete lowerable namespace exists.

**Stakeholder decision (no alias):** the `--link-node-shims` CLI flag and the
`linkNodeShims` INPUT option are **removed entirely**, not deprecated.
`--link node:fs` (CLI) / `link: ["node:fs"]` (programmatic) is the only spelling.
All in-repo callers (tests, `examples/native-messaging/*`, `scripts/`, docs) were
migrated to the new spelling.

- **S1 — flag + plumbing.** `--link <ns>` repeatable CLI parser (`--link node:fs`,
  `--link=node:fs` both accepted); the removed `--link-node-shims` flag now errors
  as an unknown option. `link?: string[]` added to `CompileOptions`
  (`src/index.ts`) and `CodegenOptions` (`src/codegen/context/types.ts`); the
  `linkNodeShims` input fields were dropped from both. `buildCodegenOptions`
  (`src/compiler.ts`) dedupes `options.link`. `create-context.ts` builds
  `ctx.linkedNamespaces` (WASI-gated) and derives the INTERNAL convenience
  boolean `ctx.linkNodeShims = linkedNamespaces.has("node:fs")` so the ~30
  existing `ctx.linkNodeShims` codegen read sites are zero-churn and the two can
  never drift (`ctx.linkNodeShims` is no longer a user-facing option — just an
  internal derived getter). `--help` updated.
- **S2 — strict-gate generalization (the one new capability).**
  `isHostImportAllowed` / `scanForLeakedHostImports`
  (`src/codegen/host-import-allowlist.ts`) take an optional `linkedNamespaces`
  set; a `--link`'d namespace's imports now survive the `--no-host-imports` /
  WASI strict gate (both the per-call `addImport` gate in
  `src/codegen/registry/imports.ts` and the post-link
  `assertNoLeakedHostImports` scan in `src/codegen/index.ts`). `env` host
  bindings stay allowlist-gated (not `--link`-overridable). No lowering added.
- **S3 — tests + migration.** `tests/issue-2783.test.ts`: `--link node:fs`
  selects the import-and-link std-IO path; gate permits an arbitrary namespace
  (`acme:telemetry`) while rejecting an unlinked one; per-namespace isolation;
  `env` not overridable; byte-neutral when no `--link` (omitted ≡ `link: []`);
  the removed `--link-node-shims` flag is rejected by the CLI; multi-file
  `compileProject` forwards the `link` policy. Every `linkNodeShims: true` /
  `--link-node-shims` caller across `tests/`, `examples/`, `scripts/`, `docs/`
  migrated to `link: ["node:fs"]` / `--link node:fs`.

## Test Results

- `tests/issue-2783.test.ts` — pass.
- `examples/native-messaging/smoke-test.sh` (now `--link node:fs`) — **PASS under
  real wasmtime 44.0.0** (byte-exact Native Messaging round-trip). The real-link
  gate.
- Regression set unchanged: `issue-2633`, `issue-2631`, `issue-2094`,
  `host-import-allowlist-gate`, `host-import-allowlist-budget`,
  `issue-1554-cli-flag-exclusion` pass.
- Byte-neutral: `--link node:fs` output unchanged from the old
  `linkNodeShims: true` (same create-context derivation; `node:fs` stays in
  `ALWAYS_ALLOWED_IMPORT_MODULES`). No-`link` single-source compiles unchanged.
- Pre-existing/unrelated: the heavy Native Messaging runtime tests (#1530, #1753,
  #1767, #2526, #1768, #1886) fail identically on clean `origin/main` in this
  container (large-memory/wasmtime env), so they are NOT a #2783 regression.
- `tsc --noEmit` clean (also confirms no caller still passes the removed option);
  `biome lint` clean; `prettier` clean.
- No remaining input-side `--link-node-shims` / `linkNodeShims:`-as-input in
  `src`/`tests`/`examples`/`scripts`/`docs` (grep clean; historical `plan/`
  issue records intentionally preserved).

# #2783 — general `--link <namespace>` dynamic-linking flag

## Problem

Today the decision "leave an external dependency as a **wasm import** (satisfied
at link/instantiation time) vs **inline-lower** it to a self-contained module"
is **hardcoded per-shim**. Only `node:fs` has both:

- a **direct-lowering** path (#2655): fd-based `readSync`/`writeSync` lower
  straight to `wasi_snapshot_preview1.fd_read`/`fd_write`, and console.log /
  `process.std*.write` lower to `fd_write` inline — a self-contained WASI command
  module; and
- a **modular-linking** path (`--link-node-shims`, #2625/#2633): the user module
  _imports_ `readSync`/`writeSync` + its linear memory from `node:fs`, and is
  satisfied at instantiation by a linked `node-fs.wasm`
  (`scripts/build-node-fs-shim.mjs`, `wasmtime --preload node:fs=node-fs.wasm`).

The toggle is a single boolean (`linkNodeShims`) threaded `cli.ts →
CompileOptions → buildCodegenOptions → CodegenContext.linkNodeShims`, and the
codegen reads it at ~6 decision points all keyed to **`node:fs` specifically**.
There is no way to say "leave `node:process` as an import" or "leave
`wasi_snapshot_preview1` as an import but inline everything else" or "leave
_this arbitrary user namespace_ `acme:telemetry` as a link-time import." The
lower-vs-import axis exists for exactly one namespace and is welded to it.

This issue generalizes that one boolean into an **orthogonal, per-dependency
axis**:

```
--link node:fs        # leave node:fs::* as imports for link-time satisfaction (today's --link-node-shims)
--link node:process   # same for process stdio
--link wasi_snapshot_preview1
--link <namespace>    # any external import namespace; repeatable
```

`--link-node-shims` becomes **sugar for `--link node:fs`** (kept working, soft
deprecation warning). Default per-namespace stays **standalone** (inline-lower
wherever the compiler can); `--link <ns>` flips that one namespace to
import-and-link. The satisfying module is supplied at instantiation via
**core-wasm linking (#2527)** / `wasmtime --preload`; the compiler only emits the
import signature.

## The orthogonality (stakeholder-flagged)

There are **two independent axes**, and the current code conflates them:

| Axis         | Issue        | Question                                                                        | Default                                             | Direction              |
| ------------ | ------------ | ------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------- |
| **Bundling** | #2771        | Do I pull a **local** `./helper.ts` module's code _into_ my module?             | **always** (resolve from disk, lower as one module) | —                      |
| **Linking**  | #2783 (this) | Do I leave an **external** namespace as an _import_ for link-time satisfaction? | **standalone / inline-lower**                       | `--link <ns>` flips it |

These compose cleanly and must stay separable:

- **Bundling** is about _local source resolution_ (entry imports `./shared.ts`):
  the bundler (`compileProject`/`compileMultiSource`) resolves the relative dep
  through the TS program and lowers all files as **one** module. Always on when a
  relative import is present. It never touches the lower-vs-import decision.
- **Linking** is about _external dependency satisfaction_ (`node:fs`,
  `wasi_snapshot_preview1`, `acme:telemetry`): a per-namespace choice to emit an
  import instead of inlining. `--link <ns>` is the only control.

A bundled program can still `--link node:fs` (the bundled cross-file `node:fs`
seam stays an import); a single-file program can `--link node:fs` too. The
#2779 reserved-but-uncreated work ("bundled `node:fs` codegen gaps") is the
**evidence the current coupling is fragile**: when bundling pulled `node:fs` IO
across files, the `node:fs` lower-vs-import decision (a `ctx.linkNodeShims`
boolean checked deep in `node-fs-api.ts`) did not cleanly survive the multi-file
path, because the decision is a _side effect of the compile path_ rather than an
_explicit per-dependency property_. Making "lower vs import" a first-class
per-namespace decision (a `LinkPlan`) is what decouples them.

## Investigation — how `--link-node-shims` works TODAY (end-to-end)

1. **CLI** (`src/cli.ts`): `let linkNodeShims = false;` (line ~161); `--link-node-shims`
   sets it true (line ~239); folded into `compileOptions` as
   `...(linkNodeShims ? { linkNodeShims: true } : {})` (line ~368).
2. **CompileOptions** (`src/index.ts:292`): `linkNodeShims?: boolean`.
3. **Resolver** (`src/compiler.ts:719`, `buildCodegenOptions`):
   `linkNodeShims: options.linkNodeShims` into `CodegenOptions`.
4. **Context** (`src/codegen/context/create-context.ts:225`):
   `linkNodeShims: !!(options?.wasi && options?.linkNodeShims)` — note it is
   **WASI-gated** (ignored for non-WASI targets). Type at
   `src/codegen/context/types.ts:1732`.
5. **Namespace detection** is _separate_ and already namespace-keyed:
   - `detectNodeFsImports(source)` (`compiler.ts:531`) → `ctx.wasiNodeFsFuncs`
     (named imports from `node:fs`/`fs`).
   - `detectRawWasiImports(source)` (`compiler.ts:626`) →
     `ctx.wasiRawImports` (named imports from `wasi_snapshot_preview1`) +
     `ctx.wasiMemAccessors` (from `wasm:memory`).
6. **Codegen decision points** (all in `src/codegen/index.ts` unless noted), each
   currently a `if (ctx.linkNodeShims)` branch hardcoded to `node:fs`:
   - `registerWasiImports` (~6026): under shims, import `node:fs` `memory` +
     `readSync`/`writeSync` (driven by `sourceUsesStreamWriteIo` + `wasiNodeFsFuncs`);
     else own the memory + export it.
   - Syscall-need recompute (~6328): under shims, drop `fd_read`/`fd_write` for
     stream IO (they flow through `node:fs`), keep `fd_write` only for
     `writeFileSync`→`path_open`.
   - std-IO write helpers (~6691, ~6740, ~7445, ~7501, ~7602, ~7758): branch the
     write sink between `ctx.nodeFsWriteSyncIdx` (shim) and `ctx.wasiFdWriteIdx`
     (direct).
   - `src/codegen/node-fs-api.ts`: `tryCompileNodeFsCall` / `emitNodeFsReadSync` /
     `emitNodeFsWriteSync` select `writeSinkIdx = ctx.linkNodeShims ?
ctx.nodeFsWriteSyncIdx : ctx.wasiFdWriteIdx` (lines ~85, ~171, ~247, ~309).
   - `src/codegen/linear-uint8-codegen.ts:442` — same branch for Uint8Array IO.
7. **Strict-import gate** (`src/codegen/host-import-allowlist.ts`):
   `ALWAYS_ALLOWED_IMPORT_MODULES` hardcodes `{"wasi_snapshot_preview1",
"node:fs"}`. This is what lets a `node:fs` import survive the
   `--no-host-imports` / WASI strict gate. **A general `--link <ns>` must add `<ns>`
   to the allowed set dynamically.**
8. **Provider + round-trip**: `scripts/build-node-fs-shim.mjs` emits `node-fs.wasm`
   (owns + exports the shared `memory`, implements `readSync`/`writeSync` over
   WASI `fd_read`/`fd_write`); `examples/native-messaging/smoke-test.sh` compiles
   with `--link-node-shims`, builds the shim, and links via
   `wasmtime --preload node:fs=node-fs.wasm`.

### Candidate namespaces for the general axis

| Namespace                                    | Can be left-as-import?                                                     | Can be inline-lowered (standalone)?                 | Notes                                                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `node:fs` (fd readSync/writeSync)            | ✅ today (`--link-node-shims`)                                             | ✅ today (#2655 direct WASI)                        | The reference case — has **both** paths.                                                                                |
| `node:fs` path family (`readFileSync(path)`) | ✅ (link a richer provider)                                                | partial (needs `path_open`/preopens)                | **Partially lowerable** — see edge cases.                                                                               |
| `node:process` / stdio                       | ✅ (provider exports stdio fns)                                            | ✅ today (lowers to `node:fs writeSync`/`fd_write`) | Since #2633 std-IO is `node:fs`; a distinct `node:process` link target means re-introducing a process provider surface. |
| `wasi_snapshot_preview1`                     | ✅ (this IS the canonical link target — always satisfied by the WASI host) | n/a (it is the syscall floor)                       | #2657 raw passthrough. Already always-allowed; `--link` is implicitly its default.                                      |
| Deno globals (`Deno.*`)                      | hard (not a wasm import namespace — global object)                         | ✅ today (deno-api.ts → direct WASI)                | Deno is a _global_, not an import module — **not a clean `--link` target** without a synthetic namespace.               |
| arbitrary user module (`acme:telemetry`)     | ✅ (emit import signature; user preloads provider)                         | ❌ (compiler has no lowering)                       | The **general** case: `--link` is the _only_ way to satisfy it; default would otherwise be a strict-gate rejection.     |

Key realization: **left-as-import is the universal capability** (emit the import
signature, satisfy at link time) — every namespace can do it. **Inline-lowering
is the special capability** the compiler only has for a known few (`node:fs` fd
IO, stdio). So `--link <ns>` is "turn OFF inline-lowering for `<ns>` (or, for a
namespace with no lowering, simply _permit_ the import)."

## Implementation Plan

### Model

Introduce a **per-namespace link plan** on the compile options, replacing the
single boolean:

```ts
// CompileOptions (src/index.ts) — new field, additive
link?: string[];   // namespaces to leave as link-time imports, e.g. ["node:fs"]
```

Lower it to a normalized set on the codegen context:

```ts
// CodegenContext (src/codegen/context/types.ts)
linkedNamespaces: ReadonlySet<string>;   // e.g. {"node:fs"}
// Back-compat accessor (keeps the ~6 existing call sites compiling unchanged):
get linkNodeShims(): boolean { return this.linkedNamespaces.has("node:fs"); }
```

`linkNodeShims` becomes a **derived getter** over `linkedNamespaces.has("node:fs")`.
This is the keystone that lets every existing `ctx.linkNodeShims` site keep
working verbatim while the underlying state generalizes. (If a getter on the
context object is awkward given how the context is constructed, compute a plain
`linkNodeShims: boolean` field alongside `linkedNamespaces` in
`create-context.ts` — same observable behavior; pick whichever the context shape
allows. Prefer the derived value so the two can never drift.)

### Changes

**File: `src/cli.ts`**

- Add a repeatable flag parser next to `--link-node-shims` (line ~239):
  ```
  } else if (arg === "--link" || arg.startsWith("--link=")) {
    const ns = arg.startsWith("--link=") ? arg.slice("--link=".length) : args[++i];
    if (!ns) { console.error("--link requires a namespace argument"); process.exit(1); }
    linkedNamespaces.add(ns);
  } else if (arg === "--link-node-shims") {
    console.error("warning: --link-node-shims is deprecated; use --link node:fs instead.");
    linkedNamespaces.add("node:fs");
  }
  ```
  Declare `const linkedNamespaces = new Set<string>();` near line ~161 (replacing
  `let linkNodeShims = false;`).
- Fold into `compileOptions` (line ~368):
  `...(linkedNamespaces.size ? { link: [...linkedNamespaces] } : {})`.
- Validation: a `--link <ns>` for a namespace the compiler _cannot_ leave as an
  import on the current target is not an error (any namespace can be an import) —
  but a `--link` on a _non-WASI / non-standalone_ target where it has no effect
  should warn (mirrors today's WASI-gating of `linkNodeShims`). Decide the gate
  with the same `options.wasi` condition used in `create-context.ts:225`.
- Update `--help` text (line ~82): document `--link <ns>` as the general form and
  mark `--link-node-shims` deprecated-alias.

**File: `src/index.ts` (CompileOptions)**

- Add `link?: string[]` with a doc comment (line ~292 area). Keep
  `linkNodeShims?: boolean` as a **deprecated alias** — in `buildCodegenOptions`,
  fold `linkNodeShims === true` into the `link` set as `"node:fs"` so any
  programmatic caller keeps working.

**File: `src/compiler.ts` (`buildCodegenOptions`, ~701)**

- Replace `linkNodeShims: options.linkNodeShims` with:
  ```ts
  link: [
    ...(options.link ?? []),
    ...(options.linkNodeShims ? ["node:fs"] : []),
  ],
  ```
  (normalize/dedupe). Thread `link` through `CodegenOptions`
  (`src/codegen/context/types.ts:78` area — replace/augment `linkNodeShims?`).
- The namespace **detection** functions (`detectNodeFsImports`,
  `detectRawWasiImports`) stay as-is — they are already namespace-keyed and feed
  `wasiNodeFsFuncs`/`wasiRawImports`. The `link` set is the _policy_ (lower vs
  import); the detection sets are the _usage_ (which symbols). They compose.

**File: `src/codegen/context/create-context.ts` (~225)**

- Build `linkedNamespaces` from `options.link`, WASI-gated exactly as today:
  ```ts
  linkedNamespaces: new Set(options?.wasi ? (options?.link ?? []) : []),
  ```
  and provide `linkNodeShims` as the derived `linkedNamespaces.has("node:fs")`.

**File: `src/codegen/context/types.ts`**

- Add `linkedNamespaces: ReadonlySet<string>` to `CodegenContext`.
- Keep `linkNodeShims: boolean` (now derived) so the ~30 read sites in
  `index.ts` / `node-fs-api.ts` / `linear-uint8-codegen.ts` are untouched in
  slice 1.

**File: `src/codegen/host-import-allowlist.ts`**

- `ALWAYS_ALLOWED_IMPORT_MODULES` keeps `wasi_snapshot_preview1` + `node:fs`
  (the always-linkable interfaces), but the strict gate
  (`scanForLeakedHostImports`, around `index.ts:1968`/`2000`) must ALSO treat any
  namespace in `ctx.linkedNamespaces` as allowed. Thread `ctx.linkedNamespaces`
  into the leaked-import scan so `--link acme:telemetry` permits
  `(import "acme:telemetry" …)` past the `--no-host-imports` gate. **This is the
  one genuinely new capability** beyond a rename: it lets an _arbitrary_ namespace
  be left as an import.

### Wasm IR / import model (unchanged shape, generalized key)

A linked namespace emits exactly what `--link-node-shims` emits today — an
import declaration the host satisfies at instantiation:

```wasm
;; --link node:fs (today's --link-node-shims), unchanged
(import "node:fs" "memory"    (memory 3))
(import "node:fs" "readSync"  (func (param i32 i32 i32) (result i32)))
(import "node:fs" "writeSync" (func (param i32 i32 i32) (result i32)))

;; --link acme:telemetry — general case: just the signature the user declared,
;; satisfied by `wasmtime --preload acme:telemetry=acme.wasm` (#2527 shared store)
(import "acme:telemetry" "record" (func (param i32 i32)))
```

The satisfiability/linking model ties directly to **#2527** (core-wasm module
linking, shared store, canonical rec-group): a `--link`'d namespace is satisfied
by a separately-compiled provider module preloaded into the same store. For
WasmGC-typed boundaries the provider must declare the **identical** canonical rec
group (#2527 Phase 1); for the i32-pointer / linear-memory boundary used by
`node:fs` today there is no GC-type coupling (the shim owns + exports the
`memory`), which is why `node:fs` works on `wasmtime --preload` _now_, before
#2527's GC-identity work lands.

### Edge cases

- **Partially-lowerable namespace.** `node:fs` fd IO (readSync/writeSync) is
  lowerable; the path family (`readFileSync(path)`) needs `path_open`/preopens.
  `--link node:fs` should leave the **whole** `node:fs` namespace as imports
  (consistent), not split fd-vs-path. Document that a provider linked for
  `node:fs` must satisfy _every_ `node:fs` symbol the module imports. (A future
  finer-grained `--link node:fs/readSync` is out of scope.)
- **Mixing linked + lowered in one module.** `--link node:fs` while the module
  _also_ uses `Math.sin` (host import) or raw `wasi_snapshot_preview1` is fine —
  each namespace is decided independently. The recompute logic at `index.ts:6328`
  that today drops `fd_read`/`fd_write` when `linkNodeShims` is set must remain
  keyed to `node:fs` being linked (it is, via the derived getter), and the
  raw-wasi re-assertion at ~6355 (`ctx.wasiRawImports`) must still win so a
  program that _explicitly_ imports `fd_write` keeps it even with `--link node:fs`.
- **`--link wasi_snapshot_preview1`.** No-op / always-on: WASI P1 is already the
  canonical link target and always permitted. Accept it for symmetry; emit no
  warning.
- **Deno globals.** `Deno.*` is a _global object_, not an import module, so it has
  no namespace string to `--link`. `--link deno` is rejected (or warns) — Deno
  stays on its direct-WASI lowering (deno-api.ts). Re-assert
  `denoUsesReadSync/WriteSync` after any recompute (already done at ~6363).
- **Standalone-floor implications.** The standalone-floor gate (runs only on
  `merge_group`) compiles examples with **no** `--link`, exercising the
  inline-lowered path. `--link <ns>` modules are NOT standalone (they import an
  external provider), so they must be **excluded from the standalone floor** — a
  `--link` build is a _linked_ artifact validated by its own round-trip
  (`smoke-test.sh`), not the standalone floor. Ensure no floor example silently
  acquires a `--link` flag.
- **Bundling × linking composition (#2771/#2779).** A bundled multi-file program
  with `--link node:fs` must thread `link` through `compileMultiSource`'s
  `buildCodegenOptions` call exactly like the single-source path. #2771 already
  wired `detectNodeFsImports`/`detectRawWasiImports` into the multi path; this
  issue must ensure the `link` _policy_ set is likewise forwarded (today
  `linkNodeShims` is, via `options.linkNodeShims`; the new `link` array rides the
  same `options` object, so this is mostly free — but add a multi-file test).

### Decomposition into dev-sized slices

| #      | Slice                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Role             | Cost             | Depends on |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------- | ---------- |
| **S1** | **Flag + plumbing (mechanical).** Add `--link <ns>` repeatable parser + `--link-node-shims` deprecation alias in `cli.ts`; add `link?: string[]` to `CompileOptions`; thread through `buildCodegenOptions` (folding `linkNodeShims`→`["node:fs"]`); build `ctx.linkedNamespaces` in `create-context.ts` with the derived `linkNodeShims` getter. No codegen branch changes — existing `ctx.linkNodeShims` sites keep working through the getter. Update `--help`. | developer        | **mechanical**   | —          |
| **S2** | **Strict-gate generalization (core-ish).** Thread `ctx.linkedNamespaces` into the leaked-host-import scan (`host-import-allowlist.ts` + `index.ts:~2000`) so an _arbitrary_ `--link`'d namespace survives `--no-host-imports`. Add the general-namespace import emission test (`--link acme:telemetry` → import survives, gate passes). This is the one genuinely-new capability.                                                                                 | developer        | **medium**       | S1         |
| **S3** | **Tests + back-compat lock-in (mechanical).** Test matrix: (a) `--link node:fs` byte-identical to `--link-node-shims` (the rename is pure); (b) deprecation warning emitted; (c) multi-file (`compileProject`) with `--link node:fs`; (d) `--link` excluded from standalone floor. Wire an `examples/` round-trip for a non-fs namespace if cheap.                                                                                                                | developer        | **mechanical**   | S1, S2     |
| **S4** | **(Optional / follow-up) Generalize the codegen branch sites.** Replace direct `ctx.linkNodeShims` reads in `node-fs-api.ts` / `index.ts` / `linear-uint8-codegen.ts` with namespace-parameterized `ctx.linkedNamespaces.has(ns)` checks, so a _future_ second linkable namespace (e.g. a real `node:process` provider) does not need a second boolean. Pure refactor; no behavior change.                                                                        | senior-developer | **core-codegen** | S1–S3      |

**Ordering**: S1 → S2 → S3 land the generalization with full back-compat. S4 is a
clean-up that only pays off when a _second_ lowerable namespace is actually added
(YAGNI until then) — keep it as a follow-up, not a blocker.

### Honest cost / feasibility verdict

- **S1 + S3 are mechanical** — flag plumbing + tests over an already-threaded
  option. The `linkNodeShims`→derived-getter trick makes the ~30 existing read
  sites zero-churn.
- **S2 is the only real new capability** (permit an arbitrary namespace past the
  strict gate) and is small/medium.
- **S4 is genuinely core-codegen** but **optional/deferred** — the `node:fs`
  lower-vs-import logic is _entangled_ with `node:fs`-specific assumptions (fd
  semantics, the shim owning the shared `memory`, the std-IO→`writeSync` lowering
  from #2633). Generalizing those branch sites to truly arbitrary namespaces is
  only worth it when a second concrete lowerable namespace exists.

**Is `--link-node-shims`→`--link node:fs` a pure rename, or does it hide
per-shim special-casing?** It is a **pure rename for the surface**, but the
_implementation underneath_ is `node:fs`-special-cased: `registerWasiImports`
imports the `node:fs` `memory` + the specific `readSync`/`writeSync` signatures,
the recompute drops `fd_read`/`fd_write` because std-IO is _defined_ (since
#2633) to route through `node:fs`, and the shim-vs-direct sink selection names
`ctx.nodeFsWriteSyncIdx`. So the _flag_ generalizes cleanly (S1–S3); the
_codegen_ does not yet — it knows how to leave exactly **one** namespace as an
import. The general `--link acme:telemetry` works for any namespace that needs
_only_ an import signature (no inline-lowering alternative), because for those
the compiler's only job is "don't reject the import" (S2). A namespace that has
_both_ a lowering and a link path (like `node:fs`) still requires per-namespace
codegen — that is the S4 backlog, deliberately deferred.
