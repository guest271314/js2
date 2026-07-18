/**
 * Test262 DYNAMIC chunk — index/total supplied via TEST262_CHUNK_INDEX /
 * TEST262_CHUNK_TOTAL env vars instead of being baked into the filename.
 *
 * Used ONLY by the merge_group-consolidated shard matrix (#3431,
 * scripts/gen-test262-mg-matrix.mjs) to run fewer, bigger shards without
 * touching the static 57-way tests/test262-chunkN.test.ts set that
 * pull_request/push/workflow_dispatch keep using unchanged. The underlying
 * partition logic (assignBalancedChunk in test262-shared.ts) is a pure
 * function of (chunkIndex, totalChunks) — it does not read the calling
 * filename — so this file is a drop-in equivalent to the static
 * test262-chunkN.test.ts files, just parameterized at runtime.
 */
import { runTest262Chunk } from "./test262-shared.js";

const rawIndex = process.env.TEST262_CHUNK_INDEX ?? "";
const rawTotal = process.env.TEST262_CHUNK_TOTAL ?? "";
const idx = Number.parseInt(rawIndex, 10);
const total = Number.parseInt(rawTotal, 10);

if (!Number.isInteger(idx) || !Number.isInteger(total) || total <= 0 || idx < 0 || idx >= total) {
  throw new Error(
    `test262-chunk-dynamic.test.ts requires valid TEST262_CHUNK_INDEX/TEST262_CHUNK_TOTAL env vars ` +
      `(got TEST262_CHUNK_INDEX=${JSON.stringify(rawIndex)}, TEST262_CHUNK_TOTAL=${JSON.stringify(rawTotal)}).`,
  );
}

runTest262Chunk(idx, total);
