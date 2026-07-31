# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.037ms | 0.051ms | 0.042ms | — | js |
| string/concat-long | 0.004ms | 0.006ms | 0.005ms | — | js |
| string/indexOf | 0.002ms | 0.631ms | 0.016ms | — | js |
| string/includes | 0.002ms | 0.662ms | 0.016ms | — | js |
| string/split | 0.403ms | 22.17ms | 1.09ms | — | js |
| string/replace | 0.041ms | 0.871ms | 0.149ms | — | js |
| string/case-convert | <0.001ms | 1.18ms | 4.78ms | — | js |
| string/substring | 0.004ms | 6.19ms | 0.021ms | — | js |
| string/trim | 0.154ms | 5.69ms | 0.539ms | — | js |
| string/startsWith-endsWith | 0.313ms | 12.71ms | 0.739ms | — | js |
| array/push-pop | 1.72ms | 2.22ms | 0.974ms | — | gc-native |
| array/sort-i32 | 0.846ms | 1290.8ms | — | — | js |
| array/map-filter | 0.137ms | 0.657ms | 0.051ms | — | gc-native |
| array/reduce | 2.46ms | 2.24ms | 0.988ms | — | gc-native |
| array/indexOf | 4.45ms | 3.82ms | 2.88ms | — | gc-native |
| array/slice | 0.038ms | 0.023ms | 0.011ms | — | gc-native |
| array/reverse | 8.84ms | 3.66ms | 4.42ms | — | host-call |
| array/forEach | 0.054ms | 0.086ms | 0.034ms | — | gc-native |
| array/find | 0.285ms | 0.473ms | — | — | js |
| dom/create-elements | 0.036ms | — | — | — | js |
| dom/set-attributes | 0.108ms | — | — | — | js |
| dom/read-attributes | 0.060ms | — | — | — | js |
| dom/modify-text | 0.059ms | — | — | — | js |
| mixed/csv-parse | 0.457ms | 34.30ms | 0.884ms | — | js |
| mixed/text-search | 0.108ms | 26.45ms | 1.09ms | — | js |
| mixed/fibonacci | 0.118ms | 0.266ms | 0.095ms | 0.264ms | gc-native |
| mixed/matrix-multiply | 0.187ms | 0.493ms | 0.200ms | 2.05ms | js |
| mixed/sieve | 1.85ms | 2.34ms | 1.35ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.38x slower | 1.15x slower | — |
| string/concat-long | 1.48x slower | 1.23x slower | — |
| string/indexOf | 411.73x slower | 10.32x slower | — |
| string/includes | 389.84x slower | 9.71x slower | — |
| string/split | 55.02x slower | 2.70x slower | — |
| string/replace | 21.12x slower | 3.60x slower | — |
| string/case-convert | 3245.83x slower | 13131.64x slower | — |
| string/substring | 1754.10x slower | 5.93x slower | — |
| string/trim | 36.93x slower | 3.50x slower | — |
| string/startsWith-endsWith | 40.62x slower | 2.36x slower | — |
| array/push-pop | 1.29x slower | 1.77x faster | — |
| array/sort-i32 | 1525.34x slower | — | — |
| array/map-filter | 4.80x slower | 2.67x faster | — |
| array/reduce | 1.10x faster | 2.49x faster | — |
| array/indexOf | 1.17x faster | 1.54x faster | — |
| array/slice | 1.64x faster | 3.55x faster | — |
| array/reverse | 2.42x faster | 2.00x faster | — |
| array/forEach | 1.57x slower | 1.60x faster | — |
| array/find | 1.66x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 75.02x slower | 1.93x slower | — |
| mixed/text-search | 243.92x slower | 10.05x slower | — |
| mixed/fibonacci | 2.25x slower | 1.25x faster | 2.24x slower |
| mixed/matrix-multiply | 2.64x slower | 1.07x slower | 10.96x slower |
| mixed/sieve | 1.26x slower | 1.37x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.20x faster |
| string/concat-long | 1.20x faster |
| string/indexOf | 39.90x faster |
| string/includes | 40.14x faster |
| string/split | 20.40x faster |
| string/replace | 5.86x faster |
| string/case-convert | 4.05x slower |
| string/substring | 295.63x faster |
| string/trim | 10.55x faster |
| string/startsWith-endsWith | 17.21x faster |
| array/push-pop | 2.28x faster |
| array/map-filter | 12.79x faster |
| array/reduce | 2.27x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.16x faster |
| array/reverse | 1.21x slower |
| array/forEach | 2.51x faster |
| mixed/csv-parse | 38.80x faster |
| mixed/text-search | 24.28x faster |
| mixed/fibonacci | 2.81x faster |
| mixed/matrix-multiply | 2.47x faster |
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
| string/concat-short | 1234.1ms | 1169.1ms | — |
| string/concat-long | 658.5ms | 986.6ms | — |
| string/indexOf | 567.9ms | 1063.5ms | — |
| string/includes | 548.7ms | 1007.9ms | — |
| string/split | 725.5ms | 969.6ms | — |
| string/replace | 547.3ms | 1032.1ms | — |
| string/case-convert | 548.8ms | 1253.3ms | — |
| string/substring | 542.8ms | 857.2ms | — |
| string/trim | 538.5ms | 982.0ms | — |
| string/startsWith-endsWith | 637.2ms | 957.1ms | — |
| array/push-pop | 756.2ms | 837.9ms | — |
| array/sort-i32 | 840.8ms | — | — |
| array/map-filter | 939.1ms | 960.2ms | — |
| array/reduce | 870.6ms | 903.1ms | — |
| array/indexOf | 733.9ms | 815.4ms | — |
| array/slice | 737.9ms | 826.0ms | — |
| array/reverse | 767.2ms | 834.3ms | — |
| array/forEach | 869.6ms | 951.6ms | — |
| array/find | 880.0ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 764.7ms | 1026.5ms | — |
| mixed/text-search | 767.0ms | 1050.1ms | — |
| mixed/fibonacci | 676.0ms | 876.0ms | 706.5ms |
| mixed/matrix-multiply | 796.0ms | 881.2ms | 808.9ms |
| mixed/sieve | 847.7ms | 900.4ms | — |
