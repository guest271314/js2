# Runtime code evaluation: `eval`, indirect `eval`, `new Function`

**Status:** architecture (this document) — decomposes the standing strategy
proposal #1584 into a staged, landable roadmap and records the strategy
decision with its trade-offs.
**Author:** architect (arch-interp), 2026-07.
**Scope:** direct `eval`, indirect `eval` (`(0, eval)(s)`), and the `Function`
constructor / `new Function`. **Out of scope of this doc:** `with` and `Proxy`
mechanics themselves (tracked in #1355) — but this doc specifies the shared
substrate (environment reification, dynamic meta-object protocol, boxed-any
bridge) so those tracks **converge** on it rather than diverging.

Related prior art already on `main`: #1006/#1164 (JS-host eval shim),
#1163 (constant-string compile-away inliner), #1261 (eval tiering classifier),
#1584 (this strategy, umbrella), #1715 (bytecode-backend proof point, done),
#1710 (Acorn dogfood harness, done), #2864 ($Frame generator carrier,
in-progress), #2527 (core-wasm module linking, in-progress).

---

## 1. TL;DR — the recommendation

Runtime code evaluation is **not one feature**; it is a **tiered fallback
ladder**, and two of its three rungs already exist on `main`. The right
architecture is to finish the ladder, not to start a VM from scratch:

- **Tier 0 — compile-away (AOT splice).** When the source string is
  compile-time constant, parse it and splice the AST inline at compile time.
  Already shipped for `eval("<const>")` (#1163); **broaden** it (it currently
  bails on functions/classes/for-of in the body) and **extend** it to
  `new Function("<const params>", "<const body>")` (which today is a no-op
  stub). Pure AOT — works **standalone today**, no interpreter, no host.
- **Tier 1 — JS-host meta-circular.** When a JS runtime is present, recompile
  the dynamic source through js2wasm at runtime into a fresh WasmGC module
  (`createEvalShim`, #1164). Already shipped and passing the bulk of the eval
  suite in JS-host mode; the remaining gap is **direct-eval scope capture**,
  which requires environment reification (see §4.1).
- **Tier 2 — standalone bytecode interpreter.** When there is **no** JS host
  and the source is **not** constant, run a compact WasmGC-native bytecode
  interpreter embedded in the module: Acorn (compiled by js2wasm) parses,
  a second IR backend emits bytecode, a typed dispatch loop runs it. This is
  the lead's steer and #1584's committed direction. It is the standalone leg
  of the ladder, built **last**, because Tiers 0/1 already cover most cases
  and it is gated on independent substrate work (self-host maturity, #2864
  `$Frame`, #2527 linking).

The **single load-bearing decision** is *how* the standalone interpreter
represents values. We choose **strategy 2(a): author the interpreter in the
js2wasm-compilable TypeScript subset and self-compile it**, so the
interpreter's `JSValue` **is, by construction, the same `anyref`/`$Object`
substrate the AOT path already uses.** That makes the value-representation
bridge — the crux of every eval design — *free*. Every alternative
(hand-written WAT VM 2(b), embedded QuickJS 2(c), full meta-circular 3) pays a
marshalling/identity tax at the AOT↔dynamic boundary that this one avoids.
§3 argues this honestly against each alternative.

**Three-sentence version:** Keep the existing JS-host meta-circular fast path
(#1164) and the constant-string compile-away path (#1163) as Tiers 1 and 0, and
build the standalone answer as a WasmGC-native bytecode interpreter authored in
the js2wasm-compilable TS subset and self-compiled (#1584 strategy 2a) so its
values are the *same* boxed-any substrate as the AOT path — making the
value-rep bridge free and preserving `ref.eq` object identity across the
boundary, which the linear-memory QuickJS route (2c) cannot. Sequence the work
so the cheap, backend-agnostic wins land first (broaden constant-string
compile-away; `new Function` constant-body compile-away; direct-eval scope
reification in JS-host), and defer the interpreter proper (Acorn-via-js2wasm +
bytecode emitter + dispatch loop) to the L/XL back half, where it depends on
self-host maturity and the #2864 `$Frame` carrier. Order the interpreter
milestones **`new Function` (global scope, no capture) → indirect eval (global)
→ direct eval (scope capture, needs `$Frame`)**, because global-only evaluation
needs no environment reification and is the largest, easiest slice.

---

## 2. Current state on `main` (what already exists)

| Mechanism | File | What it does | Standalone? |
|---|---|---|---|
| Constant-string `eval` inliner (#1163) | `src/codegen/expressions/eval-inline.ts` | Parses a compile-time-constant `eval("…")` string as a Script and splices its statements inline at the call site. Bails on function/class/arrow/for-of/for-in/yield/await in the body. | **Yes** (pure AOT) |
| Eval tiering classifier (#1261) | `src/codegen/eval-tiering.ts` | Read-only pass classifying a module's eval usage into 5 tiers (NoEval / StaticLiteral / Indirect / DirectStrict / DirectSloppy). Does not yet gate codegen. | n/a |
| Call-site lowering | `src/codegen/expressions/calls.ts` (~3965) | Tries `tryEvalAsRegExpPeephole` → `tryStaticEvalInline` → falls through to `__extern_eval(src, isDirect)` host import. | Host import → traps standalone |
| JS-host meta-circular shim (#1164) | `src/runtime-eval.ts` (`createEvalShim`), `src/runtime.ts` (~8048) | Recompiles the dynamic source through js2wasm at runtime → fresh WasmGC module via `WebAssembly.Module(bytes)` (sync). CSP-friendly (`wasm-unsafe-eval`), no `(0,eval)` capability leak. Legacy `(0,eval)` fallback for harness-rewritten strings. | **No** — host import absent standalone |
| `new Function(...)` | `src/codegen/expressions/new-super.ts` (~3179) | **No-op stub**: evaluates args for side effects, returns `ref.null.extern` (a function that returns `undefined`). | trivially, but wrong |

**Key correction to the #1584 framing:** #1584 was written as if eval were an
unsolved greenfield problem. It is not — Tiers 0 and 1 are shipped. This doc
re-bases the roadmap on that reality: the interpreter is the *third* leg, and
several high-value slices (broaden Tier 0, `new Function` compile-away,
direct-eval reification in Tier 1) land **before** any VM exists.

---

## 3. Strategy comparison (challenged honestly)

The lead asked for trade-off honesty, not a foregone conclusion. Here is each
strategy on its merits, with the reason it wins or loses.

### 3.1 JS-host fast path (naive `(0, eval)`)
Strategy 1 as literally posed — `eval` via the host's own `eval`. **Rejected as
the primary path, retained only as a harness-compatibility fallback.** It leaks
the entire JS capability surface (`window`, `fetch`, `Function`, globals) the
moment control reaches the host, and CSP without `'unsafe-eval'` blocks it.
#1164 already replaced it with the meta-circular shim (Tier 1) for exactly these
reasons; the raw `(0,eval)` path survives only inside `_legacyHostEval` for
test262 harness strings the WasmGC recompile can't yet handle. **Verdict:
fast path only, and already superseded by the meta-circular shim.**

### 3.2(a) Embedded interpreter, authored in TS and self-compiled — **CHOSEN**
The interpreter (parser bridge, bytecode emitter, dispatch loop, built-ins) is
written in the js2wasm-compilable TypeScript subset and compiled by js2wasm
itself into the same module.

- **Pro — the value-rep bridge is free.** Because js2wasm compiles the
  interpreter, the interpreter's `JSValue` *is* the AOT path's
  `anyref`/`$Object` substrate (tag-5 field-4 classifier, `__box_number`
  boxing, native i16-array strings). A value produced by AOT code is read
  directly by an opcode; a value produced by an opcode is returned to AOT code.
  No marshalling layer, and — decisively — **object identity is preserved
  across the boundary via `ref.eq`** (the standalone-equality invariant in
  memory `reference_standalone…object_identity`). This is the property no
  embedded-engine route can match.
- **Pro — built-ins are shared work.** Every `Array.prototype.*`,
  `String.prototype.*`, `Object.*` implemented once against the boxed rep
  serves both the AOT path (specialized wrappers) and the interpreter (generic
  `CallBuiltin`). The engineering surface that dominates a JS engine (the
  library) is work that standalone conformance needs anyway.
- **Pro — Acorn-via-js2wasm doubles as a self-host stress test** for #1058;
  the dogfood harness already exists (#1710, done) and the IR→bytecode backend
  seam is already proven (#1715, done).
- **Con — the compiler's own gaps bite.** Acorn uses generators, classes,
  computed properties; the dispatch loop is a large `switch`. Each gap is a
  real compiler issue surfaced early (mitigation: Acorn compilation is the
  first interpreter slice, §6-D). This is a feature, not only a cost — it is
  the same self-hosting pressure the project already invests in.
- **Con — interpreter throughput is bounded by js2wasm's own codegen quality**
  on a switch-dispatch loop. Acceptable: the interpreter is the *fallback*, not
  the hot path; hot code is AOT. Tier-up (re-AOT-compile hot interpreted
  functions) is a deferred Phase-2 option, not a Phase-1 requirement.

### 3.2(b) Hand-written core-wasm / WAT runtime module, linked via #2527
A 120–150-opcode VM hand-written in WAT, shipped as a prebuilt `.wasm` and
linked to the app module via the #2527 canonical-rec-group core-wasm linking
(shared store, zero-copy `$Object`).

- **Pro — full control of dispatch-loop performance** (no dependency on
  js2wasm compiling a complex TS interpreter well), and it distributes as a
  library artifact rather than inlined bytes.
- **Con — it throws away the shared-built-ins lever.** Every built-in must be
  hand-written in WAT *or* bridged back to the TS built-ins — re-introducing
  exactly the marshalling surface 2(a) avoids. Hand-authoring a full VM plus a
  library in WAT is a large *unshared* effort with no self-host dividend.
- **Verdict: rejected as the vehicle, adopted as a *distribution optimization*
  for 2(a).** The #2527 canonical rec-group is precisely how a
  *separately-compiled* interpreter module (still produced by js2wasm from TS)
  shares the `$Object` substrate zero-copy — restoring the 0.2 KB floor for
  no-eval modules by linking the interpreter on demand instead of inlining it.
  So #2527 is a dependency of the *packaging* slice (§6-D), not an alternative
  execution strategy.

### 3.2(c) Compile an existing tiny engine (QuickJS-class) to Wasm and bridge
- **The crux is GC interop, and QuickJS is on the wrong side of it.** QuickJS
  is a **linear-memory** engine with NaN-boxed values in its own heap; ours is
  **WasmGC**. Bridging them means a **handle table**: every `$Object` an eval'd
  closure captures, and every object it returns that the AOT side later
  mutates, must round-trip through an opaque handle. That **breaks `ref.eq`
  object identity** at the boundary — the exact identity breakage #1066
  documents for the host-compile path, and the exact invariant standalone
  native equality depends on. Add 600 KB–several MB of size and the dilution of
  the "no embedded JS engine" architectural story.
- **Verdict: rejected.** The value-rep/identity bridge is the whole problem,
  and this strategy maximizes it instead of eliminating it.

### 3.3 Meta-circular (compile js2wasm itself to Wasm, invoke at runtime)
- **Already shipped for JS-host (Tier 1, #1164)** — `createEvalShim` re-enters
  `compileSourceSync`. That works because the *host* already has js2wasm.
- **Infeasible as the standalone primary path.** Standalone meta-circular means
  compiling the entire js2wasm front-end (the TypeScript compiler API +
  codegen + Binaryen) to Wasm and shipping it *inside every eval-using module*
  — multi-MB, 5–50 ms+ compile latency per `eval` call, and a full TS
  type-checker at runtime to evaluate what is always plain JS. **Verdict:
  keep as the JS-host tier; do not pursue standalone.** (The parser half —
  Acorn-via-js2wasm — *is* reused by the interpreter; the *codegen* half is
  what makes full meta-circular too heavy, and the interpreter replaces it with
  a compact bytecode emitter.)

### 3.4 Compile-away slice (Tier 0, #1163) — **cheapest win, already partial**
Constant-string `eval`/`new Function` compiled AOT into the module. Backend-
agnostic (works standalone today because it is pure AOT). Bounded coverage
(only statically-constant strings) but a real, immediate, zero-risk win.
**Verdict: keep and broaden — it is the first landable slice.** §5 quantifies
how many test262 uses are constant-string.

### 3.5 Decision matrix

| Strategy | Value-rep bridge | Object identity | Standalone | Size (no-eval) | Size (eval) | Effort | Verdict |
|---|---|---|---|---|---|---|---|
| 1. naive `(0,eval)` | n/a (host) | n/a | ✗ | 0 | 0 | trivial | fallback only |
| 2a. self-compiled TS interp | **free** | **preserved** | ✓ | floor (opt-linked) | +interp+Acorn | high (shared) | **CHOSEN** |
| 2b. hand-WAT VM (+#2527) | free (shared store) | preserved | ✓ | floor | +VM+lib(WAT) | very high (unshared) | packaging opt for 2a |
| 2c. QuickJS→Wasm bridge | handle table | **broken** | ✓ | +engine | +engine | high (bridge) | rejected |
| 3. meta-circular standalone | free | preserved | ✓ | +whole compiler | +whole compiler | — | rejected (size/latency) |
| 3'. meta-circular JS-host (#1164) | free | preserved | ✗ | 0 | 0 | shipped | **Tier 1 (kept)** |
| 4. compile-away (#1163) | free (AOT) | preserved | ✓ | floor | floor | low | **Tier 0 (broaden)** |

---

## 4. The hard problems, answered concretely

### 4.1 Direct-eval scope access — environment reification via the `$Frame` carrier

Direct `eval` **sees and mutates** the enclosing lexical scope
(ECMA-262 §19.2.1.1 PerformEval, VariableEnvironment step). Under AOT
compilation, locals are unboxed Wasm locals or per-variable ref cells — invisible
to a fresh evaluator. The fix is **environment reification**: for a function
that *may contain direct eval*, promote its capturable bindings into a
heap-allocated **environment record** the evaluator can read and write by name.

**This is the existing closure ref-cell pattern, generalized — and it converges
with #2864's `$Frame`.**

- Today, each captured mutable local is its own `struct (field $value (mut T))`
  ref cell. Env reification batches these into **one** environment struct: an
  ordered set of mutable slots **plus a `name → slot-index` map** **plus a link
  to the parent environment record** (the lexical scope chain).
- #2864 is building `$Frame` — a heap-allocated activation record holding a
  generator/async function's local slots so they survive suspend/resume. A
  reified direct-eval environment is *the same object* with one addition: a
  by-name lookup table so the evaluator can resolve identifiers dynamically.
  **The interpreter/eval track does not build its own frame type — it extends
  the #2864 `$Frame` with a name map.** (This doc does not touch #2864's files;
  it states the dependency so the two tracks share one carrier.)

**Gating (the classic deopt).** Only functions whose body *syntactically
contains* a direct-eval call pay reification. #1261's tiering classifier already
computes this at module granularity (tiers 4/5 = direct eval); the first
reification slice **refines it to per-function** and threads a
`mayContainDirectEval` flag into codegen. A function that provably contains no
direct eval keeps unboxed locals and pays nothing — the whole non-eval program
is unaffected. Indirect eval and `new Function` never trigger reification
(they are global-scope only, §4.3).

**Two consumers, one mechanism:**
- *JS-host (Tier 1):* thread the reified environment record to `__extern_eval`
  so the meta-circular shim resolves/mutates caller bindings against live
  slots. This unlocks the ~76 failing direct-eval-scope tests **without any
  interpreter** (§6-C).
- *Standalone (Tier 2):* the interpreter's `LdName`/`StName` opcodes resolve
  against the same environment-record chain.

### 4.2 Value representation bridge — the crux, made free by strategy 2(a)

An interpreter value that round-trips through compiled code is where every eval
design lives or dies. Under strategy 2(a) the bridge **does not exist as a
distinct layer**, because the interpreter is compiled by js2wasm:

- The interpreter's `JSValue` = the AOT `anyref`/`$Object` substrate. Numbers
  are `__box_number`-boxed f64; strings are the native i16-array (or
  `wasm:js-string`) rep; objects are `$Object` structs read by the existing
  dynamic reader; `undefined`/`null` use the existing tag singletons; the
  tag-5 field-4 three-way classifier is the *same* classifier.
- An AOT-produced `$Object` passed into an opcode is operated on with the exact
  instructions AOT code emits; an opcode-produced value returned to AOT code
  needs no conversion. **`ref.eq` identity holds across the boundary** because
  there is only one representation.
- The **only** real bridge work is completeness, not conversion: every
  *specialized* built-in (`add_int_int`, typed array fast paths, …) must have a
  **generic `(any, …) → any` sibling** the interpreter's `CallBuiltin` can
  target when operand types are unknown at bytecode-emission time. That audit is
  a discrete slice (§6-D) and is shared work with standalone AOT conformance.

Contrast 2(c): QuickJS values live in linear memory; every crossing needs a
handle and breaks identity. That is why the substrate choice, not the dispatch
loop, is the architecture-defining decision.

*Dependency note:* the boxed-any substrate is actively being hardened by the
value-rep team (the `$Object` dynamic reader / native-string value reads, the
tag-5 classifier). The interpreter **consumes** that substrate; interpreter
milestones that touch `any`-typed values inherit its current limitations and
should land **after** the corresponding substrate fix, not race it. This is
stated per-milestone in §6/§8.

### 4.3 Global / realm access — `var`/`function` hoisting into the calling realm

Indirect eval and `new Function` run in **global scope** (§19.2.1 / §20.2.1.1):
a `var x` or `function f(){}` in the evaluated code creates a **property on the
global environment record**, and free identifiers resolve against it.

- "Global" is the module's global environment record, already modelled as an
  `$Object` (globalThis, #369 done). The interpreter's `LdGlobal`/`StGlobal`
  opcodes read/write that shared object; `var`/`function` hoisting from eval'd
  code adds properties to it, visible to subsequent AOT code and vice versa.
- Because this path needs **no lexical capture and no per-function
  reification**, it is the **largest and easiest** slice — hence the ordering
  in §4.4.

### 4.4 `new Function` — easiest, therefore first

`new Function(p1, …, pn, body)` (§20.2.1.1) creates a function whose scope is
**always the global environment** — it never captures the caller's lexicals.
That makes it strictly easier than eval, and it splits cleanly:

- **Constant body/params → compile-away (no interpreter).** When the arguments
  are compile-time-constant strings, synthesize a real AOT function via the
  same AST-splice machinery as #1163 and return a callable. This replaces the
  no-op stub in `new-super.ts` and works **standalone today**. (§6-B.)
- **Dynamic body → interpreter (Tier 2, global scope only).** A runtime-computed
  body string parses via Acorn, emits bytecode, returns a callable whose
  invocation runs the dispatch loop. This is the interpreter's **first
  end-to-end milestone** (§6-E) precisely because global-only scope needs no
  §4.1 reification.

Roadmap ordering therefore is: **`new Function` (global, no capture) → indirect
eval (global) → direct eval (scope capture, needs `$Frame`).**

---

## 5. Test262 unlock quantification

Measured 2026-07 against the current baseline
(`.test262-cache/test262-current.jsonl`, 48,117 records) and the test262
checkout at `test262/`.

### 5.1 Test surface (file counts)

| Bucket | Files |
|---|---|
| `test/built-ins/eval` | 10 |
| `test/language/eval-code` (total) | 347 |
| &nbsp;&nbsp;…/direct | 286 |
| &nbsp;&nbsp;…/indirect | 61 |
| `test/built-ins/Function` (total) | 509 |
| &nbsp;&nbsp;…using the `Function` constructor as codegen | 133 |
| Any test whose body calls `eval(` (harness or in-body) | 1,476 |
| Any test using `new Function(` | 119 |

### 5.2 Current pass/fail (JS-host baseline — i.e. *with* the Tier-1 shim)

| Bucket | pass | fail | CE | total |
|---|---|---|---|---|
| `built-ins/eval` | 7 | 3 | 0 | 10 |
| `language/eval-code` | 240 | 106 | 1 | 347 |
| &nbsp;&nbsp;…/direct | 209 | 76 | 1 | 286 |
| &nbsp;&nbsp;…/indirect | 31 | 30 | 0 | 61 |
| `built-ins/Function` (all) | 252 | 254 | 3 | 509 |
| &nbsp;&nbsp;…Function-ctor codegen tests | 14 | 119 | 0 | 133 |

**Directly addressable failing tests (mechanism-related):**
- **~76** direct-eval failures → dominated by **scope capture** (§4.1); the
  Tier-1 shim compiles a fresh module with no caller-local visibility. Failure
  signatures: 36 `assertion_fail`, 26 `null_deref`, 8 `illegal_cast`.
- **~30** indirect-eval failures (25 `assertion_fail`) → global-scope semantics
  the shim mishandles.
- **~119** Function-constructor failures → the no-op stub. Reachable by Tier-0
  compile-away (constant body) + Tier-2 interpreter (dynamic body).

**Net addressable in JS-host: ~225 tests** across direct-eval scope,
indirect-eval global semantics, and the Function constructor.

### 5.3 The standalone cliff (the real strategic gap)

The §5.2 numbers are **JS-host**. In **standalone/WASI** mode the
`__extern_eval` import is absent, so **every one of the ~490 currently-passing
eval/Function tests instantiation-traps** — the pass rate for these buckets
standalone is effectively **0**. Tier 0 (compile-away) recovers the
constant-string subset immediately; only Tier 2 (the interpreter) recovers the
dynamic remainder. This is the core justification for building the standalone
interpreter at all: without it, standalone conformance has a hard ceiling on
every dynamic-code test, and the dual-mode architectural principle is unmet for
this feature family.

### 5.4 Constant-string fraction (Tier-0 reachability)

Of the 119 `new Function(` users and the eval-code tests, a substantial share
pass **constant** strings (test262 characteristically writes
`new Function("a", "b", "return a+b")` and `eval("1+2")`). The first slices
(§6-A/§6-B) should report the exact constant-vs-dynamic split as an acceptance
artifact (a `--dry-run` classifier over the buckets), since that number sizes
the compile-away win precisely; the tiering pass (#1261) already distinguishes
`StaticLiteral` (tier 2) from dynamic at the call-site level and is the natural
place to emit the count.

---

## 6. Milestone roadmap (staged, landable)

Each slice is an issue (ids in §11). First two are `sprint: current` (S/M,
independently landable, no interpreter). The rest are `sprint: Backlog`
(the interpreter build-out), ordered by dependency.

### A. Broaden constant-string compile-away — **S, current, independent** (#2923)
Extend `tryStaticEvalInline` (#1163) to cover the currently-bailed node kinds
(function/class declarations, `for-of`/`for-in`) in constant `eval` bodies,
using the existing hoist + nested-declaration machinery. Pure AOT, standalone-
safe. Ships a constant-vs-dynamic classifier count (§5.4) as an artifact.
*Depends on:* nothing. *Backend:* both.

### B. `new Function("<const>")` compile-away — **M, current, independent** (#2924)
Replace the no-op `new Function` stub (`new-super.ts` ~3179) with an AST-splice
that, when args are compile-time-constant, synthesizes a real AOT function
(global scope, §4.4) via the #1163 machinery and returns a callable. Dynamic
bodies keep falling through (to the host import today, the interpreter later).
Unlocks the constant-body subset of the 119 Function-ctor failures, standalone.
*Depends on:* A (shares the splice machinery). *Backend:* both.

### C. Direct-eval scope reification (JS-host) — **L, Backlog** (#2925)
Refine #1261 tiering to **per-function** `mayContainDirectEval`; for flagged
functions, reify capturable locals into an environment record (extending the
#2864 `$Frame` with a `name→slot` map, §4.1) and thread it to `__extern_eval`
so the Tier-1 shim resolves/mutates caller bindings. Unlocks the ~76 direct-eval
scope tests in JS-host. *Depends on:* #2864 (`$Frame` landed). *Converges with:*
`with`/Proxy env work. *Backend:* WasmGC (host tier).

### D. Interpreter foundation: Acorn-via-js2wasm + generic-built-in audit — **L, Backlog** (#2927)
Compile Acorn through js2wasm as the runtime parser (builds on the #1710 dogfood
harness); produce an optionally-linkable parser artifact (via #2527 core-wasm
linking so no-eval modules keep the size floor). Audit every specialized
built-in for a generic `(any,…)→any` sibling the interpreter's `CallBuiltin`
can target (§4.2). Surfaces + files Acorn-compilation gaps as child issues.
*Depends on:* self-host maturity (#1058/#1710), #2527 (packaging). *Backend:*
WasmGC.

### E. Bytecode interpreter core + standalone `new Function`/indirect eval — **XL, Backlog** (#2928)
Opcode-set ADR (register+accumulator, after Ignition; builds on the #1715
IR→bytecode proof); bytecode emitter as a second IR backend gated by a
per-function may-contain-dynamic flag; typed dispatch loop compiled by js2wasm;
bidirectional AOT↔interpreter call protocol with zero marshalling
(§4.2); exception propagation via Wasm EH tags. Acceptance:
`new Function("a","b","return a+b")(1,2) === 3` and `(0,eval)("1+2") === 3`
**standalone**. *Depends on:* D. *Backend:* WasmGC.

### F. Direct eval + `with` + Proxy-MOP convergence in the interpreter — **XL, Backlog** (#2929)
`LdName`/`StName` opcodes over the reified environment-record chain (reusing
C's mechanism) for standalone direct-eval scope capture; the generic dynamic
**meta-object protocol** opcodes (`Get`/`Set`/`GetByValue`/`HasProperty`/
`OwnKeys` with full prototype + descriptor semantics) that Proxy traps (#1355)
and `with` also require (§7). Generator/async opcodes align with #2864/#2865.
*Depends on:* E, C, #2864. *Converges with:* #1355 (Proxy), `with`.

```
Tier 0 (AOT, standalone-now)      Tier 1 (JS-host)        Tier 2 (standalone interp)
  A ──▶ B                            C ───────────────────────▶ F
        │                           (needs #2864 $Frame)        ▲
        └───────────────── shared splice ──▶ D ──▶ E ───────────┘
                                            (Acorn,   (VM core,
                                             #1710,    new Function
                                             #2527)    + indirect eval)
```

---

## 7. Convergence with `with` and `Proxy` (why these tracks must not diverge)

This track is out of scope for #1355 (Proxy) and #2864 ($Frame) *files*, but its
substrate is the same, and building it in isolation would duplicate three
mechanisms. Stated so the tracks converge:

- **Environment reification (§4.1) is also the `with` substrate.** `with (obj)`
  prepends an object to the lexical environment chain and resolves names against
  its properties — structurally identical to a reified direct-eval environment
  where one link in the chain is an arbitrary object. C/F's environment-record
  chain, with an "object environment record" variant, *is* `with`.
- **The dynamic MOP opcodes (§6-F) are the Proxy trap surface.** A Proxy
  intercepts `[[Get]]`/`[[Set]]`/`[[Has]]`/`[[OwnKeys]]`/`[[Delete]]` — the
  exact generic internal-method operations the interpreter must implement to run
  dynamic property access. Building them once as reusable
  `$Object`-level MOP primitives lets #1355's handler dispatch plug into the
  same surface instead of re-deriving it.
- **The boxed-any bridge (§4.2) is what lets a Proxy/`with` object cross the
  AOT↔dynamic boundary with identity intact.** Same `ref.eq` argument.

Recommended coordination: the C/F environment-record type and the F MOP-opcode
signatures should be reviewed jointly with the #1355 and #2864 owners before
implementation, so one carrier and one MOP surface serve all three.

---

## 8. Dependencies and ordering vs. substrate work

| This track's slice | Independent of substrate? | Gated on |
|---|---|---|
| A (broaden compile-away, #2923) | **Yes** | — |
| B (`new Function` compile-away, #2924) | **Yes** | A |
| C (direct-eval reification, host, #2925) | No | **#2864 `$Frame`** landing |
| D (Acorn + built-in audit, #2927) | No | self-host (#1058/#1710), **#2527** for optional linking |
| E (VM core, standalone global eval, #2928) | No | D; boxed-any substrate maturity (§4.2) |
| F (direct eval + `with` + MOP, #2929) | No | E, C, **#2864**, converges #1355 |

**Independent (start anytime):** A, B — pure AOT, no substrate coupling.
**Substrate-gated:** C waits for #2864's `$Frame`; D/E consume the boxed-any
substrate and self-host; F needs both plus the MOP surface shared with #1355.

---

## 9. Non-goals

- V8/SpiderMonkey-grade interpreter throughput — the interpreter is the
  fallback; hot code is AOT (optional tier-up is deferred).
- A general-purpose embedded JS engine — the interpreter covers the gap between
  compile-away and host-import for code that cannot be statically resolved.
- TypeScript parsing at runtime — the runtime parser is Acorn (JS only); TS
  parsing stays a build-time concern.
- Replacing #1006/#1164 — JS-host meta-circular remains the fast path; the
  interpreter is the standalone third leg.

## 10. Spec references

- [§19.2.1 `eval(x)`](https://tc39.es/ecma262/#sec-eval-x) — global/indirect eval
- [§19.2.1.1 PerformEval](https://tc39.es/ecma262/#sec-performeval) — direct-eval VariableEnvironment (§4.1)
- [§20.2.1.1 `Function(p1,…,pn,body)`](https://tc39.es/ecma262/#sec-function-p1-p2-pn-body) — Function constructor (§4.4)
- [§14.11 The `with` Statement](https://tc39.es/ecma262/#sec-with-statement) — object environment record (§7)

## 11. Staged issues

| Slice | Issue | Horizon | Sprint | Title |
|---|---|---|---|---|
| A | #2923 | S | current | Broaden constant-string `eval` compile-away (functions/classes/for-of) |
| B | #2924 | M | current | `new Function("<const>")` compile-away MVP (replace no-op stub) |
| C | #2925 | L | Backlog | Direct-eval scope reification in JS-host (per-function tiering + `$Frame` name-map) |
| D | #2927 | L | Backlog | Interpreter foundation: Acorn-via-js2wasm + generic-built-in audit |
| E | #2928 | XL | Backlog | Bytecode interpreter core + standalone `new Function`/indirect eval |
| F | #2929 | XL | Backlog | Interpreter direct eval + `with` + Proxy-MOP convergence |

All six are children of umbrella #1584 and belong to goal `runtime-eval`.
