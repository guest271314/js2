# sr-interp — session context (#2927)

## Role
Senior developer (Opus), issue #2927 "Interpreter foundation: Acorn-via-js2wasm
runtime parser + generic-built-in audit" (L-horizon, feasibility: hard).

## Landed this session (PR #2592, loopdive/js2, branch issue-2927-interpreter-foundation)
1. **Fix**: native-vec `.push`/`.pop` brand arm for standalone/wasi any-receiver.
   - Real host-free DATA-LOSS bug: `--target standalone` `const a:any=[1,2];
     a.push(3)` returned 0, left `.length===2`, dropped element; `.pop()` returned 0.
   - Root cause: #2151 closed-method dispatcher (`__call_m_push_1`/`__call_m_pop_0`)
     had no `$__vec_base` arm; #2784 native-vec fast path is `!ctx.standalone`-gated.
   - Files: `src/codegen/closed-method-dispatch.ts` (VEC_MUTATE_METHODS +
     `$__vec_base` fill arm → `__vec_push`/`__vec_pop`, -1-guard→undefined),
     `src/codegen/expressions/calls.ts` (reserve vec helper at call site, avoids
     eval-time import cycle).
   - Tests: `tests/issue-2927-standalone-any-push-pop.test.ts` (7, host-free-asserted).
2. **Audit refinement** in the issue file (the Part-2 deliverable): verified host-free
   measurements under `target: standalone` (asserting `Module.imports`). Corrected the
   coverage table — String/non-callback-Array/object-literal any-methods already
   host-free+correct; real gaps are Map/Set + Array callback methods.

## Verification
tsc clean; #2151 (all slices)+#2583 (51) green; array-methods/prototype (35) green;
new #2927 suite (7) green. Only failure (`fast-arrays > array find`) is pre-existing TS
type error, confirmed identical on base main.

## Methodology note (important)
`{ standalone: true }` compile OPTION is HYBRID (allows env.* host imports) — NOT
host-free. Only `--target standalone` / `--target wasi` is truly host-free (0 fn-imports).
Measure host-freeness via `WebAssembly.Module.imports`, not the option.

## Next slices (turnkey, rolled forward — see issue ## Suspended Work)
1. **Map/Set any-receiver brand arms** (highest value). Root cause pinned:
   `src/codegen/expressions/extern.ts:60-93` keys native Map/Set interception on the
   STATIC class name (`className === "Map"`), so any-typed receivers skip it → emit
   `env.WeakMap_*`/`Set_*`. Fix: `ref.test ctx.mapTypeIdx`/`$Set` arm in the
   closed-method dispatcher routing to native `__map_get/set/has/delete` /
   `__set_*` (map-runtime.ts / set-runtime.ts). Same pattern as the push/pop arm.
2. Array callback methods (map/filter/forEach/reduce) on any → `env.__make_callback`
   (needs in-Wasm callback bridge; largest).
3. `string[]` push under standalone: native-string vec carrier not in `__vec_push`
   `mutEntries` (index.ts) — file under #2784.
4. Part 1 — Acorn runtime parser: blocked on #2937 (host $Object-hash poison).
