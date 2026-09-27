---
id: 6713
title: "standalone: calling or constructing a builtin constructor carrier held as a dynamic value (RegExp, Error, TypeError) does not yield an instance (lodash `reIsNative`)"
status: ready
sprint: current
created: 2026-09-27
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6711, 6703, 4394, 6651]
---

# #6713 — dynamic `[[Call]]` / `[[Construct]]` of the standalone `RegExp` carrier

## Problem

lodash 4.18.1 npm-compat **standalone-dynamic** lane, after
[#6711](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6711-standalone-realm-ctors-seeded-without-eval-provider)
(realm object now carries `RegExp`):

```
runtime-error (phase: module-init): TypeError: Cannot read properties of undefined (reading 'test')
```

Inside `runInContext`, `RegExp` is the LOCAL `var RegExp = context.RegExp`
(an externref holding the `__builtin_ctor_RegExp` carrier), so

```js
var reIsNative = RegExp('^' + funcToString.call(hasOwnProperty)
  .replace(reRegExpChar, '\\$&')
  .replace(/hasOwnProperty|(function).*?(?=\\\()| for .+?(?=\\\])/g, '$1.*?') + '$');
```

goes through the dynamic-call bridge (`__apply_closure`), which has `[[Call]]`
arms for the `String`/`Number`/`Boolean`/`BigInt` carriers
(`src/codegen/builtin-ctor-callable.ts`, #4394) and for `Object`/`Array`, but
none for `RegExp`. The call answers a non-RegExp value, and the first
`getNative(context, 'DataView')` → `baseIsNative` → `pattern.test(…)` throws.

## Reduction (standalone, `runtimeEvalProvider: false`, 0 imports)

```js
var out = 0;
var R = globalThis.RegExp;
try { if (RegExp('^a+$').test('aa')) out += 1; } catch (e) { out += 100; }     // static: ok
try { if (new RegExp('^a+$').test('aa')) out += 2; } catch (e) { out += 200; } // static: ok
try { if (R('^a+$').test('aa')) out += 4; } catch (e) { out += 400; }          // TRAP: dereferencing a null pointer
try { if (new R('^a+$').test('aa')) out += 8; } catch (e) { out += 800; }      // throws (800)
try { if (R === RegExp) out += 16; } catch (e) {}                               // ok (identity holds)
try { var x = R('^a+$'); if (x instanceof RegExp) out += 32; } catch (e) {}    // TRAP
export function run() { return out; }
```

Each line measured alone on `c2601efa89` + #6711: lines 1, 2, 5 pass; line 4
answers 800; lines 3 and 6 trap with `dereferencing a null pointer` (uncatchable).
Node answers 63 for the whole program. Through a function-scoped alias
(`var RegExp = context.RegExp; RegExp('^a+$')`) the call returns a value whose
`typeof` is `"object"` but whose `.test(…)` throws.

## Direction

Add a `RegExp` arm to the carrier `[[Call]]` guard in `__apply_closure`
(identity `ref.eq` against `ctor:RegExp`, like #4394) that performs §22.2.4.1
with the runtime pattern compiler (`ensureDynamicStandaloneRegExpCompiler`,
already used by `new RegExp(dynamicString)`): string pattern → compile
`ToString(p)` with `flags === undefined ? "" : ToString(flags)`; a RegExp
pattern with undefined flags → return it (call spelling). Mirror it in the
dynamic `[[Construct]]` path so `new R(p)` builds a fresh RegExp. Check the
runtime compiler accepts lodash's `reIsNative` source (lazy `.*?`, escaped
`\(\) \{ \[native code\] \}`) — if it defers ("poisoned" simple compile), that
is the next link.

Same family, next in line for lodash: the `Error` / `TypeError` carriers held
as values (`var Error = context.Error`) also fail — `var E = globalThis.Error;
new E('x')` traps with `illegal cast` (uncatchable), and a lodash probe
`throw new Error('…')` placed inside `runInContext` rendered only as
`[object WebAssembly.Exception]`. A lodash probe after the `reIsNative`
definition confirmed `reIsNative == null || typeof reIsNative.test !=
'function'` holds at module init. Scope the fix as dynamic `[[Call]]` /
`[[Construct]]` for the builtin constructor carriers that lodash's
`runInContext` aliases (`RegExp`, `Error`, `TypeError`, `Date`, `String`,
`Object`, `Function`), RegExp first.

Separately observed (not a lodash blocker): `typeof Function.prototype` reads
`"object"` in standalone (spec: `"function"`), and
`Function.prototype.toString.call(Object.prototype.hasOwnProperty)` throws at
top level while the same call through a `context.Function` alias returns a
string.
