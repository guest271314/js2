# 00 — July-2026 Fable audit: clean IR-first design, async, and the standalone gap

> Synthesis of five parallel Fable audit agents run 2026-07-02 against
> `origin/main @ 70732174f`. Scopes: (1) IR front-end & legacy retirement,
> (2) async/promise/generator pipeline, (3) standalone dynamic features
> (promises, eval, `new Function`), (4) backend lowering seam (WasmGC vs
> linear), (5) quantified standalone gap + dynamic object model.
> Companion to the June program (`plan/log/analysis-2026-06/00-…`); this
> report audits what changed since and lays out the route to the north star:
> **everything through the IR; backends differ only at lowering; full async;
> standalone closes on host parity.**
>
> New issues filed from this audit: **#2949–#2964** (§6). Sprint plan: §5.

---

## 0. Headline numbers (verified 2026-07-02)

| Metric                                      | Value                                                                          | Source                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Host (gc) test262 pass                      | 33,147 / 43,106 (76.9%)                                                        | `benchmarks/results/test262-current.json` @ 06e47fd1 |
| Standalone honest (host-free) pass          | 18,157 (42.1%)                                                                 | `test262-standalone-highwater.json` (#2879 floor)    |
| **Standalone gap (host-pass ∧ ¬host-free)** | **15,376** = 7,498 pass-but-leaky + 6,962 executed fails + 915 CE + 1 timeout  | per-test JSONL join                                  |
| Honest floor trend                          | 12,551 → 18,157 in 3 days (carrier lane landing)                               | highwater git history                                |
| IR claim rate on untyped corpus             | **8 skipped bodies across 4 of 233 files** (#2138 measurement)                 | #2138 impl notes                                     |
| IR fallback buckets                         | body-shape 33 · closure 5 · class-method 6 · param-type 1 · async 4 (deferred) | `scripts/ir-fallback-baseline.json`                  |
| `STRICT_IR_REASONS`                         | still empty set                                                                | `src/codegen/index.ts:1021`                          |
| BackendEmitter bypass                       | **77 `pushRaw` WasmGC-inline sites** in `src/ir/lower.ts`                      | audit 4                                              |
| Linear backend IR consumption in production | **zero** (fork above the IR at `compiler.ts:861`)                              | audit 4                                              |

The June "~5,400 standalone bucket" number is **not comparable** to today's
15,376 — #2879 (2026-06-30) re-based the floor onto the honest
`host_free_pass` metric (leaked `env::` import ⇒ not passing), which is the
right metric and roughly triples the visible gap.

---

## 1. Finding — IR front-end: the retirement machinery is built; the type system is the wall

**What's solid** (verified): staged pipeline select → from-ast → verify
(SSA/dominance/terminator invariants, CI-hard-fail) → hygiene passes → lower
→ integration patch; symbolic `IrFuncRef`/`IrGlobalRef`/`IrTypeRef` kill the
funcIdx-shift bug class for IR bodies; ratchet infra (baseline JSON,
`--update-on-decrease`, post-claim metering #1923, generated
`ir-adoption.md` cross-checked in CI) is exemplary. #2138 slices 1+2 landed:
`JS2WASM_IR_FIRST=1` skips legacy bodies for fully-claimed closures with a
hard-error contract on skipped-slot fallback (`index.ts:1753-1789`). #2135
slice 1 landed `src/ir/capability.ts` (3-state table, operators only) — the
#2945 `%`-drift class is structurally dead **for operators**; the ~2,200-line
`isPhase1*` predicate family in `select.ts` still mirrors 188 throw sites in
`from-ast.ts` for everything else.

**The wall**: `IrType`'s leaf is `{kind:"val", val: ValType}` —
**Wasm types, not JS types**. There is no dynamic/any/JsTag representation
inside the IR. That is _why_ the IR claimed 8 bodies in 233 mostly-untyped
files: as built, the IR is a typed-subset optimizer, not a general JS
front-end. Zeroing every fallback bucket (the current #2855/#2856-#2859
program, measured against 13 DOM-heavy playground examples) will _look_ like
victory while the test262-scale claim rate stays single-digit. **The D1
value-representation program (JsTag/brands — done at codegen level) and the
IR have not met.** This is the true critical path and had no filed issue →
**#2949**.

Second structural gap: hybrid control flow (top-level blocks, but if/try/loop
as instructions with nested buffers; no `br_table`, no multi-level labeled
exit) makes switch / labeled break/continue / do-while / for-in structurally
unadoptable → **#2952**.

Bucket intelligence (from #2856's landed diagnostic): body-shape-33 is **not**
missing statement kinds — it's host-global member access (19/31 fns), `#field`
names, non-tail if/else, module-scope reads. Demotion is **contagious**
(selector fixpoint): the extern-in-IR slice must land before leaf arms or
call-graph-closure grows and the gate fails. #2856 ordering is load-bearing.

Stale metadata found: #2134 `blocked_by: [2167]` but #2167 closed 2026-07-02
(fixed in this audit's PR); `CLAUDE.md`/`codegen-axes.md` still cite #1530
where #2855 is meant; `ir-adoption.md` cites the demote channel at
`index.ts:889-896` (drifted ~850 lines).

## 2. Finding — async: four coexisting lowering models; the N-state frame machine is the engine

The #1796-done vs #1373b-blocked contradiction resolves: **both true,
different gates**. `ASYNC_CPS_ENABLED` is `true` (async-cps.ts:60) but
predicate-scoped (`asyncFnNeedsCps`): only single-tail-await **function
declarations** get real CPS Promises in host mode; await-elidable and
non-canonical bodies stay on the legacy synchronous model (`f() as any as
number` still governs most of the corpus). The IR async gate is hardcoded
closed (`isAsyncIrReady` → false, select.ts:239). `IrInstrAwait`/
`IrInstrAsyncReturn`/`IrInstrAsyncThrow` exist but are **type-only** — nothing
constructs or lowers them.

Current dispatch (function-body.ts:1150-1204): ① WASI N-state
`$AsyncFrame` drive machine (#2906 — multi-await + try/finally-across-await,
real resumable frames, shared frame ABI with generators), ② host CPS
(single tail-await declarations only), ③ legacy sync pass-through
(everything else), plus ④ the eager generator buffer (host mode; why
`.next(arg)/.throw()/.return()` can't work — #1687). `--target standalone`
(non-WASI) currently has **no async carrier** (premature widen regressed
−31/−601 and was reverted; re-widen is deliberately last, #2867 slice 1d).

**Convergence strategy** (the audit's highest-leverage move): the N-state
frame machine is already the general engine. Retire the single-await CPS
special case by re-targeting host mode onto the same machine with
host-Promise settle adapters (`Promise_then2` instead of native reactions) —
**#1042 re-scoped to exactly this**. Only then do #1373b (IR async Phase C),
so the IR targets **one** engine, not three. Host activation is also
declaration-only today (both hooks require `ts.isFunctionDeclaration`) —
async arrows/methods/function-expressions never activate → **#2957**.

Standalone async runtime already there: microtask ring + `_start` drain
(#1326/#1326c), thenable assimilation, native `.then/.catch`,
`Promise.all/race`, and the #2632 timer/event-loop reactor (done). Missing:
`new Promise(executor)` (**#2959** — unconditionally lowers to the
`Promise_new` host import today), `.finally`/`allSettled`/`any`/generic
iterables (#2867/#2919 arms), unhandled-rejection reporting (**#2958**),
async generators (#2865, ~986 standalone failures).

## 3. Finding — the standalone gap is 15,376 and decomposes into three staffed lanes + three unstaffed ones

Ranked clusters:

1. **Async/generator/Promise host carriers ~6-7k** — top leaked imports
   `__get_caught_exception` 5,810, `__make_callback` 4,693, `__gen_*` ~4.6k,
   `Promise_*` ~3k. **Staffed**: #2864/#2865/#2866/#2867 (the 3-day +5.6k
   floor jump is this lane landing).
2. **Opaque exception payloads — 1,427 fails** ("uncaught Wasm-GC exception
   (non-stringifiable payload)"). Natively-thrown GC error structs have no
   host-independent stringification/identity. Both a direct win and the
   triage force-multiplier for the largest fail directory. Unstaffed →
   **#2962** (best next dispatch).
3. **$Object descriptor semantics — ~1,091** (defineProperty 398, gOPD 184,
   …). Staffed: #2042 in-progress.
4. **Generator/destructuring runtime semantics ~1,750** — staffed #2040; plus
   iterator illegal-cast residual ~366 and ToPrimitive ~229 (#2358 lane).
5. **Compile errors 915**: `__get_builtin` dynamic-shape **295** + builtins
   as first-class values ~100 (unstaffed → **#2963**); invalid-Wasm residual
   ~150 (#2039 **blocked — needs re-triage**); Reflect.construct/Proxy
   Phase-C refusals (#1355).
6. Leaky long tail: `dynamic_object_property` 375, `dynamic_code` ~640
   (`__extern_eval`/`__dynamic_import`) → runtime-eval goal (§4).

The measurement/ratchet infra requested in June is **fully landed and
trustworthy**: honest host-free floor (#2879/#2097, merge_group-required),
allowlist budget (every entry names its retiring issue), post-link import
scan (#2094), reached-test inject-throw probe (#2921). Progress banks
automatically.

**Protection asymmetry**: `strictNoHostImports` auto-enables only for
`--target wasi` — plain `--target standalone` has **no structural
no-leak guarantee**, only the statistical floor; a host import off the
late-import path emits silently and traps at instantiation → **#2961**.

**Dynamic object model**: `object-runtime.ts` (~9k lines) is much further
along than "missing" — native property store with descriptor flag bits,
insertion-order seq, accessors, delete/tombstones, seal/freeze incl. write
path, for-in over own keys, mapped arguments, native apply/typeof. Bounded
gaps: descriptor semantics residual (#2042), builtins-as-values (**#2963**),
error identity (**#2962**), for-in prototype-chain walk + integer-key
ordering (**#2964**), dynamic instanceof/bind (later). Proxy: stay on the
host lane near-term (#2615-#2618 root-caused host bugs), standalone
invariants deferred behind the descriptor model (#797/#1460/#1462 → #1355).

## 4. Finding — dynamic code (eval / new Function): the ladder is right, the rungs are rough

- Tier 0 constant-string compile-away: shipped, standalone-safe (#1163,
  #2923 done). Tier 1 host meta-circular shim (runtime re-entry into
  js2wasm): shipped for indirect eval.
- **`new Function` compiles to a silent wrong-value no-op stub in BOTH
  modes** (`ref.null.extern`, new-super.ts:3175-3191) — ~119 host failures.
  #2924 (constant-body compile-away, ready) covers the static case; the
  dynamic case must route to the Tier-1 shim in host mode and **throw at
  call time** (not return undefined) in standalone → **#2960**.
- Standalone dynamic eval today = instantiation trap with **zero
  compile-time diagnostic** → also **#2960** (warning diagnostic on the
  `__extern_eval` fall-through, pattern of `refuseStandalone*`).
- Tier 2 (standalone bytecode interpreter): goal `runtime-eval` already
  sequenced — #2927 in-progress → **#2928 is the highest-value slice**
  (~119 Function-ctor + ~30 indirect-eval, no direct-eval scope problem) →
  #2929. Packaging via #2527 Phase 2 / #2514 (shared runtime.wasm), which is
  blocked on frozen rec-group type emission — do NOT block eval/promise
  slices on it; land inline, relocate later.
- test262 weight: 1,476 tests call `eval(`, 119 `new Function(`; standalone
  currently ≈0% on all of them (instantiation traps).

## 5. Finding — backend seam: proven at the trait layer, ~10-15% real in production

`BackendEmitter<S>` (src/ir/backend/emitter.ts) + per-backend legality
verifier (#1851) + cross-backend differential harness (#1854) are genuine.
But: production always lowers WasmGC (`lower.ts:278` defaults the emitter;
Linear/Bytecode emitters are test-only); **77 pushRaw sites** inline WasmGC
for unions/closures/refcells/Promises/ref.cast; loop/try/await bypass the
trait entirely; and `src/codegen-linear/` (15.9k lines, maintained, 25
commits since May) receives the **AST directly** — the backend fork sits
_above_ the IR. The IR front-end is also string-mode-polymorphic
(`nativeStrings` branches at 5 from-ast sites) — identical source builds
different IR per string mode. Honest framing: **two separate compilers
sharing an instruction encoding**, with a well-designed seam waiting to be
filled. Migration: **#2953** (close the pushRaw gap — byte-identical
refactor, unblocks everything) → **#2954** (LinearEmitter core-op coverage +
corpus rows) → **#2955** (de-polymorph strings) → **#2956** (wire the IR
selector into `generateLinearModule` — XL, architect spec first; umbrella
#1585). The linear async story is explicitly deferred behind all of this.

---

## 6. The program — three tracks, dependency-ordered

**Track A — IR-first spine (north star)**

```
#2138 S3 measurement (ir_first CI lane #2947, run now)
  → #2135 predicate families (in-progress)   → #2945 `%` lowering (ready)
#2856 extern-in-IR FIRST → leaf arms → #2857 → #2858 → #2859
  → STRICT_IR_REASONS promotions (#2855 ACs)
#2953 pushRaw gap ──→ #2954 LinearEmitter ops ──→ #2956 linear consumes IR (arch spec)
              └────→ #2955 string de-polymorph
#2951 skip-set widen (gens+class members) ─┐
#2135 + #2945 + #2138-S3 ──────────────────┴→ #2950 IR-first DEFAULT flip
                                               → delete compile-twice + demote channel (#2855 AC4)
#2949 dynamic IrType (JsTag in the IR) — XL keystone, arch-spec first;
  unblocks real claim rate; feeds #2952 multi-exit CF adoption targets
#2134 effect model (unblocked — stale blocker cleared)
```

**Track B — async convergence**

```
#2906 N-state machine (in-flight)
  → #1042 (RE-SCOPED): host mode re-targets the same machine via settle adapters
      → #1373b IR async Phase C (IR emits await nodes → ONE engine)
  → #2895 → #2867 slice-1d gate-widen wasi→standalone
#2864 native generators → #2865 async generators (AG2) → for-await (#2906 gap 5a)
#2957 async arrows/methods activation (independent, M)
#2959 native new Promise(executor) (independent, M — biggest promise slice)
#2919 arms: allSettled/any/iterables · #2958 unhandled-rejection (S)
#2613+#2614 fold: multi-hop host↔wasm callback substrate (unblock both)
```

**Track C — standalone gap + dynamic features**

```
carriers #2864/#2865/#2866/#2867 (staffed, ~6-7k)
#2962 error identity/stringification (L, P1 — direct win + triage multiplier)
#2042 descriptors (staffed) → Proxy standalone invariants (later, #1355)
#2963 builtin reification (M/L) · #2964 for-in proto chain (S/M)
#2961 strict leak-scan for --target standalone (M, structural guarantee)
#2960 eval/new Function loud diagnostics + host shim routing (M)
  → #2924 (ready) → #2928 interpreter core (XL) → #2929
#2039 re-triage (blocked, ~150 CE)
```

## 7. Sprint plan (rolling budget windows, #2751)

Priorities: P1 = claim first (big rocks early in the window), P2 = core
queue, P3 = tail filler. All `sprint: current` unless noted.

**Window 67 (now).** Continue staffed in-flight: #2864/#2865/#2867/#2906,
#2135, #2856 (extern-first ordering!), #2042, #2040. New dispatches:

- P1: **#2949** (dynamic IrType — architect spec + slice 1, XL),
  **#2953** (pushRaw gap, L), **#2962** (error identity, L),
  **#2959** (Promise executor, M), **#1042** re-scoped (host N-state
  convergence, L — after #2906 lands its CFG layer), #2945 (`%`, S).
- P2: **#2957** (async activation shapes, M), **#2960** (eval/newFunction
  diagnostics+routing, M), **#2961** (standalone leak-scan, M),
  **#2963** (builtin reification, L), #2924 (ready, M), **#2952**
  (multi-exit CF, L).
- P3 tail: **#2964** (S/M), **#2958** (S), **#2954** (M), **#2955** (M),
  **#2951** (M, prefer after #2138-S3 measurement), #2134 (unblocked).
- Zero-cost actions: run the #2947 `ir_first` dispatch lane (= #2138 S3);
  re-triage #2039; doc repoints #1530→#2855.

**Window 68.** **#2950** (IR-first default flip — gated on #2138-S3 clean +
#2135 families + #2951), #1373b (IR async on the converged engine), #2928
(interpreter core), #2867 slice-1d gate-widen, descriptor follow-ups,
STRICT_IR_REASONS promotions as buckets zero.

**Window 69+.** **#2956** (linear backend consumes IR, arch-spec'd in 68),
#2929 (interpreter direct-eval/with/Proxy-MOP), Proxy standalone invariants
(post-descriptor-model), #2514 shared runtime.wasm (post rec-group work),
demote-channel removal (#2855 AC4), Annex-B host-free tail.

**Sequencing rules the audit proved load-bearing:** (1) #2856 extern-in-IR
before leaf arms (contagious demotion); (2) #1042 convergence before #1373b
(one engine); (3) carrier gate-widen only after #2895 (the −601 lesson);
(4) don't block promise/eval slices on #2514 packaging.

## 8. New issues filed (#2949–#2964)

| #    | Title                                                                             | Size | Prio                          | Track |
| ---- | --------------------------------------------------------------------------------- | ---- | ----------------------------- | ----- |
| 2949 | IR dynamic value representation: JsTag-carrying `dynamic` kind in IrType          | XL   | P1                            | A     |
| 2950 | IR-first default flip: JS2WASM_IR_FIRST default-ON, retire compile-twice          | L    | P1                            | A     |
| 2951 | IR-first skip-set: include generators + class members                             | M    | P3                            | A     |
| 2952 | IR multi-exit control flow: switch/labeled break/continue/do/for-in               | L    | P2                            | A     |
| 2953 | Close the BackendEmitter pushRaw gap (unions/closures/refcells/coercions)         | L    | P1                            | A     |
| 2954 | LinearEmitter core-op coverage + cross-backend corpus dynamic rows                | M    | P3                            | A     |
| 2955 | De-polymorph IR front-end on string mode (abstract IR string ops)                 | M    | P3                            | A     |
| 2956 | Linear backend consumes the IR front-end (production wiring)                      | XL   | P2 (Fable spec now, impl W69) | A     |
| 2957 | Async activation for arrows/methods/function-expressions                          | M    | P2                            | B     |
| 2958 | Standalone unhandled-rejection tracking at drain/loop exit                        | S    | P3                            | B     |
| 2959 | Native `new Promise(executor)` on the standalone carrier                          | M    | P1                            | B     |
| 2960 | eval/`new Function`: loud standalone diagnostics + host Tier-1 routing            | M    | P2                            | C     |
| 2961 | Extend strictNoHostImports leak-scan to `--target standalone`                     | M    | P2                            | C     |
| 2962 | Native error identity + payload stringification (retire `__get_caught_exception`) | L    | P1                            | C     |
| 2963 | Reify builtins as first-class values (retire `__get_builtin` CE cluster)          | L    | P2                            | C     |
| 2964 | for-in: prototype-chain enumeration + integer-key ordering on $Object             | M    | P3                            | C     |

Existing issues re-grounded by this audit: #1042 (re-scoped to N-state
convergence), #2134 (stale blocker cleared), #2039 (needs re-triage),
#1796 (clarifying note: predicate-scoped flip, not the global model).
