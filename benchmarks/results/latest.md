# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.015ms | 0.038ms | 0.038ms | — | js |
| string/concat-long | 0.003ms | 0.010ms | 0.018ms | — | js |
| string/indexOf | 0.017ms | 0.563ms | 0.032ms | — | js |
| string/includes | 0.018ms | 0.545ms | 0.033ms | — | js |
| string/split | 0.310ms | 17.09ms | 0.848ms | — | js |
| string/replace | 0.032ms | 0.683ms | 0.114ms | — | js |
| string/case-convert | <0.001ms | 0.901ms | 3.67ms | — | js |
| string/substring | 0.003ms | 4.87ms | 0.017ms | — | js |
| string/trim | 0.119ms | 4.34ms | 0.419ms | — | js |
| string/startsWith-endsWith | 0.320ms | 9.95ms | 0.575ms | — | js |
| array/push-pop | 1.35ms | 1.77ms | 0.762ms | — | gc-native |
| array/sort-i32 | 0.658ms | 977.3ms | — | — | js |
| array/map-filter | 0.116ms | 0.522ms | 0.039ms | — | gc-native |
| array/reduce | 1.25ms | 1.75ms | 0.746ms | — | gc-native |
| array/indexOf | 3.46ms | 2.96ms | 2.24ms | — | gc-native |
| array/slice | 0.032ms | 0.034ms | 0.019ms | — | gc-native |
| array/reverse | 6.87ms | 2.84ms | 3.43ms | — | host-call |
| array/forEach | 0.069ms | 0.068ms | 0.081ms | — | host-call |
| array/find | 0.221ms | 0.363ms | — | — | js |
| dom/create-elements | 0.569ms | — | — | — | js |
| dom/set-attributes | 0.104ms | — | — | — | js |
| dom/read-attributes | 0.065ms | — | — | — | js |
| dom/modify-text | 0.042ms | — | — | — | js |
| mixed/csv-parse | 0.353ms | 25.86ms | 0.701ms | — | js |
| mixed/text-search | 0.182ms | 20.26ms | 0.847ms | — | js |
| mixed/fibonacci | 0.098ms | 0.206ms | — | 0.205ms | js |
| mixed/matrix-multiply | 0.146ms | 0.384ms | 0.154ms | 1.57ms | js |
| mixed/sieve | 1.44ms | 1.82ms | 1.02ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 2.47x slower | 2.47x slower | — |
| string/concat-long | 3.06x slower | 5.34x slower | — |
| string/indexOf | 32.50x slower | 1.84x slower | — |
| string/includes | 30.12x slower | 1.82x slower | — |
| string/split | 55.10x slower | 2.73x slower | — |
| string/replace | 21.53x slower | 3.58x slower | — |
| string/case-convert | 2640.85x slower | 10757.46x slower | — |
| string/substring | 1537.46x slower | 5.30x slower | — |
| string/trim | 36.53x slower | 3.53x slower | — |
| string/startsWith-endsWith | 31.11x slower | 1.80x slower | — |
| array/push-pop | 1.32x slower | 1.77x faster | — |
| array/sort-i32 | 1485.88x slower | — | — |
| array/map-filter | 4.49x slower | 2.98x faster | — |
| array/reduce | 1.39x slower | 1.68x faster | — |
| array/indexOf | 1.17x faster | 1.54x faster | — |
| array/slice | 1.05x slower | 1.65x faster | — |
| array/reverse | 2.42x faster | 2.00x faster | — |
| array/forEach | 1.02x faster | 1.18x slower | — |
| array/find | 1.65x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 73.21x slower | 1.99x slower | — |
| mixed/text-search | 111.53x slower | 4.66x slower | — |
| mixed/fibonacci | 2.09x slower | — | 2.09x slower |
| mixed/matrix-multiply | 2.63x slower | 1.05x slower | 10.73x slower |
| mixed/sieve | 1.27x slower | 1.41x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.00x slower |
| string/concat-long | 1.74x slower |
| string/indexOf | 17.62x faster |
| string/includes | 16.58x faster |
| string/split | 20.16x faster |
| string/replace | 6.01x faster |
| string/case-convert | 4.07x slower |
| string/substring | 290.24x faster |
| string/trim | 10.35x faster |
| string/startsWith-endsWith | 17.29x faster |
| array/push-pop | 2.33x faster |
| array/map-filter | 13.37x faster |
| array/reduce | 2.34x faster |
| array/indexOf | 1.32x faster |
| array/slice | 1.74x faster |
| array/reverse | 1.21x slower |
| array/forEach | 1.20x slower |
| mixed/csv-parse | 36.88x faster |
| mixed/text-search | 23.92x faster |
| mixed/matrix-multiply | 2.49x faster |
| mixed/sieve | 1.79x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 1.7KB | — |
| string/concat-long | 236B | 1.9KB | — |
| string/indexOf | 216B | 2.1KB | — |
| string/includes | 236B | 2.1KB | — |
| string/split | 973B | 1.7KB | — |
| string/replace | 289B | 2.5KB | — |
| string/case-convert | 249B | 11.5KB | — |
| string/substring | 239B | 1.3KB | — |
| string/trim | 205B | 1.8KB | — |
| string/startsWith-endsWith | 330B | 1.7KB | — |
| array/push-pop | 947B | 1.4KB | — |
| array/sort-i32 | 1.2KB | — | — |
| array/map-filter | 2.4KB | 2.5KB | — |
| array/reduce | 1.7KB | 2.2KB | — |
| array/indexOf | 1022B | 1.5KB | — |
| array/slice | 1.0KB | 1.5KB | — |
| array/reverse | 1.0KB | 1.5KB | — |
| array/forEach | 1.8KB | 2.4KB | — |
| array/find | 2.0KB | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 1.4KB | 2.9KB | — |
| mixed/text-search | 600B | 2.2KB | — |
| mixed/fibonacci | 157B | — | 173B |
| mixed/matrix-multiply | 1.5KB | 1.8KB | 950B |
| mixed/sieve | 1.5KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 964.8ms | 900.2ms | — |
| string/concat-long | 488.6ms | 795.1ms | — |
| string/indexOf | 448.5ms | 767.6ms | — |
| string/includes | 462.0ms | 808.1ms | — |
| string/split | 571.7ms | 768.7ms | — |
| string/replace | 429.1ms | 763.8ms | — |
| string/case-convert | 425.1ms | 984.6ms | — |
| string/substring | 426.4ms | 676.0ms | — |
| string/trim | 430.8ms | 722.3ms | — |
| string/startsWith-endsWith | 482.0ms | 755.5ms | — |
| array/push-pop | 600.8ms | 652.4ms | — |
| array/sort-i32 | 677.7ms | — | — |
| array/map-filter | 719.5ms | 745.5ms | — |
| array/reduce | 644.4ms | 691.4ms | — |
| array/indexOf | 579.5ms | 663.9ms | — |
| array/slice | 586.6ms | 638.1ms | — |
| array/reverse | 575.4ms | 645.3ms | — |
| array/forEach | 656.7ms | 718.1ms | — |
| array/find | 663.1ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 608.7ms | 774.4ms | — |
| mixed/text-search | 506.4ms | 792.5ms | — |
| mixed/fibonacci | 505.1ms | — | 528.7ms |
| mixed/matrix-multiply | 630.4ms | 686.7ms | 596.5ms |
| mixed/sieve | 617.8ms | 670.0ms | — |
