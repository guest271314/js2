---
id: 2837
title: "[SENIOR-DEV ONLY] dynamic property-add to a NON-EMPTY object literal is silently dropped (closed struct, no sidecar) — route growable literals to externref $Object (Approach A)"
status: done
completed: 2026-06-29
assignee: ttraenkler/sendev-arrowparam
sprint: 69
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
created: 2026-06-29
task_type: bugfix
area: codegen
language_feature: value-representation
goal: acorn-dogfood
related: [2836, 2831, 2664, 2151, 2186, 2379]
depends_on: []
blocks: [1712]
architect_spec: done
---

# #2837 — dynamic property-add to a non-empty object literal is silently dropped (closed struct, no sidecar)

**Round-4 acorn-dogfood wall, exposed after #2836.** The carve title ("block-body
arrow") was a RED HERRING — WAT-grounded isolation shows the real trigger is the
**`return` statement**, and the true root cause is a general
object-representation bug: **a property added to a NON-EMPTY object literal after
creation is silently compiled away.**

## Trigger isolation (compiled acorn@8.16.0, AFTER #2836)

`parse(src, {ecmaVersion:2022})`:

```
function f(){}              OK     function f(){ 1; }        OK
function f(){ x; }          OK     function f(){ var x=1; }  OK
function f(){ f(); }        OK     function f(){ ; }         OK
() => {}                    OK     () => { 1; }              OK
function f(){ return; }     THROW  function f(){ return 1; } THROW
() => { return 1; }         THROW  x => { return x; }        THROW
```

Not block-body, not params — **only a `return` statement throws.** (My round-3
carve guessed block-body arrow; that was wrong — the block bodies that "threw" all
happened to contain `return`.)

## Why `return` throws (acorn raise path → getter → root cause)

`parseReturnStatement` (acorn.mjs:1191): `if (!this.allowReturn) { this.raise(…,
"'return' outside of function") }`. Instrumented compiled acorn:
`allowReturn = 0` (typeof number), `inFunction = 0`, **but** my direct
`currentVarScope().flags & SCOPE_FUNCTION = 2` (correct). So the getter
`inFunction` returns 0 despite `flags&2 == 2`.

`inFunction`/`allowReturn`/`inGenerator`/`inAsync`/`canAwait`/… are **getters
installed via `Object.defineProperties(Parser.prototype, prototypeAccessors)`**
(acorn.mjs:600/608/624). Instrumenting the getter body proved **it is never
invoked** (its `console.log` never fires, while a `console.log` in
`parseReturnStatement` does). So `this.inFunction` reads a **default 0**, not the
getter result → `allowReturn` 0 → every `return` raises.

## Root cause (minimal repro + WAT, NOT hand-waved)

acorn's idiom: `var prototypeAccessors = { inFunction: { configurable: true },
… }` then `prototypeAccessors.inFunction.get = function(){…}` then
`Object.defineProperties(Parser.prototype, prototypeAccessors)`. The getter is
added to the descriptor via a **property assignment after the literal**.

Minimal repros (no acorn):

| repro | result | |
|---|---|---|
| `var o={}; o.f=7; o.f` | `number:7` | empty literal → dynamic `$Object`, grows fine |
| `var o={}; o.type="X"; o.start=5; o.get=fn` (all late) | works | empty literal grows fine |
| `var o={c:1}; o.d=7; o.d` | **`object`/null** | **non-empty literal → write DROPPED** |
| `{inFn:{configurable:true}}` then `.inFn.get=fn`, read `.get` | **`typeof "object"`** | acorn's exact pattern — getter lost |
| `Object.defineProperty(proto,…)` (singular) | works | install+dispatch machinery is fine |
| `Object.defineProperties(proto,{x:{get:fn}})` (inline literal) | works | inline descriptors fine |

WAT for `var o={c:1}; o.d=7; return o.d`:

```wat
(func $probe (result externref)
  (local $o (ref null 2))   ;; o = closed struct type 2 (only field 'c': f64)
  f64.const 1
  struct.new 2              ;; build {c:1}
  local.set 0
  f64.const 0
  drop                      ;; o.d = 7   → WRITE SILENTLY DROPPED (no sidecar)
  ref.null extern           ;; return o.d → null
  return)
```

**A non-empty object literal is lowered to a CLOSED struct with no sidecar
fallback.** A write to a field not in the literal shape is silently dropped; the
read returns null. An EMPTY literal `{}` uses the dynamic `$Object`
representation and grows correctly — so the divergence is purely the
representation choice (`{}` → `$Object`; `{…fields}` → closed struct). acorn's
`prototypeAccessors` (and its nested `{configurable:true}` descriptors) are
non-empty literals → closed structs → the later `.get =` assignment is dropped →
no getters installed → `inFunction` reads default 0 → `return` throws.

(`Object.defineProperty` singular and inline-literal `defineProperties`
descriptors work — this is NOT a defineProperties bug; it is the descriptor
object losing its late-added `.get` field.)

## Why this is architecture-scope (escalated for an architect spec)

This is the **object-representation substrate** (the `$Object` dynamic
reader / member-set-dispatch #2664 / member-get-dispatch #2151 family). Blast
radius: **every non-empty object literal that later receives a property not in
its literal shape** — a representation-scale change (reference_2379 hazard).
Candidate approaches, each with real tradeoffs an architect should weigh:

- **A — escape/flow analysis at the literal:** if an object created by a
  non-empty literal is ever the target of a property write whose key is not in
  the literal shape (or an `Object.define*` target), represent it as `$Object`
  (dynamic), like empty literals already are. Precise but needs intra/inter-proc
  escape analysis; misses dynamically-keyed writes.
- **B — sidecar fallback on closed structs:** make a write of an unknown field to
  a closed-struct object route to the sidecar, and member-get fall through to the
  sidecar on a miss (the machinery the empty-`$Object` path already uses). Uniform,
  no analysis, but adds a sidecar branch to every struct member-set/get (perf;
  the #2664 slot-vs-sidecar desync hazard must be respected).
- **C — always represent object literals as `$Object`:** simplest, but a broad
  perf regression for the common closed-record case.

**Senior-dev / architect, `reasoning_effort: max`, `horizon: l`. Broad-impact ⇒
full `merge_group` + standalone-floor.**

## Acceptance (bar = #1712)

- `var o={c:1}; o.d=7` reads back 7; the acorn `prototypeAccessors` idiom installs
  working getters; `parse("function f(){ return 1; }")`, `parse("() => { return
  x; }")` on compiled acorn return the correct AST (no `WebAssembly.Exception`).
- The real-world NM differential `edge.js` (module, 1190 nodes) compiled-acorn vs
  node-acorn is **structurally equal** modulo documented quirks (null
  `sourceFile`, boolean-as-i32) — completes the #1712 bar started by
  #2831/#2836. `background.js` must STAY structurally-equal (it already is — no
  `return`-in-non-empty-literal pattern).
- 0-regression `merge_group` + standalone-floor (broad-impact ⇒ full CI). Watch
  the object-literal / member-set-dispatch / `built-ins/Object/**` buckets and the
  #2664 invariant.

## Pointers

- acorn: `parseReturnStatement` 1191, `allowReturn`/`inFunction` getters 624/608,
  `Object.defineProperties(Parser.prototype, prototypeAccessors)` ~600, getter
  assignments 608+.
- Compiler: object-literal lowering (closed struct vs `$Object`) — the
  `struct.new` vs dynamic-object decision; member-set-dispatch (#2664,
  `src/codegen/member-set-dispatch.ts`), member-get-dispatch (#2151), the
  `$Object` sidecar reader.
- Repro infra (branch `issue-2837-blockbody-arrow` `.tmp/`): `bb-probe2.mjs`
  (return trigger), `bb-instr*.mjs` (getter-never-invoked proof),
  `getter-repro{,2,3,4,5}.mjs` (the table above), `dump-lit.mjs` + `lit.wat` (the
  dropped-write WAT), `nm-diff.mjs` (edge.js still throws; background.js stays
  equal).
- Verified after #2836 on compiled acorn@8.16.0, 2026-06-29 (sendev round 4).

## Implementation Plan

**Architect verify-first (2026-06-29, branched off origin/main @805c980d5 — has
#2831+#2836). Chosen approach: A (escape/flow-analysis → existing externref
`$Object` route), SCOPED. Confirmed by WAT + end-to-end runs, NOT hand-waved.**

### Verify-first findings (these overturn part of the issue framing)

1. **The divergence is NOT "empty → `$Object`, non-empty → closed struct."** The
   EMPTY case works via **struct WIDENING**, not `$Object`: `var o={}; o.d=7`
   compiles `o` to a closed struct `(struct (field $d (mut f64)))` — the pre-pass
   `collectEmptyObjectWidening` (declarations.ts:2176) scans later `o.X=` writes
   and bakes field `d` into the struct at construction. The non-empty path skips
   that scan (declarations.ts:**2189** `if (decl.initializer.properties.length > 0)
   continue;`), so `{c:1}` stays a closed `{c}`-only struct and `o.d=7` lowers to
   `f64.const 0; drop`. WAT-confirmed (`lit-nonempty.wat` vs `lit-empty.wat`).

2. **acorn's real trigger is a NESTED write, not a direct one.** acorn.mjs:600–685
   (verified against `tests/dogfood/.acorn/package/dist/acorn.mjs`):
   ```js
   var prototypeAccessors = { inFunction: { configurable: true }, /* +10 more */ };
   prototypeAccessors.inFunction.get = function () { ... };   // 608
   prototypeAccessors.inGenerator.get = function () { ... };  // 610
   ...                                                        // individual stmts
   Object.defineProperties( Parser.prototype, prototypeAccessors ); // 685
   ```
   The out-of-shape writes are **`prototypeAccessors.<field>.get = fn`** — depth-2
   writes onto the *nested* descriptor objects `{configurable:true}`. The widening
   scan keys off `varName.prop=` (direct identifier base), so it can **never**
   reach the nested descriptor. WAT-confirmed (`d2-nested_host.wat`: `po.inFn.get=5`
   → `f64.const 0; drop`). The idiom is **individual statements, no loop, no
   computed key → fully statically scannable.**

3. **The fix target representation ALREADY EXISTS and WORKS in host mode.** The
   `$Object`/plain-object builder `compileObjectLiteralAsExternref`
   (literals.ts:204) uses host imports `__new_plain_object` + `__extern_set` (NOT
   standalone-gated — works in JS-host mode, which is the mode the NM differential
   compiles in: `nm-diff.mjs` calls `compile(src)` with **no `target`**). It
   **recursively** builds nested object-literal values as growable objects
   (literals.ts:**298–307**). Proof: forcing the receiver to `any` (which already
   routes the literal to this builder + types the local externref) makes BOTH the
   direct and the full nested acorn pattern work end-to-end in host mode:
   ```
   var o:any  = { c: 1 };               o.d = 7;            o.d  → number:7      ✓
   var po:any = { inFn:{configurable:true} }; po.inFn.get = fn; po.inFn.get() → 9 ✓
   ```
   (`anychk.mjs`.) So **the entire machinery is in place**; the ONLY missing piece
   is the routing DECISION — making a non-`any` var that is later mutated
   out-of-shape behave like an `any`-typed one.

### Root cause (one sentence)

A non-empty object literal assigned to a variable is lowered to a **closed
struct** whose field set is frozen at the literal's static shape; the compiler
never detects that the variable (or a nested literal value it holds) later
receives an out-of-shape property write, so those writes lower to `drop` and the
reads to `ref.null extern`.

### Chosen approach: A (scoped flow-analysis → existing externref `$Object`), with rationale

| | A (chosen) | B (sidecar on closed structs) | C (always `$Object`) |
|---|---|---|---|
| Solves nested acorn case | **yes** (recursion in the builder) | yes, but needs the static `struct.set`-of-unknown-field path rewritten to a sidecar-set AND every struct gains a sidecar field | yes |
| Perf | **no regression** — scoped to objects PROVEN to grow; the 99% closed-record case keeps `struct.get/set` | regresses the hottest path (sidecar branch on every member get/set) | broad regression |
| #2664 desync hazard | **N/A** — pure externref `$Object`, no slot-vs-sidecar split | **high** — the exact write-leaks-to-sidecar / read-uses-slot trap | N/A |
| #1897/-45 hazard | avoided by the consumer-safety guard (below) | N/A | **re-triggers it** — 116 regressions when struct-typed consumers see `$Object` (`struct.get` null-deref, `(o as any)-0` mis-coerce). The #1901 comment block (literals.ts:1080–1163) is the documented record that "always `$Object`" was tried and reverted |
| New infrastructure | **almost none** — reuses `compileObjectLiteralAsExternref` + `externrefAccessorVars`; adds one detection pre-pass | a new sidecar struct field + member-dispatch rewrite | trivial routing, catastrophic fallout |

**C is off the table** (quantified: #1897's 116 regressions). **B is heavy and
re-opens #2664.** **A is minimal, validated, and mode-uniform.**

A is "lower to `$Object` when the literal escapes to an out-of-shape write" — the
issue's Approach A — but realized by reusing the **existing recursive externref
builder** and the **existing `externrefAccessorVars` dispatch hook** rather than
writing new escape analysis or a new representation.

### Changes

**1. New ctx field — `src/codegen/context/types.ts` (~line 1525, beside `objectHashConsumerVars`) + `src/codegen/context/create-context.ts:191`**
- Add `growableObjectLiteralVars: Set<string>` to the context type, init `new Set()`.
  (It is the detection output; membership then feeds both the literal routing and
  the existing `externrefAccessorVars` tagging. You MAY instead fold the result
  directly into `externrefAccessorVars` — see step 4 — but keeping a distinct set
  makes the routing decision inspectable/testable.)

**2. New detection pre-pass — `src/codegen/declarations.ts`, beside `collectEmptyObjectWidening` (line 2176)**
- Add `export function collectGrowableObjectLiterals(ctx, checker, sourceFile)`.
  Mirror `collectEmptyObjectWidening`'s statement walker (it already recurses into
  function bodies / try / if / loops / switch — copy that traversal).
- For each `var/let/const V = <NON-EMPTY ObjectLiteralExpression>` (i.e. the case
  the empty pre-pass skips at line 2189), scan the enclosing statement list for an
  **out-of-shape mutation rooted at `V`**:
  - **Direct rule:** an assignment `V.k = …` where `k` is NOT a property name
    present in `V`'s literal shape → mark `V`.
  - **Nested rule (this is the acorn trigger):** an assignment whose LHS is a
    `PropertyAccessExpression` chain whose **root identifier is `V`** and whose
    **depth ≥ 2** (`V.a.b … = …`). Walk `lhs.expression` until you hit the root
    Identifier, counting hops; depth ≥ 2 ⇒ mark `V`. (Conservative: a depth-≥2
    write to an already-in-shape nested field also marks `V` — a safe
    over-approximation; such objects are being deep-mutated and growable is
    correct, only marginally slower. Refine later if a perf case appears.)
  - Also walk into the same nested statement scopes the empty pre-pass walks
    (blocks, if/else, try/catch/finally, for/while/switch).
- On a match, `ctx.growableObjectLiteralVars.add(V)`.
- **Consumer-safety guard (avoids the #1897/-45 regression).** Do NOT mark `V`
  growable if it has a consumer that requires the closed-struct representation —
  mirror the poison logic the empty pre-pass already applies
  (`objectHashConsumerVars` #2584, `dynamicDescriptorWidenVars` #2372). Concretely
  bail (leave `V` on the struct path) when any of:
  - a field of `V` is read in a numeric/typed context that expects `struct.get`
    f64 (e.g. `V.x - 0`, `V.x * n`),
  - `V` is passed as an argument to a **non-`any`** typed parameter, returned as a
    concrete struct type, or destructured into typed slots.
  For acorn's `prototypeAccessors` none of these hold (it is consumed ONLY by
  `Object.defineProperties` iterating keys), so it marks cleanly. When in doubt,
  prefer NOT marking (leaves the pre-existing bug for that var — acceptable; it is
  not the acorn blocker) over an unsound externref route.

**3. Wire the pre-pass — `src/codegen/index.ts:1221` and `:5902`**
- Call `collectGrowableObjectLiterals(ctx, …)` at BOTH sites where
  `collectEmptyObjectWidening` is already called (single-file and multi-file
  compile paths), immediately after it.

**4. Local typing — `src/codegen/statements/variables.ts:755–779`**
- Add, beside `initIsHostSpreadLiteral`:
  ```ts
  const initIsGrowableObjectLiteral =
    decl.initializer !== undefined &&
    ts.isObjectLiteralExpression(decl.initializer) &&
    ts.isIdentifier(decl.name) &&
    ctx.growableObjectLiteralVars.has(decl.name.text);
  ```
- Include it in the `externrefAccessorVars.add(name)` condition (line 759) and in
  the `wasmType` externref selection (line 777–779). This makes the var's local an
  externref AND — because `externrefAccessorVars` is consulted by member dispatch
  (property-access.ts:1039/1082 for reads, the member-set path for writes) —
  routes every `V.k` read/write through `__extern_get`/`__extern_set`. (If you
  folded detection straight into `externrefAccessorVars` in step 2, this reduces
  to just the `wasmType` arm.)

**5. Literal lowering — `src/codegen/literals.ts`, `compileObjectLiteral`**
- For a NON-EMPTY literal whose parent is `var V = …` with
  `ctx.growableObjectLiteralVars.has(V)`, route to
  `compileObjectLiteralAsExternref(ctx, fctx, expr)` and return its result —
  **NOT** standalone-gated (the builder works in host mode; the existing
  `ctx.standalone` gate at line 1110 is the #1901 *decision* gate, not a builder
  limitation). Place this check **before** the `if (!contextType)` closed-struct
  fallthrough (line 1165) and before the concrete-`contextType` struct path (line
  1198), so a marked var never reaches `compileObjectLiteralForStruct`. The
  builder's line-298 recursion then builds the nested descriptor objects growable
  automatically — no extra work for the nested case.
- If `compileObjectLiteralAsExternref` returns null (e.g. the literal has
  methods/accessors/computed keys it cannot build — see its prop guard at
  literals.ts:275/321), fall through to the existing paths (graceful). acorn's
  `prototypeAccessors` is all data props, so it never declines.

### Wasm IR pattern (target, post-fix — already produced today for `any`-typed vars)

```wat
;; var prototypeAccessors = { inFunction: { configurable: true }, ... }
call $__new_plain_object              ;; outer object
local.set $po
;; inner descriptor (built recursively as growable too)
call $__new_plain_object
local.tee $desc
(global.get $configurable) (global.get $true) call $__extern_set
local.get $po (global.get $inFunction) local.get $desc call $__extern_set
;; ... late: prototypeAccessors.inFunction.get = fn
local.get $po (global.get $inFunction) call $__extern_get   ;; → $desc externref
(global.get $get) <fn-closure>        call $__extern_set      ;; LANDS (was drop)
```

### Edge cases (call these out in tests)

- **Out-of-shape write then read** (direct): `var o={c:1}; o.d=7; o.d` → `7`.
- **In-shape write unaffected**: `var o={c:1}; o.c=2; o.c` → must still be `2`
  (marked var: now via `__extern_set`/`__extern_get`; verify the in-shape field
  round-trips through the `$Object`, not just the new one).
- **Nested (acorn)**: `var po={inFn:{configurable:true}}; po.inFn.get=fn` then read
  → getter installed & callable.
- **Numeric vs ref fields**: a marked var's numeric field read in arithmetic
  (`o.n + 1`) — this is the #1897 hazard; the consumer-safety guard MUST keep such
  a var OFF the externref route (or box/unbox correctly). Add a test that a struct
  var with a numeric field used arithmetically and NO out-of-shape write stays on
  the struct path (no regression).
- **`delete`**: `delete o.d` on a marked (externref) var routes through the
  `$Object` delete path — verify it does not trap; not required for acorn but
  in-scope for the representation.
- **Unmarked vars are byte-identical**: a plain `var o={c:1}; o.c` with no
  out-of-shape write keeps the exact closed-struct lowering (regression floor).
- **Standalone parity**: the same routing must hold under `--target standalone`
  (the native `$Object` runtime `__extern_get/set/__new_plain_object` is emitted
  there too); the floor must stay green.

### Blast radius & classification

- **Scope of behavioral change**: ONLY variables initialized by a non-empty object
  literal that (a) are later out-of-shape mutated (direct or nested) AND (b) pass
  the consumer-safety guard. Everything else is byte-identical. This is the
  reference_2379-class "every non-empty object literal later written out-of-shape"
  set, but the consumer-safety guard keeps it from touching struct-typed consumers.
- **Risk axes**: (1) detection precision — a false-positive mark routes a
  struct-consumed var to externref → #1897-style breakage (mitigated by the guard;
  prefer under-marking). (2) member-dispatch coverage for externref receivers —
  already proven by the `any`-typed runs. (3) standalone vs host — both exercised
  by existing #1901/#2542 code.
- **Senior-dev, `reasoning_effort: max`, `horizon: l`.** Broad-impact ⇒ FULL
  `merge_group` + standalone-floor, never scoped CI.

### Test plan (acceptance bar)

1. **Unit (tests/, equivalence)** — add cases:
   - `var o={c:1}; o.d=7;` reads back `7`; in-shape `o.c` still correct.
   - acorn `prototypeAccessors` idiom: `var po={inFn:{configurable:true}};
     po.inFn.get=function(){return 9}; ` then `Object.defineProperties(T,po)` →
     getter installed (returns the computed value).
   - Regression control: `var o={n:1}; (o.n+1)` with no out-of-shape write stays a
     struct (assert via WAT it still emits `struct.get`, not `__extern_get`).
2. **Return repros parse** on compiled acorn (the #1712 bar opener):
   `parse("function f(){ return 1; }")` and `parse("(a)=>{ return a; }")` return a
   correct AST with **no `WebAssembly.Exception`**.
3. **Real NM differential** (harness: copy
   `/workspace/.claude/worktrees/agent-ab738eabb9262d2f2/.tmp/nm-diff.mjs` into a
   `.tmp/` subdir of a worktree at main):
   - **edge.js** (module, 1190 nodes): compiled-acorn vs node-acorn **structurally
     equal** modulo documented quirks (null `sourceFile`, boolean-as-i32).
   - **background.js** STAYS structurally equal (no regression).
4. **0-regression** `merge_group` + standalone-floor. Watch the
   object-literal / member-set-dispatch / `built-ins/Object/**` buckets and the
   #2664 invariant.

## Implementation Notes (sendev, 2026-06-29) — Approach A IMPLEMENTED but NOT SUFFICIENT for acorn `return`

Implemented Approach A exactly (6 edits: context/types, create-context,
declarations `collectGrowableObjectLiterals` pre-pass, index.ts wiring,
variables.ts local typing, literals.ts routing), PLUS three edits the architect's
`:any`-only verify-first did not surface as necessary:
- **Module-global typing** (`moduleGlobalWasmType`, declarations.ts): acorn's
  `prototypeAccessors` is a TOP-LEVEL `var` → a module GLOBAL, which bypasses the
  function-local typing path. The global must be externref too.
- **Nested-chain member dispatch** (`chainRootIsGrowable`, property-access.ts):
  `prototypeAccessors.inFunction.get = fn` is a depth-2 write; the receiver
  `prototypeAccessors.inFunction` is a property-access (not a bare ident), so the
  dispatch must force the externref path for a chain ROOTED at a growable var.
- **Hoisted-`var` slot re-type** (variables.ts): the default re-type guard treats
  externref as "primitive" and refuses the `ref → externref` narrowing for a
  pre-hoisted struct slot; added a growable branch (like the accessor/Proxy ones).
- **defineProperties wasm-closure wrap** (runtime.ts `definePropertiesHandler`):
  a host `$Object` descsObj whose accessor get/set are RAW wasm closures was
  rejected by native `Object.defineProperties` ("Getter must be a function");
  route it through the wrapping per-key path (`_descsHaveWasmClosureAccessor`).

**Verified working** (`.tmp/regr-control.mjs`, `getter-repro*.mjs`):
`var o={c:1}; o.d=7` → 7; nested `o.inner.n=7` → 7; module-global + function-local;
regression controls (`{n:1}; o.n+1`, plain structs) STAY on the struct path
(`usesExternObj=false`, byte-identical). Object-literal/accessor/defineProperty
suites: 8/9 files green (the 1 failure is the pre-existing stale-harness
`getters-setters.test.ts` — instantiate with `{env:{}}`, unrelated).

### BLOCKER — Layer 3 (architecture-scale, NOT object-literal growth, NOT in this spec)

With all of the above, acorn module-init no longer crashes (descriptors install,
getters wrap), **but `function f(){ return 1 }` STILL throws** acorn's
`'return' outside of function`. WAT-grounded isolation (`.tmp/bb-instr2.mjs`):
`this.inFunction` reads a static **default 0** — the runtime-installed prototype
getter **is never invoked** (its injected `console.log` never fires while one in
`parseReturnStatement` does). Root cause: the compiler lowers `this.inFunction`
(a typed-receiver member access) as a STATIC field read, with no knowledge that
`inFunction` is a getter installed at RUNTIME via
`Object.defineProperties(Parser.prototype, …)`. This is **dynamic-prototype-accessor
dispatch on a statically-typed receiver** — a distinct, architecture-scale issue
the documented #2837 root cause (object-literal growth) does NOT cover, and which
the architect's `:any` verify-first did not exercise (it called the getter
FUNCTION directly in wasm — `po.inFn.get()` — not the installed-accessor chain
`Object.defineProperties` + `this.inFunction` that acorn actually uses).

**Conclusion:** Approach A is NECESSARY but NOT SUFFICIENT for acorn's `return`.
Layer 3 needs its own architect design (member-get on a typed receiver must
consult runtime-installed prototype accessors via the host MOP, or acorn-shape
`prototypeAccessors` getters must be modeled statically). **Carved as #2838**
(dynamic prototype-accessor dispatch; `depends_on: 2837`). Per the tech lead's
Option-1 decision, this PR lands Approach A as a stepping stone (it fixes the REAL
general dropped-out-of-shape-write data-loss bug, valuable beyond acorn); #2838
tracks the orthogonal accessor-dispatch layer.

### NOTE — possible round 6 (set expectation)

The NM differential reveals walls one at a time: it currently stops at the FIRST
`return`, so **edge.js may hide additional walls behind this one** that only
surface once `return` parses (1190 nodes exercises far more grammar than
background.js). Landing #2837 unblocks the next diff delta; budget for a
**round-6** carve if edge.js surfaces a new structural mismatch after returns
parse. background.js already being equal is a good sign the substrate is close,
but do not assume edge.js is one fix away.
