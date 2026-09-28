---
id: 6714
title: "standalone: `TextEncoder.encode` returns an f64 vec, but `Uint8Array` lowers to the packed-i8 vec — invalid Wasm when the result flows through a typed slot"
status: ready
sprint: current
created: 2026-09-27
updated: 2026-09-27
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [1032, 1752, 1780, 3150, 6699]
---

# #6714 — standalone `TextEncoder.encode` result representation mismatch (axios)

## What you will see

After [#6699](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6699-standalone-axios-globalthis-ensure-stack-underflow),
the npm-compat **axios** standalone-dynamic lane
(`npx tsx scripts/generate-npm-compat-report.mjs --only axios --no-write --perf-only --lane standalone-dynamic`,
measured 2026-09-27) stops at `optimization-error`; V8 names the function:

```
WebAssembly.Module(): Compiling function #2104:"__closure_392" failed: type error in fallthru[0] (expected (ref null 1010), got (ref null 4))
```

`__closure_392` is axios `lib/adapters/fetch.js`'s
`((encoder) => (str) => encoder.encode(str))(new TextEncoder())`.

## Minimal repro (standalone, `runtimeEvalProvider: false`)

```js
const enc = new TextEncoder();
const encodeText = (str) => enc.encode(str);
export function test() { return encodeText("abc").length; }
```

→ `__closure_0 failed: type error in fallthru[0] (expected (ref null 45), got (ref null 4))`.

## First reading

- `call-receiver-method.ts` lowers `TextEncoder#encode` to
  `__textencoder_encode` (`text-encoding-native.ts`), which returns
  `(ref null $__vec_f64)` — the pre-#3150 "Uint8Array" representation.
- The arrow's declared result is `resolveWasmType(Uint8Array)`, which is now the
  packed `i8_byte` vec (`getOrRegisterVecType(ctx, "i8_byte", { kind: "i8" })`,
  the backing `new Uint8Array` / `toHex` / `toBase64` use).
- `TextDecoder#decode` has the mirror problem (it expects the f64 vec).

Likely fix: make `__textencoder_encode` produce (and `__textdecoder_decode_u8`
consume) the `i8_byte` vec, so encode/decode agree with every other
`Uint8Array` producer; update #1780's `encodeInto` path if it shares the vec.
Not a one-line coercion at the call site: the two vec types have different
element storage.
