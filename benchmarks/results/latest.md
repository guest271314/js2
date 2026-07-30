# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.036ms | 0.049ms | 0.043ms | — | js |
| string/concat-long | 0.004ms | 0.006ms | 0.005ms | — | js |
| string/indexOf | 0.002ms | 0.689ms | 0.016ms | — | js |
| string/includes | 0.002ms | 0.658ms | 0.016ms | — | js |
| string/split | 0.404ms | 22.62ms | 1.09ms | — | js |
| string/replace | 0.040ms | 0.854ms | 0.147ms | — | js |
| string/case-convert | <0.001ms | 1.13ms | 4.75ms | — | js |
| string/substring | 0.004ms | 6.18ms | 0.021ms | — | js |
| string/trim | 0.159ms | 5.43ms | 0.555ms | — | js |
| string/startsWith-endsWith | 0.278ms | 12.78ms | 0.739ms | — | js |
| array/push-pop | 1.68ms | 2.18ms | 0.973ms | — | gc-native |
| array/sort-i32 | 0.846ms | 1275.9ms | — | — | js |
| array/map-filter | 0.136ms | 0.653ms | 0.049ms | — | gc-native |
| array/reduce | 1.64ms | 2.20ms | 0.988ms | — | gc-native |
| array/indexOf | 4.45ms | 3.81ms | 2.88ms | — | gc-native |
| array/slice | 0.037ms | 0.021ms | 0.011ms | — | gc-native |
| array/reverse | 8.84ms | 3.66ms | 4.42ms | — | host-call |
| array/forEach | 0.054ms | 0.086ms | 0.034ms | — | gc-native |
| array/find | 0.283ms | 0.451ms | — | — | js |
| dom/create-elements | 0.045ms | — | — | — | js |
| dom/set-attributes | 0.111ms | — | — | — | js |
| dom/read-attributes | 0.058ms | — | — | — | js |
| dom/modify-text | 0.048ms | — | — | — | js |
| mixed/csv-parse | 0.459ms | 33.66ms | 0.885ms | — | js |
| mixed/text-search | 0.236ms | 26.08ms | 1.09ms | — | js |
| mixed/fibonacci | 0.118ms | 0.266ms | — | 0.264ms | js |
| mixed/matrix-multiply | 0.187ms | 0.495ms | 0.200ms | 2.04ms | js |
| mixed/sieve | 1.81ms | 2.31ms | 1.34ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.35x slower | 1.19x slower | — |
| string/concat-long | 1.46x slower | 1.09x slower | — |
| string/indexOf | 449.50x slower | 10.46x slower | — |
| string/includes | 393.33x slower | 9.72x slower | — |
| string/split | 56.04x slower | 2.70x slower | — |
| string/replace | 21.14x slower | 3.64x slower | — |
| string/case-convert | 3100.42x slower | 13073.71x slower | — |
| string/substring | 1751.99x slower | 6.02x slower | — |
| string/trim | 34.22x slower | 3.50x slower | — |
| string/startsWith-endsWith | 45.95x slower | 2.66x slower | — |
| array/push-pop | 1.30x slower | 1.73x faster | — |
| array/sort-i32 | 1508.20x slower | — | — |
| array/map-filter | 4.80x slower | 2.77x faster | — |
| array/reduce | 1.34x slower | 1.66x faster | — |
| array/indexOf | 1.17x faster | 1.54x faster | — |
| array/slice | 1.79x faster | 3.55x faster | — |
| array/reverse | 2.42x faster | 2.00x faster | — |
| array/forEach | 1.58x slower | 1.57x faster | — |
| array/find | 1.60x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 73.29x slower | 1.93x slower | — |
| mixed/text-search | 110.67x slower | 4.64x slower | — |
| mixed/fibonacci | 2.25x slower | — | 2.23x slower |
| mixed/matrix-multiply | 2.65x slower | 1.07x slower | 10.92x slower |
| mixed/sieve | 1.27x slower | 1.35x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.14x faster |
| string/concat-long | 1.34x faster |
| string/indexOf | 42.96x faster |
| string/includes | 40.47x faster |
| string/split | 20.77x faster |
| string/replace | 5.80x faster |
| string/case-convert | 4.22x slower |
| string/substring | 290.86x faster |
| string/trim | 9.79x faster |
| string/startsWith-endsWith | 17.28x faster |
| array/push-pop | 2.24x faster |
| array/map-filter | 13.29x faster |
| array/reduce | 2.22x faster |
| array/indexOf | 1.32x faster |
| array/slice | 1.99x faster |
| array/reverse | 1.21x slower |
| array/forEach | 2.48x faster |
| mixed/csv-parse | 38.03x faster |
| mixed/text-search | 23.88x faster |
| mixed/matrix-multiply | 2.48x faster |
| mixed/sieve | 1.72x faster |

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
| mixed/fibonacci | 157B | — | 173B |
| mixed/matrix-multiply | 1.5KB | 1.8KB | 950B |
| mixed/sieve | 1.5KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1222.3ms | 1144.1ms | — |
| string/concat-long | 635.9ms | 1024.6ms | — |
| string/indexOf | 576.0ms | 991.3ms | — |
| string/includes | 572.2ms | 1030.4ms | — |
| string/split | 721.5ms | 1008.1ms | — |
| string/replace | 558.5ms | 1034.4ms | — |
| string/case-convert | 574.1ms | 1320.5ms | — |
| string/substring | 558.1ms | 893.5ms | — |
| string/trim | 566.3ms | 970.4ms | — |
| string/startsWith-endsWith | 635.3ms | 999.8ms | — |
| array/push-pop | 773.3ms | 847.3ms | — |
| array/sort-i32 | 873.6ms | — | — |
| array/map-filter | 951.9ms | 969.3ms | — |
| array/reduce | 827.6ms | 918.9ms | — |
| array/indexOf | 761.7ms | 842.6ms | — |
| array/slice | 776.4ms | 856.9ms | — |
| array/reverse | 754.3ms | 844.0ms | — |
| array/forEach | 842.9ms | 943.0ms | — |
| array/find | 848.8ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 757.7ms | 946.0ms | — |
| mixed/text-search | 662.5ms | 1024.4ms | — |
| mixed/fibonacci | 665.4ms | — | 675.7ms |
| mixed/matrix-multiply | 830.4ms | 926.3ms | 774.5ms |
| mixed/sieve | 818.3ms | 902.1ms | — |
