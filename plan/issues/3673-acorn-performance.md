---
id: 3673
title: "perf: compiled acorn parses 1,400-3,000x slower than node-acorn — host-bridge hot-path costs"
status: in-progress
assignee: claude/acorn-performance
created: 2026-07-26
updated: 2026-07-27
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/object-runtime.ts
  - src/codegen/native-strings.ts
  - src/codegen/native-strings-core.ts
  - src/codegen/native-strings-basics.ts
  - src/codegen/native-strings-shared.ts
  - src/codegen/context/types.ts
  - src/codegen/async-scheduler.ts
  - src/codegen/closures.ts
  - src/ir/integration.ts
  - src/ir/lower.ts
  - src/codegen/registry/imports.ts
  - src/codegen/json-codec-native.ts
  - src/codegen/any-helpers.ts
  - src/emit/binary.ts
  - src/codegen/member-get-dispatch.ts
  - src/codegen/shared.ts
  - src/codegen/type-coercion.ts
  - src/codegen/index.ts
  - src/codegen/registry/types.ts
  - src/codegen/context/create-context.ts
  - src/codegen/native-strings-basics.ts
  - src/codegen/closed-method-dispatch.ts
  - src/codegen/closure-exports.ts
priority: high
feasibility: medium
reasoning_effort: high
task_type: perf
area: runtime, codegen
goal: self-hosting-dogfood
sprint: current
model: fable
related: [1712, 1946, 1947, 3669, 3671]
---

# #3673 — Horrible performance of compiled acorn

## Problem

With the #1712 dogfood milestone complete, compiled acorn is **correct**
(23/23 corpus exact, full test262 parser differential 53,259/53,259 files
exact) but catastrophically slow. Measured baseline (median, Node 22 V8,
`.tmp/bench-acorn.mjs`, cached binary, steady-state):

| input                        | node-acorn | compiled | slowdown |
| ---------------------------- | ---------- | -------- | -------- |
| literals.js (259B)           | 0.055ms    | 77.6ms   | 1,407x   |
| members-calls.js (213B)      | 0.050ms    | 107.1ms  | 2,135x   |
| control-flow.js (330B)       | 0.074ms    | 155.7ms  | 2,115x   |
| 17-file corpus concat (4.3KB)| 0.666ms    | 2,050ms  | 3,078x   |

AST marshalling (`wrapExports`) is NOT the cost — the raw export is equally
slow. Compile time is a separate axis: ~21-26s to compile acorn, 682KB
host-mode binary.

## Root-cause analysis (measured, V8 --cpu-prof + per-import counters)

A 330-byte parse makes **45,239 host-bridge crossings** (~137 per input
byte): `__box_number` 6.4k, `__extern_get` 5.3k, `__get_undefined` 4.7k,
`__unbox_number` 4.5k, `__typeof_number` 3.9k, `__is_truthy` 3.8k,
`__host_eq` 3.5k, `__host_compare` 3.5k, `__extern_get_raw_callable` 3k,
`__extern_method_call` 0.9k, `__extern_set_strict` 0.3k… This is the
consequence of fnctor instances resolving to externref (#1712 two-shape
fix): every field read/write, comparison, truthiness test and method call
on Parser/token state crosses to the JS host.

The crossings themselves (~0.1-0.3µs) were NOT the dominant cost. The
bridge's per-call implementation was:

1. **`_isWasmStruct` — 57.6% of total CPU.** It classified via a
   property-set probe on the receiver inside try/catch. For a WasmGC struct
   (the overwhelmingly common receiver) the probe **throws on every call**,
   and it allocated a fresh `Symbol` per call. Called several times per
   crossing across `_safeGet`/`_safeSet`/`__extern_get`.
2. **`_getStructFieldNames` filter — 28% of CPU after (1).** Answering
   "does this struct have own field `x`" enumerated the shape's CSV and
   called the `__shas_<field>` Wasm presence export for EVERY field of the
   shape (acorn's Parser struct has dozens) — dozens of Wasm re-entries per
   property read (the #2739b own-field shadow check runs per method read).
3. **`_safeSet` native write probe.** For struct receivers it attempted
   `obj[key] = val`, which on an opaque WasmGC object unconditionally
   throws in strict code — a guaranteed V8 exception per property write.
4. **`_resolveClassMemberOnInstance`** did a megamorphic dictionary-mode
   exports lookup (`__member_kind_<key>`, exports object has thousands of
   keys) per dynamic instance read.
5. **Per-call closure creation** in `snapshotVecMirrors` (runs on every
   `__extern_method_call`/`__call_function` crossing) and
   `_resolveHostField` — each closure creation also paying the transform's
   `__name` defineProperty under tsx.

## Fixes landed (this branch)

- `_isWasmStruct`: WeakSet verdict caches (classification is stable per
  object identity) + `Object.isExtensible` fast path (WasmGC objects report
  non-extensible; `Object.create(null)` is extensible — verified on Node 22).
  The probe-throw survives only for the rare non-extensible null-proto JS
  object, once per object.
- `_structFieldNamesRaw` + per-CSV split cache + `_structHasOwnFieldName`
  (single-key presence, one `__shas_` call); hot call sites converted
  (`_wasmStructHasOwn`, `_safeGet` #2739b shadow check, `_safeSet` #2731
  re-add check, `_readOwnDescriptor` data path, Object.assign/for-in
  helpers, marshal-shape probe).
- `_safeSet`: removed the always-throwing native write attempt for struct
  receivers (the `__sset_` writeback + sidecar are the real write lanes).
- `_resolveClassMemberOnInstance`: `__member_kind_<key>` verdict memoized
  per exports object (immutable after instantiation).
- `snapshotVecMirrors` inlined to a plain loop; `_resolveHostField`'s
  getter-invoke closure hoisted to a top-level helper.
- `_isWasmStruct` verdict caches merged into ONE WeakMap (one probe per
  call; measured ~19.9k predicate calls per 330B parse, 95% cache hits,
  only ~147 slow-path classifications — the volume made the second WeakSet
  probe of the miss path measurable).

## Measured after (same protocol)

| input                        | before   | after   | slowdown now |
| ---------------------------- | -------- | ------- | ------------ |
| literals.js (259B)           | 77.6ms   | 7.7ms   | 147x         |
| members-calls.js (213B)      | 107.1ms  | 8.9ms   | 234x         |
| control-flow.js (330B)       | 155.7ms  | 13.7ms  | 226x         |
| 17-file corpus concat (4.3KB)| 2,050ms  | 192ms   | 302x         |

**~11x faster end-to-end; slowdown vs node-acorn reduced from ~3,000x to
~150-300x.** Gates: `dogfood:acorn-corpus` 23/23 exact (0 quirks, 0 real
gaps, incl. acorn self-parse) — re-verified after every batch;
`tests/issue-1712.test.ts` acceptance green; dynamic-dispatch /
ifelse-global-shift / capture-closure / exactfield-lane / tokenizer-identity
pins green (36 tests); sidecar/presence/tombstone lanes green
(issue-1630/2130/2668/2731/2739/2853 — 47/48, the one 2668 for-in failure
reproduces identically on the pre-branch base 5805049, pre-existing).
`issue-1712-reflection-identity.test.ts`'s 12 failures also reproduce
identically on the unmodified base (pre-existing container/env issue).
tsc clean, biome clean.

## wasm-opt data point (measured, not landed)

`optimize: true` (Binaryen) shrinks the host-mode acorn binary **682KB →
393KB (−42%)** but does NOT improve parse time (medium input 208ms vs
183ms — within noise, slightly worse). Confirms the residual cost is
host-bridge crossings, not Wasm execution quality. Worth wiring into the
dogfood/artifact path for SIZE, irrelevant for speed.

## .wat evidence — what one hot line compiles to

Compiled a minimal acorn-shaped repro (fnctor + prototype methods + a
`while (this.pos < this.input.length) this.pos = this.pos + 1` loop) via
`compileToWat`. The single comparison `this.pos < this.input.length`
lowers to: current-`this` global read with `__get_undefined` fallback →
`__extern_get(this, "pos")` host crossing → `__extern_is_undefined` probe
→ a 4-deep `ref.test` ladder over boxed-number shapes whose EVERY arm ends
in a `__box_number` host call (re-boxing to externref) → two more
`__extern_get` crossings for `input`/`length` → `__host_compare` on two
externrefs. The increment adds `__host_add` + `__extern_set_strict`. So
one source line ≈ 7-9 host crossings; nothing numeric ever stays in Wasm.
This is the mechanical explanation for 45k crossings / 330 bytes.

## Standalone lane (round 2) — Wasm-native runtime now BEATS the host bridge

Question driving this round: can we eliminate host calls entirely by using
the standalone lane's Wasm-native object runtime (zero imports), while still
importing only what a Node host must provide? Measured via an in-module
benchmark driver (fixture + loop compiled INTO the standalone module, so the
timed region has zero crossings; `.tmp/bench-standalone.mjs`):

**Baseline standalone was 52.4ms/parse on control-flow.js — 3.5x SLOWER
than the (optimized) host lane's 14.9ms.** Profile: `__extern_get` 37%
(Wasm-side), `__str_equals` 19%, `__str_flatten` 12%, GC 10%. Root causes,
all fixed on this branch:

1. **String literals re-allocated per execution.** Every literal site
   (`nativeStringLiteralInstrs` / `compileNativeStringLiteral`) emitted
   `array.new_fixed` + `struct.new` inline — the `__extern_get` member
   ladder allocated its comparison literal PER PROBE PER CALL. Literals are
   now INTERNED into immutable module globals (GC constant expressions),
   one allocation per distinct literal at instantiation. Also −24% binary
   (1.75MB → 1.34MB).
2. **`__str_flatten` never memoized.** A rope re-copied on every flatten.
   `ConsString.left/right` are now mutable; flatten rewrites the cons in
   place to `(left=flat, right="")` and takes a two-field fast path on the
   next call.
3. **`__str_equals` had no identity fast path** — added `ref.eq` first
   (effective now that literals are interned).
4. **Every wrapped string helper unconditionally CALLED `__str_flatten` per
   string param** (`wrapBodyWithFlatten` preamble). Now guarded by an
   inline `ref.test $NativeString` — flat params (the common case) skip
   the call.
5. **`__extern_get`'s member ladder** (one arm per distinct field name in
   the program — hundreds for acorn) flattened the key per arm and called
   `__str_equals` unconditionally. The key is now flattened once into a
   scratch local and each arm is guarded by an inline length compare.

**Result: standalone 52.4ms → 8.9ms/parse (5.9x) — now 1.7x FASTER than
the host lane (14.9ms) on the same input.** Post-fix profile: 
`__extern_get_idx` 29%, `__apply_closure` 21%, `__extern_get` 14%,
`__str_equals` 8% — attacked in round 3 below.

## Standalone lane (round 3) — indexed reads, member-ladder buckets, apply args

Three more measured fixes:

1. **`__extern_get_idx` overlay tax (29% → gone).** The #3251 vec-descriptor
   overlay design assumed "defineProperty-on-array is rare", but the
   standalone RegExp exec path defines `index`/`input`/`groups`/`indices` on
   every match-result array via `__defineProperty_value` — each exec appends
   a companion to the GLOBAL overlay table, and `__vec_overlay_lookup` is a
   linear `ref.eq` scan of that table on EVERY indexed read (acorn: regex per
   token → unbounded growth; also a leak — entries pin their arrays forever,
   noted as follow-up). Fix: a `__vec_overlay_numeric` i32 flag global, set
   by `__vec_dp_value`/`__vec_dp_accessor` only when the defined key parses
   as an ARRAY INDEX; the `__extern_get_idx` prologue gates on the flag
   instead of the state global (string-key-only companions — the regexp case
   — are irrelevant to an indexed read). The `__extern_get` string lane keeps
   the state-global gate, so descriptor introspection of match arrays is
   unchanged. Routing the regexp defines through the #3537 bag instead was
   REJECTED: bag reflection (gopd/keys) is not implemented, which would
   regress `verifyProperty`-style tests.
2. **Member ladder → length + first-char buckets.** The interned-literal
   ladder still paid one inline length check per arm (hundreds). Arms are now
   grouped by name length, sub-grouped by first character (key length and
   `data[off]` hoisted into locals once per lookup) — a miss costs ~15 length
   checks + a handful of char checks instead of ~300 arm guards; a hit runs
   `__str_equals` ~1-2 times.
3. **`__apply_closure` $ObjVec fast path.** Args built by in-module call
   sites are always the runtime's own `$ObjVec`; length + per-arg reads now
   use direct `struct.get`/bounds-checked `array.get` instead of
   `__extern_length` + fully-dynamic `__extern_get_idx` per argument
   (OOB reads keep the undefined sentinel for #3592 widened calls).

**Measured: 8.9 → 3.4ms/parse.** Standalone cumulative: **52.4 → 3.4ms
(15.3x); now ~4.3x faster than the host lane** on the same input (host
14.9ms; node-acorn 0.06ms — the residual gap is ~55x). Post-round profile:
`__apply_closure` 12.5% (the remaining cost is the closure-ARITY resolution:
`buildClosureArityProbe`'s linear funcref/`ref.test` ladders inlined per
apply — the real fix is carrying the arity in the closure representation,
follow-up), `__extern_get` 10.5%, `__obj_find` 7.2%, `__str_equals` 5.4%.

Verification (round 3): standalone acorn canaries 4/4 green; overlay +
apply suites green (issue-3251, issue-3537, issue-3592 ×3,
issue-3031-proxy-apply — 71 tests); the 94 standalone/native-string suites
show the SAME 9 pre-existing failures and zero new; host corpus 23/23
exact; 1712 acceptance + pins green; tsc + biome clean.

## Round 4 — funcref-extraction root-collapse + the measured wall

`buildFuncrefExtraction` (shared by `__call_fn_<N>`/`__call_fn_method_<N>`
/`__closure_arity`/`__apply_closure`'s arity probe) emitted one
`ref.test`+cast+get arm PER closure struct shape. Since
`mintClosureStructTypes` makes every shared-signature wrapper AND every
capture-carrying closure subtype the canonical ROOT wrapper, the ladder now
collapses to ONE root arm (+ per-shape arms only for named function
expressions / wrapper-less fallbacks). Measured: ~3% (3.52 → 3.41ms) — the
extraction was not the hot part of these dispatchers.

## Round 5 — named-func-expr func-type unification (the arity-chain fix
that needed NO layout change)

Instrumenting the arity probe showed the 149-arm chain resolved to **90
distinct closure func types over 57 self shapes for only 9 distinct
arities** — and the explosion came from NAMED FUNCTION EXPRESSIONS: each
minted a private `(ref_null $ownStruct, …)` lifted func type, so acorn's
hundreds of `pp$X.method = function …` closures each added a chain arm
even when their USER signatures were identical.

Fix (`mintClosureStructTypes`): named func exprs keep their private
capture struct but now SUBTYPE the shared wrapper, and their lifted func
type takes the nullable canonical ROOT as `__self` (deduped by
`addFuncType` across identical user signatures). Bodies downcast root →
private struct via the existing `usesWrapperFuncType` machinery; var
hoisting keeps the nullable self slot; recursion dispatches unchanged
(the #2118 comment's "struct.get runs against __self's actual param
type" contract now holds root-wide). No allocation-site or capture-index
changes — the layout-risk variant (arity FIELD in the wrapper) was
deliberately deferred.

**Measured: funcTypes 90 → 48, extraction selfShapes 57 → 1, standalone
parse 3.38 → 2.66ms.** Cumulative standalone: **52.4 → 2.7ms (19.7x),
~5x faster than the host lane**; gap to node-acorn now ~45x.

Verification (round 5): all 10 closure suites — the 10 failures
(illegal-cast-closures ×6, closure-construct ×1, 2637 ×1, 3036 ×2)
reproduce IDENTICALLY on the committed base (pre-existing); var-hoisting
+ annexB-hoist + nested-hoist suites green; async/generator suites
100/100; standalone batch — same pre-existing 4; host corpus 23/23
exact; standalone canaries 4/4; 1712 acceptance green; host bench
unchanged; tsc + biome clean.

## Round 7 — i31 small-int boxing (linear memory's value-rep trick, natively)

`__box_number` (standalone native) now encodes integral values in the
signed-31-bit range as an UNBOXED `(ref i31)` — zero allocation — instead
of a `$BoxedNumber` struct. Excluded: -0 (i31 cannot carry the sign), NaN
and infinities (fail the trunc round-trip), and out-of-range values.
Encoder gained `ref.i31` / `i31.get_s` (GC opcodes 0x1C/0x1D); abstract
i31 `ref.test`/`ref.cast` ride the existing negative-heap-type encoding
(-20 → SLEB 0x6C).

Every discriminator that detects boxed numbers gained an i31 arm:
`__unbox_number`/`__typeof_number`/`__is_truthy`/`__to_bigint`/
`__typeof_string`-class/`__typeof` (imports.ts natives);
`__any_from_extern` tag-3 classification, `__any_to_f64`'s tag-5
`$BoxedNumber` recovery, `tag5ToNumber`, and the tag-5 "is a real string"
guard (any-helpers — the tag-5 lane was the subtle one: the "tag-5 lie"
wraps every non-nullish externref, so i31 numbers hid inside tag-5 boxes
and `this.pos + size` in a prototype method answered NaN until the
recovery arms landed — pinned by
`tests/issue-3673-i31-smallint.test.ts`); the `__extern_get` numeric-key
gate + i31-twin arms, `__obj_hash` key coercion, the Array-length
validation normalize, `__vec_dp_value` f64 write-back, `__weak_key_ok`
number rejection, JSON stringify/parse-revive arms, and the two
native-string number-coercion arms. Equality/compare/Map-SameValueZero
route through the i31-aware `__typeof_number`/`__unbox_number`, so mixed
i31-vs-struct encodings of the same value stay `===`.

**Measured: wall-clock FLAT on the acorn microbench (2.67ms vs 2.66ms)**
— GC was already only ~1.2% of the profile and V8's young-gen bump
allocation is near-free at this scale. The win is allocation VOLUME
(every small-int box removed), which matters under memory pressure and
for larger workloads, not this 330B parse. Recorded honestly; the arms
are correctness-neutral by construction and pinned by the new test.

Verification (round 7): probe matrix (dyn fields/===/arrays/obj/string
concat/switch/floats/-0) green; new 7-test pin suite green; standalone
acorn canaries 4/4; host corpus 23/23 exact (host lane untouched — its
`__box_number` is a host import); 30-suite standalone batch + 1712
acceptance — only the pre-existing 1599 ×3; JSON/Map/Weak suites — same;
tsc clean.

## Round 8 — typed `__get_member_<name>__f64` dispatchers (slot monomorphism, read side)

The #3669/#3671 issues as filed were correctness bugs (fixed by another
lane); the PERF continuation is this: a ToNumber-context field read
through the generic `__get_member_<p>` dispatcher paid three calls plus a
number box per hit — the struct arm `struct.get`s the f64 slot,
`__box_number`s it up to the uniform externref, and the read site
immediately `__to_primitive`s + `__unbox_number`s it back down (the
`this.pos + size` shape in the .wat evidence above). Now the externref→f64
coercion in type-coercion.ts detects when the stack top is literally a
generic-dispatcher call with hint "number", and swaps it for a typed twin
`__get_member_<p>__f64(recv) -> f64`: numeric-slot arms are a bare
`ref.test` → `struct.get` (+`f64.convert_i32_s` for i32/boolean slots) —
no box, no ToPrimitive; non-numeric slots, accessor-bearing props, #2979
sentinel gen-results, and misses all route to the generic dispatcher +
the exact chain the site would have emitted, arm-order-preserved. Same
reserve-then-fill discipline as #2674 (deps registered at reserve, body
filled after `fillMemberGetDispatch` at finalize); wired through a
shared.ts late-bound delegate (member-get-dispatch.ts imports
`coercionInstrs` FROM type-coercion.ts — the reverse static import would
close an eval-time cycle).

**Measured: wall-clock FLAT again (2.70ms vs 2.67ms)** — 16 typed
dispatchers mint in compiled acorn (pos/start/end/lastTokEnd/curLine/…)
and the profile confirms the work is real but small: `__to_primitive`
self-time 3.7% → 1.4%, `__vec_overlay_lookup` off the top list. The
remaining wall is crossing VOLUME through `__extern_get` (9-14%) +
`__obj_find` + `__str_equals` — reads that never had a per-name
dispatcher (dynamic keys, `$Object` hash props), out of scope for this
slice.

Verification (round 8): typed-dispatcher probe (fnctor `this.pos` slice
shape) answers correctly with the typed body confirmed in the .wat (one
`ref.test` + `struct.get $14 1`, fallback = generic + to_primitive +
unbox); #3673 pin suite 7/7; host corpus 23/23 exact (rewrite is
standalone-gated); dispatcher pin suites #2674/#2963/#3041/#3050/#2664
/#2979 all green; 1712 acceptance green; #2151 ×3 failures verified
identical on pre-change tree (pre-existing); tsc clean; biome error count
identical to base (pre-existing drift only).

## Round 9 — $HashedString + per-key prototype-lookup inline cache

Goal escalated to "surpass node-acorn" (warm node-acorn on the same 330B
input: **0.0341 ms/parse**, measured — the real gap was ~79x, not 45x).
Three sub-slices this round, driven by caller-edge profiling:

1. **`$HashedString <: $NativeString`** — a flat string carrying a cached
   FNV-1a hash (field 3; 0 = uncomputed, else `(h & 0x7fffffff) | signbit`)
   plus a per-key prototype-lookup cache (fields 4-6: cacheGen/cacheOwner/
   cacheEntry, `anyref` — `$Object`/`$PropEntry` register later). Only two
   producers: interned literal globals (hash BAKED at compile time by
   `nativeStringLiteralHash` — must stay bit-identical to `__obj_hash`'s
   wasm loop) and `__str_flatten`'s memoized flat copies (lazy).
   `__obj_hash` gained the cache fast path + write-back; `__str_equals`
   gained a both-sides-hashed O(1) reject. Measured: `__obj_hash` 3.2% →
   1.0% self.
2. **String-method fast path in `__extern_method_call`** — `ref.eq` on the
   interned name against "charCodeAt"/"slice" dispatches straight to
   `__str_charCodeAt`/`__str_slice`, skipping `__extern_get` + builtin-meta
   + apply. Emitted and reachable, but WAT inspection showed dynamic
   `.charCodeAt` READS already lower inline — the hot `__extern_method_call`
   traffic is Parser PROTOTYPE method calls, which led to:
3. **Per-key prototype-lookup inline cache** (the big one): acorn assigns
   parser methods at runtime (`pp.readToken = fn`) onto per-fnctor
   prototype `$Object`s, so EVERY `this.readToken()` re-resolved through
   the full `__extern_get` (closed-struct field ladder ≈15 compares +
   builtin-meta probe + prototype hash walk) before `__apply_closure`. Now
   a first-proto DATA hit with an interned key memoizes (owner-proto,
   entry, generation) ON THE KEY STRING; the hit arm — prepended at
   finalize AFTER the ladder fills so it runs FIRST
   (`unshiftExternGetProtoCacheArm`) — answers in O(1). Soundness:
   population only runs when ladder+meta MISSED for that fnctor class;
   hits are confined by owner-proto `ref.eq` to the same class; validity =
   generation match (bumped ONLY by `__obj_grow` — rehash re-mints
   entries) + live-DATA flags check (delete → TOMBSTONE, defineProperty
   morph → ACCESSOR, both checked per hit; value updates mutate the entry
   in place and stay visible).

**Measured: 2.9 → ~2.5ms/parse** (bench noise band ±0.15); profile:
`__obj_find` 5.7% → 3.4%, `__builtinfn_get_meta` off the top-15,
`__extern_get` 9.7% → 8.0%. Binaryen `optimizeBinaryAsync` (level 3) on
the bench module: **2.31ms before this round** — re-measure after.
Remaining top: `__extern_get` residue (options/$Object reads + cache-guard
overhead), `__str_equals` ladder compares for non-cached reads,
`__call_fn_method_*` signature ladders (next: signature-id
devirtualization), `__regex_run`, `__to_primitive`.

Verification (round 9): host corpus 23/23 exact; #3673 pin suite 7/7;
canaries 4/4; dispatcher/JSON/collections/1712 batch — failures only in
the pre-existing sets (1599 ×5, 2151 ×3, getters-setters ×6,
imported-string-constants ×4 — each verified identical on base); tsc
clean.

### Round 9c — cache extension to plain `$Object` own entries

The residual `__extern_get` share was dominated by acorn's per-parse
`this.options.<x>` reads — an open `$Object` receiver, so the fnctor-proto
cache never fired. The walk's depth-0 arm now also sets `canCache` for a
plain `$Object` receiver (own DATA entries), and the hit arm's
owner-candidate falls back to the receiver itself when it has no fnctor
prototype. Same soundness shape: population implies every earlier arm
missed for this exact receiver identity; hits are owner-`ref.eq`-confined;
own always shadows proto so chain mutations can't stale a cached own
entry; tombstone/accessor/generation checks as before.

**Measured: ~2.5 → 1.91-2.08ms/parse (min 1.91, 5 reps)** — cumulative
52.4 → ~1.92ms (~27x); node-acorn warm 0.0341ms → gap ~56x. Profile:
`__str_equals` 5.1% → 2.1%, `__obj_find` off the top-15; remaining top:
`__extern_get` residue 6.6% (cache-guard overhead + uncached reads),
`__call_fn_method_{0,1,2}` ~9.4% (signature-id devirtualization is the
next structural slice), `__regex_run` 3.4%, `__to_primitive` 3.4%, GC
4.4%.

Verification (round 9c): host corpus 23/23 exact; 2896/2866/accessor/
defineProperty/delete/1888/2106-S1/2674/1712/2151-nary suites all green;
#3673 pins 7/7; canaries 4/4; tsc clean.

### Round 10 — cache-arm owner reorder + arity-bucketed signature dispatch

Two smaller slices: (a) the cache-hit arm resolved the owner-candidate by
calling the `__fnctor_proto_start` ladder even for plain `$Object`
receivers — now one `ref.test $Object` runs first; (b)
`__call_fn_method_<N>`'s signature ladder (one funcref `ref.test` per
distinct closure func type, ≈48 in acorn) is pre-filtered by the round-6
`$arity` field: an i32 compare narrows to the same-arity bucket, with the
FULL ladder kept as fallthrough (the arity field is not trusted —
builtin-fn metas stamp spec `.length`, e.g. a variadic `JSON.stringify`
value closure declares 1 vec param but `.length` 3; a bucket miss simply
re-enters the old ladder). Bucket callBodies are `structuredClone`d — the
same Instr objects living twice in one body would be double-remapped by
finalize walks.

**Measured: ~flat to slightly better (min 1.98 vs 1.91, medians ≈2.05
both) — `__call_fn_method_2` off the top list, `_1` residue is the
callBody itself (argc/extras globals + unbox + call_ref + boxing), not
the ladder.** Honest read: the round-5 func-type dedup already took the
ladder below the noise floor for this workload. Remaining top:
`__extern_get` 7.1%, `__regex_run` 5.3% (per-word-token keyword regex —
regex-engine subsystem), user closures (real work), `__to_primitive`
2.9%, GC 3.3%.

Verification (round 10): 2151-nary/dynamic-spread/spread-literal, 1712
acceptance, 2664-arity-dispatch all green; host corpus 23/23 exact;
#3673 pins 7/7; canaries 4/4; tsc clean.

### Round 11 — `__to_primitive` primitive identity early-out

§7.1.1 step 1: ToPrimitive of a primitive is the identity — but a plain
number (i31 / `$BoxedNumber`) or native string fell into the non-`$Object`
arm and paid a `__class_to_primitive` dispatcher walk per remaining
ToNumber site. Three `ref.test` early-outs at the top return the input
unchanged. Also switched measurement to a min-of-10-batches in-process
methodology (`.tmp/bench-min.mjs`) — the single-shot estimator had a
±0.5ms noise band from tier-up/GC timing. **Current: 1.71ms/parse
(stable min)** — cumulative 52.4 → 1.71 (~31x), node-acorn gap ~50x.
Verification: string-hint/coercion/class-to-primitive suites (1806,
1470, 2638, 2358, 1910) all green; corpus 23/23; pins 7/7; tsc clean.

### Round 12 — inline method-lookup cache in the per-fnctor call arms

The round-11 profile still showed 251ms of `__extern_get` self-time
under `__extern_method_call`: each per-fnctor arm called `__extern_get`,
which walks its prepended ladder + `__fnctor_proto_start` BEFORE reaching
the round-9b cache arm. Inside a per-fnctor arm the prototype is a KNOWN
GLOBAL, so the cache check is now inlined there — interned key +
generation + owner `ref.eq` against `global.get <proto>` + live-DATA
flags → apply the cached method closure with zero lookup calls; any miss
takes the exact old `__extern_get` path (which populates). **1.71 →
1.54ms/parse (stable min)** — cumulative 52.4 → 1.54 (~34x), node-acorn
gap ~45x. Verification: corpus 23/23; 1712 + 2151-nary + 2963 ×4
method-identity suites green; pins 7/7; canaries 4/4; tsc clean.

### Round 13 — cached-method DIRECT call in `__call_m_<name>_<arity>`

`__method_cache_lookup(recv, name)` (new native — the per-key cache probe
as a callable helper) lets the fixed-arity dispatchers call
`__call_fn_method_<arity>` DIRECTLY with unpacked args on a hit —
skipping the per-call `$ObjVec` allocation, `__extern_method_call`, and
`__apply_closure`. Two correctness lessons baked in: (a) the exact-arity
export only carries closures with formals ≤ call-site arity, so an
UNDER-applied call (declared > arity, read off the root wrapper's
`$arity` field) must divert to the legacy path whose #3592 widening pads
missing args — the first cut without this gate broke `raise` paths
(`getLineInfo` null-deref via a method silently answering undefined);
(b) argc is preset/reset around the direct call exactly as
`fillApplyClosure` does. Scratch-local slot patched after the fill's
locals array finalizes (placeholder-index pattern).

**Measured: 1.54 → ~1.51ms min (marginal — most calls either hit
closed-struct arms above or divert on under-application).** Battery:
corpus 23/23; 2151 ×13 suites (3 pre-existing), 2903 ×8 suites — the 4
`issue-2903-iter-helpers` failures REPRODUCE AT THE MERGE-BASE with main
(verified by checkout bisect: merge-base 5805049, rounds 6-13 all
identical) — upstream pre-existing, not introduced here; 3117/3309/1712
green; pins 7/7; tsc clean.

### Round 14 — vec-overlay newest-first scan

The #3251 overlay table (vec identity → companion `$Object`, `ref.eq`
scan — identity maps can't hash in pure WasmGC) is APPEND-ONLY and the
standalone regex-exec path appends a pair per match, so it grows across
a run while `__vec_dp_value`'s per-define lookups walked it FRONT-first
— oldest (dead) entries before the fresh match array at the end.
Reversed to newest-first: hits on the active match array are O(1)
regardless of table size. Profile: `__vec_overlay_lookup` 3.4% → 2.5%;
the residue is the MISS scan (a fresh array's first define scans the
whole table to find nothing) — next slice: an ensure-fresh (append
without scan) callable from the match-result builder, which knows its
array is brand-new. The unbounded table itself (a genuine leak — WasmGC
has no weak tables) is recorded as a standing issue for the S3-era
per-vec companion field design. Verification: 3251 suites 18/18, 3116,
corpus 23/23, pins 7/7; tsc clean.

## What "surpass node-acorn" actually requires (measured decomposition)

Session cumulative: **52.4 → ~1.92ms/parse (~27x)**; warm node-acorn on
the same input is **0.0341ms** (measured; the earlier 0.06 estimate was
generous) — the remaining gap is **~56x**. Two more null results recorded
honestly: aggressive Binaryen inlining
(`--flexible-inline-max-function-size=500
--one-caller-inline-max-function-size=1000`) is wall-flat (1.92ms — V8's
wasm tiering already absorbs the call overhead), and cold single-parse
also loses (wasm compile of the 1.27MB module ~75ms vs ~23ms for V8
parsing+evaluating acorn.mjs and one interpreter-tier parse).

Time split of the round-10 profile (excluding harness noise): **runtime
helpers ≈58%, user-closure code ≈38%, GC ≈5%**. Zeroing every remaining
runtime helper — the asymptote of the inline-cache/fast-path program this
branch has been executing — lands around **0.8ms, still ~23x off**. The
user-closure share is the compiled parser itself: every field read is a
dispatcher CALL returning a boxed value, every arithmetic op round-trips
through externref boxing, every method call crosses the closure-call
bridge. node-acorn's equivalents are single machine loads under inline
caches.

Surpassing node-acorn is therefore a CODEGEN-ARCHITECTURE goal, not a
runtime-tuning goal. The concrete path (maps to existing goals):

1. **Typed `this` monomorphization for fnctor prototype methods**
   (#1946/#1947 class of work): when every callee of
   `Parser.prototype.readToken` is provably a `$__fnctor_Parser`
   receiver, compile the method with `this: (ref $__fnctor_Parser)` —
   field reads become bare `struct.get`, writes `struct.set`, no
   dispatcher calls.
2. **Unboxed value representation** (#1584 / value-rep goal): keep
   number-typed locals/fields as raw f64/i32 through expressions;
   box only at genuine `any` boundaries. Kills the
   `__box_number`/`__unbox_number`/`$AnyValue` churn that dominates the
   user-closure share.
3. **Direct-call devirtualization**: `this.method(...)` on a
   monomorphized receiver becomes a direct `call` to the compiled
   method function (no closure struct, no `__apply_closure`, no
   `call_ref` type ladder).
4. Only then do the residual runtime helpers (`__regex_run`,
   `__to_primitive`, iterator glue) matter again.

Items 1-3 are the standing IR/value-rep roadmap; this branch's inline
caches remain valuable as the fallback path those optimizations demote
to.

## Round 6 — arity IN the closure representation (the deferred layout change)

Every closure struct in the root wrapper hierarchy now carries an immutable
`$arity` i32 at field 1 (`CLOSURE_ARITY_FIELD_IDX`); captures/TDZ slots
start at `CLOSURE_CAPTURE_FIELD_BASE` (2). `buildClosureArityProbe` (inside
`__apply_closure`) and the `__closure_arity` export answer with ONE
`ref.test <root>` + `struct.get` — the per-func-type chain survives only
for shapes outside the hierarchy (fnctor ctor closures). Touched: type
mints (wrapper root/per-sig/constructible, arrow/named/fallback structs,
funcref-as-closure `__fn_cap_*`, async-scheduler settle-cap, builtin-fn
meta, IR `__ir_closure_*`), all allocation sites (emitClosureConstruction,
trampolines/lazy caches, member-get dispatch arms, promise executor caps,
builtin closure values, IR `closure.new` via a new optional
`emitClosureArityOperand` backend-trait method — bytecode/linear backends
unaffected), capture-index math (closures.ts, funcref-as-closure
trampolines, IR capFieldIdx), and the bfn meta state/id field shifts in
`fillBuiltinFnMeta`. One missed site (the IR lowering) was caught by the
loud struct.new-operand-count validation failure in issue-3546's suite and
fixed.

**Result: `__apply_closure` VANISHED from the standalone parse profile
(was 12.5% self).** Wall time ~2.7ms/parse (the arity chain was the last
of `__apply_closure`'s cost); profile-loop throughput +30%. Post-round
profile: `__extern_get` 14.1%, `__obj_find` 8.2%, `__str_equals` 6.3%,
`__vec_overlay_lookup` 5.6% — property lookup is now decisively the top
family (#3669/#3671 next).

Verification (round 6): 16-shape closure smoke matrix compiles+validates
both targets; closure/hoisting/arity battery back to exactly the 10 known
pre-existing failures (3546 green); IR suites — 9 `ir-bytecode-wasmgc-vm`
failures reproduce identically on base (pre-existing env issue); async +
generator suites green; standalone batch — same 3 pre-existing; host
corpus 23/23 exact; standalone canaries 4/4; 1712 acceptance green; tsc +
biome clean. The emitted `__apply_closure` carries a 149-arm `ref.test` chain
over distinct closure FUNC types to answer "declared arity of this
closure" (the #3592 widening probe), and `__call_fn_method_1` a 69-arm
chain to select the `call_ref` target type. Together `__apply_closure`
(12.5%) + `__call_fn_method_{0,1,2,3}` (~13.5%) are the dominant remaining
cost, and both are O(#closure-func-types) per dynamic call. The real fix
is REPRESENTATIONAL: carry the declared arity (and ideally a small
signature id) as a field in the root closure wrapper so the probe is one
`struct.get`. That shifts every capture field index by one — capture
indices are computed at multiple sites (`closures.ts` `i + 1` sites, TDZ
at `1 + captures.length + ti`, `__constructible` append, every allocation
`struct.new` operand list) — a contained but genuinely risky refactor
that needs its own slice with the full closure/dispatch suite as the
gate (the #1712 history shows this class of change causing invalid-wasm
regressions when done piecemeal). Remaining profile after round 4:
`__apply_closure` 12.5%, `__extern_get` 11.3%, `__obj_find` 6.5%,
`__call_fn_method_1` 5.4%, `__str_equals` 5.2%.

**Answer to the hybrid question**: yes, and it is now the winning
direction. The standalone object runtime, after this round, outperforms
the host bridge — so a "standalone-core + thin host imports" artifact
(host provides only what Wasm can't: I/O, RegExp beyond the native subset,
Date/locale, etc.) is the right target shape. Two concrete gaps block
promoting it to the default acorn artifact:
  - the 17-file corpus-concat fixture TRAPS in the standalone parser
    (pre-existing, reproduces before this branch — needs its own triage;
    the 23-input host corpus is all-green, so this is a standalone-runtime
    gap, not a parser gap);
  - standalone string output/marshalling back to JS needs a thin
    `wasm:js-string`-style seam so a Node host can call `parse` with a JS
    string without compiling the input into the module.

Verification for this round: all four standalone acorn canaries green
(parse / parseExpressionAt / tokenizer / function-body), 94
standalone/native-string test suites — zero new failures (9 pre-existing,
each verified identical on the committed base: issue-1599 JSON-refuse ×3,
issue-2865 async-await ×2, issue-2879 floor ×2, issue-681 iterators ×2),
host corpus 23/23 exact, host bench unchanged, 1712 pins green, tsc +
biome clean.

## Correctness fix — `Function.prototype.call`/`apply` on a closure

(Not a perf round: a semantics bug surfaced by scaling the standalone
benchmark up to a full-size input.)

Found by scaling the standalone benchmark from the 4 tiny canaries + the
330 B fixture up to acorn parsing **its own 245 KB `dist/acorn.js`**. The
canaries pass; the full self-parse did not — it died with
`TypeError: Cannot access property on null or undefined at 2724:51`
(`parseMaybeAssign`, `refDestructuringErrors.shorthandAssign >= left.start`).

Root cause, and it is a **correctness bug, not a perf one**: a closure is
not a `$Object`, so `__extern_method_call` sent a method call on a function
value to the #3468 closure own-property side table. That table has no
`call`/`apply` entry, so the lookup missed and the whole call expression
evaluated to `undefined` — the function was never invoked. It only bites
where the receiver is **dynamic** (a parameter or field), because a static
receiver is rewritten by the `.call`/`.apply` cases in `calls.ts` long
before the runtime sees it. acorn hits exactly that shape:
`left = afterLeftParse.call(this, left, startPos, startLoc)` with
`afterLeftParse` a parameter (`this.parseParenItem`), so `left` came back
`undefined` and every parenthesized or destructuring assignment crashed on
the following line.

Fix: a new reserved helper `__closure_method_call(fn, name, args)` (same
reserve-then-fill discipline as the rest of C-core, so no funcIdx shift),
spliced into `__extern_method_call`'s non-`$Object` arm. Two routes in spec
precedence order — an own property in the closure's bag still wins (§10.2
[[Get]], the #3468 `assert` harness behaviour, unchanged), otherwise
`call`/`apply` resolve to the %Function.prototype% builtins and invoke the
receiver itself via the existing `__apply_closure` bridge
(`fn.call(t, a, b)` → `__apply_closure(fn, t, [a, b])`;
`fn.apply(t, arr)` → `__apply_closure(fn, t, arr)`). The method name is
matched by `ref.eq` against the interned literal (round 2), the same
identity test the string-receiver fast path uses; a non-interned name
misses and falls through to the old undefined result, so nothing regresses.
Throw-free, per the C-core discipline.

Measured on a 29-case assignment/call matrix through standalone-compiled
acorn: **12 broken → 8 broken, 0 regressions** (each of the 8 verified
byte-identical on the committed base). Newly correct: `({a: b} = c)`,
`({...a} = b)`, `(a) = 1`, `(function(){…}).call(null)`, and direct
`f.call(a, b)` / `f.apply(a, [b, c])`. Pinned by
`tests/issue-3673-closure-call-apply.test.ts` (7 cases). Host/gc mode is
**byte-identical** (verified by sha256 of a compiled binary before/after —
the whole helper is behind the `ctx.standalone || ctx.wasi` gate).

### Full self-parse is still blocked — three SEPARATE pre-existing bugs

Fixing `.call` moves the 245 KB self-parse deeper but not to green. The
remaining blockers are independent of it and each reproduces on the
unmodified base, so they are **not** regressions from this round:

1. **`raise`/`getLineInfo` null deref.** Any acorn `raise(...)` traps with
   `dereferencing a null pointer` inside `getLineInfo` — `this.input` reads
   non-null at the `raise` entry but the `input` parameter is null one frame
   in. Reproduces on the base with a bare `1 = 2` or `var 3 = x`, i.e. it
   needs no destructuring and no `.call`.
2. **`for-in` over a fnctor instance enumerates nothing**, which breaks
   shorthand object destructuring. `({a} = b)`, `({a = 1} = b)`,
   `({a, b: [c]} = d)` reach `toAssignable`'s `default:` arm and raise
   "Assigning to rvalue" although they are valid; the trace shows the
   `Property` arm entered with `kind=init`, so the bad node is the shorthand
   `prop.value`, which acorn builds with `copyNode`'s
   `for (var prop in node) { newNode[prop] = node[prop] }`. Confirmed with a
   9-line repro — copying a fnctor instance carrying expando properties
   yields a copy with **none** of them, so `value.type` is `undefined` and
   no `toAssignable` case matches (cf. the known #2668 for-in gap). Then
   (1) turns the bogus raise into a trap.
3. **RegExp construction.** `var re = /ab+c/g` traps with `illegal cast` in
   `parseFloat` via the regexp validator's `reset`.

Each deserves its own issue; the standalone lane's correctness gate is
currently 4 canaries, which is why all four of these (including the `.call`
bug) were invisible. **A full acorn self-parse is the gate that would have
caught them** — worth adding once (2) and (3) land.

## Remaining follow-up (out of scope here, needs codegen)

The residual ~150-300x is dominated by crossing VOLUME, not per-call cost.
Structural reductions belong to the existing codegen goals:

- **#3669 / #3671 property-slot monomorphism** — keep hot fnctor field
  reads/writes on typed struct slots Wasm-side instead of `__extern_get`/
  `__extern_set_strict` crossings.
- **#1946/#1947 GC-ref typing / closure devirtualization** — reduce
  `__extern_get_raw_callable` + `__extern_method_call` dispatch.
- Cheap codegen wins observable in the .wat: `__get_undefined` is a host
  call per `undefined` literal use (4.7k/parse — cacheable in a global);
  `__typeof_number`/`__is_truthy`/`__host_eq`/`__host_compare` on boxed
  numbers could take a Wasm-side fast path before falling back to the host.
- Value representation (`__box_number`/`__unbox_number` 11k crossings per
  330B parse) is the #1584-era value-rep question.
