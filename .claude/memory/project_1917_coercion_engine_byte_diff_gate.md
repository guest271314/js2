---
name: project_1917_coercion_engine_byte_diff_gate
metadata: 
  node_type: memory
  type: project
  originSessionId: 54c1df0f-04d4-4026-b675-77fe695fb95c
---

#1917 "one coercion engine" is a PHASED, behavior-neutral consolidation (emitToString #1960 landed → emitToNumber #1962 → emitToBoolean #1963 → emitToPrimitive → equality LAST). Two reusable techniques proven on this series (branch `issue-1917-emit-*`, agent sdev-coercion-impl-2):

**Both-lane neutrality proof (the gate the user/lead require):** for a pure code-motion refactor, capture a baseline on a DETACHED origin/main worktree, run the SAME probe on the branch, diff. Two probe styles:
- test262 status probe: `runTest262File(f, cat, 30000, lane==="standalone"?"standalone":undefined)` reading `r.status` (NOT `.outcome`), control file (charAt) first, on BOTH host gc-lane AND `--target standalone`. Wrap each call in try/catch (one exotic exception in `extractWasmExceptionMessage` aborts the whole run otherwise).
- Wasm-byte diff: compile the `website/playground/examples` corpus (13 files) + inline ToPrimitive programs on both lanes, SHA-256 `compile(src,{target:"standalone"?}).binary`. Byte-identical ⟹ zero behavior change (strongest neutrality proof). `.tmp/diff-neutrality.mts`.

**emitToPrimitive cycle constraint (Stage A landed, byte-neutral):** coercion-engine.ts already imports `coerceType`+`tryStructToString` FROM type-coercion.ts, so moving ToPrimitive host helpers INTO the engine would cycle. Sanctioned fix = the `shared.ts` lazy-delegate idiom (`registerCoerceType` at shared.ts:299): keep helper bodies in type-coercion, register via a new `shared.ts` `registerToPrimitiveHostCall`, engine calls the leaf delegate. NOTE the #2108 `check-coercion-sites.mjs` gate matches the literal token `__to_primitive` even in COMMENTS — don't write it in new plumbing comments.

**Stage B (remaining, high-risk):** fold coerceType's ~380-line ref→f64 ToPrimitive dispatch region (`type-coercion.ts` ~:1781-2160) behind an `emitToPrimitive` façade keeping its ~100 callers untouched. **Equality step is LAST** — wraps task-#32's `tag5StringEqThen` classifier (on main) + reuses emitToNumber, so it BLOCKS ON #1962 landing. Deferred increments stay deferred (native-template, String() lowering, join-elemToStr, standalone native-concat, unary +/-/~). See [[feedback_reground_spec_against_current_main]], [[feedback_verify_fix_in_git_not_narrative]].
