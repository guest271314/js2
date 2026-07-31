# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.043ms | 0.049ms | 0.050ms | — | js |
| string/concat-long | 0.004ms | 0.005ms | 0.006ms | — | js |
| string/indexOf | 0.002ms | 0.723ms | 0.016ms | — | js |
| string/includes | 0.002ms | 0.740ms | 0.016ms | — | js |
| string/split | 0.370ms | 26.06ms | 1.07ms | — | js |
| string/replace | 0.041ms | 0.883ms | 0.135ms | — | js |
| string/case-convert | <0.001ms | 1.41ms | 4.82ms | — | js |
| string/substring | 0.003ms | 7.18ms | 0.042ms | — | js |
| string/trim | 0.154ms | 5.92ms | 0.697ms | — | js |
| string/startsWith-endsWith | 0.231ms | 15.19ms | 1.69ms | — | js |
| array/push-pop | 1.58ms | 1.65ms | 0.797ms | — | gc-native |
| array/sort-i32 | 0.712ms | 1107.1ms | — | — | js |
| array/map-filter | 0.144ms | 0.615ms | 0.059ms | — | gc-native |
| array/reduce | 1.97ms | 1.63ms | 0.817ms | — | gc-native |
| array/indexOf | 4.83ms | 3.94ms | 2.57ms | — | gc-native |
| array/slice | 0.039ms | 0.038ms | 0.022ms | — | gc-native |
| array/reverse | 7.26ms | 4.11ms | 4.04ms | — | gc-native |
| array/forEach | 0.076ms | 0.063ms | 0.039ms | — | gc-native |
| array/find | 0.265ms | 0.442ms | — | — | js |
| dom/create-elements | 0.062ms | — | — | — | js |
| dom/set-attributes | 0.124ms | — | — | — | js |
| dom/read-attributes | 0.066ms | — | — | — | js |
| dom/modify-text | 0.069ms | — | — | — | js |
| mixed/csv-parse | 0.456ms | 39.82ms | 0.959ms | — | js |
| mixed/text-search | 0.228ms | 30.72ms | 1.53ms | — | js |
| mixed/fibonacci | 0.113ms | 0.218ms | 0.089ms | 0.217ms | gc-native |
| mixed/matrix-multiply | 0.204ms | 1.65ms | 0.187ms | 1.95ms | gc-native |
| mixed/sieve | 1.50ms | 2.18ms | 1.16ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.15x slower | 1.18x slower | — |
| string/concat-long | 1.24x slower | 1.34x slower | — |
| string/indexOf | 445.46x slower | 9.81x slower | — |
| string/includes | 428.89x slower | 9.27x slower | — |
| string/split | 70.38x slower | 2.88x slower | — |
| string/replace | 21.28x slower | 3.25x slower | — |
| string/case-convert | 4709.47x slower | 16063.77x slower | — |
| string/substring | 2480.28x slower | 14.51x slower | — |
| string/trim | 38.55x slower | 4.54x slower | — |
| string/startsWith-endsWith | 65.71x slower | 7.30x slower | — |
| array/push-pop | 1.05x slower | 1.98x faster | — |
| array/sort-i32 | 1554.23x slower | — | — |
| array/map-filter | 4.27x slower | 2.46x faster | — |
| array/reduce | 1.21x faster | 2.42x faster | — |
| array/indexOf | 1.23x faster | 1.88x faster | — |
| array/slice | 1.01x faster | 1.77x faster | — |
| array/reverse | 1.77x faster | 1.80x faster | — |
| array/forEach | 1.20x faster | 1.92x faster | — |
| array/find | 1.67x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 87.41x slower | 2.11x slower | — |
| mixed/text-search | 134.79x slower | 6.69x slower | — |
| mixed/fibonacci | 1.94x slower | 1.27x faster | 1.93x slower |
| mixed/matrix-multiply | 8.06x slower | 1.09x faster | 9.55x slower |
| mixed/sieve | 1.45x slower | 1.29x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.02x slower |
| string/concat-long | 1.08x slower |
| string/indexOf | 45.43x faster |
| string/includes | 46.27x faster |
| string/split | 24.42x faster |
| string/replace | 6.56x faster |
| string/case-convert | 3.41x slower |
| string/substring | 170.98x faster |
| string/trim | 8.49x faster |
| string/startsWith-endsWith | 9.01x faster |
| array/push-pop | 2.07x faster |
| array/map-filter | 10.52x faster |
| array/reduce | 1.99x faster |
| array/indexOf | 1.53x faster |
| array/slice | 1.75x faster |
| array/reverse | 1.02x faster |
| array/forEach | 1.60x faster |
| mixed/csv-parse | 41.51x faster |
| mixed/text-search | 20.14x faster |
| mixed/fibonacci | 2.45x faster |
| mixed/matrix-multiply | 8.82x faster |
| mixed/sieve | 1.88x faster |

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
| string/concat-short | 1244.1ms | 1132.6ms | — |
| string/concat-long | 600.8ms | 986.8ms | — |
| string/indexOf | 546.6ms | 984.9ms | — |
| string/includes | 540.6ms | 1026.1ms | — |
| string/split | 732.5ms | 1018.6ms | — |
| string/replace | 562.4ms | 1027.7ms | — |
| string/case-convert | 538.4ms | 1299.7ms | — |
| string/substring | 530.8ms | 859.4ms | — |
| string/trim | 525.2ms | 931.5ms | — |
| string/startsWith-endsWith | 602.2ms | 968.5ms | — |
| array/push-pop | 738.7ms | 822.9ms | — |
| array/sort-i32 | 806.2ms | — | — |
| array/map-filter | 990.3ms | 953.2ms | — |
| array/reduce | 807.9ms | 915.7ms | — |
| array/indexOf | 734.2ms | 805.1ms | — |
| array/slice | 746.6ms | 807.7ms | — |
| array/reverse | 719.6ms | 777.8ms | — |
| array/forEach | 841.0ms | 932.0ms | — |
| array/find | 914.8ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 729.4ms | 984.2ms | — |
| mixed/text-search | 650.0ms | 999.3ms | — |
| mixed/fibonacci | 627.6ms | 797.4ms | 654.1ms |
| mixed/matrix-multiply | 781.4ms | 904.1ms | 776.9ms |
| mixed/sieve | 779.6ms | 877.6ms | — |
