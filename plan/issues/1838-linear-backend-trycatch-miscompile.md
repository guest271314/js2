---
id: 1838
title: "Linear backend silently miscompiles try/catch (throw -> unreachable, catch dropped)"
status: ready
created: 2026-06-04
updated: 2026-06-04
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

