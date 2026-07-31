# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.051ms | 0.042ms | — | js |
| string/concat-long | 0.004ms | 0.006ms | 0.005ms | — | js |
| string/indexOf | 0.001ms | 0.635ms | 0.016ms | — | js |
| string/includes | 0.002ms | 0.647ms | 0.016ms | — | js |
| string/split | 0.402ms | 22.73ms | 1.09ms | — | js |
| string/replace | 0.040ms | 0.866ms | 0.148ms | — | js |
| string/case-convert | <0.001ms | 1.14ms | 4.73ms | — | js |
| string/substring | 0.004ms | 6.25ms | 0.021ms | — | js |
| string/trim | 0.154ms | 5.35ms | 0.535ms | — | js |
| string/startsWith-endsWith | 0.313ms | 13.30ms | 0.739ms | — | js |
| array/push-pop | 1.69ms | 2.18ms | 0.970ms | — | gc-native |
| array/sort-i32 | 0.841ms | 1311.2ms | — | — | js |
| array/map-filter | 0.134ms | 0.655ms | 0.050ms | — | gc-native |
| array/reduce | 1.60ms | 2.18ms | 0.960ms | — | gc-native |
| array/indexOf | 4.45ms | 3.81ms | 2.88ms | — | gc-native |
| array/slice | 0.035ms | 0.020ms | 0.010ms | — | gc-native |
| array/reverse | 8.85ms | 3.66ms | 4.42ms | — | host-call |
| array/forEach | 0.052ms | 0.085ms | 0.035ms | — | gc-native |
| array/find | 0.282ms | 0.473ms | — | — | js |
| dom/create-elements | 0.037ms | — | — | — | js |
| dom/set-attributes | 0.107ms | — | — | — | js |
| dom/read-attributes | 0.057ms | — | — | — | js |
| dom/modify-text | 0.053ms | — | — | — | js |
| mixed/csv-parse | 0.457ms | 35.03ms | 0.885ms | — | js |
| mixed/text-search | 0.106ms | 26.67ms | 1.09ms | — | js |
| mixed/fibonacci | 0.118ms | 0.266ms | 0.095ms | 0.264ms | gc-native |
| mixed/matrix-multiply | 0.185ms | 0.493ms | 0.200ms | 2.04ms | js |
| mixed/sieve | 1.79ms | 2.29ms | 1.32ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.55x slower | 1.26x slower | — |
| string/concat-long | 1.44x slower | 1.13x slower | — |
| string/indexOf | 431.32x slower | 10.75x slower | — |
| string/includes | 408.96x slower | 10.26x slower | — |
| string/split | 56.49x slower | 2.70x slower | — |
| string/replace | 21.44x slower | 3.65x slower | — |
| string/case-convert | 3122.00x slower | 12988.94x slower | — |
| string/substring | 1770.03x slower | 5.82x slower | — |
| string/trim | 34.80x slower | 3.48x slower | — |
| string/startsWith-endsWith | 42.50x slower | 2.36x slower | — |
| array/push-pop | 1.29x slower | 1.75x faster | — |
| array/sort-i32 | 1559.38x slower | — | — |
| array/map-filter | 4.90x slower | 2.66x faster | — |
| array/reduce | 1.36x slower | 1.67x faster | — |
| array/indexOf | 1.17x faster | 1.54x faster | — |
| array/slice | 1.72x faster | 3.54x faster | — |
| array/reverse | 2.42x faster | 2.00x faster | — |
| array/forEach | 1.62x slower | 1.50x faster | — |
| array/find | 1.68x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 76.61x slower | 1.94x slower | — |
| mixed/text-search | 252.65x slower | 10.32x slower | — |
| mixed/fibonacci | 2.25x slower | 1.25x faster | 2.24x slower |
| mixed/matrix-multiply | 2.66x slower | 1.08x slower | 11.00x slower |
| mixed/sieve | 1.28x slower | 1.36x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.23x faster |
| string/concat-long | 1.27x faster |
| string/indexOf | 40.14x faster |
| string/includes | 39.86x faster |
| string/split | 20.88x faster |
| string/replace | 5.87x faster |
| string/case-convert | 4.16x slower |
| string/substring | 304.31x faster |
| string/trim | 9.99x faster |
| string/startsWith-endsWith | 18.00x faster |
| array/push-pop | 2.24x faster |
| array/map-filter | 13.05x faster |
| array/reduce | 2.27x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.06x faster |
| array/reverse | 1.21x slower |
| array/forEach | 2.43x faster |
| mixed/csv-parse | 39.58x faster |
| mixed/text-search | 24.49x faster |
| mixed/fibonacci | 2.81x faster |
| mixed/matrix-multiply | 2.46x faster |
| mixed/sieve | 1.73x faster |

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
| string/concat-short | 1224.3ms | 1122.7ms | — |
| string/concat-long | 622.6ms | 959.6ms | — |
| string/indexOf | 558.7ms | 987.8ms | — |
| string/includes | 554.5ms | 969.5ms | — |
| string/split | 700.1ms | 1018.3ms | — |
| string/replace | 564.1ms | 993.8ms | — |
| string/case-convert | 562.3ms | 1262.1ms | — |
| string/substring | 535.1ms | 908.8ms | — |
| string/trim | 565.2ms | 944.4ms | — |
| string/startsWith-endsWith | 605.0ms | 965.6ms | — |
| array/push-pop | 741.0ms | 819.1ms | — |
| array/sort-i32 | 815.7ms | — | — |
| array/map-filter | 918.7ms | 924.9ms | — |
| array/reduce | 828.4ms | 881.9ms | — |
| array/indexOf | 766.2ms | 828.7ms | — |
| array/slice | 741.9ms | 859.9ms | — |
| array/reverse | 736.7ms | 812.9ms | — |
| array/forEach | 872.7ms | 943.3ms | — |
| array/find | 854.9ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 766.2ms | 979.1ms | — |
| mixed/text-search | 690.7ms | 1040.0ms | — |
| mixed/fibonacci | 662.6ms | 847.7ms | 663.3ms |
| mixed/matrix-multiply | 773.0ms | 927.4ms | 780.4ms |
| mixed/sieve | 783.4ms | 881.8ms | — |
