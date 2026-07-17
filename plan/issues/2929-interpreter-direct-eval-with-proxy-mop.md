---
id: 2929
title: "Interpreter direct eval + with + Proxy-MOP convergence"
status: backlog
created: 2026-07-02
updated: 2026-07-02
priority: medium
horizon: xl
feasibility: hard
model: fable
reasoning_effort: max
task_type: feature
area: runtime
language_feature: eval
goal: runtime-eval
sprint: Backlog
parent: 1584
depends_on: [2928, 2925, 2864]
related: [1355, 2865]
---

# #2929 — Interpreter direct eval + `with` + Proxy-MOP convergence

Slice **F** of the runtime-eval roadmap
([docs/architecture/runtime-eval-interpreter.md](../../docs/architecture/runtime-eval-interpreter.md), §6-F, §7).
#1584 Phase 2. Adds standalone **direct-eval scope capture** to the interpreter,
and — deliberately — builds the shared substrate (`with`, Proxy MOP) so those
tracks converge on it instead of re-deriving it.

## Scope

### 1. Standalone direct-eval scope capture
Add `LdName` / `StName` opcodes that resolve identifiers against a **reified
environment-record chain** (§4.1). Reuse the `$EnvRecord`/name-map carrier
introduced in the JS-host reification slice **#2925** (which extends #2864's
`$Frame` with a name map) — do NOT define a second environment type. This makes
`function f(){ var x=1; eval("x=2"); return x }` return `2` **standalone**,
mirroring the JS-host behavior #2925 delivers.

### 2. `with` (shared substrate, roadmap §7)
`with (obj) { … }` prepends an **object environment record** to the lexical
environment chain and resolves names against the object's properties — the same
chain the interpreter walks for direct eval, with one link being an arbitrary
object. Implement `with` as an object-environment-record variant of the §1
chain. (`with` is currently in the IR "deferred-feature" bucket alongside eval;
this is where it exits that bucket.)

### 3. Dynamic meta-object protocol (Proxy trap surface, roadmap §7)
The interpreter's generic property opcodes —
`Get`/`Set`/`GetByValue`/`HasProperty`/`OwnKeys`/`Delete` — must implement the
full ordinary-object internal methods (prototype chain + descriptor semantics)
on `any`-typed receivers. Build these as **reusable `$Object`-level MOP
primitives** so #1355's Proxy handler dispatch plugs into the *same* surface.
**This issue does not implement Proxy traps or edit #1355's files** — it exposes
the MOP primitives #1355 consumes, and coordinates their signatures with the
#1355 owner (roadmap §7).

### 4. Generator / async opcodes
`SuspendGenerator`/`ResumeGenerator`/`YieldValue`, aligned with the #2864/#2865
`$Frame` suspend/resume encoding (the interpreter's frame IS the #2864 carrier).

## Coordination (must-not-diverge)

Per roadmap §7, the `$EnvRecord` type (with #2925/#2864) and the MOP-primitive
signatures (with #1355) are reviewed **jointly with those owners before
implementation**, so one carrier and one MOP surface serve direct-eval, `with`,
and Proxy.

## Acceptance criteria

- [ ] `function f(){ var x=1; eval("x=2"); return x }()` returns `2`
      **standalone** (interpreter direct-eval capture).
- [ ] `with ({a:1}) { a }` evaluates to `1` via the object-environment-record
      chain (standalone).
- [ ] The MOP primitives are consumed by at least one #1355 Proxy trap in a
      joint integration test (coordinated, not implemented here).
- [ ] A generator run through the interpreter suspends/resumes correctly using
      the #2864 `$Frame` carrier.
- [ ] Direct-eval scope tests pass identically via JS-host (#2925) and the
      standalone interpreter (differential check).

## Notes

Depends on #2928 (VM core), #2925 (env-record carrier), #2864 (`$Frame`).
Converges with #1355 (Proxy) and `with`. Umbrella: #1584. Goal: `runtime-eval`.
