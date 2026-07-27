# Cross-engine axis benchmark (#3684)

Decomposes runtime performance **by axis** across three engines running the
**same source file** with **identical checksums**:

- **node** (V8, JIT) — the reference
- **Porffor** (`/home/user/porffor`, JS → C → native, `cc -O3 -flto`)
- **js2 standalone** (`--target standalone`, pure WasmGC, zero imports)

## Why this exists

A single aggregate number (e.g. "compiled acorn parses N× slower") conflates
independent axes and has produced wrong conclusions. In particular it
conflates the **js2 host lane's** JS-bridge tax with **codegen quality** — two
completely different problems with different owners. Per-axis numbers separate
them.

`axes-core.js` is deliberately plain ES5 so all three engines accept it
verbatim. Every bench returns a checksum; all three engines must agree, or the
measurement is void.

## Running it

```bash
# node + Porffor (both read the same generated driver)
node benchmarks/cross-engine/run-node-porffor.mjs

# js2 standalone (compiles the same core, times each exported bench)
node --import tsx benchmarks/cross-engine/run-js2.mjs
```

`run-js2.mjs` embeds the string subject in 4 KB chunks — a single 35 KB string
literal overflows the compiler's expression recursion.

## Reading the results

Report **min-of-5** after a warmup call. The absolute numbers are
machine-specific; only the **ratios between engines on the same axis** are
meaningful, and only when the checksums match.

Axes below ~0.1 ms are loop-bound rather than measuring the named operation —
scale the iteration count up before drawing a conclusion. (The first cut of
this harness "measured" `charCodeAt` at a size where deleting `charCodeAt`
entirely did not change the time.)
