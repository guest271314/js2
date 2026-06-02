---
id: 1764
title: "wasmtime bench: model production edge-serverless per-request instantiation (warm engine), not full process spawns"
status: done
created: 2026-05-31
updated: 2026-06-01
completed: 2026-06-01
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
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

## Measured cold-cost anatomy (2026-05-31, aarch64 dev container, wasmtime 44)

Direct measurement decomposing the `string-hash` cold number — to correct the
prior (wrong) assumption that it reflected a large module. **It does not: the
module is tiny; cold is dominated by fixed per-instance `wasmtime run`
instantiation, not module weight or AOT slowness.**

- `string-hash.js` source: 28 lines / 601 B.
- Compiled module (`target: wasi, nativeStrings, optimize: 3`): **1.4 KB wasm**
  (gzip 0.7 KB). Precompiled artifact: **201 KB `.cwasm`** (native code +
  wasmtime AOT format overhead).
- **Bare `wasmtime run` of an empty no-op module: ~2 ms** (warm disk cache) —
  i.e. wasmtime's own process startup is *not* the bottleneck.
- Cold `wasmtime run --allow-precompiled --invoke run` (best-of-3):
  - `run(1)`   (≈zero compute): **24 ms**
  - `run(1000)`               : **22 ms**
  - `run(50000)` (heavy build+hash): **56 ms**

**Interpretation:** `run(1)` does essentially no work yet costs ~24 ms, so
**~22 ms is fixed per-instance instantiation overhead** over the ~2 ms bare
floor — loading the precompiled module + building the **WasmGC heap / type
definitions** + **WASI** context init + linear-memory growth + first-touch page
faults. Only the jump to 56 ms at n=50000 is actual compute. The published
~30 ms cold ≈ this ~22 ms fixed instantiate + the workload run once.

**Why this matters for the two-lane redesign above:** that ~22 ms is precisely
what a warm-engine / pre-instantiated-module / Wizer-snapshot model removes —
dropping cold toward the ~2 ms floor and revealing AOT's real cold-start lead
(which the current fresh-instantiate-per-call measurement masks). It is also
why the interpreter lanes cluster at ~28–31 ms: they pay the analogous
per-instance engine-setup cost. So Lane B (Wasm pre-instantiated pool) should
report this ~22 ms instantiate cost **once at pool warm-up**, not per request.

## Acceptance criteria

- [x] **Company-agnostic labels** throughout the harness header and landing
      page (no Cloudflare / Fastly / Workers / Compute@Edge / Fermyon /
      Shopify in benchmark framing). *(Label genericization landed in the
      originating PR — Deliverable 1; this criterion is the regression guard:
      no commercial platform name reappears in the framing.)*
- [x] **Cold lane models warm-engine per-request instantiation for BOTH
      lanes**: JS via `node:vm` createContext (+ optional `worker_threads`
      sensitivity row); Wasm via a warm-`Engine` + fresh-`Instance` host
      (Node binding, in-Node `WebAssembly` API, or minimal Rust/C wasmtime
      host — whichever is chosen, with the tradeoff documented).
- [x] **Methodology documented** in BOTH the issue (resolution notes) and the
      harness header comment: which mechanism each lane uses, the `vm`-lighter
      / worker-heavier JS fidelity bounds, and the wasmtime-embedding choice
      and its engine-fidelity tradeoff.
- [x] **Numbers refreshed** in `benchmarks/results/wasm-host-wasmtime-hot-runtime.json`
      (+ the `website/public/...` copy) once the embedding harness exists,
      using current main's compiler, with a stability proof in the same shape
      as #1760 (repeated identical-binary samples, spread reported).
- [x] **No new always-on heavy dependency** without sign-off: if a Rust/C
      host is required, it is an optional, documented build step (the
      generator degrades gracefully / skips that lane when the host binary is
      absent, exactly as it skips Javy/StarlingMonkey today).

## Fidelity / tradeoff summary (must appear in the harness header)

| Lane | Mechanism | Fidelity caveat |
|------|-----------|-----------------|
| JS cold | `node:vm` `createContext` + run (warm V8) | `vm` Context is **lighter** than a true isolate (shared heap/builtins) → **lower bound** on per-request JS cost. Optional `worker_threads` row = **upper bound**. |
| Wasm cold | Rust host with warm Wasmtime `Engine` + Cranelift-compiled `Module`; per sample fresh `Store` + `Instance` | `wasmtime run` CLI cannot pool — needs an **embedding**. The Rust host measures true Wasmtime/Cranelift instantiation and adds a Cargo build step. |
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

## Implementation Summary

### What was done

- Replaced the full-process cold lane in
  `scripts/generate-wasmtime-hot-runtime.mjs` with warm-engine,
  per-request measurements:
  - JS cold primary: `node:vm` `createContext` + fresh `Script` compile +
    first `run(arg)` in one long-lived Node/V8 process.
  - JS cold sensitivity: compiled-once `Script` + fresh context per request,
    emitted as `jsCompiledContextUs` / `jsCompiledContextStdUs`.
  - Wasm cold primary: a committed Rust host in
    `benchmarks/wasmtime-cold-host` owns a warm Wasmtime `Engine` plus a
    Cranelift-compiled `Module`, then creates a fresh `Store` + `Instance`
    and calls `run(arg)` once per measured request.
  - Javy / StarlingMonkey cold auxiliaries: the same Rust host now measures
    matching warm-engine, fresh-store+instance samples. Javy uses a
    dynamic-link module plus a preloaded `javy-default-plugin-v3` module.
    StarlingMonkey uses a ComponentizeJS component with Wizer + Weval AOT.
    Both auxiliary cold lanes use a fixed-argument no-return wrapper because
    Javy v8.1.1 WIT exports only support `func()` today.
- Documented the fidelity tradeoffs in the harness header and landing-page
  copy:
  - `vm` Context is a lower bound for a real V8 isolate.
  - A Worker-per-request row would be the heavier upper-bound analog but is
    not emitted by default.
  - The Wasm cold lane uses Wasmtime's Rust embedding API, so the primary
    cold number is a Cranelift instantiation number rather than a Node
    `WebAssembly` lifecycle fallback.
- Kept the #1760 warm steady-state lane unchanged: Wasm still uses
  `wasmtime run --invoke warm` with in-process repeated measurement; JS still
  uses the existing child-process warm iterator.
- Added `wasmMinUs` / `wasmMaxUs` / `jsMinUs` / `jsMaxUs` to every benchmark
  row so the committed JSON carries the repeated-sample spread alongside
  medians and stddevs.
- Replaced legacy Javy / StarlingMonkey **cold** values with matching #1764
  warm-engine measurements instead of plotting the old full-process startup
  numbers beside the new AOT cold lane. Their warm steady-state values remain
  carried from the verified labs harness.
- Added a Wasmtime-normalization pass using the existing `wasm-opt`
  `--all-features --disable-custom-descriptors` CLI shape before the
  Wasmtime warm precompile. This matches the project’s #1173 harness fix and
  prevents the optimized `string-hash` warm artifact from reintroducing exact
  refs that Wasmtime rejects.
- Refreshed `benchmarks/results/wasm-host-wasmtime-hot-runtime.json` and the
  `website/public/...` mirror with Node v24.4.1, Wasmtime 45.0.0
  (`377cd917a`, 2026-05-21), and the Rust `wasmtime` crate 45.0.0.
- Updated `website/index.html` to describe the new warm-engine cold model and
  the Rust Wasmtime host without naming commercial platforms.
- Added `tests/issue-1764.test.ts` to guard methodology documentation, cold
  row metadata/spread fields, matching auxiliary cold lanes, and
  company-agnostic benchmark framing.

### What worked

- The Rust Wasmtime host directly models the requested warm-Engine /
  fresh-Store+Instance lifecycle and keeps host process startup outside the
  measured samples.
- The compiled-once JS sensitivity row showed the intended lower-bound
  distinction without changing the chart’s primary `jsUs` baseline.
- The existing `wasm-opt --disable-custom-descriptors` mitigation was enough
  to keep the refreshed `string-hash` warm artifact loadable by Wasmtime 45.

### What did not work

- The first implementation used Node's host `WebAssembly` API as a pragmatic
  lifecycle-shape fallback. That was rejected because it did not measure
  Wasmtime/Cranelift. The Rust embedding host replaces that fallback.
- I did not emit the optional `worker_threads` upper-bound row by default; it
  would make refreshes heavier and needs chart/schema design before becoming
  user-facing.

### Files changed

- `.gitignore`
- `benchmarks/wasmtime-cold-host/Cargo.toml`
- `benchmarks/wasmtime-cold-host/Cargo.lock`
- `benchmarks/wasmtime-cold-host/src/main.rs`
- `scripts/generate-wasmtime-hot-runtime.mjs`
- `scripts/wasmtime-bench-child-js.mjs`
- `website/index.html`
- `benchmarks/results/wasm-host-wasmtime-hot-runtime.json`
- `website/public/benchmarks/results/wasm-host-wasmtime-hot-runtime.json`
- `tests/issue-1764.test.ts`

### Tests

- `PATH=.tmp/wasmtime-home/bin:$HOME/.cargo/bin:$PATH
  JAVY_BIN=.tmp/javy-v8.1.1 pnpm run refresh:benchmarks:wasmtime` passed
  and refreshed both benchmark JSON files with the Rust Wasmtime cold host,
  Javy 8.1.1 dynamic-plugin cold lane, and ComponentizeJS 0.20.0
  StarlingMonkey component cold lane.
- `cargo build --release --manifest-path benchmarks/wasmtime-cold-host/Cargo.toml`
  passed.
- `cargo fmt --check --manifest-path benchmarks/wasmtime-cold-host/Cargo.toml`
  passed.
- `node node_modules/vitest/dist/cli.js run tests/issue-1764.test.ts tests/issue-1580.test.ts`
  passed: 2 files, 9 tests.
- `node --check scripts/generate-wasmtime-hot-runtime.mjs` passed.
- `node --check scripts/wasmtime-bench-child-js.mjs` passed.
- `pnpm exec prettier --check scripts/generate-wasmtime-hot-runtime.mjs scripts/wasmtime-bench-child-js.mjs tests/issue-1764.test.ts benchmarks/results/wasm-host-wasmtime-hot-runtime.json website/public/benchmarks/results/wasm-host-wasmtime-hot-runtime.json`
  passed.
- `git diff --check` passed.
- Accidental broad `pnpm test -- tests/issue-1764.test.ts tests/issue-1580.test.ts`
  invocation ran the wider suite, hit many existing unrelated failures, and
  eventually exited with a V8 out-of-memory error. The targeted Vitest run
  above is the relevant signal for this issue.
