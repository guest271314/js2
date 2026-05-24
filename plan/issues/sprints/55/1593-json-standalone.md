---
id: 1593
sprint: 55
title: "host-indep: JSON.parse / JSON.stringify in standalone mode"
status: ready
created: 2026-05-24
priority: medium
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, runtime
language_feature: json
goal: standalone-wasm
related: [1474, 1539]
depends_on: []
---

# #1593 — JSON standalone: refuse-and-document then pure-Wasm implementation

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
    "JSON.stringify / JSON.parse is not supported in --target standalone (#1593). " +
    "Use a pure-JS serializer compiled with js2wasm, or avoid JSON in WASI targets.");
  return null;
}
```

Phase 1 is ~30 LOC, follows the exact same pattern as #1474 Phase 1.

## Phase 2 — Pure-Wasm JSON implementation

Implement JSON serialisation and deserialisation as pure Wasm (WasmGC).

### Option A: embed a small C JSON library (recommended)

[`jsmn`](https://github.com/zserge/jsmn) or [`cJSON`](https://github.com/DaveGamble/cJSON):
- `cJSON`: ~1,500 LOC C, MIT, handles full RFC 8259. Compile with `wasi-sdk clang -Os`
  → embed as side module via Binaryen `wasmMerge` (same pattern as #1539 / regress).
- Binary size: ~30–50 KB compiled Wasm. Only linked when `JSON.*` is used.

### Option B: implement in Wasm helpers (~medium effort)

Write a JSON serialiser/deserialiser directly as Wasm helper emitters:

**Serialiser** (`JSON.stringify`):
- `null`/`undefined` → `"null"`
- `boolean` → `"true"` / `"false"`
- `number` (f64) → use existing `__f64_to_string` helper
- `string` → escape control chars, wrap in `"`
- `array` → `[` + join elements with `,` + `]`
- `object` → `{` + `"key":value` pairs + `}`
- Circular reference detection via a seen-set (`$ExternMap`)

**Deserialiser** (`JSON.parse`):
- Recursive-descent parser over a WasmGC string (array i16)
- Returns `externref` (boxed JS value) for each JSON value type
- Validates UTF-16 input; throws `SyntaxError` (Wasm trap in standalone) on malformed input

### Recommended approach

Land Phase 1 (refuse) immediately as part of the host-independence series.
Phase 2 as a follow-up with Option A (cJSON side module) — lower implementation
risk, correct spec behaviour, small binary.

## Files

### Phase 1
- `src/codegen/declarations.ts` lines 1065, 1069 — add `ctx.standalone` guard
- Call sites for `JSON.stringify` / `JSON.parse` in `src/codegen/expressions/calls.ts`
  — add `reportError` when `ctx.standalone`
- `tests/issue-1593-json-standalone-refuse.test.ts` — refusal tests

### Phase 2
- `vendor/cjson.wasm` (Option A) + `src/codegen/json-link.ts` — side-module linker
- OR `src/codegen/wasm-helpers/json.ts` (Option B) — pure Wasm emitters

## Acceptance criteria

### Phase 1
- `--target standalone` module using `JSON.parse` or `JSON.stringify` fails at
  compile time with a clear error referencing #1593.
- No `env::JSON_parse` or `env::JSON_stringify` in standalone output.

### Phase 2
- `JSON.stringify({a: 1, b: [2, 3]})` returns `'{"a":1,"b":[2,3]}'` in standalone.
- `JSON.parse('{"x":42}').x === 42` in standalone.
- Passes `test/built-ins/JSON/*` test262 subset under `--target standalone`.

## Effort

Phase 1: ~30 LOC, easy.
Phase 2 (Option A): ~200 LOC (linker + ABI shims), medium. Rust/C toolchain for artifact.
Phase 2 (Option B): ~800 LOC (full recursive-descent parser + serialiser), hard.
