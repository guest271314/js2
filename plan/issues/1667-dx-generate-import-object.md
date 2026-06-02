---
id: 1667
title: "DX: compile() should return a ready-to-pass import object for default/JS-host mode"
status: done
created: 2026-05-25
updated: 2026-05-27
completed: 2026-05-27
priority: medium
feasibility: medium
task_type: feature
area: api/dx
language_feature: n/a
sprint: Backlog
github_issue: 601
filed_by: guest271314
related: [601, 1661, 1471]
---
## Motivation

From GitHub issue **#601** (guest271314). In default (JS-host) mode, the
compiled output requires host imports (`string_constants`, `env.__box_number`,
`env.__extern_*`, …), so

```js
const result = compile(src);
const { instance } = await WebAssembly.instantiate(result.binary, {}); // throws
// TypeError: WebAssembly.instantiate(): Import #0 "string_constants": module is not an object or function
```

fails. Today the user's only options are:

- compile with `target: "standalone"` / `"wasi"` (no imports — the portable,
  zero-import path), or
- hand-wire the host runtime themselves.

The **CLI already emits** the runtime as `<name>.imports.js`, but the
programmatic `compile()` API does **not** expose it. So a default-mode user of
the programmatic API has no easy way to instantiate the binary.

## Proposal

(The maintainer's framing.) `compile()` could **generate an import object that
the caller passes directly**. For example, the `CompileResult` exposes
`result.importObject` — a ready JS object wiring the runtime host functions
(`string_constants`, `env.__box_number`, `env.__extern_get`, …) — so that

```js
const r = compile(src);
const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
instance.exports.add(2, 3); // works out of the box in default mode
```

succeeds with no hand-wiring. Optionally add a convenience helper such as
`instantiate(result)`. This surfaces the existing `.imports.js` runtime through
the programmatic API.

## Note — host-imports-required stays the explicit default

Standalone / `wasi` mode is the zero-import path and remains the **recommended
default for portability**. This enhancement is the **opt-in convenience** for
the JS-host path, NOT a change to the default behavior. Keep
host-imports-required as the explicit default; add the generated import object
as a provided affordance.

## Acceptance criteria

- `const r = compile(src); await WebAssembly.instantiate(r.binary, r.importObject)`
  succeeds and the exports run, with no hand-wiring, in **default mode**.
- Documented in the README alongside the standalone option (ties to #1661).
- The standalone / zero-import path remains the recommended portable default
  (no regression to default behavior).

## Relation to #1661

Complementary, not duplicate:

- **#1661** (docs) — fixes the README programmatic-API example by documenting
  the standalone / zero-import option so the snippet genuinely runs under
  `instantiate(binary, {})`.
- **#1667** (this issue, feature) — adds the JS-host convenience: a generated
  import object the caller can pass directly, so default-mode output also
  instantiates without hand-wiring.

## Resolution

`CompileResult` now exposes `importObject` (`WebAssembly.Imports`), attached at
the public `compile` / `compileMulti` / `compileFiles` / `compileProject` entry
points in `src/index.ts` via `withImportObject`. It is a lazily-computed,
cached getter that wires the existing `buildImports()` runtime into
`{ env, "wasm:js-string", string_constants }` — the polyfill instantiation
shape. Standalone / `wasi` (zero-import) and failed compiles return `{}`, so
the field is always safe to pass to `WebAssembly.instantiate`.

The standalone / zero-import path stays the recommended portable default — this
is an opt-in convenience for the JS-host path only; default codegen is
unchanged. README "Compile modes and imports" documents the new affordance
alongside the standalone option. Tests in `tests/issue-1667.test.ts`.
