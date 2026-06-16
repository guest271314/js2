---
id: 1838
title: "Linear backend silently miscompiles try/catch (throw -> unreachable, catch dropped)"
status: done
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
priority: medium
feasibility: medium
task_type: bugfix
area: codegen-linear
goal: correctness
sprint: 59
---
# #1838 — linear backend drops `try/catch`

## Symptom
In the linear/standalone backend, `try { throw e } catch (e) { handler }` traps
(via `unreachable`) instead of running the handler — silent divergence from JS, no
diagnostic.

## Location
`src/codegen-linear/index.ts:669-676` inlines the try body and discards the catch
clause; `:682-685` lowers `throw` to `unreachable`. The emitter supports EH
`try`/`catch`/`throw` (`src/emit/binary.ts:1095-1120`).

## Fix
Emit the EH `try`/`catch` instructions, or raise a compile error for `try/catch` in
standalone mode rather than silently miscompiling.

## Resolution
Took the safety option (raise a compile error) — full Wasm-EH lowering through
the linear backend is a larger feature deferred to a follow-up. In
`src/codegen-linear/index.ts`, the `try` statement handler now:
- **throws** a `try/catch is not yet supported by the linear/standalone
  backend …` Error when the statement has a `catchClause`. (Throws rather than
  `ctx.errors.push` because the linear backend's `ctx.errors` are NOT surfaced
  into the compile result — a push would still silently miscompile. The
  `compiler.ts` try/catch around `generateLinearM(ulti)Module` converts the
  thrown Error into a `Codegen error:` failed result with `success: false`.)
- **inlines `try { ... } finally { ... }`** (no `catchClause`) as before — there
  is no handler to drop, and the `finally` block always runs, so inlining both
  blocks is correct.

The bare `throw → unreachable` lowering is left as-is: a `throw` with no
enclosing handler traps, which matches the documented MVP limitation; the
critical defect was the **silently dropped catch handler**.

### Test Results
- `tests/issue-1838.test.ts` (4, all pass): try/catch → compile error (not a
  silent miscompile); try/catch/finally → compile error; try/finally → compiles
  and runs both blocks (`x === 6`); the default WasmGC backend (which has real
  EH) still compiles try/catch normally (scope guard).

