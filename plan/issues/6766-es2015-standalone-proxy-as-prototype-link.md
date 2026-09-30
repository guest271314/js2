---
id: 6766
title: "ES2015 standalone: a Proxy as [[Prototype]] — link carrier in `$Object.$proto`, per-hop trap dispatch, receiver-threaded [[Set]]"
status: ready
sprint: current
created: 2026-09-30
updated: 2026-09-30
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-lead
related: [6651, 5196, 5316, 2046, 4721, 5268]
loc-budget-allow:
  # 2026-09-30 (#6766 plan): the per-hop proxy arms are NEW emitted-code paths
  # in the five prototype walkers, the link producers in the three prototype
  # writers, and a `$Object` field append. Heavy pieces go in the NEW leaf
  # `src/codegen/object-runtime-proxy-chain.ts`; the listed files grow by
  # wiring (an arm splice per walker, one `ref.null any` per `struct.new`).
  - src/codegen/object-runtime.ts
  - src/codegen/object-runtime-prototype.ts
  - src/codegen/object-runtime-enumeration.ts
  - src/codegen/object-runtime-proxy.ts
  - src/codegen/object-runtime-proxy-chain.ts
  - src/codegen/dynamic-proto.ts
  - src/codegen/builtin-value-read.ts
  - src/codegen/literals.ts
  - src/codegen/context/types.ts
  - scripts/compiler-boundaries.json
---

## Problem

Standalone cannot put a Proxy in a prototype chain. `$Object.$proto` is
`(ref null $Object)` and `$Proxy` is a sibling struct (not a subtype — the
#2009 canonicalization hazard, `src/codegen/object-runtime.ts:1233-1247`), so
`Object.create(proxy)` and `Object.setPrototypeOf(o, proxy)` store the proxy's
TARGET (`__proxy_get_target_if_absent`, `object-runtime-prototype.ts:366-421`,
reached from `canonicalizeProtoArg` at `:423`) or `null` when a `get` trap
exists. No trap ever fires on an inherited read/write/`in`, and
`Object.getPrototypeOf(heir)` is not the proxy.

Measured on `origin/main` @ `eb57f327` (2026-09-30), standalone,
`.tmp/probe.mts`-style module (`var __r = 0; …; export function readResult()`):

| probe | program | main | node |
| --- | --- | --- | --- |
| p1 | `receiver = Object.create(new Proxy({}, {set(t,k,v,r){log++; ctx = this===handler}}))`; `receiver.prop = 1` → `log*10 + ctx` | **0** | 11 |
| p3 | `child = Object.create(new Proxy({}, {get(t,k,r){ return r===proxy ? 1 : 2 }}))`; `child.attr*10 + proxy.attr` | **NaN** | 21 |
| p4 | `getPrototypeOf(Object.create(proxy)) === proxy` (1) + `proxy.isPrototypeOf(child)` (2) + plain-object control (4) + `setPrototypeOf(s, proxy)` then `getPrototypeOf(s) === proxy` (8) | **6** | 15 |
| p5 | `g = getPrototypeOf(Object.create(new Proxy({attr:5}, {})))`: `g===null` 1, `g===target` 4, `g===proxy` 8, `child.attr===5` 16 | **1** | 24 |

p5 shows the current answer is neither the target nor the proxy — the
chain is simply cut (`$proto = null`, and `child.attr` reads nothing).

This is #5196 cluster **B** ("proxy as `[[Prototype]]` + receiver threading",
12 rows), whose Step 4 design was written on 2026-09-01 but never
implemented (#5196 closed with B recorded as "own issue"; see its
`Recorded, not fixed` table row B). Since then #5316 r5 landed the receiver
primitive that Step 4-c needed: `__reflect_set_receiver(target, key, value,
receiver) -> i32` (`src/codegen/object-runtime-ordinary-set.ts`,
`reserveOrdinarySetWithReceiver` `:212` / `fillOrdinarySetWithReceiver` `:238`
/ `noteReflectSetReceiverCall` `:495`) and its proxy twin
`__proxy_set_receiver_dispatch(proxy, key, value, receiver)`
(`object-runtime-proxy.ts:1189-1204`, registered only when the primitive was
reserved). So the receiver half exists; what is missing is the LINK
representation and the per-hop arms.

### Rows (ES2015, standalone, non-pass on the 2026-09-29 22:47 UTC baseline)

Core — the proxy-as-prototype mechanism is the FIRST failing assertion
(10 rows; all must pass):

- `built-ins/Proxy/set/call-parameters-prototype.js`
- `built-ins/Proxy/set/call-parameters-prototype-index.js`
- `built-ins/Proxy/set/call-parameters-prototype-dunder-proto.js`
- `built-ins/Proxy/set/trap-is-null-receiver.js`
- `built-ins/Proxy/set/trap-is-missing-receiver-multiple-calls.js`
- `built-ins/Proxy/set/trap-is-missing-receiver-multiple-calls-index.js`
- `built-ins/Proxy/get/trap-is-undefined-receiver.js`
- `built-ins/Proxy/has/call-in-prototype.js`
- `built-ins/Proxy/has/call-in-prototype-index.js`
- `built-ins/Proxy/has/call-object-create.js`

Measure — the link is one of several mechanisms in the row (report each
row's verdict; a pass is a bonus, a residual gets its mechanism named):

- `built-ins/Proxy/get/trap-is-{missing,null,undefined}-target-is-proxy.js`
- `built-ins/Proxy/has/trap-is-{missing,undefined}-target-is-proxy.js`
- `built-ins/Proxy/defineProperty/trap-is-null-target-is-proxy.js`
- `built-ins/Proxy/setPrototypeOf/trap-is-null-target-is-proxy.js`
- `built-ins/TypedArrayConstructors/internals/Set/key-is-valid-index-prototype-chain-set.js`
- `built-ins/TypedArrayConstructors/internals/Set/key-is-canonical-invalid-index-prototype-chain-set.js`
- `built-ins/Object/prototype/__proto__/set-cycle-shadowed.js`
- `built-ins/Function/prototype/Symbol.hasInstance/value-get-prototype-of-err.js`

Row lists: `.tmp/6766/core.txt` and `.tmp/6766/measure.txt` (paths relative
to `test262/test/`, one per line — the format `scripts/run-test262-paths.mts`
takes).

## Implementation Plan (2026-09-30, Fable lane; Opus implements)

Order-preserving: steps 1–3 land together (a link with no arms is a chain
cut in a new place), step 4 is measure-first, step 5 is the record. Type
queries go through `ctx.oracle`, never `ctx.checker`.

### Step 0 — base copies and the before-state

- `mkdir -p .tmp/6766 && git archive origin/main src | tar -x -C .tmp/6766/base-src`
  (the revert copy; `rsync` is not installed).
- Write the four probes above into `.tmp/6766/p{1,3,4,5}.js` and a runner
  (`.tmp/6766/probe.mts`: `compile(source, { target: "standalone", allowJs:
  true, skipSemanticDiagnostics: true, deferTopLevelInit: true })`,
  instantiate, `__module_init`, `readResult`). Record the main answers.
- Run `core.txt` and `measure.txt` on the UNMODIFIED tree with
  `flock /tmp/claude-0/t262.lock npx tsx scripts/run-test262-paths.mts <list> --isolate --standalone`
  (paths under `test262/test/`, i.e. `built-ins/…`, no `test/` prefix) →
  `.tmp/6766/core-base.log`, `.tmp/6766/measure-base.log`.

### Step 1 — representation: the proxy LINK field on `$Object`

- Append ONE field to `objectFields` (`object-runtime.ts` ~`:1218-1231`, after
  `nextSeq`): `{ name: "protoLink", type: { kind: "anyref" }, mutable: true }`.
  Append-only; do not renumber. Every `struct.new $Object` pushes one more
  `ref.null any` — there are exactly four sites (grep
  `struct.new", typeIdx: objectTypeIdx` / `types.objectTypeIdx`):
  `object-runtime.ts:2257` (`__new_plain_object`),
  `object-runtime-prototype.ts:636` (`__object_create`),
  `dynamic-proto.ts:602`, and
  `src/runtime/wasmgc/values/ordinary-object-storage-bodies.ts:35`. Add a
  `PROTO_LINK_FIELD = 6` const next to the field list and use it everywhere
  (no bare `fieldIdx: 6`).
- A LINK is a fresh `$Object` with empty props, `$proto = null`,
  `flags = 0`, `protoLink = <the $Proxy>`. It is never handed to the program
  (`__getPrototypeOf` unwraps it, step 3), so it needs no flag bit; the
  non-null `protoLink` IS the discriminator. Do not reuse `0x10`/`0x20`/`0x40`
  (taken: `FLAG_INTERNAL`, vec-overlay) or `0x08`/`0x80`.
- Register a native `__proto_link_new(externref proxy) -> (ref $Object)` and
  `__proto_link_of(ref null $Object) -> externref` (the proxy, or null extern
  when the object is not a link) in the NEW leaf
  `src/codegen/object-runtime-proxy-chain.ts` (add it to
  `scripts/compiler-boundaries.json` the way H6 added
  `array-proxy-receiver.ts` — run
  `node scripts/check-compiler-boundaries.mjs --mode inventory` to confirm).
- Byte identity: everything in this issue is gated on `ctx.proxyDirty` (the
  H6 pre-scan flag, set at `src/codegen/array-holes.ts:189` when the source
  mentions the identifier `Proxy`). The field append itself changes the
  `$Object` type for EVERY module; that is accepted (one extra
  `ref.null any` per `struct.new`). Everything else — the natives, the arms,
  the producers — is emitted only when `ctx.proxyDirty`.

### Step 2 — producers: store a link instead of unwrapping

All three writers reach the argument through `canonicalizeProtoArg`
(`object-runtime-prototype.ts:423-428`), which today calls
`__proxy_get_target_if_absent` first. Under `ctx.proxyDirty`, replace that
first call with `__proto_link_wrap(externref) -> externref`: a `$Proxy`
argument (trap or no trap) becomes `extern.convert_any(__proto_link_new(p))`;
anything else passes through unchanged. Keep `__proxy_get_target_if_absent`
registered (other callers, #4721) but stop calling it from
`canonicalizeProtoArg`.

- `__object_create` (`:593-649`) — the link flows through the existing
  `ref.test $Object` → store path. `Object.create(proxy, descriptors)` is the
  same native plus the call-site descriptor materialisation; nothing extra.
- `__object_setPrototypeOf` (`:651+`) and its `_status` twin (`:708`
  region): (a) the SameValue step 2 must compare the CURRENT link's proxy
  with the requested proxy (`__proto_link_of(current) ref.eq
  any.convert_extern(requested)`), not the link object; (b) the cycle walk
  (step 4) must stop at a link (a proxy prototype ends OrdinarySetPrototypeOf's
  loop per §10.1.2.1 step 8.b: "If p.[[GetPrototypeOf]] is not the ordinary
  object internal method, set done to true") — emit `protoLink != null →
  break`. `set-cycle-shadowed.js` is the row for this.
- The `__proto__:` literal key (`literals.ts:554-566`) and the `__proto__`
  setter (`builtin-value-read.ts:1412`) both call `__object_setPrototypeOf`;
  verify with `call-parameters-prototype-dunder-proto.js` that no earlier
  arm intercepts a proxy value there.
- Compile-site side effects, at every `Object.create(<expr>)` /
  `Object.setPrototypeOf(<o>, <expr>)` / `__proto__` producer when
  `ctx.proxyDirty`: call `reserveOrdinarySetWithReceiver(ctx)` +
  `noteReflectSetReceiverCall(ctx)` (so `__reflect_set_receiver` and
  `__proxy_set_receiver_dispatch` exist for step 3) and set
  `ctx.inheritedSetDescriptorDirty = true` (so `__extern_set_decide`'s chain
  walk is emitted at all — `src/codegen/inherited-set-gate.ts` header). A
  simpler, equally correct gate: do all three once in the pre-scan when
  `proxyDirty` is set, and measure whether the H6 reach set stays
  byte-identical (it should: modules that mention `Proxy` already pay for
  the proxy runtime).

### Step 3 — consumers: one arm per walker, in `object-runtime-proxy-chain.ts`

Each walker gets a `fill<Walker>ProxyLinkArm(ctx)` that splices the arm at
the top of its prototype loop, following the `definedFuncAt` + `body`
splice idiom of `fillObjectAssignProxySourceArm`
(`object-runtime-enumeration.ts:1590`) and the H6 `fillProxyDispatch` guards
(`object-runtime-proxy.ts:1885-1960`). Call them from the finalize site that
calls `fillProxyDispatch` (`src/codegen/index.ts`; grep `fillProxyDispatch`).
Every arm: `cursor.protoLink != null → <proxy op>(extern(protoLink), key,
ORIGINAL receiver) ; return`. The ORIGINAL receiver is param 0 of the walker
(the object the program named), never the cursor.

| walker | where the loop reads `$proto` | arm |
| --- | --- | --- |
| `__extern_get` | `object-runtime.ts` inherited walk, the `loop` at ~`:2601-2660` whose cursor is local 9 (`struct.get objectTypeIdx fieldIdx 0` at `:2566`) | `return __proxy_get_dispatch(link, key, receiver)` — it already takes a receiver (`object-runtime-proxy.ts:1176`) |
| `__extern_set_decide` (#4504 walk, `:2471-2698`) and `__extern_set_own`'s inherited-accessor arm (`:2847-2960`, cursor local 10) | same shape | `__proxy_set_receiver_dispatch(link, key, value, receiver)`; return its boolean as the decision (`SET_DECISION_HANDLED` when the trap/forward ran). Its trap-absent arm runs `__reflect_set_receiver(target, key, value, receiver)`, which creates the own property on the HEIR (§10.1.9.2 step 2.c–e) — `trap-is-missing-receiver-multiple-calls.js` observes exactly the gopd/defineProperty traps that walk fires |
| `__extern_has` / `__extern_has_with_implicit_object_proto` (`:3820-3950`) | the `$proto` loop | `return __proxy_has_dispatch(link, key, receiver)` |
| `__getPrototypeOf` (`object-runtime-prototype.ts:513-591`, `protoFieldAnswer`) | reads `$proto` once | if the field is a link, answer `__proto_link_of(field)` (the PROXY), else the existing answer |
| `__isPrototypeOf` (`:922-960`) | seed + loop | when the cursor is a link: `Reflect`-style — the proxy's `[[GetPrototypeOf]]` is the trap (`__proxy_gpo_dispatch`, `object-runtime-proxy.ts:1897`); compare identity against the PROXY (`__proto_link_of`) before hopping, then continue from `__proxy_gpo_dispatch(link)` |
| for-in / `Object.keys` inherited enumeration (`object-runtime-enumeration.ts:607` region) | its `$proto` hop | stop at a link and append `__proxy_ownkeys_names_dispatch(link)` filtered by enumerability through `__proxy_gopd_dispatch` (the #5268 2.4 filter); if that is more than the slice can carry, stop at the link and record it (no ES2015 core row needs for-in over a proxy prototype) |
| `__object_setPrototypeOf` cycle loop | step 2 (b) | `break` at a link |

Audit — these also read `$proto` (field 0) and must be classified as "walks
(needs the arm)" or "links only (no change)": `dynamic-proto.ts:566`,
`vec-proto-link.ts` (4 reads, 3 writes), `promise-subclass-proto-link.ts`,
`promise-dynamic-member-read.ts` (3), `proto-function-value.ts`,
`src/runtime/wasmgc/values/prototype-chain-bodies.ts`,
`object-runtime.ts:1793/1810` (`objectTerminalAllowsImplicitProto`). Write
the classification into the record; a walker left without an arm is a
silent chain cut, which is worse than today's null.

Receiver rule for the trap `this`: the handler (`phandler`), never the
receiver — the dispatch drivers already do this (`fillProxyDispatch`
threads `handler` as `thisVal`); `call-parameters-prototype.js` asserts it.

### Step 4 — measure, then the exotic-target residue

Re-run `core.txt` (all 10 must pass) and `measure.txt`. For each residual
name the first failing assertion and its mechanism; the `*-target-is-proxy`
rows also need the F cluster (exotic targets: array `length`, `new
String("str")` indices, RegExp accessors, function `name`/`length` —
#5196 Step 6, #5268) and are NOT this slice's to finish. Do not build a
second array/string MOP inside the proxy runtime.

### Step 5 — pins, controls, gates, record

- Pin suite `tests/issue-6766-proxy-as-prototype.test.ts`: p1, p3, p4, p5
  as "RED on base" pins (assert the node answer), plus three guards that
  answer the same on both trees: a plain `Object.create({})` chain read, a
  `Object.create(null)` write, and `Object.setPrototypeOf(o, {})` identity.
  The file must be red on `.tmp/6766/base-src` (swap `src/` in, run, swap
  back) — write the base verdict into the record.
- Controls (0 pass → non-pass, per-path set diff, `--isolate`): every
  currently-passing ES2015 standalone row under `built-ins/Proxy/**`,
  `built-ins/Reflect/**` and `built-ins/Object/**` (extract from
  `.test262-cache/test262-standalone-current.jsonl`, `status:"pass"`; ~900
  rows, ~40 min under the lock — run it once, at the end, on the merged
  tree).
- Byte identity outside `proxyDirty`: compile 20 rows from
  `language/expressions/object/**` that do not mention `Proxy` on base and
  branch and compare `sha256` of `.binary`. The `$Object` field append WILL
  move bytes; report that honestly and show the diff is only the extra
  `ref.null any` per `struct.new` (compare `wasm-objdump -d` or the
  instruction count).
- Gates, run bare and chained: `node scripts/check-loc-budget.mjs && node
  scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs &&
  npm run -s check:oracle-ratchet && npm run -s check:dead-exports`, then
  again with `LOC_GATE_BASE=$(git rev-parse origin/main)` for loc/func, plus
  `npm run -s check:host-import-policy` (if present in `package.json`),
  `node scripts/check-compiler-boundaries.mjs --mode inventory`, and `npm
  run -s typecheck`. `check:dead-exports` leaves ~80 MB in
  `.tmp/core-node-execution-*` (#6764) — delete it after the run.
- Record: append `### 2026-09-30 — #6766 implementation (Opus)` to THIS
  file with the before/after row tables, the walker audit table, the pins'
  base verdict, the control diff, the byte-identity note, and residuals with
  mechanisms; then a one-paragraph pointer in
  `plan/issues/6651-es2015-standalone-100pct-execution-plan.md` under a new
  `### 2026-09-30 — #6766 …` heading.

## Acceptance criteria

- The 10 core rows pass on standalone (`--isolate`), measured on the
  branch with `origin/main` merged in.
- p1 = 11, p3 = 21, p4 = 15, p5 = 24 on the branch; the pin file is red on
  the base sources.
- 0 pass → non-pass across the `Proxy`/`Reflect`/`Object` control.
- Every `$proto` reader in the audit table is classified; every walker has
  its arm or a recorded reason.
- All gates green; `src/ir/select.ts` untouched; growth grants in this
  file's frontmatter only.

## Lane protocol

- Worktree: `git worktree add /home/user/js2/.claude/worktrees/issue-6766 -b issue-6766-proxy-proto-link origin/main`,
  then `ln -s /home/user/js2/node_modules <wt>/node_modules` and
  `ln -s /home/user/js2/test262 <wt>/test262` (the hook does not provision
  them here). Never edit `/home/user/js2` itself — it is the BASE tree the
  lead measures against.
- One test262 runner at a time on this 4-core box: every
  `run-test262-paths.mts` invocation goes through
  `flock /tmp/claude-0/t262.lock …`. Rebuild the QuickJS adapter after a
  `src/` change if a row reports "provider is not built":
  `npx tsx scripts/build-quickjs-eval-provider.mjs`.
- Commit early and push the branch immediately (`git push -u origin
  <branch>`; the pre-push hook is slow — run it with output redirected to a
  log, then confirm with `git ls-remote origin <branch>`). Do NOT open a PR:
  the lead verifies the pushed head and opens it.
- Commit format: subject ends with ` ✓`; author `Thomas Tränkler
  <git@thomas.traenkler.com>`, committer `Claude <noreply@anthropic.com>`
  (`GIT_COMMITTER_NAME=Claude GIT_COMMITTER_EMAIL=noreply@anthropic.com git
  -c user.name="Thomas Tränkler" -c user.email=git@thomas.traenkler.com
  commit -m "<msg>"`); trailers `Co-Authored-By: Claude Opus 5.5
  <noreply@anthropic.com>`, `Claude-Session:
  https://claude.ai/code/session_01FEGi3DmyPRPD5dx4kWU8hs`, `Model: Claude
  Opus 5.5 High`. Never `--no-verify`.
- No `git stash`; A/B by file copy from `.tmp/6766/base-src`.
