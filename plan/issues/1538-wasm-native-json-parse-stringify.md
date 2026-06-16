---
id: 1538
title: "Wasm-native JSON.parse and JSON.stringify (standalone, no host)"
status: ready
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: high
task_type: feature
area: runtime
language_feature: json
goal: standalone-wasm
sprint: 62
related: [1535, 1537]
---
# #1538 — Wasm-native JSON.parse / JSON.stringify

## Problem
`JSON_parse` and `JSON_stringify` are host imports that delegate to the JS engine. In WASI/standalone mode, applications that read JSON config or emit JSON results cannot do so without a JS runtime — yet JSON is one of the most common standalone use cases (edge functions, CLI tools, config parsing).

## Proposed solution
Implement a pure-Wasm JSON encoder and decoder operating on the existing `--nativeStrings` (i16 WasmGC array) and the union value representation.

- **Parser**: recursive-descent over the input string buffer; standard JSON grammar (RFC 8259). Output: a tagged union value (object → `Map`-style struct, array → WasmGC array, string → i16-array, number → f64, true/false/null → sentinels).
- **Stringifier**: walks the union value; emits to a growable i16-array buffer. Supports the `replacer` arg only for the function form (host-friendly subset) and indent arg.
- **Number formatting**: depends on #1537 (Ryū) for `Number → string` inside stringify.
- **String escapes**: `\u{...}`, `\\`, `\"`, control-char escapes per spec.

## Library/approach
Reference implementations to study (license-compatible):
- **jsmn** (MIT, ~1 KB, parser-only) — too minimal but useful as skeleton.
- **QuickJS** (MIT) — high-quality C reference for both parse and stringify.
- **Duktape** (MIT) — clean C reference.
Re-implement from spec; no FFI.

## Binary size impact
~15-20 KB Wasm: parser ~6 KB, stringifier ~8 KB, escape tables ~2 KB.

## Test262 impact (estimated)
- `built-ins/JSON/parse/*`: ~80 tests
- `built-ins/JSON/stringify/*`: ~120 tests
- Many feature tests use `JSON.stringify` as their oracle; fixing those raises secondary passes too.
- Estimate **+150-300 passes** in standalone mode.

## Implementation steps
1. Define a uniform "JS value" union representation (depends on #1540 if not already present, or use the current `externref`-or-typed pattern).
2. Add `src/codegen/json-helpers.ts` with `__json_parse`, `__json_stringify` Wasm functions.
3. Register them via `addImport`-equivalent for defined functions; remove `JSON_parse`/`JSON_stringify` host import calls in `src/codegen/index.ts:4772,4776`.
4. Provide a host-mode fallback for non-`nativeStrings` builds.
5. Test against test262 `built-ins/JSON/*`.

## Risk
The recursive parser is straightforward; the stringifier is harder because of `toJSON` invocation, replacer-function semantics, and cyclic-object detection (spec §25.5.2). Cyclic detection needs a side-set of "seen" object refs (~256-entry hash set, ~1 KB extra).

## Implementation Plan (architect, 2026-06-16)

### Host imports leaked today
`JSON_stringify` (`index.ts:8097`, `declarations.ts:1260`, allowlist `host-import-allowlist.ts:334`), `JSON_parse` (`index.ts:8103`, `declarations.ts:1266`, allowlist :340; #2013 added the reviver param).

### What already exists — build on it
- `$AnyValue` tagged union (`any-helpers.ts:22`): tags 0=null,1=undefined,2=i32,3=f64,4=bool,5=string,6=object/ref. This IS the JSON value model.
- `__json_quote_string` (`json-runtime.ts:66`, §25.5.4.3 QuoteJSONString, pure Wasm).
- `__json_parse_primitive` (`json-runtime.ts:423`, single primitive → `$AnyValue`).
- Compile-time literal folding (`json-standalone.ts`).
- Open-object runtime (`object-runtime.ts`): `$Object` with **insertion-ordered keys** maintained explicitly for JSON.stringify; `__obj_insert`/`__obj_find`/`__new_plain_object`.

Gap = the runtime object/array codec: parse text → `$Object`/array graphs; walk a graph → text. Primitives/quoting/literals done.

### Design — `src/codegen/json-codec.ts`, gated `ctx.wasi || ctx.standalone`
**Parser `__json_parse(text) -> ref $AnyValue`**: recursive-descent over flattened `$NativeString` units (reuse `__str_flatten` preamble). Worker `__json_parse_value(data, cursor-cell, end)` with a 1-field `struct (mut i32)` cursor ref-cell advancing across recursive calls. Productions: object→`__new_plain_object` + `__obj_insert` pairs (box tag 6); array→standalone array (box tag 6); string→unescape (`\"\\\/ bfnrt`, `\uXXXX` + surrogate pairs)→`$NativeString` (tag 5); number→reuse §21 scanner (tag 3); true/false/null→tags 4/4/0. Malformed→`throw new SyntaxError` via `$Error_struct`+`throw $tag` (#1536), NOT `unreachable` (§25.5.1). Reviver (§25.5.1 InternalizeJSONProperty, #2013): bottom-up walk; **defer to Phase B** (gate `JSON.parse(s,reviver)` to host path in JS-host mode, document standalone gap).

**Stringifier `__json_stringify(value, indent) -> externref`** (§25.5.2 SerializeJSONProperty): recursive dispatch on tag — null→"null"; bool→"true"/"false"; undefined/function→omit (array→"null", object→skip key); number→`number_toString`/Ryū (**depends #1537**), non-finite→"null"; string→`__json_quote_string`; tag6→`ref.test` array vs `$Object`: array→`[...]`, object→`{...}` in insertion order. Support numeric (1-10) + string `space` indent (`\n`+indent*depth, `": "` after keys). `toJSON`/`replacer`→Phase B. **Cycle detection** (§25.5.2 step 1): `seen` set `(array (mut (ref null eq)))` checked by `ref.eq`, push on descent/pop on ascent; re-entry→`throw new TypeError("Converting circular structure to JSON")` (#1536).

### Call-site wiring
- `calls.ts` `tryEmitJsonParsePrimitive` (~514): under standalone stop bailing on object/array consumption → route to `__json_parse`; keep primitive fast path.
- `calls.ts` JSON.stringify dispatch (~473-492): extend beyond string-only to call `__json_stringify` for object/array/`$AnyValue` with resolved space/indent.
- `index.ts` needStringify/needParse (~8087-8104): under standalone emit native `emitJsonCodec(ctx)` instead of `addImport(JSON_parse/JSON_stringify)`; keep host imports for JS-host.

### Edge cases
NaN/Inf→"null", `-0`→"0"; deep nesting (~1000 levels, document cap if traps); circular→TypeError; surrogate pair→astral; empty `{}`/`[]`/`""`; duplicate keys→last wins; whitespace; undefined/function top-level→undefined, array elem→"null", object value→key omitted; `1e21`→"1e+21" (#1537); `JSON.parse("")`/malformed→SyntaxError throw.

### Scoping & dependency
All gated `ctx.wasi || ctx.standalone`; JS-host keeps imports. **Depends on #1537** for number→string inside stringify (disjoint files: #1537 number-ryu.ts, #1538 json-codec.ts — no conflict; sequence #1537 first or accept interim non-round-tripping numbers). No new host imports.

### test262 gate & phasing
`built-ins/JSON/parse/` (~80), `built-ins/JSON/stringify/` (~120) standalone; reviver/replacer/toJSON tests gated to Phase B if deferred. `tests/issue-1538.test.ts` `{target:"standalone",testRuntime:true}`: round-trip deep-equal, circular→throws, escapes, indent `=== JSON.stringify(x,null,2)`. Est. +150-300 passes. **Phase A** = parse(objects/arrays/strings/escapes, no reviver) + stringify(value types, indent, cycle detection); **Phase B** = reviver/replacer/toJSON. Ship A first.
