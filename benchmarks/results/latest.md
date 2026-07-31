# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.037ms | 0.054ms | 0.042ms | — | js |
| string/concat-long | 0.004ms | 0.006ms | 0.005ms | — | js |
| string/indexOf | 0.002ms | 0.651ms | 0.013ms | — | js |
| string/includes | 0.002ms | 0.659ms | 0.013ms | — | js |
| string/split | 0.403ms | 22.02ms | 0.762ms | — | js |
| string/replace | 0.041ms | 0.873ms | 0.140ms | — | js |
| string/case-convert | <0.001ms | 1.14ms | 4.74ms | — | js |
| string/substring | 0.004ms | 6.16ms | 0.020ms | — | js |
| string/trim | 0.154ms | 5.51ms | 0.173ms | — | js |
| string/startsWith-endsWith | 0.313ms | 13.80ms | 0.232ms | — | gc-native |
| array/push-pop | 1.70ms | 2.15ms | 0.960ms | — | gc-native |
| array/sort-i32 | 0.841ms | 1269.7ms | — | — | js |
| array/map-filter | 0.136ms | 0.646ms | 0.050ms | — | gc-native |
| array/reduce | 1.59ms | 2.19ms | 0.970ms | — | gc-native |
| array/indexOf | 4.45ms | 3.81ms | 2.88ms | — | gc-native |
| array/slice | 0.035ms | 0.020ms | 0.010ms | — | gc-native |
| array/reverse | 8.84ms | 3.65ms | 4.42ms | — | host-call |
| array/forEach | 0.053ms | 0.085ms | 0.034ms | — | gc-native |
| array/find | 0.281ms | 0.473ms | — | — | js |
| dom/create-elements | 0.038ms | — | — | — | js |
| dom/set-attributes | 0.109ms | — | — | — | js |
| dom/read-attributes | 0.058ms | — | — | — | js |
| dom/modify-text | 0.065ms | — | — | — | js |
| mixed/csv-parse | 0.699ms | 35.99ms | 0.784ms | — | js |
| mixed/text-search | 0.236ms | 25.93ms | 0.620ms | — | js |
| mixed/fibonacci | 0.118ms | 0.266ms | 0.095ms | 1.30ms | gc-native |
| mixed/matrix-multiply | 0.185ms | 0.493ms | 0.199ms | 2.03ms | js |
| mixed/sieve | 1.77ms | 2.33ms | 1.33ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.48x slower | 1.14x slower | — |
| string/concat-long | 1.38x slower | 1.08x slower | — |
| string/indexOf | 428.68x slower | 8.68x slower | — |
| string/includes | 397.95x slower | 8.11x slower | — |
| string/split | 54.66x slower | 1.89x slower | — |
| string/replace | 21.31x slower | 3.43x slower | — |
| string/case-convert | 3125.67x slower | 12967.93x slower | — |
| string/substring | 1746.08x slower | 5.70x slower | — |
| string/trim | 35.87x slower | 1.13x slower | — |
| string/startsWith-endsWith | 44.10x slower | 1.35x faster | — |
| array/push-pop | 1.26x slower | 1.78x faster | — |
| array/sort-i32 | 1510.07x slower | — | — |
| array/map-filter | 4.73x slower | 2.70x faster | — |
| array/reduce | 1.37x slower | 1.64x faster | — |
| array/indexOf | 1.17x faster | 1.55x faster | — |
| array/slice | 1.73x faster | 3.60x faster | — |
| array/reverse | 2.42x faster | 2.00x faster | — |
| array/forEach | 1.61x slower | 1.56x faster | — |
| array/find | 1.68x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 51.49x slower | 1.12x slower | — |
| mixed/text-search | 110.10x slower | 2.63x slower | — |
| mixed/fibonacci | 2.25x slower | 1.25x faster | 11.00x slower |
| mixed/matrix-multiply | 2.66x slower | 1.08x slower | 10.94x slower |
| mixed/sieve | 1.32x slower | 1.33x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.30x faster |
| string/concat-long | 1.27x faster |
| string/indexOf | 49.37x faster |
| string/includes | 49.06x faster |
| string/split | 28.89x faster |
| string/replace | 6.21x faster |
| string/case-convert | 4.15x slower |
| string/substring | 306.33x faster |
| string/trim | 31.84x faster |
| string/startsWith-endsWith | 59.51x faster |
| array/push-pop | 2.24x faster |
| array/map-filter | 12.80x faster |
| array/reduce | 2.26x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.08x faster |
| array/reverse | 1.21x slower |
| array/forEach | 2.51x faster |
| mixed/csv-parse | 45.90x faster |
| mixed/text-search | 41.85x faster |
| mixed/fibonacci | 2.81x faster |
| mixed/matrix-multiply | 2.47x faster |
| mixed/sieve | 1.76x faster |

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
| string/trim | 205B | 1.7KB | — |
| string/startsWith-endsWith | 330B | 1.6KB | — |
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
| mixed/text-search | 600B | 2.1KB | — |
| mixed/fibonacci | 157B | 1.1KB | 173B |
| mixed/matrix-multiply | 1.3KB | 1.8KB | 950B |
| mixed/sieve | 1.5KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1207.6ms | 1123.8ms | — |
| string/concat-long | 638.9ms | 978.6ms | — |
| string/indexOf | 580.9ms | 1022.8ms | — |
| string/includes | 564.0ms | 1030.0ms | — |
| string/split | 733.1ms | 1024.9ms | — |
| string/replace | 572.7ms | 1034.1ms | — |
| string/case-convert | 560.7ms | 1288.0ms | — |
| string/substring | 539.7ms | 887.2ms | — |
| string/trim | 545.1ms | 953.7ms | — |
| string/startsWith-endsWith | 622.4ms | 963.6ms | — |
| array/push-pop | 769.2ms | 814.2ms | — |
| array/sort-i32 | 804.8ms | — | — |
| array/map-filter | 922.4ms | 960.2ms | — |
| array/reduce | 848.8ms | 909.5ms | — |
| array/indexOf | 783.8ms | 838.3ms | — |
| array/slice | 753.8ms | 840.7ms | — |
| array/reverse | 748.9ms | 824.4ms | — |
| array/forEach | 885.1ms | 945.2ms | — |
| array/find | 877.1ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 773.0ms | 959.7ms | — |
| mixed/text-search | 674.4ms | 1003.8ms | — |
| mixed/fibonacci | 658.1ms | 837.7ms | 683.9ms |
| mixed/matrix-multiply | 808.2ms | 867.8ms | 798.6ms |
| mixed/sieve | 798.1ms | 895.3ms | — |
