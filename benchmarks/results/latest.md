# js2wasm Benchmark Results

Date: 2026-10-02
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.048ms | 0.046ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.066ms | 0.012ms | 0.020ms | gc-native |
| string/includes | 0.019ms | 0.145ms | 0.015ms | 0.016ms | gc-native |
| string/split | 0.426ms | 8.55ms | 2.92ms | FAILED | js |
| string/replace | 0.103ms | 0.702ms | 0.339ms | FAILED | js |
| string/case-convert | 0.056ms | 0.579ms | 0.278ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.174ms | 4.04ms | 2.93ms | FAILED | js |
| string/startsWith-endsWith | 0.400ms | 2.99ms | 3.08ms | 0.560ms | js |
| array/push-pop | 1.43ms | 0.510ms | 0.504ms | FAILED | gc-native |
| array/sort-i32 | 0.775ms | 0.294ms | 0.294ms | FAILED | host-call |
| array/map-filter | 0.127ms | 0.070ms | 0.071ms | FAILED | host-call |
| array/reduce | 2.14ms | 0.499ms | 0.501ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.026ms | 0.027ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.07ms | host-call |
| dom/create-elements | 0.036ms | 0.094ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.225ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.135ms | — | — | js |
| dom/modify-text | 0.029ms | 0.110ms | — | — | js |
| mixed/csv-parse | 0.488ms | 8.78ms | 0.638ms | FAILED | js |
| mixed/text-search | 0.388ms | 5.10ms | 2.82ms | 1.08ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.288ms | js |
| mixed/matrix-multiply | 0.160ms | 74.22ms | 80.23ms | 0.719ms | js |
| mixed/sieve | 1.60ms | 2.11ms | 2.13ms | FAILED | js |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | warmup | memory access out of bounds |
| string/split | linear-memory | mid-loop | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 3.14 | 4.76 | 4.62 | — |
| string/concat-long | 1000 | 3.66 | 4.56 | 3.75 | — |
| string/indexOf | 1000 | 19.19 | 66.06 | 12.28 | 19.84 |
| string/includes | 1000 | 19.24 | 144.77 | 14.52 | 16.00 |
| string/split | 10000 | 42.60 | 854.94 | 291.87 | — |
| string/replace | 1000 | 103.27 | 701.90 | 339.22 | — |
| string/case-convert | 2000 | 27.94 | 289.48 | 138.81 | — |
| string/substring | 10000 | 9.89 | 3.74 | 3.08 | — |
| string/trim | 10000 | 17.40 | 404.44 | 292.56 | — |
| string/startsWith-endsWith | 20000 | 20.00 | 149.47 | 154.00 | 28.01 |
| array/map-filter | 30000 | 4.22 | 2.33 | 2.36 | — |
| array/indexOf | 1000 | 3948.27 | 2644.65 | 2642.00 | — |
| dom/create-elements | 2000 | 17.86 | 47.06 | — | — |
| dom/set-attributes | 6000 | 17.38 | 37.42 | — | — |
| dom/read-attributes | 3000 | 18.38 | 44.95 | — | — |
| dom/modify-text | 2000 | 14.68 | 55.17 | — | — |
| mixed/csv-parse | 11000 | 44.37 | 798.49 | 57.99 | — |
| mixed/text-search | 40000 | 9.70 | 127.51 | 70.57 | 27.05 |
| mixed/fibonacci | 10000 | 12.03 | 28.30 | 28.31 | 28.77 |
| mixed/matrix-multiply | 125000 | 1.28 | 593.80 | 641.85 | 5.75 |
| mixed/sieve | 200000 | 7.99 | 10.57 | 10.63 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.51x slower | 1.47x slower | — |
| string/concat-long | 1.25x slower | 1.03x slower | — |
| string/indexOf | 3.44x slower | 1.56x faster | 1.03x slower |
| string/includes | 7.53x slower | 1.32x faster | 1.20x faster |
| string/split | 20.07x slower | 6.85x slower | — |
| string/replace | 6.80x slower | 3.28x slower | — |
| string/case-convert | 10.36x slower | 4.97x slower | — |
| string/substring | 2.65x faster | 3.22x faster | — |
| string/trim | 23.25x slower | 16.82x slower | — |
| string/startsWith-endsWith | 7.47x slower | 7.70x slower | 1.40x slower |
| array/push-pop | 2.81x faster | 2.84x faster | — |
| array/sort-i32 | 2.64x faster | 2.63x faster | — |
| array/map-filter | 1.81x faster | 1.79x faster | — |
| array/reduce | 4.28x faster | 4.27x faster | — |
| array/indexOf | 1.49x faster | 1.49x faster | — |
| array/slice | 1.06x slower | 1.07x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.75x faster | 1.76x faster | — |
| array/find | 16.03x faster | 15.78x faster | 4.23x slower |
| dom/create-elements | 2.63x slower | — | — |
| dom/set-attributes | 2.15x slower | — | — |
| dom/read-attributes | 2.45x slower | — | — |
| dom/modify-text | 3.76x slower | — | — |
| mixed/csv-parse | 17.99x slower | 1.31x slower | — |
| mixed/text-search | 13.14x slower | 7.27x slower | 2.79x slower |
| mixed/fibonacci | 2.35x slower | 2.35x slower | 2.39x slower |
| mixed/matrix-multiply | 463.69x slower | 501.21x slower | 4.49x slower |
| mixed/sieve | 1.32x slower | 1.33x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x faster |
| string/concat-long | 1.22x faster |
| string/indexOf | 5.38x faster |
| string/includes | 9.97x faster |
| string/split | 2.93x faster |
| string/replace | 2.07x faster |
| string/case-convert | 2.09x faster |
| string/substring | 1.22x faster |
| string/trim | 1.38x faster |
| string/startsWith-endsWith | 1.03x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.01x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.02x slower |
| mixed/csv-parse | 13.77x faster |
| mixed/text-search | 1.81x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.08x slower |
| mixed/sieve | 1.01x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.8KB | 3.5KB | — |
| string/replace | 1.9KB | 4.4KB | — |
| string/case-convert | 1.8KB | 2.5KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.5KB | 3.1KB | — |
| string/startsWith-endsWith | 2.0KB | 4.0KB | 1.7KB |
| array/push-pop | 1.2KB | 1.6KB | — |
| array/sort-i32 | 3.3KB | 3.8KB | — |
| array/map-filter | 4.3KB | 4.8KB | — |
| array/reduce | 3.0KB | 3.5KB | — |
| array/indexOf | 2.1KB | 2.5KB | — |
| array/slice | 1.3KB | 1.7KB | — |
| array/reverse | 1.2KB | 1.7KB | — |
| array/forEach | 3.4KB | 4.0KB | — |
| array/find | 1.2KB | 1.6KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.5KB | 4.5KB | — |
| mixed/text-search | 2.2KB | 4.3KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 3.5KB | 4.0KB | 991B |
| mixed/sieve | 2.5KB | 2.7KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1140.0ms | 624.7ms | — |
| string/concat-long | 427.8ms | 686.1ms | — |
| string/indexOf | 382.3ms | 679.9ms | 547.0ms |
| string/includes | 372.4ms | 676.7ms | 560.8ms |
| string/split | 518.1ms | 699.0ms | — |
| string/replace | 545.9ms | 796.7ms | — |
| string/case-convert | 521.1ms | 637.2ms | — |
| string/substring | 390.6ms | 470.9ms | — |
| string/trim | 503.8ms | 690.2ms | — |
| string/startsWith-endsWith | 500.9ms | 725.1ms | 617.1ms |
| array/push-pop | 510.4ms | 572.9ms | — |
| array/sort-i32 | 656.2ms | 706.7ms | — |
| array/map-filter | 682.9ms | 738.5ms | — |
| array/reduce | 593.3ms | 679.0ms | — |
| array/indexOf | 589.4ms | 655.6ms | — |
| array/slice | 507.3ms | 585.3ms | — |
| array/reverse | 499.6ms | 564.1ms | — |
| array/forEach | 627.0ms | 697.2ms | — |
| array/find | 506.3ms | 585.3ms | 518.5ms |
| dom/create-elements | 417.0ms | — | — |
| dom/set-attributes | 371.3ms | — | — |
| dom/read-attributes | 385.0ms | — | — |
| dom/modify-text | 375.0ms | — | — |
| mixed/csv-parse | 514.5ms | 657.2ms | — |
| mixed/text-search | 499.9ms | 696.9ms | 611.1ms |
| mixed/fibonacci | 457.2ms | 497.4ms | 487.9ms |
| mixed/matrix-multiply | 619.0ms | 701.6ms | 537.3ms |
| mixed/sieve | 624.2ms | 685.6ms | — |
