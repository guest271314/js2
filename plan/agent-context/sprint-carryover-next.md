# Sprint carry-over → next sprint start (standalone #1472 push)

_Wound down 2026-06-05 (out of tokens). Resume here._

## Standalone pass-rate arc this sprint
- Start: ~29.81% → **34.69%** (14,961/43,132, baseline sha `1aec170c0`, 2026-06-05T14:54).
- Banked landmarks: S2 `__extern_method_call` (+625) · S5c capturing accessors (+339 → 34.33%) · **S6-c Math/Number constants native (+155 → 34.69%)**.
- compile_error: 16,500.

## TOP PRIORITY — resume first
**#124 + #1901 co-land (the plateau-breaker, ~+254 net).** Half-built.
- Branch `issue-130-closed-struct-extern-get`, head `14ffff31b`. PR **#1241** — held **BLOCKED, NOT enqueued** (correct; #1897 gate caught it).
- Why parked: #1901 routing ALONE is **net −205** (266 ToPrimitive-on-$Object regressions). It must co-land with #124. Full evidence: `plan/agent-context/1241-regression-analysis.md`.
- Sharpened root cause (sd-s2): NOT a method-storage gap — `{valueOf:fn}` already stores a callable closure on $Object (`{foo:()=>7}`→`o.foo()`===7 via `__extern_method_call`). The bug is **name-specific interception** of valueOf/toString in calls.ts name-arms + the ToPrimitive coercion sites (type-coercion externref→f64/i32 ~L1340-1364), which bypass the working generic dispatch.
- Fix: route $Object valueOf/toString member-calls + ToPrimitive coercion through `__extern_method_call` under ctx.standalone; on OrdinaryToPrimitive exhaustion → `emitThrowTypeError("Cannot convert object to primitive value")` (§7.1.1/§7.1.1.1, native, no host import). Clears ~260/266.
- **Bar to enqueue: re-run standalone diff must be NET POSITIVE past −15 tolerance** before re-push. sd-s2's detailed resume steps are in the #1901 issue file (`## Suspended Work`).
- 6 non-coercion residuals expected to remain (file as follow-up, do NOT block co-land): Array.indexOf/lastIndexOf on $Object ×2, Symbol.iterator-null ×1, illegal-cast in `__obj_find`←`__extern_get` ×1, valueOf-side-effect-count ×2.

### #124 state at wind-down (refined)
- **Open-`$Object` ToPrimitive WORKS** — 4/5 of `tests/issue-124-toprimitive-object.test.ts` pass standalone (own valueOf via `(o as number)+0`, `o*1`, explicit `o.valueOf()`, abrupt-completion throw propagates). Committed on the branch. This is the hard part of the plateau-breaker, done.
- Fix is 4 files: calls.ts (removed identity/`[object Object]` short-circuit that pre-empted generic dispatch), type-coercion.ts:1352 → new native `__to_primitive(recv,hint)` (object-runtime.ts, RESERVE/FILL `fillToPrimitive` after `fillApplyClosure` to dodge the `u32 -1` late-shift class), `__to_primitive` added to OBJECT_RUNTIME_HELPER_NAMES (supersedes #1806 Phase-0 refusal).
- **Closed-struct path kept REFUSING-LOUD** (decision A) — removing the #1806 refusal unmasked a pre-existing latent `global.get -1` (invalid Wasm) in closed-struct→externref→ToPrimitive. Re-gated to refuse rather than emit invalid Wasm.
- **NEW separate issue (closed-struct representation, fixed when #1901 routing co-lands — NOT in #124):** (a) closed-struct→externref→ToPrimitive `global.get -1`; (b) `__unbox_number(undefined)`→0 (should be NaN, §7.1.1.1 step-6). These block the closed-struct ToPrimitive cases.
- **#124 scope = COERCION CLUSTER ONLY** (Date/prototype 21 + assignment 19 + object computed-key ToPropertyKey within the 98). These flip via `__to_primitive`, net-positive on their own. The for-of 69 do NOT clear on this branch and that's EXPECTED — they need a separate bridge (below), not this PR.
- **for-of 69 = SEPARATE 3-layer iterator bridge (new issue, NOT #124).** sd-s2's step-0 trace: (a) store `@@iterator` method on `$Object` [gap-1: literals.ts:271-274 skip + 723-727 routing predicate reject MethodDecl/computed-key]; (b) `__iterator` must recognize `$Object` + call stored `@@iterator` — TODAY `ref.cast $Vec` TRAPS (iterator-native.ts:113-116, loops.ts:3789-3796); (c) `__iterator_next` must dispatch user iterator `next()` — TODAY `$IterRec`-only. All 3 needed; method-store alone is insufficient. #1320/#342 territory.
- TODO next sprint (order): (1) run net-positive standalone diff on the COERCION-ONLY #1901+#124 branch; (2) if net-positive past −15, co-land #1241; (3) build the 3-layer for-of bridge as its own issue. #1241 still BLOCKED/unenqueued.

## Next levers (banked, ordered)
1. **S6-b** `__get_builtin` builtins-as-static-globals (~4.6k). Plan committed `d6c71a59e` (#1888 Slice 6). Tight-first-slice: wrappable set = Array.isArray / JSON.stringify / String.fromCharCode / Math.* / Number.*; fail-loud Reflect + rest; per-name guardrail (each gated name must have a verified native downstream emitter).
2. **$Object enumeration gap** (sibling finding, needs own issue): `Object.keys({a:1}).length`→0, `Object.assign({},{a:1}).a`→0. Not dispatch — struct-ops/enumeration on $Object. Likely shares root with residual #4 (illegal-cast read path).
3. **#129**: two `-1` string-constant-sentinel sites — literals.ts:399 (objlit data-prop key) + :461 (Symbol-keyed method key).
4. **S6-c per-name hardening**: trivial test-only follow-up PR, commit `e628ff59c` (exhaustive it.each over 16 Math/Number names).

## Coordination watch
- **#1806** (dev-regex, standalone ToPrimitive ~1,350-2,136) overlaps #124 on the ToPrimitive coercion path. #124 lands first; #1806 rebases onto it. Watch for `[CONFLICT]` on type-coercion.ts — route to senior-dev if both touch the same lines.

## Team
- sd-s2 suspended (was driving #124+#1901, S6-b plan, S6-c). Re-spawn next sprint pointed at this file + the #1901 issue `## Suspended Work`.
- Standalone regression gate (#1897) is live and working — it correctly blocked #1241. Trust it; never bypass.
