---
id: 1599
title: "host-indep: JSON.parse / JSON.stringify in standalone mode"
status: done
created: 2026-05-24
updated: 2026-05-24
priority: medium
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, runtime
language_feature: json
goal: standalone-wasm
sprint: 55
related: [1474, 1539]
---
# #1599 — JSON standalone: refuse-and-document then pure-Wasm implementation

## Problem

`JSON.stringify` and `JSON.parse` unconditionally register JS host imports with no
`ctx.standalone` guard (`src/codegen/declarations.ts:1065, 1069`):

```ts
addImport(ctx, "env", "JSON_stringify", { kind: "func", typeIdx }); // line 1065
addImport(ctx, "env", "JSON_parse",     { kind: "func", typeIdx }); // line 1069
```

Any standalone/WASI module that calls `JSON.parse(s)` or `JSON.stringify(v)` fails
at instantiation with `unknown import env::JSON_stringify`.

JSON is one of the most common serialization primitives in npm packages. Without it,
modules that do any serialization (config parsing, API responses, logging) cannot
run standalone.

## Phase 1 — Refuse-and-document (fast follow to #1474 pattern)

Gate the import registration on `!ctx.standalone`. Add a `reportError` at the
call site when `ctx.standalone`:

```ts
if (state.jsonNeedStringify) {
  if (ctx.standalone) {
    // deferred to Phase 2 — emit compile error
    // (reportError will be called at the actual JSON.stringify call site)
  } else {
    addImport(ctx, "env", "JSON_stringify", { kind: "func", typeIdx });
  }
}
```

At the call sites in `string-ops.ts` / `expressions/calls.ts` that lower
`JSON.stringify(...)` and `JSON.parse(...)`, add:

```ts
if (ctx.standalone) {
  reportError(ctx, expr,
    "JSON.stringify / JSON.parse is not supported in --target standalone (#1599). " +
    "Use a pure-JS serializer compiled with js2wasm, or avoid JSON in WASI targets.");
  return null;
}
```

Phase 1 is ~30 LOC, follows the exact same pattern as #1474 Phase 1.

## Phase 2 — Pure-Wasm JSON implementation

Implement JSON serialisation and deserialisation directly as Wasm helper emitters
operating on the existing WasmGC type graph. No C library, no side module, no
marshalling layer.

**Why not cJSON or a C side module**: cJSON returns a C struct tree, not WasmGC
types. stringify would need to walk the WasmGC value graph into C memory first;
parse would need to reconstruct WasmGC objects/arrays from the C struct output.
That marshalling layer is more code and more fragile than implementing the codec
directly against the types we already have.

### Serialiser (`JSON.stringify`) — `src/codegen/wasm-helpers/json-stringify.ts`

Recursive value walker over the WasmGC value graph:

- `null` / `undefined` → emit `"null"`
- `boolean` → emit `"true"` / `"false"` (tag check on externref)
- `number` (f64) → `__f64_to_string` (already exists); emit `"null"` for NaN/Infinity per spec
- `string` (`$StringArr`) → scan UTF-16 code units, escape `"`, `\`, and control chars U+0000–U+001F
- `array` (`$Array`) → `[` + iterate elements recursively + `]`
- `object` (`$PlainObject`) → `{` + iterate own enumerable string keys + `:`+ value + `}`
- Circular reference detection: thread a seen-set (linear scan over a local `(array ref)` — JSON depth is shallow in practice)
- `toJSON()` method: check for it via the existing property-lookup path before serialising

Result: accumulate into a `(array (mut i16))` builder, return as `$StringArr`.

### Deserialiser (`JSON.parse`) — `src/codegen/wasm-helpers/json-parse.ts`

Recursive-descent parser over a `$StringArr` (array i16, UTF-16). JSON grammar
has no lookahead beyond one character:

```
value    := null | true | false | number | string | array | object
string   := '"' chars '"'
array    := '[' (value (',' value)*)? ']'
object   := '{' (string ':' value (',' string ':' value)*)? '}'
number   := '-'? int frac? exp?
```

- Parser state: `(local $pos i32)` cursor into the string array
- `skipWhitespace`: advance past space/tab/CR/LF
- `parseString`: scan code units, handle `\uXXXX` and standard escapes, allocate `$StringArr`
- `parseNumber`: accumulate digits, call `__parse_f64` (or inline) → f64 → box as externref
- `parseArray`: allocate `$Array`, push parsed values
- `parseObject`: allocate `$PlainObject`, set key-value pairs via existing property-set helper
- Error: on malformed input, emit `unreachable` (Wasm trap in standalone; caller catches as SyntaxError in JS-host mode)

~350 LOC of helper emitters total across both files. No new WasmGC types needed.

## Files

### Phase 1
- `src/codegen/declarations.ts` lines 1065, 1069 — add `ctx.standalone` guard
- Call sites for `JSON.stringify` / `JSON.parse` in `src/codegen/expressions/calls.ts`
  — add `reportError` when `ctx.standalone`
- `tests/issue-1593-json-standalone-refuse.test.ts` — refusal tests

### Phase 2
- `src/codegen/wasm-helpers/json-stringify.ts` — serialiser helper emitter
- `src/codegen/wasm-helpers/json-parse.ts` — recursive-descent parser helper emitter
- `src/codegen/declarations.ts` — wire up helpers when `ctx.standalone && state.jsonNeed*`

## Acceptance criteria

### Phase 1
- `--target standalone` module using `JSON.parse` or `JSON.stringify` fails at
  compile time with a clear error referencing #1599.
- No `env::JSON_parse` or `env::JSON_stringify` in standalone output.

### Phase 2
- `JSON.stringify({a: 1, b: [2, 3]})` returns `'{"a":1,"b":[2,3]}'` in standalone.
- `JSON.parse('{"x":42}').x === 42` in standalone.
- Passes `test/built-ins/JSON/*` test262 subset under `--target standalone`.

## Effort

Phase 1: ~30 LOC, easy.
Phase 2: ~350 LOC (serialiser + parser helper emitters), hard. No external toolchain.

## Status — Phase 1 done (PR fix(#1599))

**Phase 1 (refuse-and-document) is implemented and merged.** Phase 2
(pure-Wasm codec) remains a follow-up.

### What landed
- `src/codegen/declarations.ts` — `env::JSON_stringify` / `env::JSON_parse`
  imports are now gated on `!(ctx.wasi || ctx.standalone)`. No JSON host import
  is registered in standalone / WASI output. (Both targets lack the JS host;
  the spec mentioned only `ctx.standalone`, but `--target wasi` has the same
  instantiation failure, so the guard covers both — matching the #1473 sibling
  precedent `ctx.wasi || ctx.standalone`.)
- `src/codegen/expressions/calls.ts` — at the `JSON.stringify` / `JSON.parse`
  call site, when `ctx.standalone || ctx.wasi` and the value is not handled by
  the pure-Wasm primitive slice (#1324), emit a `reportError` whose message
  starts with `Codegen error:` (required to flip `CompileResult.success` to
  `false` per `src/compiler.ts`) referencing #1599.
- `tests/issue-1599-json-standalone-refuse.test.ts` — 11 tests: refusal of
  object/array/string stringify + all parse (standalone AND wasi), no
  `env::JSON_*` import emitted, primitive `null`/`true` stringify still compiles
  standalone, and default JS-host mode unchanged.

### Acceptance criteria — Phase 1
- ✅ `--target standalone`/`wasi` module using non-primitive `JSON.stringify`
  or any `JSON.parse` fails at compile time with a clear `#1599` error + source
  location.
- ✅ No `env::JSON_parse` / `env::JSON_stringify` in standalone/wasi output.

### Notes for Phase 2 (follow-up — NOT in this PR)
- The primitive `JSON.stringify` slice (#1324) covers `null` / `undefined` /
  `boolean` standalone, but **`number` is NOT standalone-safe**: that slice
  lowers via `env::number_toString`, a host import absent in standalone/wasi.
  So `JSON.stringify(42)` is (correctly) refused with the #1599 message today.
  Phase 2 must add a pure-Wasm f64→string path (or reuse `__f64_to_string`) to
  unblock the number primitive standalone.
- Remaining Phase 2 scope unchanged from the spec above: pure-Wasm serialiser
  (`json-stringify.ts`) + recursive-descent parser (`json-parse.ts`) over the
  WasmGC value graph. Acceptance: `JSON.stringify({a:1,b:[2,3]})` →
  `'{"a":1,"b":[2,3]}'` and `JSON.parse('{"x":42}').x === 42` standalone.
