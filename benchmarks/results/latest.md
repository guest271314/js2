# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.049ms | 0.040ms | — | js |
| string/concat-long | 0.004ms | 0.006ms | 0.005ms | — | js |
| string/indexOf | 0.001ms | 0.652ms | 0.016ms | — | js |
| string/includes | 0.001ms | 0.691ms | 0.016ms | — | js |
| string/split | 0.402ms | 22.21ms | 1.06ms | — | js |
| string/replace | 0.042ms | 0.859ms | 0.142ms | — | js |
| string/case-convert | <0.001ms | 1.24ms | 4.43ms | — | js |
| string/substring | 0.003ms | 6.23ms | 0.026ms | — | js |
| string/trim | 0.151ms | 5.82ms | 0.508ms | — | js |
| string/startsWith-endsWith | 0.246ms | 13.24ms | 0.658ms | — | js |
| array/push-pop | 1.46ms | 1.85ms | 0.839ms | — | gc-native |
| array/sort-i32 | 0.792ms | 1282.0ms | — | — | js |
| array/map-filter | 0.132ms | 0.611ms | 0.063ms | — | gc-native |
| array/reduce | 1.36ms | 1.83ms | 0.844ms | — | gc-native |
| array/indexOf | 3.94ms | 3.38ms | 2.56ms | — | gc-native |
| array/slice | 0.027ms | 0.032ms | 0.014ms | — | gc-native |
| array/reverse | 7.83ms | 3.39ms | 4.31ms | — | host-call |
| array/forEach | 0.048ms | 0.081ms | 0.044ms | — | gc-native |
| array/find | 0.240ms | 0.425ms | — | — | js |
| dom/create-elements | 0.035ms | — | — | — | js |
| dom/set-attributes | 0.104ms | — | — | — | js |
| dom/read-attributes | 0.054ms | — | — | — | js |
| dom/modify-text | 0.048ms | — | — | — | js |
| mixed/csv-parse | 0.471ms | 33.99ms | 0.858ms | — | js |
| mixed/text-search | 0.215ms | 27.05ms | 0.974ms | — | js |
| mixed/fibonacci | 0.109ms | 0.228ms | 0.085ms | 0.232ms | gc-native |
| mixed/matrix-multiply | 0.158ms | 0.487ms | 0.186ms | 2.12ms | js |
| mixed/sieve | 1.55ms | 2.11ms | 1.15ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.43x slower | 1.16x slower | — |
| string/concat-long | 1.49x slower | 1.23x slower | — |
| string/indexOf | 508.44x slower | 12.37x slower | — |
| string/includes | 471.66x slower | 11.22x slower | — |
| string/split | 55.21x slower | 2.64x slower | — |
| string/replace | 20.24x slower | 3.34x slower | — |
| string/case-convert | 3828.95x slower | 13681.22x slower | — |
| string/substring | 1993.73x slower | 8.23x slower | — |
| string/trim | 38.41x slower | 3.36x slower | — |
| string/startsWith-endsWith | 53.85x slower | 2.68x slower | — |
| array/push-pop | 1.27x slower | 1.74x faster | — |
| array/sort-i32 | 1619.22x slower | — | — |
| array/map-filter | 4.64x slower | 2.10x faster | — |
| array/reduce | 1.35x slower | 1.62x faster | — |
| array/indexOf | 1.16x faster | 1.54x faster | — |
| array/slice | 1.18x slower | 1.96x faster | — |
| array/reverse | 2.31x faster | 1.82x faster | — |
| array/forEach | 1.68x slower | 1.11x faster | — |
| array/find | 1.77x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 72.21x slower | 1.82x slower | — |
| mixed/text-search | 125.62x slower | 4.52x slower | — |
| mixed/fibonacci | 2.08x slower | 1.28x faster | 2.12x slower |
| mixed/matrix-multiply | 3.09x slower | 1.18x slower | 13.47x slower |
| mixed/sieve | 1.36x slower | 1.35x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.23x faster |
| string/concat-long | 1.21x faster |
| string/indexOf | 41.09x faster |
| string/includes | 42.03x faster |
| string/split | 20.95x faster |
| string/replace | 6.06x faster |
| string/case-convert | 3.57x slower |
| string/substring | 242.14x faster |
| string/trim | 11.45x faster |
| string/startsWith-endsWith | 20.11x faster |
| array/push-pop | 2.21x faster |
| array/map-filter | 9.73x faster |
| array/reduce | 2.17x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.32x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.87x faster |
| mixed/csv-parse | 39.60x faster |
| mixed/text-search | 27.77x faster |
| mixed/fibonacci | 2.67x faster |
| mixed/matrix-multiply | 2.61x faster |
| mixed/sieve | 1.83x faster |

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
| array/map-filter | 3.3KB | 3.3KB | — |
| array/reduce | 2.3KB | 2.8KB | — |
| array/indexOf | 1022B | 1.5KB | — |
| array/slice | 1.0KB | 1.5KB | — |
| array/reverse | 1.0KB | 1.5KB | — |
| array/forEach | 2.6KB | 3.1KB | — |
| array/find | 2.7KB | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 1.4KB | 2.9KB | — |
| mixed/text-search | 600B | 2.2KB | — |
| mixed/fibonacci | 157B | 1.1KB | 173B |
| mixed/matrix-multiply | 1.3KB | 1.8KB | 950B |
| mixed/sieve | 1.5KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1251.2ms | 1171.7ms | — |
| string/concat-long | 629.8ms | 1021.1ms | — |
| string/indexOf | 593.3ms | 1022.6ms | — |
| string/includes | 564.5ms | 1033.1ms | — |
| string/split | 726.7ms | 995.9ms | — |
| string/replace | 559.4ms | 1078.5ms | — |
| string/case-convert | 596.1ms | 1294.1ms | — |
| string/substring | 570.6ms | 905.7ms | — |
| string/trim | 562.1ms | 987.2ms | — |
| string/startsWith-endsWith | 642.3ms | 1002.4ms | — |
| array/push-pop | 769.1ms | 859.6ms | — |
| array/sort-i32 | 894.3ms | — | — |
| array/map-filter | 1003.6ms | 1010.8ms | — |
| array/reduce | 878.4ms | 947.0ms | — |
| array/indexOf | 783.6ms | 871.8ms | — |
| array/slice | 797.2ms | 871.6ms | — |
| array/reverse | 791.2ms | 826.2ms | — |
| array/forEach | 870.1ms | 949.9ms | — |
| array/find | 868.2ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 769.2ms | 983.8ms | — |
| mixed/text-search | 650.3ms | 1079.0ms | — |
| mixed/fibonacci | 679.8ms | 857.8ms | 725.5ms |
| mixed/matrix-multiply | 806.2ms | 924.8ms | 826.4ms |
| mixed/sieve | 833.1ms | 907.4ms | — |
