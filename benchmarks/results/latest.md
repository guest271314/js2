# js2wasm Benchmark Results

Date: 2026-09-29
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.052ms | 0.051ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.041ms | gc-native |
| string/includes | 0.019ms | 0.103ms | 0.014ms | 0.031ms | gc-native |
| string/split | 0.423ms | 7.79ms | 2.75ms | FAILED | js |
| string/replace | 0.094ms | 0.593ms | 0.276ms | FAILED | js |
| string/case-convert | 0.058ms | 0.530ms | 0.250ms | FAILED | js |
| string/substring | 0.114ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 3.35ms | 2.48ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 2.60ms | 2.56ms | 0.567ms | js |
| array/push-pop | 1.67ms | 0.609ms | 0.611ms | FAILED | host-call |
| array/sort-i32 | 0.844ms | 0.298ms | 0.296ms | FAILED | gc-native |
| array/map-filter | 0.135ms | 0.066ms | 0.066ms | FAILED | gc-native |
| array/reduce | 1.59ms | 0.598ms | 0.604ms | FAILED | host-call |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.036ms | 0.017ms | 0.017ms | FAILED | gc-native |
| array/reverse | 8.85ms | 3.97ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.053ms | 0.029ms | 0.029ms | FAILED | host-call |
| array/find | 0.273ms | 0.015ms | 0.015ms | 1.21ms | host-call |
| dom/create-elements | 0.040ms | 0.101ms | — | — | js |
| dom/set-attributes | 0.109ms | 0.240ms | — | — | js |
| dom/read-attributes | 0.060ms | 0.135ms | — | — | js |
| dom/modify-text | 0.030ms | 0.113ms | — | — | js |
| mixed/csv-parse | 0.467ms | 8.29ms | 0.551ms | FAILED | js |
| mixed/text-search | 0.403ms | 4.43ms | 2.53ms | 1.55ms | js |
| mixed/fibonacci | 0.125ms | 0.327ms | 0.328ms | 0.325ms | js |
| mixed/matrix-multiply | 0.185ms | 68.88ms | 73.07ms | 0.725ms | js |
| mixed/sieve | 1.77ms | 2.32ms | 2.32ms | FAILED | js |

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
| string/concat-short | 10000 | 3.54 | 5.15 | 5.10 | — |
| string/concat-long | 1000 | 4.16 | 5.33 | 3.47 | — |
| string/indexOf | 1000 | 19.06 | 59.94 | 12.17 | 40.68 |
| string/includes | 1000 | 18.78 | 102.64 | 13.87 | 30.61 |
| string/split | 10000 | 42.27 | 779.49 | 274.89 | — |
| string/replace | 1000 | 94.27 | 593.40 | 276.38 | — |
| string/case-convert | 2000 | 29.00 | 265.16 | 125.18 | — |
| string/substring | 10000 | 11.41 | 3.98 | 3.44 | — |
| string/trim | 10000 | 17.30 | 335.35 | 248.39 | — |
| string/startsWith-endsWith | 20000 | 20.67 | 130.23 | 128.14 | 28.33 |
| array/map-filter | 30000 | 4.49 | 2.21 | 2.20 | — |
| array/indexOf | 1000 | 4462.66 | 2864.91 | 2860.87 | — |
| dom/create-elements | 2000 | 19.77 | 50.53 | — | — |
| dom/set-attributes | 6000 | 18.17 | 39.97 | — | — |
| dom/read-attributes | 3000 | 20.01 | 44.89 | — | — |
| dom/modify-text | 2000 | 14.81 | 56.71 | — | — |
| mixed/csv-parse | 11000 | 42.44 | 753.24 | 50.13 | — |
| mixed/text-search | 40000 | 10.08 | 110.67 | 63.20 | 38.79 |
| mixed/fibonacci | 10000 | 12.53 | 32.72 | 32.76 | 32.48 |
| mixed/matrix-multiply | 125000 | 1.48 | 551.02 | 584.57 | 5.80 |
| mixed/sieve | 200000 | 8.86 | 11.59 | 11.62 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.45x slower | 1.44x slower | — |
| string/concat-long | 1.28x slower | 1.20x faster | — |
| string/indexOf | 3.14x slower | 1.57x faster | 2.13x slower |
| string/includes | 5.47x slower | 1.35x faster | 1.63x slower |
| string/split | 18.44x slower | 6.50x slower | — |
| string/replace | 6.29x slower | 2.93x slower | — |
| string/case-convert | 9.14x slower | 4.32x slower | — |
| string/substring | 2.86x faster | 3.32x faster | — |
| string/trim | 19.39x slower | 14.36x slower | — |
| string/startsWith-endsWith | 6.30x slower | 6.20x slower | 1.37x slower |
| array/push-pop | 2.73x faster | 2.73x faster | — |
| array/sort-i32 | 2.83x faster | 2.86x faster | — |
| array/map-filter | 2.03x faster | 2.04x faster | — |
| array/reduce | 2.66x faster | 2.63x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.14x faster | 2.18x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.84x faster | 1.84x faster | — |
| array/find | 18.55x faster | 18.39x faster | 4.44x slower |
| dom/create-elements | 2.56x slower | — | — |
| dom/set-attributes | 2.20x slower | — | — |
| dom/read-attributes | 2.24x slower | — | — |
| dom/modify-text | 3.83x slower | — | — |
| mixed/csv-parse | 17.75x slower | 1.18x slower | — |
| mixed/text-search | 10.98x slower | 6.27x slower | 3.85x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.59x slower |
| mixed/matrix-multiply | 372.02x slower | 394.66x slower | 3.92x slower |
| mixed/sieve | 1.31x slower | 1.31x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.01x faster |
| string/concat-long | 1.54x faster |
| string/indexOf | 4.92x faster |
| string/includes | 7.40x faster |
| string/split | 2.84x faster |
| string/replace | 2.15x faster |
| string/case-convert | 2.12x faster |
| string/substring | 1.16x faster |
| string/trim | 1.35x faster |
| string/startsWith-endsWith | 1.02x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.02x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 15.03x faster |
| mixed/text-search | 1.75x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.06x slower |
| mixed/sieve | 1.00x slower |

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
| string/concat-short | 1125.6ms | 611.4ms | — |
| string/concat-long | 435.7ms | 656.2ms | — |
| string/indexOf | 388.0ms | 652.4ms | 534.5ms |
| string/includes | 382.8ms | 686.9ms | 553.9ms |
| string/split | 517.5ms | 702.0ms | — |
| string/replace | 495.7ms | 760.8ms | — |
| string/case-convert | 517.1ms | 614.1ms | — |
| string/substring | 406.9ms | 462.1ms | — |
| string/trim | 474.1ms | 671.9ms | — |
| string/startsWith-endsWith | 503.1ms | 690.1ms | 611.4ms |
| array/push-pop | 513.5ms | 589.1ms | — |
| array/sort-i32 | 663.1ms | 721.3ms | — |
| array/map-filter | 668.7ms | 745.8ms | — |
| array/reduce | 609.7ms | 689.9ms | — |
| array/indexOf | 609.7ms | 668.1ms | — |
| array/slice | 513.7ms | 596.3ms | — |
| array/reverse | 495.5ms | 576.7ms | — |
| array/forEach | 636.5ms | 698.9ms | — |
| array/find | 496.2ms | 597.0ms | 528.9ms |
| dom/create-elements | 438.0ms | — | — |
| dom/set-attributes | 397.8ms | — | — |
| dom/read-attributes | 392.1ms | — | — |
| dom/modify-text | 382.5ms | — | — |
| mixed/csv-parse | 503.7ms | 669.3ms | — |
| mixed/text-search | 507.0ms | 724.7ms | 618.6ms |
| mixed/fibonacci | 455.7ms | 531.9ms | 468.3ms |
| mixed/matrix-multiply | 625.8ms | 695.0ms | 516.6ms |
| mixed/sieve | 611.5ms | 675.8ms | — |
