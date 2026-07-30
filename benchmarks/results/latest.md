# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.047ms | 0.038ms | — | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | — | js |
| string/indexOf | 0.001ms | 0.716ms | 0.016ms | — | js |
| string/includes | 0.001ms | 0.684ms | 0.017ms | — | js |
| string/split | 0.402ms | 22.73ms | 1.06ms | — | js |
| string/replace | 0.042ms | 0.873ms | 0.139ms | — | js |
| string/case-convert | <0.001ms | 1.26ms | 4.40ms | — | js |
| string/substring | 0.003ms | 6.56ms | 0.024ms | — | js |
| string/trim | 0.152ms | 6.05ms | 0.504ms | — | js |
| string/startsWith-endsWith | 0.246ms | 13.50ms | 0.658ms | — | js |
| array/push-pop | 1.47ms | 1.88ms | 0.839ms | — | gc-native |
| array/sort-i32 | 0.799ms | 1260.9ms | — | — | js |
| array/map-filter | 0.133ms | 0.611ms | 0.059ms | — | gc-native |
| array/reduce | 2.16ms | 1.85ms | 0.842ms | — | gc-native |
| array/indexOf | 3.94ms | 3.38ms | 2.57ms | — | gc-native |
| array/slice | 0.026ms | 0.033ms | 0.014ms | — | gc-native |
| array/reverse | 7.83ms | 3.39ms | 4.31ms | — | host-call |
| array/forEach | 0.049ms | 0.082ms | 0.044ms | — | gc-native |
| array/find | 0.240ms | 0.409ms | — | — | js |
| dom/create-elements | 0.037ms | — | — | — | js |
| dom/set-attributes | 0.103ms | — | — | — | js |
| dom/read-attributes | 0.055ms | — | — | — | js |
| dom/modify-text | 0.045ms | — | — | — | js |
| mixed/csv-parse | 0.465ms | 34.86ms | 0.860ms | — | js |
| mixed/text-search | 0.219ms | 27.85ms | 0.973ms | — | js |
| mixed/fibonacci | 0.109ms | 0.228ms | 0.086ms | 0.233ms | gc-native |
| mixed/matrix-multiply | 0.158ms | 0.486ms | 0.186ms | 2.13ms | js |
| mixed/sieve | 1.56ms | 2.13ms | 1.16ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.51x slower | 1.22x slower | — |
| string/concat-long | 1.42x slower | 1.19x slower | — |
| string/indexOf | 557.81x slower | 12.41x slower | — |
| string/includes | 465.28x slower | 11.27x slower | — |
| string/split | 56.52x slower | 2.64x slower | — |
| string/replace | 20.61x slower | 3.27x slower | — |
| string/case-convert | 3904.46x slower | 13657.46x slower | — |
| string/substring | 2102.57x slower | 7.56x slower | — |
| string/trim | 39.96x slower | 3.33x slower | — |
| string/startsWith-endsWith | 54.88x slower | 2.68x slower | — |
| array/push-pop | 1.27x slower | 1.76x faster | — |
| array/sort-i32 | 1578.88x slower | — | — |
| array/map-filter | 4.60x slower | 2.24x faster | — |
| array/reduce | 1.17x faster | 2.57x faster | — |
| array/indexOf | 1.16x faster | 1.54x faster | — |
| array/slice | 1.24x slower | 1.91x faster | — |
| array/reverse | 2.31x faster | 1.82x faster | — |
| array/forEach | 1.67x slower | 1.11x faster | — |
| array/find | 1.71x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 74.94x slower | 1.85x slower | — |
| mixed/text-search | 127.36x slower | 4.45x slower | — |
| mixed/fibonacci | 2.08x slower | 1.28x faster | 2.13x slower |
| mixed/matrix-multiply | 3.07x slower | 1.18x slower | 13.42x slower |
| mixed/sieve | 1.37x slower | 1.34x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.24x faster |
| string/concat-long | 1.20x faster |
| string/indexOf | 44.95x faster |
| string/includes | 41.30x faster |
| string/split | 21.39x faster |
| string/replace | 6.30x faster |
| string/case-convert | 3.50x slower |
| string/substring | 278.01x faster |
| string/trim | 12.01x faster |
| string/startsWith-endsWith | 20.50x faster |
| array/push-pop | 2.24x faster |
| array/map-filter | 10.32x faster |
| array/reduce | 2.20x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.38x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.86x faster |
| mixed/csv-parse | 40.56x faster |
| mixed/text-search | 28.63x faster |
| mixed/fibonacci | 2.66x faster |
| mixed/matrix-multiply | 2.61x faster |
| mixed/sieve | 1.84x faster |

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
| array/map-filter | 2.7KB | 2.8KB | — |
| array/reduce | 1.9KB | 2.5KB | — |
| array/indexOf | 1022B | 1.5KB | — |
| array/slice | 1.0KB | 1.5KB | — |
| array/reverse | 1.0KB | 1.5KB | — |
| array/forEach | 2.1KB | 2.7KB | — |
| array/find | 2.3KB | — | — |
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
| string/concat-short | 1254.5ms | 1221.2ms | — |
| string/concat-long | 656.0ms | 1032.7ms | — |
| string/indexOf | 592.7ms | 1043.1ms | — |
| string/includes | 576.4ms | 1071.0ms | — |
| string/split | 750.9ms | 1015.8ms | — |
| string/replace | 575.2ms | 1033.3ms | — |
| string/case-convert | 571.2ms | 1301.0ms | — |
| string/substring | 571.4ms | 860.8ms | — |
| string/trim | 550.6ms | 976.6ms | — |
| string/startsWith-endsWith | 646.6ms | 1032.1ms | — |
| array/push-pop | 764.8ms | 832.0ms | — |
| array/sort-i32 | 862.1ms | — | — |
| array/map-filter | 942.6ms | 946.3ms | — |
| array/reduce | 828.1ms | 892.2ms | — |
| array/indexOf | 757.6ms | 850.6ms | — |
| array/slice | 757.5ms | 816.7ms | — |
| array/reverse | 754.1ms | 819.2ms | — |
| array/forEach | 867.3ms | 930.4ms | — |
| array/find | 858.1ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 808.6ms | 989.4ms | — |
| mixed/text-search | 661.2ms | 1036.9ms | — |
| mixed/fibonacci | 699.4ms | 814.0ms | 730.9ms |
| mixed/matrix-multiply | 799.3ms | 930.1ms | 789.3ms |
| mixed/sieve | 856.8ms | 901.7ms | — |
