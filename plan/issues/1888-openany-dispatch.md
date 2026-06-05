---
id: 1888
title: "standalone open-any method dispatch + built-ins-as-static-globals (prototype vtable)"
status: ready
created: 2026-06-05
priority: high
feasibility: hard
reasoning_effort: high
task_type: feat
area: codegen, runtime
language_feature: objects, prototype chain, method dispatch, built-ins
goal: host-independence
sprint: Backlog
related: [1472, 6407, 1629, 1104, 1539, 1103]
parent: 1472
---
# #1888 — Standalone open-any method dispatch + built-ins-as-static-globals

> Architectural sub-issue of **#1472 Phase C**. This is the spec for the
> single layer that unblocks the largest remaining standalone gap. sd-1472c
> implements it as the independent slices below. The runtime types/helpers
> live in `src/codegen/object-runtime.ts`; routing lives in
> `src/codegen/expressions/late-imports.ts`. The conservative dual-mode
> invariant from #1472 holds throughout: **GC/host path unchanged and
> default; standalone is the new native path; any uncertainty ⇒ fail loud
> (`Codegen error:` queued via `reportError*`), never invalid Wasm.**

## Problem (the addressable block)

#1472 Phase B gave standalone a Wasm-native open-`$Object` hash-map for
*property* get/set/delete/enumerate/define-data-descriptor. What it does
**not** have is the *dispatch* layer:

| Refused helper (`STANDALONE_REFUSED_IMPORT`) | Raw rows (2026-06-02 JSONL) | What it does |
| --- | ---: | --- |
| `__get_builtin` | 6,565 | `globalThis[name]` — resolve `Object`/`Array`/`Math`/… as a value |
| `__extern_method_call` | 7,465 | `obj.m(...)` generic dispatch on an `any`/externref receiver |
| `__proto_method_call` | 659 | `Type.prototype.m.call(recv, …)` borrowed-method dispatch |
| `__defineProperty_accessor` | 2,713 | accessor (get/set) descriptors — deferred by S6 (no funcref slots) |
| `__hasOwnProperty` (bare-method form) | 1,416 | `o.hasOwnProperty(k)` reaches dispatch, not the property path |

These converge on **one** missing capability: *invoke a method named by a
string on an open value, resolving the method through the prototype chain,
where the prototype graph for built-ins is shipped as Wasm data, not JS.*
That is ~9k of the ~18.8k standalone #1472 gap (the largest single block
toward the 27.8%→57% target).

The two halves of the capability:

1. **Method resolution** — given `(receiver, "methodName")`, find the
   function value: own property → walk `$Object.$proto` chain (ES §10.1.8.1
   OrdinaryGetPrototypeOf, §10.1.5 [[Get]]). For built-in receivers
   (`[].map`, `Math.max`, `"s".slice`), the prototype is a built-in object
   graph that today only exists in JS (`globalThis`).
2. **Method invocation** — `Call(method, receiver, args)` (§7.3.14). The
   method value is either a user closure (`$Closure`-family wrapper, invoked
   via `call_ref` — already have `__call_fn_N`) or a built-in (compiled
   native helper, e.g. `__str_slice`, `__array_map`).

## Spec references (ECMA-262)

- §10.1 Ordinary Object Internal Methods — [[Get]]/[[Set]]/[[GetPrototypeOf]]
  /[[SetPrototypeOf]]/[[GetOwnProperty]]/[[DefineOwnProperty]].
- §10.1.8.1 OrdinaryGetPrototypeOf, §10.1.2.1 OrdinarySetPrototypeOf
  (the extensibility + cycle checks `setPrototypeOf` must honour).
- §10.1.5.1 OrdinaryGetOwnProperty (accessor vs data descriptor shape).
- §10.1.6.3 ValidateAndApplyPropertyDescriptor (accessor define rules).
- §7.3.14 Call, §6.2.5 Reference Record (the `GetValue` of an accessor get).
- §13.3.5 / §13.3.6 — member-call evaluation order: receiver evaluated
  once, bound as the `this` of the call.

## Architectural decisions

### D1 — Representation: built-ins as a compile-time-resolved static
###      prototype graph, NOT a runtime `globalThis` object.

We do **not** ship a runtime `globalThis` hash-map keyed by `"Array"`,
`"Math"`, … and walk it at runtime. That would require materialising every
built-in object as an `$Object` with every method boxed as a closure — huge
binary bloat and a second method-resolution mechanism. Per
`feedback_compile_away` (resolve JS semantics statically, zero runtime
overhead), the receiver's built-in *kind* is **already known at compile
time** in the overwhelming majority of call sites, because the existing
fast-path dispatchers in `calls.ts` (`tryExternClassMethodOnAny`, the array
/ string / Map / Set method handlers) classify the receiver before falling
through to `__extern_method_call`. The native dispatch layer is a **fallback
for the residual `any` receiver only**, and it splits into two cases:

  - **(a) Statically-classifiable receiver** (`[].map(...)`,
    `"s".slice(...)`, `Math.max(...)`, `Array.isArray(x)`): the existing
    static fast paths already emit the native helper directly with **no host
    import** — these mostly work standalone *today* and are out of scope
    except where a fast path is gated on `!ctx.standalone` or falls through
    incorrectly (audit task, Slice 0).

  - **(b) Genuinely-open receiver** (`const o: any = {...}; o.m(args)` where
    `m` is a user method stored as a function-valued property, or
    `obj[k](args)`): resolve `m` through the `$Object` chain at runtime and
    invoke it via `call_ref`. **This is the new native path.** Built-in
    *instance* methods on a genuinely-open receiver (e.g. an `any` that turns
    out to hold a `$Vec`/`$NativeString` at runtime) route through the
    **runtime brand-dispatch** in D3.

  - **(c) Named built-in constructor/namespace as a value**
    (`__get_builtin("Array")` to read `Array.isArray`, pass `Object` to a
    function, `const C = Array`): these need the constructor/namespace to
    *exist as a value*. Decision: emit a **lazily-constructed singleton
    `$Object`** per named built-in, populated with only the
    statically-referenced own properties (the methods/props actually read in
    the program), each method stored as the corresponding native helper
    wrapped in a `$Closure`. This is the "built-ins as static globals"
    piece — see D4. It is far smaller than a full `globalThis` because it is
    **demand-driven by the program's actual references**.

> **Why this is the right cut:** the 7,465 `__extern_method_call` rows are
> dominated by case (b) (open user objects) and case (a) leakage (a fast
> path that bails to the host shim under standalone). Case (c) (`Array` as a
> first-class value) is the long tail. Slicing (b) first banks the bulk;
> (c) is a later, self-contained slice.

### D2 — `$Object` already carries the dynamic shape. No new container type.

The Phase-B `$Object { proto, props, count, tombstones, flags }` +
`$PropMap`/`$PropEntry` already *is* the open-any dynamic-shape carrier.
Method dispatch on an open object is just **`__extern_get(o, "m")` then
`Call`**. So case (b) needs **no new representation** — it reuses
`__extern_get` (which already walks the proto chain, Phase B Slice 1) to
fetch the method value, then invokes it. The only genuinely new types are
for the accessor-descriptor extension (D5) and the built-in singleton
registry (D4).

### D3 — Invocation mechanism: `call_ref` for user closures; brand-switch
###      to native helpers for built-in instance methods. NO call_indirect
###      table.

We deliberately avoid a `call_indirect` dispatch table keyed by a runtime
method-id. Reasons:

  - The method value fetched from `$Object.props` is an `anyref`. If it
    holds a user function it is a `$Closure`-family wrapper struct — the
    existing `__call_fn_N(externref recv-or-args…) -> externref` exports
    (`emitClosureCallExport`/`…1`/`…2`/…, index.ts:2316+) already do
    `ref.test`→`ref.cast`→`struct.get $func`→`call_ref` for arities 0–4.
    **Reuse them.** A function-valued property invocation is:
    `box receiver+args → call __call_fn_N`.
  - If the fetched value is **not** a callable (`ref.is_null` or
    `ref.test $Closure*` fails), throw TypeError "`m` is not a function"
    (§7.3.14 step 2 / the host shim's `Cannot read properties of null`).
  - Built-in *instance* methods on a genuinely-open receiver are reached via
    a **runtime brand switch** helper `__extern_method_call` (native impl,
    D6): `ref.test $Vec` → array-method dispatch; `ref.test $NativeString`
    (after `any.convert_extern`) → string-method dispatch; `ref.test
    $Object` → own/proto user-method lookup → `call_ref`; else TypeError.
    Each brand arm calls the **already-existing native helper** for that
    method name (e.g. `__array_includes`, `__str_indexOf`), selected by a
    compile-time `methodName`→helper map. A `call_indirect` table buys
    nothing here because the method name is a *compile-time string constant*
    at every call site — the arm selection is static.

### D4 — Built-in singleton registry (case (c)): demand-driven lazy globals.

`__get_builtin("Array")` and friends, when the result is used as a *value*
(not immediately `.m()`-called — that's case (a)/(b)), lower to a
per-name **lazily-initialised global** holding a `$Object` singleton:

  - One nullable global `$__builtin_<Name>` per referenced built-in.
  - First read runs an init: `struct.new $Object`, then for each own
    property the program statically references on that built-in, insert a
    `$PropEntry` whose value is the native helper wrapped in a `$Closure`
    (static-method props like `Array.isArray`, `Object.keys`) or a nested
    built-in singleton (`Array.prototype`).
  - The set of own properties to materialise is computed at compile time by
    the existing reference scan (mirror `sourceHasMethodReassignment`'s
    SourceFile walk): collect every `Builtin.prop` / `Builtin[prop]` /
    `Builtin.prototype.m` referenced, materialise exactly those.
  - **Conservative fail-loud:** if a referenced built-in property has no
    native helper yet, emit `Codegen error: <Name>.<prop> not yet available
    in standalone (#1888)` rather than a null slot that traps at runtime.

This keeps the registry proportional to what the program uses, not to the
full built-in surface. It is the smallest piece and ships last.

### D5 — Accessor descriptors (`__defineProperty_accessor`): extend
###      `$PropEntry` with two funcref slots, gated by the `ACCESSOR` flag.

S6 deferred accessors because `$PropEntry` has only `{key, value, flags}`.
Extend it (this is a **type-layout change** — see migration note R3):

```
(type $PropEntry (struct
  (field $key    (ref $AnyString))   ;; immutable
  (field $value  (mut anyref))       ;; data value | null when accessor
  (field $flags  (mut i32))          ;; +bit 6 = FLAG_ACCESSOR (0x20 free; see below)
  (field $get    (mut (ref null $Closure0)))   ;; getter closure | null
  (field $set    (mut (ref null $Closure1))))) ;; setter closure | null
```

  - `FLAG_ACCESSOR` bit: pick an unused bit. Current bits:
    `WRITABLE 0x01, ENUMERABLE 0x02, CONFIGURABLE 0x04, TOMBSTONE 0x80`.
    Use **`0x08`** for `FLAG_ACCESSOR` (0x10/0x20/0x40 remain free).
  - `$Closure0`/`$Closure1`: reuse the existing zero-arg / one-arg
    `$Closure` wrapper base types the `__call_fn_0` / `__call_fn_1`
    dispatch already targets. Getter = arity-0 (`this` is the self field of
    the wrapper); setter = arity-1 (the new value). If the program defines
    no accessor, these two fields are always null — zero behavioural change
    for the data-only path (S1–S3 tests must stay green).
  - `__extern_get`: after locating the entry, if `flags & FLAG_ACCESSOR`,
    invoke `$get` via `__call_fn_0(self)` (§6.2.5.5 GetValue of an accessor
    Reference) instead of returning `$value`. Null getter ⇒ return
    `undefined` (§10.1.5.1).
  - `__extern_set`: if `flags & FLAG_ACCESSOR`, invoke `$set` via
    `__call_fn_1(self, newValue)`; null setter ⇒ no-op in sloppy mode
    (strict-mode throw deferred to the #1473 error machinery, same posture
    as the freeze-write refusal).
  - `__defineProperty_accessor`: native impl — find-or-insert the entry, set
    `FLAG_ACCESSOR`, store the getter/setter closures, clear `$value`.

### D6 — `__extern_method_call` / `__proto_method_call` native impls.

Both are added to `OBJECT_RUNTIME_HELPER_NAMES` with the **exact host
signatures** so every existing call site auto-routes with zero retargeting
(the Slice-1 invariant):

```
__extern_method_call (externref recv, externref name, externref args) -> externref
__proto_method_call  (externref typeName, externref methodName,
                      externref recv, externref args) -> externref
```

`__extern_method_call` native algorithm (case (b) + runtime brand fallback):

```
any = any.convert_extern(recv)
if any is null            -> throw TypeError (Call on null/undefined)   ;; §7.3.14
if ref.test $Object(any):
    m = __extern_get(recv, name)          ;; own + proto walk, accessor-aware (D5)
    if m is null / not $Closure*          -> throw TypeError "<name> is not a function"
    return __apply_closure(m, recv, args) ;; D7 — arity-dispatched call_ref
if ref.test $Vec(any):    return <array-method brand arm>(any, name, args)
if string-branded:        return <string-method brand arm>(any, name, args)
... (Map/Set/etc. brand arms reuse existing native helpers) ...
else                      -> throw TypeError
```

`__proto_method_call(typeName, methodName, recv, args)` is the
borrowed-method form (`Array.prototype.map.call(arrayLike, cb)`). It
ignores `recv`'s own shape and dispatches `methodName` against the
*named type's* prototype semantics — i.e. it routes straight to the
`typeName`-specific native helper for `methodName` applied to `recv` (the
brand arm for `typeName`, bypassing the own-property lookup). For
`typeName === "Object"` the receiver is coerced via ToObject and the
`$Object` user-method path is used. This is the same arm table as
`__extern_method_call`, keyed by `typeName` instead of the runtime brand.

### D7 — `__apply_closure(method, recv, args)`: the arity bridge.

The existing `__call_fn_N` exports take *positional* externref params, but
the dispatch call site has `args` as a `$ObjVec`/JS-array externref of
unknown length. Add a native bridge:

```
__apply_closure (externref fn, externref recv, externref args) -> externref
```

that reads `__extern_length(args)`, and dispatches to `__call_fn_0..4`
(reading `__extern_get_idx(args, k)` for each positional) for the common
arities, with a refuse-loud fallback (`Codegen error: dynamic method arity
>4 not yet supported in standalone (#1888)`) above arity 4 — matching the
existing `emitClosureCallExport{,1,2,3,4}` ceiling. (Raising the ceiling is
a mechanical follow-up: add `__call_fn_5+`.) The `recv` is threaded as the
closure self/`this` (the wrapper's self field), per §7.3.14.

## INDEPENDENT SLICES (for sd-1472c)

Each slice is a reviewable PR. They share the `object-runtime.ts` tail +
`tests/issue-1472.test.ts` region (mechanical merge, as in S1–S3). **Order
matters only where noted**; (b)-path slices are the high-value core.

### Slice 0 — Fast-path audit (NO new runtime; small, do first)
- Grep every `ensureLateImport(ctx, "__extern_method_call" | "__get_builtin"
  | "__proto_method_call", …)` call site and every `!ctx.standalone`-gated
  static method fast path in `calls.ts` / `array-methods.ts` /
  `property-access.ts`.
- For each, classify: does a statically-classifiable receiver (case (a))
  already have a native helper that the standalone path *should* reach but
  currently bails to the host shim? Fix those to route to the existing
  native helper (no new runtime). Document the residual that genuinely needs
  (b)/(c).
- **Deliverable:** a short audit table in the issue file + any trivial
  fast-path re-routes. This de-risks the later slices by shrinking their
  scope to true open-receiver cases.

### Slice 1 — `__apply_closure` arity bridge (D7) [foundation]
- Native helper bridging a fetched closure + `$ObjVec`/array args to
  `__call_fn_0..4` via `__extern_length` + `__extern_get_idx`. Refuse-loud
  above arity 4.
- Test: a user closure stored in a local, invoked through the bridge with
  0/1/2 args, instantiate-and-run under Node WasmGC, zero host imports.

### Slice 2 — `__extern_method_call` for the **open `$Object` user-method**
###            path (case (b)) [the big lever — depends on Slice 1]
- Native `__extern_method_call`: `any.convert_extern` → null-check
  (TypeError) → `ref.test $Object` → `__extern_get(recv, name)` →
  not-a-function check (TypeError) → `__apply_closure`. Non-`$Object`
  brands fall through to a refuse-loud `Codegen error` *for now* (brand arms
  are Slice 4).
- Add `__extern_method_call` to `OBJECT_RUNTIME_HELPER_NAMES`.
- Tests (computed-key to force the open path, as in S3): `o.m()` /
  `o.m(a,b)` on an open `any` object whose `m` is a stored arrow; method
  reads/writes `this.x` through the open object; `o.notAFn()` throws
  TypeError; `o` null throws TypeError. Instantiate-and-run, zero host
  imports.
- **Also unblocks the bare-method presence forms** sd-1472c's earlier
  slices punted (`o.hasOwnProperty(k)`, `o.isPrototypeOf(x)`): once the open
  `$Object` user-method path lives, route those bare-method names to the
  native `__hasOwnProperty`/`__object_hasOwn`/`__isPrototypeOf` helpers from
  the brand-arm table instead of the falsy no-op (the call-site dispatch gap
  flagged in S2's "Deferred" note).

### Slice 3 — `__proto_method_call` native (D6 borrowed-method form)
###            [depends on Slice 2 brand table skeleton]
- Native `__proto_method_call(typeName, methodName, recv, args)`: arm table
  keyed by `typeName` string; `"Object"` → ToObject + user-method path;
  other type names route to that type's native method helper. Refuse-loud
  for any `(typeName, methodName)` with no native helper.
- Tests: `Object.prototype.hasOwnProperty.call(o, k)`, a borrowed array
  method on an array-like, refuse path for an unsupported pair.

### Slice 4 — Runtime brand arms in `__extern_method_call` (case (a)
###            fallthrough for genuinely-`any` receivers)
- Extend `__extern_method_call` with `ref.test $Vec` / string-brand /
  Map / Set arms, each routing `methodName` to the existing native helper.
  This is additive over Slice 2's `$Object`-only body.
- Coordinate with **#6407** (receiver-element-retrieval for
  `Array.proto.<m>.call($Vec/open-obj)`) — that spec is the element-read
  side of the same brand-dispatch; reuse its helper, don't duplicate.
- Tests: `(x as any).push(1)` where `x` is a `$Vec` at runtime; string
  method on an `any`-typed string.

### Slice 5 — Accessor descriptors (D5) [type-layout change — see R3]
- Extend `$PropEntry` with `$get`/`$set` funcref slots + `FLAG_ACCESSOR`
  (0x08). Make `__extern_get`/`__extern_set` accessor-aware. Native
  `__defineProperty_accessor`. Add to `OBJECT_RUNTIME_HELPER_NAMES` and
  remove `__defineProperty_accessor` from the refusal set.
- **Regression gate:** every S1–S3 data-descriptor test must stay green
  (the two new fields are null on the data path).
- Tests: `Object.defineProperty(o, "x", { get(){...}, set(v){...} })` then
  read/write `o.x` invokes getter/setter; enumerable/configurable flags
  honoured; getter-only write is a sloppy no-op.

### Slice 6 — Built-in singleton registry (D4, case (c)) [self-contained,
###            ships last]
- Per-referenced-built-in lazy `$Object` singleton global, demand-populated
  from the compile-time reference scan. `__get_builtin` native routes to the
  singleton. Refuse-loud for any referenced built-in prop with no native
  helper.
- Tests: `const C = Array; C.isArray([])`; `Object.keys` read as a value
  then applied; refuse path for an unsupported built-in prop.

### Slice 7 — `Object.setPrototypeOf` dual-mode (small, independent)
- `calls.ts` ~L3857 currently stubs `setPrototypeOf` (drops proto) in ALL
  modes. Make it a dual-mode call-site change: standalone writes
  `$Object.$proto` (field 0) after the §10.1.2.1 OrdinarySetPrototypeOf
  checks (non-extensible target ⇒ refuse-or-throw; cycle check by walking
  the candidate proto chain for identity with the target). GC/host keeps the
  existing host path. Independent of the dispatch slices.

## Edge cases (must handle)

- **Null/undefined receiver** in `obj.m()` ⇒ TypeError before method
  lookup (§7.3.14; the host shim's "Cannot read properties of null"). In
  standalone, conflate undefined≡null (`ref.is_null`), as elsewhere in the
  runtime.
- **Method value present but not callable** ⇒ TypeError "`m` is not a
  function" (don't `call_ref` a non-`$Closure`).
- **Accessor getter throws / setter throws** ⇒ propagate (it's a `call_ref`
  into user code; exceptions flow through the existing try/throw machinery —
  no special handling).
- **Getter-only property written / setter-only read** ⇒ §10.1.5.1: read of
  setter-only returns undefined; write of getter-only is sloppy no-op.
- **Prototype chain walk for method resolution** reuses `__extern_get`'s
  existing proto walk — accessor-aware after Slice 5.
- **`setPrototypeOf` cycle** (`o.__proto__ = o` transitively) ⇒
  OrdinarySetPrototypeOf returns false / refuse-loud; never build a cyclic
  `$proto` chain (a later proto walk would infinite-loop).
- **`setPrototypeOf` on non-extensible** target with a *different* proto ⇒
  false/refuse (§10.1.2.1 step 4).
- **Proxy interaction:** out of scope — Proxy already refuses in standalone
  (#1472 Phase C, new-super.ts / calls.ts). The dispatch layer never sees a
  Proxy because construction refused upstream. Do not add Proxy handling.
- **Symbol-keyed methods** (`obj[Symbol.iterator]()`): the `$Object` runtime
  keys only string keys (consistent standalone approximation, per the
  Reflect.ownKeys note in #1472). Symbol-keyed dispatch stays refused-loud;
  well-known-symbol protocols (iterator) have their own native paths
  (#1320/#1665) — do not entangle.
- **Method reassignment** (`o.toString = fn`): naturally handled — the open
  `$Object` stores the reassigned function as an own prop, so `__extern_get`
  finds it before the proto chain. No special wrapper-reassignment scan
  needed on the open path (that scan is a JS-host-mode wrapper concern).

## Risks / coordination

- **R1 — call-site convergence with sd-1472c's in-flight slices.** #1472
  Phase C PRs #1194/#1195/#1196 (is-undefined / has-hasOwn / proto-ops) edit
  the same `OBJECT_RUNTIME_HELPER_NAMES` tail + `tests/issue-1472.test.ts`.
  Land this issue's slices *after* those merge, or expect a ~3-line helper-
  names merge per slice (test additions at distinct anchors). Mechanical;
  senior-dev resolves any `[CONFLICT]`.
- **R2 — fast-path leakage hides the win.** Many `obj.m()` sites are
  case (a) (statically classifiable) and *should* already be native. If
  Slice 0 isn't done first, Slice 2's tests may not exercise the new path
  (TS narrows a local `{}` to a closed struct — use computed keys + `any`
  function params to force the open path, exactly as S3 did). **Do Slice 0
  first.**
- **R3 — `$PropEntry` layout change (Slice 5) is the one non-additive
  change.** Adding two fields shifts nothing in funcMap (helpers are looked
  up by name) but every `struct.new $PropEntry` / `struct.get $PropEntry`
  site in `object-runtime.ts` must pass/skip the two new fields. Keep them
  **last** in the struct so existing field indices (0/1/2) are unchanged;
  `struct.new` must still supply all 5 operands (push two `ref.null` for the
  data path). Audit every `$PropEntry` constructor in the file. This is why
  Slice 5 is sequenced after the dispatch core — it touches shared
  read/write helpers and needs the S1–S3 regression gate green.
- **R4 — binary size of the built-in registry (Slice 6).** Demand-driven
  materialisation keeps it bounded, but a program that reads many built-in
  props pays per-prop. Acceptable: it's strictly better than refusing, and
  real standalone programs reference a small built-in surface.
- **R5 — `__call_fn_N` ceiling (arity 4).** `__apply_closure` refuses
  >4-arg dynamic calls loud. If test262 shows meaningful arity-5+ dynamic
  method traffic, raise the ceiling as a mechanical follow-up
  (`emitClosureCallExportN`). Not a blocker for the bulk.

## Conservative dual-mode invariant (restate)

- Every new behaviour is `ctx.standalone`-gated or lives inside
  `ensureObjectRuntime` (standalone-only). GC/host (`__extern_method_call`
  etc. host imports) is **byte-for-byte unchanged** — verify with the
  default-`gc` regression guards in `tests/issue-1472.test.ts`.
- Native helpers carry the **exact host name + signature** so call sites
  auto-route (no per-site `if (ctx.standalone)` except the genuinely
  call-site-shaped changes: Slice 0 fast-path re-routes, Slice 7
  setPrototypeOf).
- Any unsupported `(receiver kind, method)` / `(builtin, prop)` /
  arity pair ⇒ `Codegen error:`-prefixed hard fail (compiler.ts emits
  `success:false`, empty module). **Never** a null slot that traps or a
  leaked `env::*` import. This converts gaps into trackable compile errors,
  the #1472 posture.

## Acceptance criteria

- [ ] `--target standalone` emits zero `env::__extern_method_call`,
      `env::__proto_method_call`, `env::__get_builtin`,
      `env::__defineProperty_accessor` imports for the covered cases.
- [ ] `o.m(args)` on an open `any` object (user-stored method) runs under
      Node WasmGC / wasmtime with zero host imports (Slice 2).
- [ ] `Object.defineProperty(o, k, {get,set})` getter/setter invoked on
      read/write (Slice 5); data-descriptor tests stay green.
- [ ] `Object.setPrototypeOf` writes `$proto` standalone; cycle +
      non-extensible refused (Slice 7).
- [ ] No regression in default-`gc` mode (issue-1472 gc guards green).
- [ ] Unsupported pairs refuse-loud with a `#1888` cite; no leaked imports.

## Implementation pointers (file:line)

- Routing: `src/codegen/expressions/late-imports.ts` —
  `OBJECT_RUNTIME_HELPER_NAMES` check (L308) runs *before*
  `refuseStandaloneObjectImport` (L317); add new helper names to the set so
  they route native instead of refusing.
- Runtime types/helpers: `src/codegen/object-runtime.ts` —
  `ensureObjectRuntime` (L114), `$PropEntry` (L126), `$Object` (L145),
  `FLAG_*` (L68), `OBJ_FLAG_*` (L82), `OBJECT_RUNTIME_HELPER_NAMES` (L2042),
  `ensureObjVecBuilders`, `__extern_get`/`__extern_set` accessor hook
  points.
- Closure invocation precedent: `src/codegen/index.ts` —
  `emitClosureCallExport{,1,2,3,4}` (L2316+), `closureInfoByTypeIdx`,
  `$call_fn_N` func types. `__apply_closure` bridges to these.
- Open-object method-dispatch call sites (where the host shim is requested
  today): `src/codegen/expressions/calls.ts` L1072 (wrapper-reassign),
  L7321–7405 (generic `obj.m()` + `__get_builtin` receiver),
  `src/codegen/expressions/new-super.ts` L150/L187 (super.method),
  `src/codegen/property-access.ts` L1452 (`Builtin.prop` read).
- `setPrototypeOf` stub: `src/codegen/expressions/calls.ts` ~L3857.
- Brand-arm element read shared with #6407 receiver-element-retrieval spec.
