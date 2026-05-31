---
id: 1764
title: "wasmtime bench: model production edge-serverless per-request instantiation (warm engine), not full process spawns"
status: ready
created: 2026-05-31
updated: 2026-05-31
priority: medium
feasibility: hard
reasoning_effort: high
task_type: enhancement
area: benchmarks
goal: platform
sprint: 58
related: [1760, 1580, 1746]
origin: project lead asked to (1) strip commercial platform names from the edge-serverless benchmark framing and (2) make the cold lane model how production edge runtimes actually serve a request — a per-request context/instance from a warm engine — instead of a full OS-process spawn per request.
---

# #1764 — model production edge-serverless per-request instantiation (warm engine), not full process spawns

## Problem

`scripts/generate-wasmtime-hot-runtime.mjs` measures the **cold** lane as
full OS-process spawns:

- **Wasm lane:** `wasmtime run --allow-precompiled <cwasm>` wall time —
  measures process spawn + wasmtime engine boot + cwasm `mmap` + signature
  check + a single `run(arg)`.
- **JS lane:** `node script.js` wall time — measures process spawn + V8
  engine boot + module parse + Ignition→Liftoff + first invocation.

That is the **true cold-process worst case** — a brand-new OS process per
request — which is **not how production edge serverless runs**. Real edge
runtimes (V8-isolate platforms and AOT-Wasm platforms alike) keep the
**engine/runtime warm and resident** across requests and pay only a
lightweight **per-request execution context / instance** cost:

- A V8-isolate runtime spins up a fresh **isolate (or context)** per request
  against an already-booted V8 — microseconds-to-low-milliseconds, not the
  tens-of-ms of a cold `node` process.
- An AOT-Wasm runtime instantiates a fresh **`Instance`** of an
  already-compiled `Module` against a long-lived `Engine` — often
  sub-millisecond, and faster still with a pre-instantiated/pooled instance
  (Wizer-style snapshot).

Because both current cold numbers are dominated by **process startup** (the
exact noise #1760 documented for the warm lane — ~tens of ms, ms-scale
jitter), the published cold comparison overstates absolute cost for **both**
lanes and is not representative of real edge cold-start. The chart framing
also names specific commercial platforms, which the project lead wants
removed in favour of architecture-level descriptions.

Deliverable 1 of the originating PR already **genericized the labels** (see
"Done in the same PR" below). This issue covers the substantive,
embedding-dependent **measurement change**.

## Scenario model (target)

Three lanes, all against a **warm, long-lived engine** (no per-request
process spawn):

### Lane A — JS "isolate-per-request, warm engine" (cold)

A single long-lived Node process that, **per measured request**, creates a
fresh per-request execution context, compiles the program into it, runs it
once, and records `contextCreate + compile + firstRun`.

**Mechanism (pick one, document the fidelity tradeoff):**

1. **`node:vm` `createContext` + `Script.runInContext`** (recommended
   default). Long-lived process; per request: `vm.createContext({...})`,
   `new vm.Script(src)` (or a pre-compiled `Script` reused — measure both:
   *fresh-compile-per-request* and *compiled-once, new-context-per-request*),
   then `script.runInContext(ctx)`. Measures context allocation + first run
   against a warm V8.
   - **Fidelity limitation (state plainly in the harness header):** a `vm`
     Context is **lighter** than a true V8 *isolate* — it shares the host
     isolate's heap and built-ins, so it under-counts the per-isolate
     allocation a real isolate-per-request platform pays. It is the closest
     *in-process, dependency-free* analog and is honest as a **lower bound**
     on per-request JS context cost.
2. **`worker_threads` Worker per request** (alternative). A fresh `Worker`
   is **heavier** than a context (own event loop + heap) and over-counts vs
   an isolate, but is a closer structural analog to "new isolate." Higher
   per-request cost and teardown complexity.

**Decision:** default to **`node:vm` createContext** for the primary cold-JS
number (dependency-free, lower-bound honest), and optionally report the
`worker_threads` number as an upper-bound sensitivity row. Document both
bounds in the header so the `vm`-is-lighter / worker-is-heavier caveat is
explicit and the reader knows the true isolate cost sits between them.

### Lane B — Wasm "pre-instantiated module pool, warm engine" (cold)

A single long-lived **host** that holds a warm wasmtime `Engine` + an
already-compiled `Module` (from the existing `.cwasm`), and **per measured
request** creates a **fresh `Instance`** (optionally drawn from a
pre-instantiated/pooled set, Wizer-style), calls `run(arg)` once, and
records `instantiate + firstRun`.

**Key new dependency — this is the main implementation cost:** the
`wasmtime run` **CLI cannot model instance pooling** — every CLI invocation
is a new process with a cold engine. Modelling "fresh instance, warm engine"
**requires a wasmtime *embedding* host** that owns the `Engine`/`Store`/
`Instance` lifecycle directly.

Options, smallest viable first:

1. **Node wasmtime binding, if a maintained one exists.** Check
   `@bytecodealliance/*` and community npm bindings for a Node API exposing
   `Engine` + `Module` + per-call `Instance`. **If a Node-friendly embedding
   genuinely exists and is maintained**, this is the cheapest path — keep
   the whole harness in the existing `.mjs`. **As of writing, no maintained,
   production-grade Node wasmtime *embedding* (Engine/Instance lifecycle, not
   just `wasmtime run` shell-out) is known** — the dev MUST verify current
   state before assuming one exists. The browser/Node `WebAssembly` API
   (`WebAssembly.compile` once + `new WebAssembly.Instance` per request) is a
   **legitimate fallback for the "warm engine, fresh instance" shape** and
   runs in Node with zero new deps — but it measures **V8's** Wasm
   instantiation, not **Cranelift/wasmtime's**, so it is a different engine
   than the cold-process lane it replaces. Call this tradeoff out explicitly;
   it may still be the right pragmatic choice for an apples-to-apples
   "instantiate-per-request" number if both JS and Wasm lanes then run on the
   same V8 engine.
2. **Minimal Rust (or C) wasmtime host** (the faithful path). A tiny binary
   using the `wasmtime` crate: at startup `Engine::new` + `Module::from_file`
   (deserialize the `.cwasm`), then a loop that per iteration does
   `Instance::new(&mut store, &module, &imports)` + `instance.get_typed_func`
   + `func.call(arg)`, timing each with `Instant::now()`, and prints the
   per-request `instantiate + firstRun` (min/median) to stdout. Optionally
   add the **pooling allocator** (`Config::allocation_strategy(Pooling)`)
   and/or a Wizer pre-init snapshot to model the pre-instantiated pool.
   **This is the main new implementation cost: a small Rust/C host crate +
   a build step**, the smallest viable form of which is ~80–120 lines plus a
   `Cargo.toml`. The `.mjs` generator shells out to the built host binary the
   same way it shells out to `wasmtime run` today.

**Recommendation for the spec:** the dev should first **verify** whether a
maintained Node wasmtime embedding exists. If yes → Option 1 (cheapest). If
no (the likely case) → choose between (a) the in-Node `WebAssembly`-API
fallback for a same-engine V8-vs-V8 instantiate comparison, accepting it is
not Cranelift, or (b) the faithful **minimal Rust wasmtime host** for a true
Cranelift instance-pool number, accepting the build-step cost. **State the
chosen path and its tradeoff plainly in both the issue resolution and the
harness header.** If the Rust/C host is required, **that is the primary
implementation cost of this issue** and should be sized accordingly.

### Lane C — warm steady-state (unchanged, re-labelled)

The existing **warm** lane (#1760, in-process repeated-measure) already
correctly models "warm isolate / reused instance steady state" — engine
warm, instance/isolate reused, optimizing tiers settled, many in-process
iterations, min/median per-call. **Keep it as-is**; only **re-label** it to
the company-agnostic "warm isolate/instance reuse (steady state)" framing.

## Re-framing the cold lane

Replace "fresh process per request" with **"per-request cold = new
context/instance from a warm engine (µs–ms)."** Expected effect:

- **Both** cold numbers should **drop dramatically** versus the current
  process-spawn numbers (process boot is no longer in the measurement).
- The cold comparison becomes **representative of real edge cold-start**
  (per-request instantiation against a resident engine), which is the
  scenario the landing page actually wants to depict.
- The absolute ranking may shift: instance instantiation vs context creation
  is a much closer race than process boot vs process boot, which is the
  honest story.

## Acceptance criteria

- [ ] **Company-agnostic labels** throughout the harness header and landing
      page (no Cloudflare / Fastly / Workers / Compute@Edge / Fermyon /
      Shopify in benchmark framing). *(Label genericization landed in the
      originating PR — Deliverable 1; this criterion is the regression guard:
      no commercial platform name reappears in the framing.)*
- [ ] **Cold lane models warm-engine per-request instantiation for BOTH
      lanes**: JS via `node:vm` createContext (+ optional `worker_threads`
      sensitivity row); Wasm via a warm-`Engine` + fresh-`Instance` host
      (Node binding, in-Node `WebAssembly` API, or minimal Rust/C wasmtime
      host — whichever is chosen, with the tradeoff documented).
- [ ] **Methodology documented** in BOTH the issue (resolution notes) and the
      harness header comment: which mechanism each lane uses, the `vm`-lighter
      / worker-heavier JS fidelity bounds, and the wasmtime-embedding choice
      and its engine-fidelity tradeoff.
- [ ] **Numbers refreshed** in `benchmarks/results/wasm-host-wasmtime-hot-runtime.json`
      (+ the `website/public/...` copy) once the embedding harness exists,
      using current main's compiler, with a stability proof in the same shape
      as #1760 (repeated identical-binary samples, spread reported).
- [ ] **No new always-on heavy dependency** without sign-off: if a Rust/C
      host is required, it is an optional, documented build step (the
      generator degrades gracefully / skips that lane when the host binary is
      absent, exactly as it skips Javy/StarlingMonkey today).

## Fidelity / tradeoff summary (must appear in the harness header)

| Lane | Mechanism | Fidelity caveat |
|------|-----------|-----------------|
| JS cold | `node:vm` `createContext` + run (warm V8) | `vm` Context is **lighter** than a true isolate (shared heap/builtins) → **lower bound** on per-request JS cost. Optional `worker_threads` row = **upper bound**. |
| Wasm cold | warm `Engine` + fresh `Instance` (Rust/C host, Node binding, or in-Node `WebAssembly` API) | `wasmtime run` CLI cannot pool — needs an **embedding**. In-Node `WebAssembly` API measures **V8 Wasm**, not Cranelift. A Rust/C host measures **true wasmtime/Cranelift** but adds a build step. |
| Warm (both) | #1760 in-process repeated-measure | already faithful steady state; re-label only. |

## Primary implementation cost (call-out)

If no maintained **Node wasmtime embedding** (Engine/Instance lifecycle, not
a `wasmtime run` shell-out) exists at implementation time — **the likely
case** — a **minimal Rust (or C) wasmtime host crate + build step** is
required to produce a faithful Cranelift instance-pool cold number. That host
(plus its wiring into the `.mjs` generator and CI/build) is the **main cost**
of this issue. The dev should verify the binding landscape first and record
the finding; if the Rust/C host is needed, size the work around it.

## Done in the same PR (Deliverable 1 — label genericization)

The originating PR (`bench: genericize edge-serverless labels + spec
production per-request measurement`) already:

- Stripped commercial platform names from
  `scripts/generate-wasmtime-hot-runtime.mjs` header (Fastly/Cloudflare/
  Workers/Fermyon → "AOT-compiled Wasm edge runtime (pre-instantiated
  module)" vs "V8-isolate edge runtime (isolate-per-request)"; "Shopify-style
  dynamic-link" → "dynamic-link plugin mode").
- Genericized the landing-page (`website/index.html`) cold/warm section copy
  to describe the two architectures, with a #1764 caveat that the cold lane
  currently measures a full cold process per request.
- Verified `website/index.html` stays valid HTML and its `data-texts` JSON
  still parses.

This issue (#1764) is the follow-up that changes the **measurement** itself.
