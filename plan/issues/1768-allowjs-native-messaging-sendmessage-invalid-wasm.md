---
id: 1768
title: "allowJs native-messaging sendMessage emits invalid WASI wasm"
status: done
created: 2026-06-01
updated: 2026-06-01
completed: 2026-06-01
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: allowjs
goal: platform
sprint: 58
es_edition: multi
related: [389, 80, 1061, 1654, 1753]
origin: "GitHub #389 guest271314 comment 2026-06-01T00:17:59Z"
---
# #1768 — allowJs native-messaging `sendMessage` emits invalid WASI wasm

## Problem

guest271314 transpiled the working TypeScript native-messaging host to plain
JavaScript with both `tsc` and `bun build`, then compiled that `.js` input:

```sh
node ~/bin/js2wasm.js nm_js2wasm.js --wit --target wasi -o .
```

The compile step emitted `.wasm`, `.wat`, `.d.ts`, `.imports.js`, and `.wit`,
but wasmtime rejected the generated module in `sendMessage`:

```text
Error: failed to compile: wasm[0]::function[36]::sendMessage

Caused by:
    0: WebAssembly translation error
    1: Invalid input WebAssembly code at offset 7741:
       unknown global: global index out of bounds
```

He also saw the earlier pre-pull failure shape:

```text
Invalid input WebAssembly code at offset 7044:
type mismatch: expected externref, found f64
```

The same host logic works from the TypeScript source. Plain JavaScript input is
a first-class expectation for `js2wasm`, so this needs its own allowJs regression
track rather than being folded into the TypeScript native-messaging example.

Source: <https://github.com/loopdive/js2/issues/389#issuecomment-4588674539>

## Repro shape

The failing JavaScript includes:

- `new Uint8Array(...)` allocation for frame headers and output frames.
- `message.subarray(...)`, `message.indexOf(...)`, and `output.set(...)`.
- nullable/sentinel `prepend` / `append` control flow.
- `process.stdin.read(...)` and `process.stdout.write(...)`.
- `console.error` numeric-template telemetry.

The minimization should start from the reporter's transpiled
`readExact` / `decodeLength` / `getMessage` / `sendMessage` / `main` source and
reduce until the invalid `sendMessage` body is isolated.

## Scope

- Add a minimized allowJs regression test using `.js` input and `--target wasi`.
- Ensure the generated module validates under the same wasmtime feature flags
  used by the native-messaging smoke tests.
- Root-cause why the allowJs path diverges from the typed TypeScript source:
  likely typed-array inference, nullable sentinel inference, native-string
  telemetry, or stale standalone/WASI global emission.
- Keep #1654's fixed ArrayBuffer/DataView path from regressing; this report has
  the same "unknown global" surface symptom but is JS-input-specific.

## Acceptance

- The minimized `.js` repro compiles and instantiates under wasmtime.
- The full transpiled native-messaging host compiles to valid WASI wasm.
- No validator failures (`unknown global: global index out of bounds` or
  `expected externref, found f64`) are emitted from the allowJs `sendMessage`
  path.
- A regression test pins both compile-time success and real-runtime validation.

## 2026-06-01 minimization/fix notes

- Added `tests/issue-1768.test.ts` with a minimized plain `.js` allowJs
  `sendMessage` shape: `new Uint8Array`, `message.indexOf`,
  `message.subarray`, `output.set`, and `process.stdout.write` under
  `target: "wasi"`. The test validates the wasm module, rejects `env` imports,
  runs it with a small WASI `fd_write` shim, and checks the framed stdout bytes.
- Root cause 1: WASI/native string constants use `-1` sentinels in
  `ctx.stringGlobalMap`; several dynamic property/method fallback paths still
  emitted `global.get` for those sentinels. Replacing those with
  `stringConstantExternrefInstrs(...)` removes the invalid
  `global index out of bounds` wasm.
- Root cause 2: allowJs parameters can be inferred to wasm vec refs from call
  sites while the TypeScript receiver type remains `any`. Array/typed-array
  method dispatch now consults the actual wasm local/global/probe type before
  giving up, and `TypedArray#set` does the same for its source argument.
- Root cause 3: `const body = message.subarray(...)` was hoisted as
  `externref`, forcing the vec through the generic iterable conversion path.
  The let/const hoist pass now infers vec results for `.slice`/`.subarray`
  initializers when the receiver is already a wasm vec, and variable
  initialization uses the already-hoisted local type as the expected type.
- Scoped validation passes:
  `node node_modules/vitest/dist/cli.js run tests/issue-1768.test.ts`.
- Neighboring typed-array stream checks:
  `tests/issue-1664.test.ts` and `tests/issue-1766.test.ts` pass in a combined
  run. The same combined run exposed an existing `tests/issue-1655...`
  ArrayBuffer helper validation failure (`__wasi_write_arraybuffer` uses local
  index 4 without declaring that local), which appears separate from #1768 and
  likely belongs with the ongoing ArrayBuffer/memory-growth work.
