---
id: 6709
title: "S3-b: `Array.prototype.reduce` / `reduceRight` (and the small non-HOF tail) as callable VALUES on the native regime"
status: ready
created: 2026-09-27
updated: 2026-09-27
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen
language_feature: array-methods
goal: architecture
sprint: current
parent: 5385
depends_on: [6685]
related: [3170, 4394, 6651, 6689]
---

# #6709 — S3-b: the reduce family as a callable value

Slice S3-b of the #5385 "Implementation Plan v2". Nightly 36305955119
(regime lane) still loses **~243 host-passing rows** to

```
TypeError: Array.prototype.reduce is not yet callable as a value in --target standalone
TypeError: Array.prototype.reduceRight is not yet callable as a value in --target standalone
```

(122 + 121), plus a tail of `lastIndexOf` 14, `splice` 13, `indexOf` 13,
`pop` 10, `shift` 7, `toString` 6, `sort` 6, `toSpliced` 6. The host lane
satisfies these through the host `__array_proto_method` import; the regime
and the standalone lane share the refusal, so this lifts BOTH lanes.

## Where the refusal is

`src/codegen/array-object-proto.ts` ≈ L925–L975 (`compileArrayProtoMemberAsValue`
lineage, #4394): higher-order members are routed to the native standalone
loop `__hof_<name>` from `ensureNativeArrayHof` for the reflective
`Array.prototype.<m>.call(arrayLike, cb, thisArg)` form, **except the reduce
family**, explicitly excluded because its native loop takes
`(recv, cb, init, hasInit)` rather than `(recv, cb, thisArg)` and "stays on
the refusal until its own arg marshalling is written" (the comment at
≈ L934). Everything not in `NATIVE_HOF_METHODS` falls to the
`emitThrowTypeError(… not yet callable as a value …)` at ≈ L975.

## Change

1. **Reduce family (the 243).** In the same arm, add the reduce-shaped
   marshal: the closure ABI declares `(this, cb, initialValue?)`; pass
   `recv`, `cb`, `init` (or `ref.null.extern`) and `hasInit = paramCount > 2
   && !isUndefinedSingleton(init)` — mirror how the direct-call lowering of
   `arr.reduce(cb, init)` computes `hasInit` today (find it via
   `NATIVE_HOF_REDUCE` consumers in `src/codegen/array-methods.ts`), so the
   spec's "initialValue present" test (§23.1.3.24 step 5: presence, not
   `undefined`-ness) is identical in both forms. Keep the §23.1.3 step-1
   ToObject receiver guard the HOF arm already emits.
2. **Tail members** (`indexOf`, `lastIndexOf`, `pop`, `shift`, `splice`,
   `toSpliced`, `sort`, `toString`): only where an AST-free
   `compileArray<member>FromVecLocal` core already exists (grep
   `array-methods.ts`); route like `slice` at ≈ L1000. Members without a core
   stay on the refusal — do not write new cores in this slice; list them in
   the PR body with counts so #6651's PR-C owner can pick them up.

## Acceptance

- [ ] Repros pass under the regime AND under `--target standalone`:
      `built-ins/Array/prototype/reduce/15.4.4.21-*` and
      `reduceRight/15.4.4.22-*` rows that fail today with the "not yet
      callable" message (scoped run:
      `JS2WASM_EVAL_ENGINE=interpreter TEST262_SEMANTIC_PROVIDERS=native-first TEST262_PATH_FILTER="built-ins/Array/prototype/reduce/|built-ins/Array/prototype/reduceRight/" TEST262_WORKERS=2 pnpm run test:262`,
      and the same with `TEST262_TARGET=standalone`); record before/after.
- [ ] Focused test: `Array.prototype.reduce.call(arrayLike, cb)` with and
      without `initialValue`, including `initialValue: undefined` (must count
      as present) and an empty array-like without init (TypeError).
- [ ] `tests/issue-4396-target-profile.test.ts` byte-identity green for
      default `gc` (host-assisted output untouched).
- [ ] 321-row sample ≥ 227; standalone high-water floor moves up, never down.
