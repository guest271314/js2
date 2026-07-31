# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.037ms | 0.051ms | 0.042ms | — | js |
| string/concat-long | 0.004ms | 0.006ms | 0.005ms | — | js |
| string/indexOf | 0.001ms | 0.633ms | 0.016ms | — | js |
| string/includes | 0.002ms | 0.668ms | 0.016ms | — | js |
| string/split | 0.405ms | 22.66ms | 1.09ms | — | js |
| string/replace | 0.042ms | 0.883ms | 0.148ms | — | js |
| string/case-convert | <0.001ms | 1.14ms | 4.75ms | — | js |
| string/substring | 0.004ms | 6.19ms | 0.019ms | — | js |
| string/trim | 0.154ms | 5.60ms | 0.537ms | — | js |
| string/startsWith-endsWith | 0.279ms | 12.85ms | 0.739ms | — | js |
| array/push-pop | 1.73ms | 2.19ms | 0.971ms | — | gc-native |
| array/sort-i32 | 0.844ms | 1433.2ms | — | — | js |
| array/map-filter | 0.137ms | 0.660ms | 0.051ms | — | gc-native |
| array/reduce | 1.61ms | 2.21ms | 0.990ms | — | gc-native |
| array/indexOf | 4.46ms | 3.82ms | 2.88ms | — | gc-native |
| array/slice | 0.038ms | 0.021ms | 0.011ms | — | gc-native |
| array/reverse | 8.84ms | 3.65ms | 4.43ms | — | host-call |
| array/forEach | 0.093ms | 0.086ms | 0.034ms | — | gc-native |
| array/find | 0.283ms | 0.475ms | — | — | js |
| dom/create-elements | 0.040ms | — | — | — | js |
| dom/set-attributes | 0.109ms | — | — | — | js |
| dom/read-attributes | 0.059ms | — | — | — | js |
| dom/modify-text | 0.049ms | — | — | — | js |
| mixed/csv-parse | 0.459ms | 34.90ms | 0.891ms | — | js |
| mixed/text-search | 0.106ms | 26.44ms | 1.09ms | — | js |
| mixed/fibonacci | 0.118ms | 0.266ms | 0.095ms | 0.282ms | gc-native |
| mixed/matrix-multiply | 0.187ms | 0.494ms | 0.201ms | 2.03ms | js |
| mixed/sieve | 1.81ms | 2.32ms | 1.34ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.41x slower | 1.16x slower | — |
| string/concat-long | 1.50x slower | 1.18x slower | — |
| string/indexOf | 422.25x slower | 10.54x slower | — |
| string/includes | 405.93x slower | 9.82x slower | — |
| string/split | 55.92x slower | 2.70x slower | — |
| string/replace | 21.24x slower | 3.56x slower | — |
| string/case-convert | 3125.01x slower | 13028.83x slower | — |
| string/substring | 1756.36x slower | 5.51x slower | — |
| string/trim | 36.37x slower | 3.49x slower | — |
| string/startsWith-endsWith | 46.04x slower | 2.65x slower | — |
| array/push-pop | 1.27x slower | 1.78x faster | — |
| array/sort-i32 | 1697.62x slower | — | — |
| array/map-filter | 4.81x slower | 2.71x faster | — |
| array/reduce | 1.38x slower | 1.62x faster | — |
| array/indexOf | 1.17x faster | 1.55x faster | — |
| array/slice | 1.82x faster | 3.49x faster | — |
| array/reverse | 2.42x faster | 2.00x faster | — |
| array/forEach | 1.09x faster | 2.71x faster | — |
| array/find | 1.68x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 76.07x slower | 1.94x slower | — |
| mixed/text-search | 249.04x slower | 10.28x slower | — |
| mixed/fibonacci | 2.25x slower | 1.25x faster | 2.39x slower |
| mixed/matrix-multiply | 2.64x slower | 1.07x slower | 10.87x slower |
| mixed/sieve | 1.29x slower | 1.35x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.21x faster |
| string/concat-long | 1.27x faster |
| string/indexOf | 40.05x faster |
| string/includes | 41.35x faster |
| string/split | 20.75x faster |
| string/replace | 5.97x faster |
| string/case-convert | 4.17x slower |
| string/substring | 318.63x faster |
| string/trim | 10.42x faster |
| string/startsWith-endsWith | 17.38x faster |
| array/push-pop | 2.26x faster |
| array/map-filter | 13.03x faster |
| array/reduce | 2.24x faster |
| array/indexOf | 1.32x faster |
| array/slice | 1.92x faster |
| array/reverse | 1.21x slower |
| array/forEach | 2.49x faster |
| mixed/csv-parse | 39.16x faster |
| mixed/text-search | 24.23x faster |
| mixed/fibonacci | 2.81x faster |
| mixed/matrix-multiply | 2.46x faster |
| mixed/sieve | 1.74x faster |

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
| string/concat-short | 1221.4ms | 1144.2ms | — |
| string/concat-long | 626.3ms | 1042.5ms | — |
| string/indexOf | 584.7ms | 962.5ms | — |
| string/includes | 591.0ms | 1031.2ms | — |
| string/split | 735.1ms | 1002.8ms | — |
| string/replace | 562.8ms | 1041.0ms | — |
| string/case-convert | 551.2ms | 1300.9ms | — |
| string/substring | 559.7ms | 870.3ms | — |
| string/trim | 566.0ms | 1000.3ms | — |
| string/startsWith-endsWith | 661.2ms | 987.4ms | — |
| array/push-pop | 785.1ms | 835.9ms | — |
| array/sort-i32 | 862.2ms | — | — |
| array/map-filter | 1018.2ms | 985.2ms | — |
| array/reduce | 891.2ms | 935.9ms | — |
| array/indexOf | 778.1ms | 897.9ms | — |
| array/slice | 803.7ms | 847.9ms | — |
| array/reverse | 788.8ms | 875.9ms | — |
| array/forEach | 911.3ms | 966.0ms | — |
| array/find | 913.4ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 763.5ms | 1006.2ms | — |
| mixed/text-search | 704.0ms | 1067.5ms | — |
| mixed/fibonacci | 691.8ms | 866.9ms | 719.3ms |
| mixed/matrix-multiply | 838.1ms | 905.6ms | 780.0ms |
| mixed/sieve | 817.9ms | 917.7ms | — |
