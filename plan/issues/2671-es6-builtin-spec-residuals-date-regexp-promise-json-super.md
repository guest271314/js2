---
id: 2671
title: "ES2015 builtin/feature spec residuals: Date, RegExp, Promise, JSON, super (~400 fails — tracking, slice per area)"
status: ready
created: 2026-06-25
updated: 2026-06-25
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 2015
language_feature: builtins, regexp, promise, date, json, super
goal: spec-completeness
related: [1343, 1440, 1444, 1439, 1465, 1368, 1551, 1342]
sprint: 66
---
# #2671 — ES2015 builtin/feature spec residuals (Date / RegExp / Promise / JSON / super)

## Edition / impact

- **Edition:** ES2015.
- **Fail count (residual after the canonical done issues):**
  - `built-ins/Date` — **104** (residual of #1343, #1440)
  - `built-ins/RegExp` — **95** (residual of #1444, #1439, Symbol.* protocol)
  - `built-ins/Promise` — **76** (residual of #1465, #1368)
  - `built-ins/JSON` — **44** (#1342 was wont-fix; reviver/replacer descriptor edges)
  - `language/expressions/super` — **68** (residual; #1551 ready covers eval order)
- **Tracking issue.** The canonical per-feature issues are all `done`; these are
  the long tails. This bundles them so the lead can slice one area at a time
  rather than leave the residuals un-issued. Lower priority than the structural
  clusters (#2666–#2670) — these are narrower, more scattered edge cases.

## Sub-area notes & sample failures

### Date (104)
Missing/incomplete `toISOString` (`toISOString is not a function`),
`set*`-with-`ToNumber`-coercion side-effect ordering, `proto-from-ctor-realm-*`,
annexB `getYear`/`setYear` + not-a-constructor checks.
```
built-ins/Date/prototype/toISOString/15.9.5.43-0-11.js
built-ins/Date/prototype/setSeconds/arg-ms-to-number.js
annexB/built-ins/Date/prototype/getYear/not-a-constructor.js
```

**Progress (dev-2046, 2026-06-25):**
- ✅ **`getYear` (Annex B §B.2.4)** — was MISSING entirely (returned
  undefined/null; `setYear` existed but not the getter). Added to `DATE_METHODS`
  / `DATE_PROTO_METHODS` + a `getFullYear()-1900` codegen arm (NaN-guarded).
  `annexB/.../getYear/` test262: 6/7 pass (the 1 fail is `not-a-constructor.js`,
  the general #930-family "method is not a constructor" gap shared by ALL Date
  methods — not getYear-specific). `tests/issue-2671-getyear.test.ts` 6/6.
- 📋 **`Date.parse` / `new Date(str)` NaN in HOST mode** — carved to **#2678**.
  The native parser (`__date_parse`, #2164) works but is gated standalone/WASI-
  only; host wiring needs js-string-externref support (dual-mode change), too big
  to fold into the `getYear` quick win.
- ⏳ Remaining Date: `set*` ToNumber-coercion side-effect ordering,
  `proto-from-ctor-realm-*`, not-a-constructor (#930-family).

### RegExp (95)
`Symbol.split` / `Symbol.match` / `Symbol.replace` / `Symbol.search` protocol
edge cases: `lastIndex` get/coerce errors, species constructor validation,
`exec` lastIndex access ordering, ToPrimitive on species ctor.
```
built-ins/RegExp/prototype/Symbol.split/str-get-lastindex-err.js
built-ins/RegExp/prototype/Symbol.split/species-ctor-ctor-non-obj.js
built-ins/RegExp/prototype/exec/success-lastindex-access.js
```

### Promise (76)
resolve-element function attributes (extensible/own-props), invoke-resolve
error-close paths, race/all resolver-element edge cases, `then` spec asserts.
```
built-ins/Promise/all/resolve-element-function-extensible.js
built-ins/Promise/all/invoke-resolve-error-close.js
built-ins/Promise/prototype/then/S25.4.5.3_A1.1_T2.js
```

### JSON (44)
reviver/replacer with non-configurable / define-prop-err properties
(`Object.defineProperty called on non-object` — ties to #2668), replacer
wrong-type handling, function values.
```
built-ins/JSON/parse/reviver-array-non-configurable-prop-delete.js
built-ins/JSON/stringify/replacer-wrong-type.js
```

**Progress (agent-ae565d4893a5783d7, 2026-06-26): JSON.stringify array-replacer
PropertyList slice — SHIPPED.**

Verified-first against the fresh baseline jsonl (JSON area = **55** standalone
fails, not 44 — the gross count is higher than the residual estimate; the other
four areas measured Date 100 / RegExp 178 / Promise 145 / super 81). Reproduced
on current main with single-file processes through the real worker harness
(`setExports` wired — critical: without it the array-replacer branch is silently
disabled and *every* replacer test mis-reports as a fail).

Three host-runtime (`src/runtime.ts`) bugs in the array-form replacer, all
fixed (JSON.stringify-scoped — `_liveGet` has 5 callers, all in the JSON
serialize/toJSON walk; `_normaliseJsonReplacer`/new `_buildJsonPropertyList`
feed only JSON.stringify):
- **Absent PropertyList keys emitted with a zero default** instead of dropped:
  the live walk read each key via `_liveGet`, which invoked a module-global
  `__sget_<key>` getter on a struct lacking that field — those return `0`/`null`,
  not `undefined`. `JSON.stringify({a:{b:2,c:3}}, ['c','b','a'])` produced
  `{"c":0,"b":0,"a":{"c":3,"b":2,"a":null}}`. Gated the getter on the canonical
  `_wasmStructHasOwn` own-property check (true for every real field, so present
  fields and accessor/getter own-props are unaffected).
- **No de-duplication** of the PropertyList (`['key','key']` kept both) — §25.5.2.1
  step 4.b.iv requires "append only if not already present".
- **String/Number wrapper-object elements** (`new String`/`new Number`) were
  ignored instead of ToString'd into keys.
- Fixed tests: `replacer-array-order`, `replacer-array-number-object`,
  `replacer-array-string-object` (fail→pass; `tests/issue-2671-json-replacer.test.ts`
  8/8). 25 currently-passing JSON tests spot-checked — no regression.
- ⏳ Remaining JSON: `replacer-array-duplicates`/`-undefined`/`-empty` (getter
  side-effect counting + sparse/hole handling), reviver descriptor edges (ties to
  #2668), Proxy/BigInt/circular cases — separate root causes, not in this slice.

**Other areas — verified NOT independent of the deferred member-dispatch /
string substrate (do NOT pick these before the proto-read substrate lands):**
- **RegExp Symbol.split** (8, all "Cannot convert object to primitive value"):
  bottoms out in `Symbol.species` construction + dynamic `exec`/`lastIndex`
  dispatch on arbitrary objects.
- **RegExp dotAll** (~8): root cause is lone-surrogate string representation
  (`"\uD800"` literal reaches the host `length` import as `undefined`) — a deep,
  broad string-backend issue, high regression risk.
- **super** (81): prototype-chain member dispatch.
- **Date** (100): scattered singletons; the cleanest cluster (`A4` multi-arg
  ctor `PoisonedValueOf`, 7) needs object→f64 ToNumber on class instances.

### super (68)
super-property access on null-proto / computed key errors, `super(...spread)`
argument-list evaluation + getter side effects (eval order is #1551).
```
language/expressions/super/prop-dot-cls-null-proto.js
language/expressions/super/call-spread-err-sngl-err-expr-throws.js
```

## Acceptance criteria

- This is a **tracking issue**; ship by area. Per-area target: pass **≥ 50%** of
  that area's residual fails.
- When an area is taken on, either reopen the canonical issue (#1343/#1440 Date,
  #1444/#1439 RegExp, #1465/#1368 Promise, #1551 super) or spin a child issue;
  update this tracker.
- No regression in currently-passing tests for the touched area.

## Notes

- JSON reviver descriptor failures partially resolve once #2668 (defineProperty
  fidelity) lands — sequence JSON after #2668.
- Deprioritized relative to #2666–#2670; pick up after the structural clusters.
