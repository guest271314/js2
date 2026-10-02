---
id: 6835
title: "Standalone find controls: borrowed length, undefined values, and view entry validation"
status: ready
sprint: current
created: 2026-10-02
updated: 2026-10-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
model: gpt-6.1-sol
task_type: investigation
area: codegen
language_feature: typed-array
goal: standalone-mode
parent: 6651
assignee: "ttraenkler/find_residual_plan_astra"
related: [6833, 6832, 6771]
---

# #6835 — standalone find control residuals

## Scope and evidence

These are existing failures exposed by the correct-expectation controls for
#6833 "ES2015 standalone: direct TypedArray find/findIndex use internal length".
They remain unchanged after that issue's two-name internal-length extension.
This issue records open work, not a completed fix, and does not replace the
parent 11,778-original ES2015 standalone goal.

Evidence was read from the implementation worktree
`/Users/thomas/Code/js2/.codex-worktrees/6833-typedarray-find-internal-length`.
All paths below are relative to that retained worktree. The inspected base is
`56680e7feb87a090ee8846c8ecb7718933cd3781`; candidate uses that same base plus
the #6833 source patch, SHA-256
`d80196564f9a4f11e05fc2d9b1a448254f307d8b3df1e16569ee5a44d38df5ac`.

- Canonical receipts: `.tmp/6833/baseline-receipt.json` and
  `candidate-receipt.json`, runs `20261002-221457` and `20261002-222335`.
  Maintained standalone Test262, QuickJS, oracle 14/honest, providers auto:
  **41 pass / 2 fail → 43 pass / 0 fail**, each with 43 registered/recorded/
  settled identities, one completion receipt, and no exclusions. Population
  is 40 frozen owned originals plus 3 separately attributed instrument controls.
  The two getter originals are #6833 gains, not gains of this follow-up.
- Original/candidate compiler SHA-256:
  `f4e72b29ff30cafcd43455cf8d50f532c385b8ba79fa3be4722a0c3138f109a6` /
  `7d6dc9f0d85588ea25d0ce11e2e0f98d5ea515e4592cf771b95029dd9338698d`.
- Canonical JSONLs are `benchmarks/results/test262-standalone-results-<run>.jsonl`;
  hashes respectively
  `8513a571fe5b5471a3a958004bc8b4b03e3de658049fa6b1ce19122d1b54e429` /
  `dd2f54490ebf7f7fd03b48279a8b15d92283fe0f220c189f2ec6aca24c783978`.
  Matching `.shard-1-of-1.complete.json` paths are recorded in the receipts.
- The unchanged 32-test correct-expectation fixture measured **23 pass / 9 fail
  → 27 pass / 5 fail**. Sources are preserved in
  `.tmp/6833/correct-expectations-original.test.ts`, SHA-256
  `b05241161a452f74daf9f8e7dea3715d6b1d34c5bdfcc5d9abc43f9064c270fb`.
  Logs: `.tmp/6833/fixtures-baseline.log` (SHA-256
  `4f926c8934dc40e7e4c77990c08eac04daedd311cc1727e039da7b92fafe4a76`)
  and `fixtures-candidate-full.log` (SHA-256
  `0708a39ecfaa3b52f60ccd2a6235ccaf57b333d452ae72cc7b603c23db85daf7`).
- Diagnostic sources are `.tmp/6833/control-diagnostics.mjs` (SHA-256
  `483c76447a8ed12dc7db289e59c5af2f9dabcd1031fc0883e38b0e8172b5daa1`)
  and `residuals.mjs` (SHA-256
  `5d34624d39e9b7ab9fb150c127f0917f0da97798f16a82e134e6f0a7ca6b7944`).
  Each compiles standalone and checks zero Wasm imports; the baseline scripts
  reject a compiler hash different from the original receipt. Their
  `<stem>-{baseline,candidate}.log` files print the matched compiler hashes.
  The two `control-diagnostics-*.json` files are byte-identical, SHA-256
  `a90e7a5331853748fd57ed640bfd869e8a9ad2f7a8ca2d74a216d477d15fadcb`;
  the two `residuals-*.json` files are byte-identical, SHA-256
  `b7c33f22d3391c28dcf397635d2e600bfb4b0aafdc30c637ecac96c516b0be51`.

## Reproduction and correct expectations

The archived fixture's three borrowed-call failures have stable labels:
`borrowed Array find observes a length once`, `borrowed Array find observes
TA.prototype length once`, and `borrowed Array findIndex observes TA.prototype
length once`. Reproduce with a constructor parameter to retain the dynamic path:

```js
function run(TA) {
  const a = new TA([1, 2, 3]);
  let hits = 0, calls = 0;
  Object.defineProperty(a, "length", {
    configurable: true, get: function () { hits++; return 1; }
  });
  const result = Array.prototype.find.call(a, function (value) {
    calls++; return value === 3;
  });
  return hits * 100 + calls * 10 + (result === undefined ? 1 : 0);
}
export function probe() { return run(Float64Array); }
```

Correct result is **111**, observed **110**: the own getter and one callback
occur, but the result comparison fails. Replacing the target `a` with
`TA.prototype` yields **30**, also wrong: zero getter calls and three callbacks.
For `findIndex`, compare result to `-1`; own target returns correct **111**,
prototype target wrong **30**. Do not infer the exact erroneous value merely
from the failed `=== undefined` comparison.

The two remaining fixture failures are `generic Array find visits holes` and
`generic Array findIndex visits holes`. Diagnostic body (run separately with
`[1, undefined, 3]` and `[1, , 3]`):

```js
function run(a) {
  let calls = 0, undef = 0;
  const result = a.find(function (value, index, receiver) {
    calls++; if (value === undefined) undef++;
    return index === 1 && value === undefined && receiver === a;
  });
  return calls * 100 + undef * 10 + (result === undefined ? 1 : 0);
}
export function probe() { return run([1, undefined, 3]); }
```

Correct result is **211**; both plain forms return **301**. For `findIndex`,
compare result to `1`; both plain forms return **300**, expected **211**.
Adding `Object.prototype[7] = 99` before the call makes all four forms return
**211**. This is a diagnostic control, not an acceptable workaround. Both find
methods visit absent indices; they must not acquire a HasProperty skip gate.

Entry-validation diagnostic (run both `find` and `findIndex`):

```js
function run(TA) {
  const a = new TA([1, 2, 3]);
  a.marker = 7;
  const buffer = a.buffer;
  buffer.__detached__ = true;
  let calls = 0;
  try { a.find(function () { calls++; return false; }); return calls; }
  catch (error) { return error instanceof TypeError ? -10 : -20; }
}
export function probe() { return run(Int8Array); }
```

Correct result is **-10**; both methods return **0** on both compilers. The
`__detached__` spelling is the existing test harness's detach marker. The
separate later-edition resizable-buffer probe substitutes this setup:

```js
const buffer = new ArrayBuffer(4, { maxByteLength: 8 });
const a = new TA(buffer, 1, 2);
buffer.resize(1);
```

Both methods again return **0**, expected **-10**. Detachment is an ES2015
semantic obligation; the resizable-buffer entry check is later-edition
coverage and must not enlarge the frozen ES2015 denominator. Normal detached
entry without an expando, callback detachment, and the fixture's in-bounds
resizable offset/element-width controls pass on both compilers.

## Source attribution and ownership

These are observed mechanism boundaries, not a claim of four independent root
causes. Source was inspected read-only at the above base; no new runtime probe
or production modification was made by this planner.

1. **Inherited length is bypassed at a confirmed seam.**
   `ta-dyn-mop.ts:1074` prepends the dynamic-view `__extern_length` arm.
   `array/array-like-exotic-arms.ts:230` (`taDynViewOwnLengthArm`) checks only
   expando own length; on miss the caller returns the internal in-bounds count.
   No concrete-prototype length lookup intervenes. Simply calling
   `__extern_get(view, "length")` is insufficient: the named-property arm in
   `ta-dyn-mop.ts` also returns internal length before ordinary inherited lookup.
   Existing `protoGetWithReceiver`/`constructorLookup` demonstrate receiver-aware
   lookup machinery, but adopting it for length needs validation of default
   intrinsic accessor behavior and recursion. Readers include generic HOFs and
   every `__extern_length` consumer, not only borrowed find.
2. **Own borrowed find miss: exact loss site unproven.**
   `array-object-proto.ts:962` marshals the borrowed call to generic `__hof_find`
   with an externref result; `hof-native.ts` already emits `undefinedExternInstrs`
   for a miss. First inspect emitted closure-return/caller coercion and the
   comparison, rather than changing the HOF miss sentinel on this evidence.
   Any necessary result-typing/call/IR edit requires its owner to approve the
   exact file after that attribution; no such file is authorized by this plan.
3. **Array element fidelity: candidate read/producer chain, not proven fix.**
   `hof-native.ts` reads each callback value via `__extern_get_idx`.
   `object-runtime.ts:7362` boxes f64 elements as numbers; its
   `fillExternGetIdxVecArms` handles holes separately. `literals.ts:6234`
   can emit undefined/hole f64 markers, while `array/vec-elem-fidelity.ts`
   restores the undefined marker only when its private `storesUndefElems`
   WeakSet was set by `vecF64ElemFromExternInstrs`, called from
   `type-coercion.ts`. Its sole reader is `fillVecElemGetIdxArms`; finalize
   installs it after the ordinary vec arms and before overlay arms. Inspect
   actual emitted carriers and callback argument boxing in plain/dirty probes
   before selecting a repair. Never make all numeric NaNs mean undefined.
4. **Entry guard boundaries are explicit.**
   `ta-dyn-method-call.ts:223` skips its detach check when the own-expando field
   is non-null, to avoid preempting an overridden method. Its applicability
   gate also requires the existing TypeError helper. The guard is consumed by
   direct dispatchers in `closed-method-dispatch.ts` and selected native call
   routes in `expressions/call-receiver-method.ts`. It checks detached backing
   storage, not entry out-of-bounds; `dataview-native.ts`'s in-bounds-length
   helper intentionally returns zero for OOB and cannot alone distinguish it
   from a valid empty view. Removing the expando condition globally would
   break own method overrides; placing validation at the resolved intrinsic
   branch is a hypothesis requiring override/control measurements.

## Implementation Plan

1. Preserve the raw correct-expectation sources and matched receipts. The
   #6833 publication must crosslink this issue and explicitly mark borrowed,
   plain-Array, expando-detached and entry-OOB acceptance as deferred. Keeping
   only passing owned fixtures in that narrow PR does not complete these
   acceptance requirements. Do not skip, rewrite to wrong expectations, or
   count archived diagnostics as passing tests.
2. Reproduce these exact encodings on the future implementation base with
   zero host imports, then inspect emitted data at the mechanism boundaries
   above. Determine whether the two undefined symptoms share a loss site.
   Promote each repaired correct-expectation probe into an ordinary regression
   fixture; preserve the still-unrepaired probes unchanged.
3. First candidate bounded slice is inherited generic TypedArray length:
   plan receiver-preserving own/prototype lookup followed by ToLength while
   direct intrinsic methods retain internal-length semantics. Request root's
   other-machine ownership clearance for `array/array-like-exotic-arms.ts`
   and the length/named-property portions of `ta-dyn-mop.ts` before editing.
   Include getter receiver identity, abrupt completion, inherited data length,
   deletion/default accessor fallback, and direct-method isolation controls.
4. Hold undefined-value implementation pending emitted-body attribution and
   clearance for the exact implicated areas: `object-runtime.ts`,
   `array/vec-elem-fidelity.ts`, `literals.ts`, `type-coercion.ts`, or the
   subsequently identified caller/result/comparison leaf. Do not authorize
   that entire list or any `src/ir/` migration change from a symptom alone.
5. Keep detached-entry and RAB-entry validation as separately scoped proposals.
   They need coordinated permission for `ta-dyn-method-call.ts` and any exact
   resolved-intrinsic dispatch/call leaf; RAB bounds additionally touch the
   existing view-layout contract. Require own method override, inherited
   override, missing/non-callable predicate, valid empty view, offset, tracking
   view, detached entry and callback-detach ordering controls before widening.
6. For each approved slice, run matched scoped originals and these diagnostics,
   applicable gates, and broader regression checks proportional to its readers.
   Report exact identities and per-row changes; no exclusions, guard/oracle
   weakening, new Test262 originals, or projected full-goal gains.

Recommend GPT-6.1 Sol **high** effort for an approved bounded slice. No production
slice is unconditionally ready: the inherited-length seam is source-attributed,
but its shared-source ownership clearance is outstanding; undefined return/read
attribution remains open. This planning issue is ready for follow-up dispatch,
not permission to modify another machine's migration work. Root owns assignment
transfer and will integrate this Markdown with #6833's publication.

- [ ] Residual probes remain reproducible with correct expectations.
- [ ] Exact source owners clear each implementation slice before edits.
- [ ] Borrowed length and undefined-value controls pass after attributed repairs.
- [ ] Expando-detached entry throws correctly without breaking method overrides.
- [ ] Later-edition RAB entry coverage is resolved and reported separately.
- [ ] #6833 deferred acceptance is crosslinked; frozen goal scope is unchanged.
