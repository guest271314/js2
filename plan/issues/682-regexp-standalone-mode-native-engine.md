---
id: 682
title: "RegExp standalone mode: native engine or embedded library for non-JS targets"
status: in-progress
owner: Raman
created: 2026-03-20
updated: 2026-06-01
priority: medium
feasibility: hard
reasoning_effort: max
goal: standalone-mode
sprint: 58
files:
  src/codegen/expressions.ts:
    new:
      - "standalone-mode RegExp lowering to a native engine or embedded regexp backend"
  src/codegen/regexp-standalone.ts:
    new:
      - "typed native standalone RegExp ABI scaffold and engine availability hook"
  src/codegen/context/types.ts:
    new:
      - "nullable CodegenContext.standaloneRegExpEngine hook"
  src/codegen/context/create-context.ts:
    new:
      - "initialize standaloneRegExpEngine to null while #1474 gate remains closed"
  tests/issue-682-regexp-standalone-abi.test.ts:
    new:
      - "pins closed gate and non-JS-host ABI shape"
---
# #682 — RegExp standalone mode: native engine or embedded library for non-JS targets

## Status: open

#676 proposed host imports for RegExp. That path is now partially implemented and
was pushed forward further by [#763](../done/763.md), which completed major
js-host-mode runtime gaps such as `exec`, `match`, `replace`, `split`, and
`search` wrappers.

This issue is now scoped only to **standalone mode**. The remaining host-mode
completion work is tracked separately in `#1002`.

In standalone mode (wasmtime/WASI/native strings), there is no JS `RegExp`
object to delegate to. We need an embedded regex backend.

## Evidence: real standalone test262 run 2026-06-01

Artifacts:
`benchmarks/results/test262-standalone-report-20260601-213702.json` and
`benchmarks/results/test262-standalone-results-20260601-213702.jsonl`.

Standalone result: 4,368 / 43,106 passing (10.1%) versus the canonical JS-host
baseline of 30,480 / 43,106 (70.7%). RegExp unsupported appears in 1,882
non-exclusive failures, confirming that a native RegExp backend is now a
material standalone test262 root cause rather than only a portability gap.

## Goal

Support `RegExp` for non-JS targets by embedding or compiling a regex engine
that works without a host JS runtime.

## Candidate approaches

### 1. Rust `regex` crate

- Official docs: [docs.rs/regex](https://docs.rs/crate/regex/latest)
- Strength: linear-time finite-automata engine, good portability, Rust/Wasm-friendly
- Limitation: explicitly does **not** support look-around or backreferences

This is a strong candidate only for a deliberately reduced standalone subset.

### 2. Rust `fancy-regex`

- Official docs: [docs.rs/fancy-regex](https://docs.rs/fancy-regex/)
- Strength: supports backreferences and look-around, while delegating simpler
  cases to `regex`
- Limitation: falls back to backtracking for “fancy” features, so worst-case
  runtime can still blow up

This is the best Rust-native candidate if we want broader JS-style feature
coverage without writing an engine from scratch.

### 3. Google RE2 / RE2-Wasm

- Official repo: [google/re2](https://github.com/google/re2)
- Wasm build: [google/re2-wasm](https://github.com/google/re2-wasm)
- Strength: fast and safe, good standalone portability
- Limitation: no backreferences or look-around by design

Good for a safe subset, not for near-ECMAScript parity.

### 4. PCRE2

- Official repo: [PCRE2Project/pcre2](https://github.com/PCRE2Project/pcre2)
- Docs: [PCRE2 manual](https://pcre2project.github.io/pcre2/doc/pcre2/)
- Strength: mature C library, wide feature support, ECMAScript-compatibility
  options, portable, embeddable
- Limitation: bigger integration surface; backtracking engine has the usual
  worst-case behavior tradeoffs

This is a serious candidate if broad syntax coverage matters more than minimal
engine size.

### 5. QuickJS `libregexp`

- Official docs: [QuickJS](https://bellard.org/quickjs/)
- Strength: includes a small regexp library described by QuickJS as fully
  compliant with the JavaScript ES2023 regexp specification
- Limitation: integration may mean extracting/adapting QuickJS’s regexp
  subsystem rather than consuming a clean standalone package

This is the highest-potential candidate for semantic alignment with JS
RegExp if the library can be cleanly isolated.

### 6. Oniguruma

- Official repo: [kkos/oniguruma](https://github.com/kkos/oniguruma)
- Strength: very feature-rich and battle-tested
- Limitation: the upstream repository was archived in April 2025

This is still technically viable, but the archival state makes it a weaker
long-term dependency than PCRE2 or a maintained Rust option.

### Phased approach

1. Decide whether standalone mode aims for:
   - a safe subset (`regex` / `RE2`)
   - or near-JS parity (`fancy-regex`, PCRE2, QuickJS libregexp)
2. Build a thin standalone RegExp ABI:
   - compile pattern
   - execute/test
   - capture groups
   - flags / `lastIndex`
3. Start with literal/class/quantifier/anchor coverage if we go custom
4. Prefer embedding an existing maintained engine over writing a full new one
   from scratch unless integration cost proves unacceptable

## ECMAScript spec reference

- [§22.2 RegExp Objects](https://tc39.es/ecma262/#sec-regexp-regular-expression-objects) — RegExp constructor and prototype
- [§22.2.2 The RegExp Constructor](https://tc39.es/ecma262/#sec-regexp-constructor) — pattern compilation semantics
- [§22.2.7.1 RegExpExec](https://tc39.es/ecma262/#sec-regexpexec) — abstract operation for executing a regexp


## Acceptance criteria

- standalone targets can execute basic `RegExp` operations without JS host imports
- the chosen backend and its semantic limitations are documented
- if a subset engine is chosen, unsupported features fail explicitly instead of
  silently diverging from JS semantics

## Complexity

XL for near-JS parity, M only if we intentionally adopt a reduced-feature
standalone subset.

## Implementation Plan

(Author: architect, 2026-05-21. Recommendation: phased approach
starting with **QuickJS libregexp** (option 5) extracted as a C
file compiled to wasm via wasi-sdk; QuickJS libregexp is the only
candidate with explicit JS-spec semantics.)

### Implementation note — 2026-06-01 first mergeable slice

Added an implementation-neutral scaffold in `src/codegen/regexp-standalone.ts`
and threaded `CodegenContext.standaloneRegExpEngine` as a nullable hook
initialized to `null`. This deliberately keeps #1474's standalone refusal gate
closed while establishing the future native-engine contract:

- selected engine kind: `quickjs-libregexp`
- ABI version: `1`
- in-module native symbols only, not JS-host imports:
  `__re_compile`, `__re_exec`, `__re_free`, `__re_group_start`,
  `__re_group_end`
- pointer/handle ABI shape pinned as `i32` values for the first slice

The scaffold does not implement RegExp semantics yet and does not alter the
current `RegExp` constructor, literal, or `String.prototype` RegExp-argument
refusals. Next slice can link/register the embedded engine and then open the
#1474 gate by querying `hasStandaloneRegExpEngine(...)`.

Validation for this slice:

- `pnpm exec prettier --write src/codegen/regexp-standalone.ts src/codegen/context/types.ts src/codegen/context/create-context.ts tests/issue-682-regexp-standalone-abi.test.ts`
  - result: passed
- `pnpm run typecheck`
  - result: passed
- `pnpm exec vitest run tests/issue-682-regexp-standalone-abi.test.ts tests/issue-1474-standalone-regex-refuse.test.ts`
  - result: passed, 2 files / 18 tests

Full test262 was not run; this was intentionally limited to scoped checks.

### Phase 0 — Decision and ABI

Pick QuickJS libregexp. Rationale:
- explicit ECMAScript ES2023 semantics
- ~3000 LOC, manageable extract surface
- no backtracking blowup for non-fancy patterns (NFA-based)
- already licensed compatibly (MIT)

Define ABI in `src/codegen/builtins/regexp-standalone.ts`:
```ts
// Wasm functions exported by the embedded engine:
//   __re_compile(pattern_ptr, pattern_len, flags) -> handle (i32)
//   __re_exec(handle, str_ptr, str_len, startIdx) -> match_struct_ref
//   __re_free(handle) -> void
//   __re_get_group(match, idx) -> {start: i32, end: i32}
```

### Phase 1 — Engine integration

1. Extract QuickJS `libregexp.c` and dependencies into a new
   `vendor/libregexp/` directory.
2. Add a build step: compile with `wasi-sdk clang` to produce a
   wasm module `libregexp.wasm`.
3. Link strategy: either (a) statically embed at compile time via
   `wasmMerge` (binaryen), or (b) instantiate as a side-module at
   runtime and import its exports. Prefer (a) for single-binary
   output.
4. Convert JS strings → libregexp `JSString` representation at the
   ABI boundary (UTF-16 native strings already match libregexp's
   internal repr).

### Phase 2 — Codegen lowering

In `src/codegen/builtins/regexp-standalone.ts`:
1. `new RegExp(pattern, flags)`:
   - Allocate `$RegExp_struct` (existing).
   - Call `__re_compile`, store the handle in `$compiled` field.
   - Store source pattern + flags for `.source` / `.flags` accessors.
2. `re.exec(s)`:
   - Call `__re_exec(handle, s, lastIndex)`.
   - Build match-array struct from the returned struct.
3. `re.test(s)`: exec, check null/non-null.
4. `s.match(re)`, `s.replace(re, ...)`, etc.: route through
   exec + result processing. Reuse logic from JS-host implementation;
   only the underlying exec changes.

### Edge cases

- **Sticky `y` flag** — engine state mutated; ensure `lastIndex`
  updates per spec.
- **Unicode `u` flag** — libregexp supports this; pass through.
- **`v` flag** (ES2024) — libregexp supports it; pass through.
- **Backreferences** — libregexp supports.
- **Look-behind** — supported.
- **Named capture groups** — supported via `(?<name>...)`.
- **Compile errors** — propagate as `SyntaxError`.
- **Memory ownership** — wasm-side `$RegExp_struct` holds the
  libregexp handle; on GC, finalizer (or explicit dispose) calls
  `__re_free`. WasmGC currently lacks finalizers — use a sidecar
  cleanup registry or live with the small leak.
- **String mutability** — libregexp expects immutable input strings;
  pass copies if the source is a mutable buffer.

### Phase 3 — Test262 conformance

- `test/built-ins/RegExp/*` — target ≥85% pass in standalone mode.
- `test/built-ins/String/prototype/{match,replace,replaceAll,search,split}/*`
  via #1105 Tier 2.

### Dependencies

- **#1105 Tier 2** — depends on this; coordinate ABI.
- **#1539** — alternative: port `regress` (Rust). Architectural
  choice; pick one.
- **#1101 WeakRef** — finalizer story shared.

### Risks

- **Engine maintenance**: forking libregexp ties us to QuickJS
  upstream. Plan: keep a thin compatibility shim, follow upstream
  bugfixes manually.
- **Binary size**: +50-80KB for the engine. Acceptable for a
  standalone wasm; consider lazy-loading for browser targets.
- **Memory leak**: without WasmGC finalizers, RegExp objects leak
  their compiled state until process exit. Use a manual `dispose()`
  API for long-running programs.
