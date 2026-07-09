# #2980 async carrier-widen A/B measure harness

Durable copy of the carrier-widen decision-measure harness (rule-5 of
`plan/issues/2980-async-carrier-widen-final-layers-decision-measure.md` — the
prior `.tmp/` copy did not survive `.tmp/` being gitignored, so it is committed
here for the next re-measure).

Measures the `JS2WASM_ASYNC_CARRIER_WIDEN` carrier widen (both gate predicates in
`src/codegen/async-scheduler.ts`) as a per-construct A/B over a deterministic
262-file test262 spread-sample, `--target standalone` + the #2404 drain hook.
The env toggle is read at module-load, so the OFF and ON arms MUST be separate
processes.

## Run

```bash
# 1. Build the deterministic corpus (writes .tmp/ab-corpus.json).
node scripts/measure/corpus.mjs

# 2. OFF arm (widen off) — writes .tmp/ab-off.jsonl.
npx tsx scripts/measure/arm.mts off

# 3. ON arm (widen on) — writes .tmp/ab-on.jsonl.
JS2WASM_ASYNC_CARRIER_WIDEN=1 npx tsx scripts/measure/arm.mts on

# 4. Per-bucket net + regression listing + FLIP verdict (rule 1).
npx tsx scripts/measure/diff.mts
```

Buckets: async-function, for-await-of, async-generator, promise-then-all,
await-expr (60/60/60/60/22 = 262). FLIP verdict = positive total net AND no
bucket net ≤ −2 (rule 1). Recorded runs live in the #2980 issue (cite the main
SHA — rule 4).
