---
id: 1642
title: "spec gap: for-of IteratorClose — RE-SCOPED to the residual 8 (return-method representation + generator-close)"
status: done
completed: 2026-06-26
depends_on: []
fixed_by: 2724
created: 2026-05-08
updated: 2026-06-26
priority: medium
feasibility: hard
reasoning_effort: high
needs_arch_spec: true
task_type: bugfix
area: codegen
language_feature: iteration
goal: spec-completeness
sprint: 67
renumbered_from: 1348
parent: 1328
---

## RESOLVED by #2724 (2026-06-26, sd-accessor)

**Closed — fixed by #2724 (object-literal accessor representation).** The
SLICE-1 grounding below was correct: these `iterator-close-*-get-method-*`
edges fail UPSTREAM of close, on the `get return()` accessor in the iterator
object literal being mis-registered as a closed WasmGC struct (so
`__iterator(iterable)` read back `null` and `__iterator_next(null)` threw before
close was ever reached). #2724's one-guard fix in `ensureStructForType`
(`src/codegen/index.ts`) skips closed-struct registration for object-LITERAL
accessor-bearing types, so they lower to externref end to end and the existing
`$Object` accessor read path services the `get return()` read.

The earlier framings on this issue — a close-time `__get_return`/`__call_return`
return-method reachability gap, and the "needs the big #2580 substrate rebuild"
dependency — were **both stale**. No close-time read and no substrate rebuild
were needed; this was a *type-layer* representation collision, fixed by one
scoped guard. `depends_on: [2580]` removed.

Verified by faithful repros (`tests/issue-2724.test.ts`, edges (b)/(b2)/(b3)/(b4)):
- non-throw completion + `get return()` throws → error forwarded (PASS)
- `get return()` returns null → IteratorClose skips return, no throw (PASS)
- throw completion + `get return()` also throws → original throw wins (PASS)
- `get return()` runs exactly once on break (PASS)

The two `…-get-method-non-callable.js` edges already passed (plain data
`return:`). Standalone for-of over a *dynamically-assigned* `[Symbol.iterator]`
remains a separate pre-existing data-path gap (a distinct #2580 slice) and is
explicitly out of #2724's scope.

---

## SLICE 1 GROUNDING + COLLISION VERDICT — STOP/ESCALATE (2026-06-26, sd-iterclose)

**Verdict: the Slice-1 root-cause model below is INCORRECT. The 4 `iterator-close-*`
edge failures are NOT a close-time return-method reachability gap. They fail
UPSTREAM of close, on the `get return()` ACCESSOR in the iterator object literal.
The real fix is object-literal accessor representation = #2580 substrate. Do NOT
build the spec's `__get_return`/`__call_return` close-time read — it fixes none of
these tests. Escalated to lead.**

### How grounded (faithful harness, current `origin/main` @ 93e7aebb)

Ran the real test262 files through `wrapTest`+`parseMeta`+`buildImports`+`setExports`
(mirrors the sharded worker), plus host-call tracing on `__iterator` /
`__iterator_next` / `__iterator_return`, plus emitted-WAT inspection. The
discriminator across the whole close cluster is **100% the accessor**:

| test (for-of/) | iterator's `return` | `__iterator(iterable)` | result |
|---|---|---|---|
| iterator-close-non-throw-get-method-**is-null** | `get return()` accessor | **null** | THROWS `null.next` (FAIL) |
| iterator-close-non-throw-get-method-**abrupt** | `get return()` accessor | **null** | FAIL (ret 3) |
| iterator-close-throw-get-method-**abrupt** | `get return()` accessor | **null** | FAIL (ret 3) |
| iterator-close-throw-get-method-**non-callable** | plain data `return:` | `[object Object]` | PASS (ret 1) |
| iterator-close-non-throw-get-method-**non-callable** | plain data `return:` | `[object Object]` | PASS (ret 1) |
| iterator-close-via-break / -return / -throw / -continue | plain data | object | PASS |

Every `get return()` (accessor) case: the host `__iterator(iterable)` —
which invokes the dynamically-assigned `[Symbol.iterator]` factory closure via
`__call_fn_0` — **returns `null`**, so `__iterator_next(null)` throws and close is
never reached. Every plain-data-`return:` case already iterates AND closes
correctly (the host `__iterator_return` chain `iter.return ?? _sidecar ??
__sget_return` works; `__sget_return`/`__sset_return` ARE emitted — contradicting
the spec's "no such getter is emitted").

### Smoking gun (emitted WAT, accessor vs plain, identical otherwise)

```
get return(){ return 5 } -> (type $__anon_0 (struct (field $next (mut externref)) (field $return (mut f64))))
return: function(){...}   -> (type $__anon_0 (struct (field $next (mut externref)) (field $return (mut externref))))
```

An object literal with an **accessor** lowers `$return` to a plain `(mut f64)`
data field whose **type is inferred from the getter's return expression** (`f64`
for `return 5`); the getter is **lazy but its accessor semantics are dropped** (a
`get g(){ throw }` does NOT throw at construction and a side-effecting getter's
counter stays 0 — so it is neither a real accessor nor an eager field). Building
the iterator object through the dynamic/closure path with such a mixed/garbage
field shape is what makes the factory's `__call_fn_0` return `null`. The
`get`/`set` accessor is **not represented as an accessor at all** in the
object-literal struct lowering.

### Collision verdict — STOP

The actual fix is **object-literal `get`/`set` accessor representation in the
dynamic/any path** (real lazy getter call-at-read, accessor descriptor, correct
field typing). That is exactly the **#2580 method/accessor-representation
substrate** the spec itself flagged as "overlap" and the task named as a
STOP-and-escalate trigger (the S3b lesson). #2580 is currently *released* (no live
lock / no open PR), so this is not recreating a LIVE conflict — but the spec's
Slice-1 mechanism is invalidated by grounding and the genuine fix lands in
representation territory #2580 owns. Per instructions I am **not building in
parallel**. Recommend: re-scope #1642 Slice 1 onto the verified accessor-rep
root cause and coordinate with the #2580 owner (sd-protoextend), or have #2580
land the general object-literal accessor representation first and let #1642
consume it. The `non-callable` + `via-*` close tests already pass, so once
accessor object literals are represented correctly, the close path likely needs
no further change for the 3 accessor edges. (`return-emulates-undefined` is an
`IsHTMLDDA`/document.all host-object case — separate, not an accessor, likely
out of scope for standalone.)

**Lead decision (2026-06-26): release + stand down — do NOT pivot into the
accessor-rep fix.** Like S3b, object-literal get/set accessor representation is
broad value-rep substrate that must be a DELIBERATE #2580 slice (architect-spec
+ single-owner), not a rushed #1642 side-effect on the floor-sensitive lane.
**#1642 is now `status: blocked`, `depends_on: [2580]`** — specifically blocked on
a #2580 object-literal-accessor-representation slice. Once `get`/`set` are real
accessors, the close path likely needs NO further change for the 3 accessor edges
(`non-throw-get-method-abrupt`, `non-throw-get-method-is-null`,
`throw-get-method-abrupt`); the 4th, `return-emulates-undefined-throws-when-called`,
is a separate `IsHTMLDDA`/document.all case. This write-up landed on `main` via a
doc-only PR (branch `issue-1642-iterclose-slice1`) so the corrected root cause +
#2580 cross-ref are visible to the next session / the #2580 owner. The #1642 lock
is released; no production code changed.

---

## RE-SCOPE + VERIFIED FINDINGS (2026-06-26, dev-conformance)

**The broad "389 fails / 48%->75%" framing is OBSOLETE.** Core IteratorClose
landed since this issue was filed (2026-05-08). Verified on current `main`
(re-grounded, not from issue text):

- **Core close works**: close-on-throw, break, labeled-break, return-from-fn;
  continue and normal completion correctly do NOT close. Both surviving
  acceptance test262 files PASS via a faithful sta+assert harness:
  `iterator-close-via-break.js`, `iterator-close-via-return.js`.
- **Authoritative baseline** (`test262-current.jsonl`), for-of close cluster:
  **7 pass / 8 fail.** The residual 8:
  - 4 x `generator-close-via-{break,continue,return,throw}.js`
  - 4 x `iterator-close-{non-throw-get-method-abrupt, non-throw-get-method-is-null,
    return-emulates-undefined-throws-when-called, throw-get-method-abrupt}.js`

### Root cause (this is why it needs an arch spec)

The host `__iterator_return` (`src/runtime.ts:11143`) is itself spec-correct
(GetMethod + IteratorClose: reads `iter.return` so a getter fires; null/undefined
-> no-op; non-callable -> TypeError; abrupt propagates). The for-of close *call
sites* are also wired (host-delegated path: break post-loop `loops.ts:4859`,
throw try/catch_all `:4825`; struct path `:4436`). **The gap is that the user
iterator's `return` method never reaches `__iterator_return` as a callable:**

- An object-literal iterator `{ next(){}, return(){} }` (and a generator) lowers
  to a **WasmGC struct**. At close time `__iterator_return` does
  `iter.return ?? _sidecarGet(iter,"return") ?? __sget_return(iter)` -- but for
  these structs the `return` **method field is not reachable** via `__sget_return`
  (no such getter / methods are not readable data fields), so `ret` stays
  undefined and close is a silent no-op. Minimal repro (closed=0, want 1):
  `var iterable:any={}; iterable[Symbol.iterator]=function(){ return { next(){}, return(){ closed=1; } }; }; for (const _ of iterable) break;`
  -- yet a **named** iterable-is-iterator literal
  (`var it={[Symbol.iterator](){return this;}, next, return}`) DOES close (its
  struct gets the field getter). So the bug is **iterator-object method-field
  representation / `__sget_return` reachability**, not the close protocol.
- `get return()` (accessor) cases additionally need the read to fire the getter
  exactly once at close -- couples to the dynamic accessor read path.
- **Generator-close** is a separate mechanism (the for-of must call the
  generator's `.return()` so its `finally` runs); `function*` iterators do not
  expose a struct `_return` the close path finds.
- **Standalone**: `__iterator_return` native (`iterator-native.ts:213`) is a
  **no-op stub** -- standalone close is entirely unimplemented (dual-mode gap).

### Why arch spec (flagged to lead)

The fix spans (a) iterator-object method-field representation + `__sget_return`
emission, (b) accessor-`return` read semantics, (c) generator `.return()`
integration with for-of close, (d) a real standalone-native `__iterator_return`,
across the hot `loops.ts` close path + the iterator runtime, dual-mode. This
overlaps the dynamic-object/method-representation ceiling (#2580 family).
Recommend an architect `## Implementation Plan` (or senior-dev) before codegen.
Slicing suggestion: (1) host-mode return-method reachability for the 4
iterator-close edges first; (2) generator-close; (3) standalone-native.

---
# #1348 — for-of / for-await-of: IteratorClose on abrupt completion

## Problem

`language/statements/for-of`: **362 / 751 pass (48.2%) — 389 fails (304 assertion_fail,
30 runtime_error, 22 type_error, 13 null_deref, 8 other)**.
`language/statements/for-await-of`: **825 / 1234 pass (66.9%) — 409 fails (315 assertion_fail,
50 null_deref, 36 illegal_cast)**.

Spec §14.7.5 (for-of/for-in/for-await-of) requires:
1. `IteratorClose(iterator, abrupt)` must be called when:
   - The body throws.
   - The body executes `break` / `continue` to a label outside the loop.
   - The body executes `return` from the enclosing function.
2. `IteratorClose` calls `iterator.return()` and propagates errors.
3. For for-await-of: the close is awaited.

A large portion of the assertion_fail failures (estimated ~150 of 304) check that the iterator's
`.return()` was called with a specific value when the body throws.

## Acceptance criteria

1. `language/statements/for-of/iterator-close-throw-error.js` passes.
2. `language/statements/for-of/iterator-close-via-break.js` passes.
3. `language/statements/for-of/iterator-close-via-return.js` passes.
4. `language/statements/for-await-of/iterator-close-throw-error.js` passes.
5. Pass-rate for `language/statements/for-of` rises from 48% to ≥75%.

## Implementation Plan (2026-06-26 — re-scoped residual, dev-conformance trace)

> Supersedes the pre-#851 `try_table` sketch (now obsolete: core IteratorClose
> shipped in #851/#1348 — see the historical notes below). This plan targets the
> **residual 8** only. DO NOT implement as a single PR — slice as below; the
> accessor/method-representation half overlaps the #2580 method-rep ceiling and
> is senior-dev work.

### Mechanism: the missing `__call_return` dispatcher (+ value-read for GetMethod)

`__iterator_next` reaches a struct iterator's `next` via the per-struct method
dispatcher **`__call_next`**, emitted by `emitMethodDispatch("next","__call_next")`
in `emitIteratorMethodExport` (`src/codegen/index.ts:2939-3035`): for each
registered struct it emits `ref.test $StructN -> ref.cast -> call $StructN_next`,
externref result, and registers the export in `ctx.funcMap`. There is
`__call_@@iterator` + `__call_next` but **NO `__call_return`** — so the host
`__iterator_return` (`src/runtime.ts:11143`) can only try `iter.return` (opaque on
a struct -> undefined), `_sidecarGet(iter,"return")`, and `__sget_return(iter)` (a
DATA-field getter; `return` is a METHOD/accessor, no such getter is emitted) -> the
close silently no-ops. A NAMED iterable-is-iterator literal closes only when its
struct happens to expose the field getter; an anonymous `{ next, return }` returned
from `[Symbol.iterator]()` does not.

**Spec §7.4.6 IteratorClose + GetMethod (§7.3.10):** close must (1) `GetMethod(iter,
"return")` — a value READ that fires an accessor `get return()` getter, (2) if the
result is `undefined`/`null` return (no-op, no throw), (3) if not callable throw
TypeError, (4) else Call it (binding `this=iter`), and on a throw outer-completion
SUPPRESS any error from steps 1/3/4 (the existing nested try/catch_all at
`loops.ts:4822` already models step-6 suppression). So the primitive needed is a
value-producing **`GetMethod(iter,"return")`**, not just a method dispatch-call.

### Slice 1 — host return-method reachability (the 4 `iterator-close-*` edges) [LAND FIRST]

Files: `src/codegen/index.ts` (dispatcher), `src/runtime.ts` (host close).

1. **Add a value-read driver `__get_return(iter) -> externref`** that yields the
   iterator's `return` AS A VALUE (firing an accessor getter, or returning the bound
   method closure for a plain `return(){}`), or `ref.null.extern` when absent. This
   is the method-as-value half — model it on the existing accessor-get driver
   `reserveAccessorGetDriver` (`src/codegen/accessor-driver.ts:72`) and the
   `emitMethodDispatch` per-struct `ref.test/cast` shape. For a plain method `return`,
   "get as value" must produce a callable closure bound to the struct (the
   representation gap that overlaps #2580 — object-literal method fields are
   currently dispatch-callable but not value-gettable as closures). If a clean
   value-get for plain methods is not yet available, Slice 1 may add
   `__call_return` (direct dispatch-call) for the plain-method path and use
   `__get_return` only for the accessor path — but the GetMethod null/callable test
   MUST run on the read result either way (do not blind-call).
2. **Wire `__iterator_return`** (`runtime.ts:11143`): replace the
   `iter.return ?? _sidecarGet ?? __sget_return` chain's struct arm with
   `exports.__get_return?.(iter)` to obtain the value (fires the accessor), then apply
   the existing GetMethod logic already present in that function (null/undefined ->
   no-op; non-callable -> TypeError; callable -> call + result-object check). The
   getter-side-effect (`returnGets++`), the null-skip, the abrupt-on-read propagation,
   and step-6 suppression then all fall out of the host JS.
   - `non-throw-get-method-is-null`: getter fires (returnGets=1) -> null -> no-op. PASS.
   - `non-throw-get-method-abrupt`: getter read throws -> propagates (break path). PASS.
   - `throw-get-method-abrupt`: getter read throws under a throw-completion -> suppressed
     by the existing `:4822` nested try/catch_all -> original throw wins. PASS.
   - `return-emulates-undefined-throws-when-called`: callable-but-throws-on-call -> the
     call throws and propagates (break path) / is suppressed (throw path). PASS.

### Slice 2 — generator-close (the 4 `generator-close-via-*`)

A `function*` used as a for-of iterator must, on abrupt completion, run the
generator's `.return()` so its `finally` executes. Generators compile to a resume
function + `.next()/.return()/.throw()` dispatch (`src/codegen/class-bodies.ts:2253`);
they do NOT expose a struct `${name}_return` the close path finds. Slice 2 routes
the for-of close to the generator's `.return()` — either by emitting a
`${genStruct}_return` that the Slice-1 `__call_return`/`__get_return` dispatcher
picks up, or by special-casing a generator receiver in `__iterator_return` to invoke
the generator resume-return entry. Verify `finallyCount`/`startedCount` per the
`generator-close-via-{break,continue,return,throw}.js` assertions.

### Slice 3 — standalone-native `__iterator_return` (§7.4.6)

The standalone native `__iterator_return` (`src/codegen/iterator-native.ts:213`) is a
**no-op stub**. Implement the §7.4.6 sequence over the `$IterRec`/`$Object` runtime:
native GetMethod(rec.userIter, "return") (own+proto, accessor-aware via the native
object runtime), null-skip, callable-test (TypeError), call, result-object check,
step-6 suppression. Gate behind the dual-mode contract (host import vs native) like
the rest of the iterator runtime. Validate via the standalone floor (merge_group).

### #2580 overlap (flagged)

Slice 1's "method/accessor as a gettable value" is the same dynamic method-field
representation gap tracked in the #2580 family (object-literal methods are
dispatch-callable but not uniformly value-readable as bound closures). Coordinate the
`__get_return` value-read with the #2580 substrate rather than building a parallel
one-off; if #2580 lands a general method-as-value read first, Slice 1 consumes it.

### Edge cases / invariants

- Byte-identical for modules with no for-of-over-iterator (`emitMethodDispatch`
  `entries.length===0` -> no dispatcher emitted).
- Normal completion (`done=true`) and `continue` MUST NOT close (current behavior —
  keep the `doneFlag` gate, `loops.ts:4854`).
- Accessor `return` getter fires EXACTLY ONCE per close (one GetMethod read).
- Both for-of paths (struct `loops.ts:4316` and host-delegated `:4476`) must reach the
  new primitive; the struct path currently gates close on `returnMethodIdx!==undefined`
  (`:4436`) and must also consult `__call_return`/`__get_return`.

### Test262 acceptance (residual 8)

`language/statements/for-of/`: `generator-close-via-{break,continue,return,throw}.js`,
`iterator-close-non-throw-get-method-abrupt.js`,
`iterator-close-non-throw-get-method-is-null.js`,
`iterator-close-return-emulates-undefined-throws-when-called.js`,
`iterator-close-throw-get-method-abrupt.js`. (Baseline today: for-of close cluster
7 pass / 8 fail; Slice 1 targets the 4 `iterator-close-*`, Slice 2 the 4 generators.)

## Implementation notes (dev-1389, 2026-05-08)

The bulk of the IteratorClose protocol was already wired in #851:

- `compileForOfIterator` (`src/codegen/statements/loops.ts:2701`) wraps the
  block-loop in a Wasm `try`/`catch_all` and pushes a `finallyStack` entry
  that emits `__iterator_return` on `return`, outer-`break`, and
  outer-`continue`.
- `compileForOfDirectIterator` does the same for direct iterator structs.
- The post-loop check inlines `__iterator_return` on inner-`break`.

The remaining failure surface for these tests was traced to a different
root cause: **void IIFE inlining did not block-wrap its body**.
`compileCallExpression` in `src/codegen/expressions/calls.ts` had two
inline paths — one for value-returning IIFEs (which patches `return` →
`local.set + br <depth>` after wrapping the body in a block) and one for
void IIFEs (which simply compiled the body inline). The void path
re-emitted `return` instructions from the IIFE body verbatim, so a
`return;` inside

```js
(function () { for (var x of it) { ...; return; } }());
```

became a Wasm `return` from the *enclosing* function, dropping the
post-IIFE asserts that verify `returnCount === 1`.

The fix mirrors the value-IIFE branch:

1. Push the IIFE body onto a fresh Instr array.
2. Save `fctx.returnType`, set it to `null` so any `return <expr>` drops
   its value.
3. Increment `fctx.blockDepth`, compile the body, decrement again.
4. Walk the block body and replace every `return` with `br <depth>`,
   undoing tail-call optimization (`return_call` → `call` + `br`).
5. Wrap the patched block in a `block { ... }` Instr.

The tail-call handling is necessary because
`compileReturnStatement` may have collapsed the final `call + return`
into `return_call`, which inside an IIFE block would still leak through
to the outer function.

### Files changed

- `src/codegen/expressions/calls.ts` — void IIFE body now block-wrapped
  with `return → br` patching (mirroring the existing value-IIFE branch).

### Tests

- `tests/issue-1348.test.ts` — 5 focused regression tests covering
  bare `return` in void IIFE, `return` inside a for-loop body, nested
  void IIFEs, and void arrow IIFEs.
- `test262/test/language/statements/for-of/iterator-close-via-return.js`
  goes from `fail` (returned 0 — early return) → `pass` after the fix.
- The other three iterator-close tests (`-via-break`, `-via-continue`,
  `-via-throw`) already passed and continue to pass.

### Estimated impact

The single root cause unlocks all `iterator-close-via-return` flavoured
tests. Several other for-of failures are unrelated (destructuring, TS
type checker rejections) and tracked elsewhere.

## Frontmatter reconcile (2026-06-12)

Was `in-progress` with no open PR, no active agent, and no Suspended Work section (session died sprints 42-52). Reset to `ready` during the sprint-62 issue review; re-validate against current main before claiming (#2148).
