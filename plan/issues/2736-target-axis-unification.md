---
id: 2736
title: "Unify --platform into --target {wasi,node,deno,web} — the single host axis (#2698 foundation)"
status: done
created: 2026-06-27
updated: 2026-06-27
completed: 2026-06-27
assignee: ttraenkler/sendev-target-axis
priority: high
feasibility: hard
reasoning_effort: max
task_type: refactor
area: host-interop
language_feature: node-api-compat
goal: platform
sprint: Backlog
es_edition: n/a
related: [2698, 2528, 2645, 389]
parent: 2698
origin: "Stakeholder directive (2026-06-26/27): collapse the two host axes (`--target wasi` output ABI + `--platform node|web|deno` ambient surface) into ONE `--target {wasi,node,deno,web}` axis. Foundation slice of the re-scoped #2698."
---

# #2736 — `--platform` → `--target` unification (single host axis)

## Problem

The compiler exposed **two** axes for "what host does this program target":

- `--target {gc,linear,wasi,standalone}` — the backend / output ABI;
- `--platform {web,node}` (#2528/#2645) — the ambient global surface (DOM vs
  node) + node-emulation injection.

The stakeholder collapsed these into **one user-facing `--target` axis**:

- `--target web` (the **default**) — WasmGC / JS-host browser surface (DOM
  ambient globals in scope). Byte-identical to today's default.
- `--target node` — a real **Node** host: Node ambient surface, no DOM,
  node-emulation on.
- `--target deno` — a real **Deno** host: analogous to `node`.
- `--target wasi` — standalone WASI Preview 1 (unchanged).

The backend-lowering names (`gc`/`linear`/`standalone`) stay valid `--target`
values — they are an orthogonal backend choice, not a host axis.

## Scope (THIS slice — axis plumbing + migration ONLY)

NOT the real-types loading. This slice establishes the unified axis and routes
the existing #2528/#2645 logic onto it. The real `@types/node` (S1) / real Deno
lib (S2) loading, the host-keyed link registry (S3), and the link-time gate (S4)
are later #2698 slices.

## What changed

- **`src/cli.ts`**: `--target` now accepts `web|node|deno|wasi` plus the
  back-compat backend names `gc|linear|standalone`. Host values (`web/node/deno`)
  route to the internal `platform` field; backend values route to `target`.
  `--platform {web,node,deno}` is kept as a **deprecated alias** that maps onto
  the same field and prints a one-line deprecation warning. Help text updated;
  `deno` added to the accepted host values. `--target=foo` form also accepted.
- **`src/index.ts` / `src/checker/index.ts`**: `CompileOptions.platform` and
  `AnalyzeOptions.platform` extended to `"web" | "node" | "deno"`; doc comments
  re-framed around `--target`.
- **`src/compiler.ts`**: `effectiveEmulateNode` now ORs `platform === "deno"`.
- **`src/checker/index.ts`**: `resolveEmulateNode` and
  `defaultLibNameForPlatform` treat `deno` like `node` (node-emulation on,
  DOM-free composite). `src/checker/language-service.ts`: the incremental path's
  default-lib selection treats `deno` like `node`.

## Design notes (WHY)

- **The internal field stays `platform`, NOT renamed.** The user-facing flag is
  unified under `--target`, but internally the host axis and the backend `target`
  must remain **distinct fields** — they are genuinely orthogonal (a `--target
wasi` backend can still carry a node/web ambient surface; `gc/linear/standalone`
  are backend lowerings). Renaming `platform`→`target` would collide with the
  existing backend `target`; renaming to `hostMode` is deferred to #2698 S3 (the
  link-satisfaction registry introduces `hostMode` as its own concept). Keeping
  `platform` also preserves the #2528/#2645 programmatic API + existing tests
  unchanged.
- **`deno` is a placeholder route, not a real Deno surface.** Per the scope, this
  slice maps `deno` through the **same node-emulation / no-DOM ambient surface as
  `node`**. #2698 S2 swaps that for the real `lib.deno.ns.d.ts`.
- **Byte-neutrality.** `platform === "web"` is byte-identical to unset (both →
  DOM composite, no emulation), and `deno`/`node` only change _type-level_ ambient
  resolution — never emitted wasm. The default (no flag) and `--target wasi`
  paths pass exactly the options they did before. Verified: default ≡ web ≡ node
  ≡ deno binaries for an ES-only program (sha256), and the existing #2528/#2645
  byte-neutral tests still pass.

## Validation

- tsc + biome lint clean.
- `tests/issue-2736-target-axis.test.ts` (new): deno routing (no DOM, process
  resolves), byte-neutrality (default ≡ web ≡ node ≡ deno), and CLI parsing
  (`--target node|deno`, deprecated `--platform` warning, unknown-value message).
- `tests/issue-2528-2645-platform-node-web.test.ts` (existing): unchanged, still
  green — the `platform` option API is preserved.

## Acceptance

- [x] `--target {wasi,node,deno,web}` is the single user-facing host axis;
      default = web (today's behaviour).
- [x] `--platform` works as a deprecated alias with a one-line warning.
- [x] Default + `--target wasi` byte-identical to pre-#2736.
- [x] `--target node|deno|web` route to the correct ambient surface.
- [x] #2698 updated to the unified `--target` model.

## Follow-ups (later #2698 slices)

- S1: real `@types/node` under `--target node`.
- S2: real Deno lib under `--target deno` (replace the placeholder node-surface
  route).
- S3: host-keyed (`hostMode`) link-satisfaction registry.
- S4: link-time used+unsatisfiable gate.
