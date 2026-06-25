---
id: 2678
title: "Date.parse / new Date(str) are NaN stubs in HOST mode — native parser is standalone/WASI-only (needs js-string externref support)"
status: done
completed: 2026-06-26
assignee: ttraenkler/dev-conformance
created: 2026-06-25
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, runtime
es_edition: multi
language_feature: date, strings, dual-mode
goal: spec-completeness
related: [2164, 2671]
sprint: 66
---

# #2678 — `Date.parse` / `new Date(str)` are NaN stubs in host mode

Carved from #2671 (ES2015 Date residuals). The native string-date parser
(`__date_parse`, #2164) exists and **works** — but only on the **standalone /
WASI** targets. In **JS-host mode** (the test262 runner default) `Date.parse(str)`
and `new Date(str)` are still **NaN stubs**.

## Evidence (current main)

- `Date.parse("2000-01-01T00:00:00.000Z")` →
  - **standalone:** `946684800000` ✅ (native `__date_parse` works)
  - **host (default):** `NaN` ❌
- `new Date("1970-01-01T00:00:00.000Z").getTime()` → host: `NaN`.

## Root cause

`src/codegen/expressions/calls.ts:8443-8451` (`Date.parse`) and the matching
`new Date(str)` arm in `src/codegen/expressions/new-super.ts:~3084` **gate the
native parser to `ctx.standalone || ctx.wasi`** and emit a `f64.const NaN` stub
otherwise. Two reasons it was gated off for host:

1. **Late-import index-shift (#2043):** wiring `__date_parse` lazily mid-body in
   host mode trips the "heap type index out of range" class. The fix the comment
   itself suggests: register `__date_parse` **up-front** (like `parseInt` /
   `collectParseImports` in `index.ts`) via a source scan, so its funcidx is
   stable before the body compiles.
2. **String representation mismatch (the real dual-mode work):**
   `emitNativeDateParse` (`date-parse-native.ts:53`) calls
   `ensureNativeStringHelpers` + `__str_flatten` and scans a WasmGC **i16**
   `$NativeString`. In host mode strings are **`wasm:js-string` externrefs**, not
   native i16 arrays — the parser has no i16 buffer to scan. So host wiring needs
   EITHER (a) convert the js-string externref to a native string first (a
   host→native string bridge, then reuse the existing parser), OR (b) a
   js-string char-access parse path (charCodeAt via the wasm:js-string import).

## Fix direction

1. Up-front register `__date_parse` for host mode (source scan for `Date.parse(…)`
   / `new Date(<string-typed>)`), mirroring `collectParseImports`.
2. Bridge the js-string receiver into the native parser — simplest: a host
   `__js_string_to_native` (or reuse an existing js-string→NativeString helper)
   so `__date_parse` gets the i16 buffer it expects; then drop the
   `standalone||wasi` gate at calls.ts:8443 / new-super.ts.
3. Keep standalone path byte-identical (it already flattens native strings).

## Acceptance

- Host-mode `Date.parse("2000-01-01T00:00:00.000Z")` === 946684800000 and the
  ISO/RFC2822 forms the standalone parser already handles.
- `new Date(str).getTime()` matches in host mode.
- Standalone/WASI unchanged. No late-import-shift validation error (#2043).
- The `built-ins/Date/parse` + `Date(str)`-construction test262 cluster flips
  toward pass in the (host-mode) runner.

## Notes

- This is the bigger of the two #2671 Date gaps; `getYear` (Annex B §B.2.4, the
  other gap) was a quick win done separately under #2671.
- Dual-mode rule: host-mode wiring must not disturb the standalone native path.


## Resolution (2026-06-26)

Fixed via a dual-mode HOST fast-path. `Date.parse(...)` and `new Date(<string>)`
in host mode now delegate to the JS `Date.parse` through a new host import
`__date_parse_host(externref) -> f64` (runtime.ts), registered **up-front** by a
new `collectDateParseHostImports` scan in `declarations.ts` (state flag
`dateParseHostNeeded`, scan + finalize) so the funcidx is stable and the #2043
late-import shift the gate comment cited is avoided. The two call sites
(`calls.ts` Date.parse, `new-super.ts` new Date(str)) gained a host branch ahead
of the old NaN stub. Host strings are real `wasm:js-string` externrefs and the JS
`Date.parse` is more format-complete than the native ISO parser.

**Standalone/WASI unchanged** — the scan only sets the flag in host mode, so the
native `__date_parse` (#2164) stays the only path there; verified no
`__date_parse_host` import leaks into a `target: standalone`/`wasi` module. The
host-only import is not in the strict allowlist (no #1524 budget growth).

Guarded by `tests/issue-2678.test.ts` (9 cases: ISO + date-only parse, variable
arg, invalid→NaN, no-arg→NaN, new Date(str), numeric construction unaffected,
Invalid Date). The issue-2164 standalone Date suite stays green.
