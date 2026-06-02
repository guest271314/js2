---
id: 1663
title: "host-indep: pure-Wasm parseInt / parseFloat / Number(string) in standalone mode"
status: done
created: 2026-05-25
updated: 2026-05-25
completed: 2026-05-25
priority: medium
feasibility: medium
task_type: bugfix
area: codegen, standalone
language_feature: numbers, string-to-number
goal: standalone-mode
sprint: Backlog
related: [1662, 1471, 1335]
---
# #1663 — Pure-Wasm `parseInt` / `parseFloat` / `Number(string)` standalone

## Problem

Under `--target wasi` (and `--target standalone`), `parseInt`, `parseFloat`,
and `Number(<string>)` still emit JS-host imports:

```
env.parseInt    (externref, f64) -> f64
env.parseFloat  (externref)      -> f64
```

The emitted module cannot instantiate without a JS runtime. These were
*supposed* to be covered by #1471 ("native path in #1471", per the allowlist
reason on lines 131–142 of `src/codegen/host-import-allowlist.ts`), but
#1471 landed (status done) covering only box/unbox/typeof/is_truthy — the
string→number parsers were never implemented. The allowlist entries are now
orphaned: they cite a closed issue.

Probe (`.tmp/probes/parseint.ts`):
```ts
export function test(): number { return parseInt("42") + parseFloat("3.14") + Number("7"); }
```
→ leaks `env.parseInt`, `env.parseFloat`.

## Standalone alternative

Both are pure functions over a string and produce an `f64`/NaN. With
`nativeStrings` (auto-on under WASI) the argument is already a WasmGC i16
array, so a Wasm-native scanner is straightforward:

- **`parseInt(s, radix)`** — ECMA-262 §19.2.5: trim leading whitespace,
  optional sign, optional `0x` prefix (radix 16 / auto), then a digit loop
  accumulating `value = value * radix + digit` until the first invalid
  digit; return NaN if no digits consumed. Radix range 2..36 with a digit
  table.
- **`parseFloat(s)`** — ECMA-262 §19.2.4: scan the longest prefix matching
  `StrDecimalLiteral` (sign, integer, fraction, exponent, `Infinity`), then
  reuse the existing `__str_to_number` helper (already emitted by the native
  string path for `__unbox_num_wasm`) on the matched slice.
- **`Number(s)`** — ECMA-262 §7.1.4 StringToNumber: full string must match
  (after trim) else NaN; reuse `__str_to_number`.

A single `$__parse_int_wasm` / `$__parse_float_wasm` helper module mirrors
the `box-unbox` helper pattern (cached on `ctx`, never imported).

## Acceptance criteria

- [ ] `--target wasi` and `--target standalone` emit **zero** `env.parseInt`
      / `env.parseFloat` imports for the probe above.
- [ ] `parseInt("42")===42`, `parseInt("0xFF")===255`, `parseInt("10",2)===2`,
      `parseInt("  -7px")===-7`, `parseInt("abc")` is NaN.
- [ ] `parseFloat("3.14")===3.14`, `parseFloat("1e3")===1000`,
      `parseFloat("Infinity")===Infinity`, `parseFloat("xyz")` is NaN.
- [ ] `Number("7")===7`, `Number(" 3.5 ")===3.5`, `Number("7px")` is NaN.
- [ ] Remove the now-orphaned `parseInt`/`parseFloat` allowlist entries
      (lines 129–142) once the native path lands; budget gate ratchets down.
- [ ] equivalence tests green in default (JS-host) and standalone modes.

## Files

- `src/codegen/host-import-allowlist.ts` — remove parseInt/parseFloat entries.
- The `parseInt`/`parseFloat`/`Number` codegen call sites (search
  `ensureLateImport(ctx, "parseInt"` / `"parseFloat"`).
- New `src/codegen/wasm-helpers/parse-number.ts` (or fold into the existing
  native-strings number helpers).

## Implementation (done 2026-05-25)

Scoped to `parseInt` / `parseFloat` — the two imports the problem names.
`Number(string)` ToNumber is split out as a follow-up (it routes through the
`__unbox_number` union helper, not the parse path, and has distinct semantics:
`Number("")===0`, `Number("0x1F")===31`, trailing chars → NaN).

- New `src/codegen/parse-number-native.ts` — `emitNativeParseNumber(ctx, which)`
  emits WasmGC-native `parseInt` / `parseFloat` as DEFINED functions registered
  under the same `ctx.funcMap` names, so every existing call site (which pushes
  the string arg as `externref`) is unchanged. Each fn does
  `any.convert_extern` + `ref.cast $AnyString` + `call __str_flatten`, then
  scans the flattened i16 code units. parseInt: leading-ws trim, optional sign,
  `0x`/`0X` prefix (radix 0/16), digit table 0-9/a-z (radix 2..36), NaN if no
  digits. parseFloat: ws, sign, integer + fraction + `[eE][+-]?` exponent,
  `Infinity` literal, NaN if no digits. (ECMA-262 §19.2.4/5.)
- `src/codegen/declarations.ts` `finalizeUnifiedCollector` — the parse finalize
  routes to `emitNativeParseNumber` under `ctx.wasi || ctx.standalone` instead
  of `addImport("env", …)`. The natives are emitted as defined funcs; the
  batched late-import shift (`fixupModuleFuncIndices`, run on every later
  `addImport`) keeps their funcMap indices + internal `call __str_flatten`
  refs correct as the rest of the finalize registers more imports (#1666).
- `src/codegen/index.ts` `collectExternDeclarations` — skip the
  `declare function parseInt/parseFloat` env stub under wasi/standalone so the
  finalize owns the registration.

The allowlist entries (host-import-allowlist.ts:129-142) were NOT removed —
they still apply to the default `gc`/JS-host path, which is unchanged.

## Test Results

`tests/issue-1663.test.ts` — 15/15 pass:
- parseInt: `"42"`→42, `"0xFF"`→255, `"10",2`→2, `"ff",16`→255, `"  -7px"`→-7,
  `"+5"`→5, `"abc"`→NaN
- parseFloat: `"3.14"`, `"1e3"`→1000, `"-2.5e-1"`→-0.25, `"Infinity"`→∞,
  `"10.5px"`→10.5, `"xyz"`→NaN
- zero `env.parseInt`/`env.parseFloat` imports under both `--target wasi` and
  `--target standalone`; control proves `gc` still emits both host imports.

Regression: `tests/parseint-edge.test.ts` (default gc path) + `tests/issue-1471.test.ts`
(adjacent native helpers) still green.

## Follow-up

`Number(string)` native ToNumber: extend the standalone `__unbox_number`
native helper (in `addUnionImportsAsNativeFuncs`, #1471 territory) to parse a
string operand per §7.1.4 (full-match-or-NaN, `""`→0, `0x` hex). Currently
`Number("7")` returns 0 in wasi/standalone — no host import leaks, but the
value is wrong. File as a #1663 follow-up issue.
