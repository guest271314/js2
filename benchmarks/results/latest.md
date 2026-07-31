# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.071ms | 0.042ms | — | js |
| string/concat-long | 0.004ms | 0.006ms | 0.005ms | — | js |
| string/indexOf | 0.002ms | 0.639ms | 0.016ms | — | js |
| string/includes | 0.002ms | 0.657ms | 0.017ms | — | js |
| string/split | 0.403ms | 22.17ms | 1.08ms | — | js |
| string/replace | 0.041ms | 0.855ms | 0.147ms | — | js |
| string/case-convert | <0.001ms | 1.20ms | 4.74ms | — | js |
| string/substring | 0.004ms | 6.06ms | 0.021ms | — | js |
| string/trim | 0.154ms | 5.45ms | 0.556ms | — | js |
| string/startsWith-endsWith | 0.313ms | 13.65ms | 0.739ms | — | js |
| array/push-pop | 1.72ms | 2.20ms | 0.968ms | — | gc-native |
| array/sort-i32 | 0.846ms | 1277.9ms | — | — | js |
| array/map-filter | 0.136ms | 0.651ms | 0.051ms | — | gc-native |
| array/reduce | 2.41ms | 2.20ms | 0.975ms | — | gc-native |
| array/indexOf | 4.46ms | 3.82ms | 2.88ms | — | gc-native |
| array/slice | 0.036ms | 0.023ms | 0.011ms | — | gc-native |
| array/reverse | 8.84ms | 3.66ms | 4.42ms | — | host-call |
| array/forEach | 0.053ms | 0.085ms | 0.034ms | — | gc-native |
| array/find | 0.284ms | 0.472ms | — | — | js |
| dom/create-elements | 0.036ms | — | — | — | js |
| dom/set-attributes | 0.109ms | — | — | — | js |
| dom/read-attributes | 0.059ms | — | — | — | js |
| dom/modify-text | 0.047ms | — | — | — | js |
| mixed/csv-parse | 0.458ms | 33.40ms | 0.897ms | — | js |
| mixed/text-search | 0.236ms | 26.69ms | 1.09ms | — | js |
| mixed/fibonacci | 0.118ms | 0.266ms | 0.095ms | 0.266ms | gc-native |
| mixed/matrix-multiply | 0.187ms | 0.493ms | 0.200ms | 2.04ms | js |
| mixed/sieve | 1.80ms | 2.32ms | 1.32ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 2.14x slower | 1.26x slower | — |
| string/concat-long | 1.45x slower | 1.21x slower | — |
| string/indexOf | 423.99x slower | 10.49x slower | — |
| string/includes | 388.49x slower | 9.77x slower | — |
| string/split | 55.03x slower | 2.69x slower | — |
| string/replace | 20.62x slower | 3.55x slower | — |
| string/case-convert | 3299.88x slower | 13006.38x slower | — |
| string/substring | 1718.42x slower | 5.94x slower | — |
| string/trim | 35.49x slower | 3.62x slower | — |
| string/startsWith-endsWith | 43.61x slower | 2.36x slower | — |
| array/push-pop | 1.28x slower | 1.77x faster | — |
| array/sort-i32 | 1510.98x slower | — | — |
| array/map-filter | 4.77x slower | 2.68x faster | — |
| array/reduce | 1.09x faster | 2.47x faster | — |
| array/indexOf | 1.17x faster | 1.55x faster | — |
| array/slice | 1.61x faster | 3.46x faster | — |
| array/reverse | 2.42x faster | 2.00x faster | — |
| array/forEach | 1.61x slower | 1.56x faster | — |
| array/find | 1.66x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 72.90x slower | 1.96x slower | — |
| mixed/text-search | 113.29x slower | 4.62x slower | — |
| mixed/fibonacci | 2.25x slower | 1.25x faster | 2.25x slower |
| mixed/matrix-multiply | 2.64x slower | 1.07x slower | 10.91x slower |
| mixed/sieve | 1.28x slower | 1.36x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.70x faster |
| string/concat-long | 1.19x faster |
| string/indexOf | 40.42x faster |
| string/includes | 39.77x faster |
| string/split | 20.44x faster |
| string/replace | 5.81x faster |
| string/case-convert | 3.94x slower |
| string/substring | 289.41x faster |
| string/trim | 9.81x faster |
| string/startsWith-endsWith | 18.47x faster |
| array/push-pop | 2.28x faster |
| array/map-filter | 12.80x faster |
| array/reduce | 2.26x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.15x faster |
| array/reverse | 1.21x slower |
| array/forEach | 2.51x faster |
| mixed/csv-parse | 37.25x faster |
| mixed/text-search | 24.50x faster |
| mixed/fibonacci | 2.81x faster |
| mixed/matrix-multiply | 2.47x faster |
| mixed/sieve | 1.75x faster |

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
| string/concat-short | 1182.3ms | 1170.7ms | — |
| string/concat-long | 630.0ms | 990.2ms | — |
| string/indexOf | 555.2ms | 974.3ms | — |
| string/includes | 563.5ms | 983.4ms | — |
| string/split | 717.8ms | 981.0ms | — |
| string/replace | 549.3ms | 1002.3ms | — |
| string/case-convert | 550.5ms | 1276.4ms | — |
| string/substring | 591.2ms | 822.4ms | — |
| string/trim | 532.8ms | 897.4ms | — |
| string/startsWith-endsWith | 608.6ms | 988.9ms | — |
| array/push-pop | 748.9ms | 788.8ms | — |
| array/sort-i32 | 811.8ms | — | — |
| array/map-filter | 931.8ms | 914.4ms | — |
| array/reduce | 800.1ms | 908.9ms | — |
| array/indexOf | 714.8ms | 836.2ms | — |
| array/slice | 742.4ms | 786.9ms | — |
| array/reverse | 723.1ms | 795.9ms | — |
| array/forEach | 857.7ms | 899.8ms | — |
| array/find | 858.2ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 744.9ms | 949.0ms | — |
| mixed/text-search | 650.5ms | 1045.3ms | — |
| mixed/fibonacci | 659.1ms | 832.1ms | 684.6ms |
| mixed/matrix-multiply | 807.5ms | 916.8ms | 802.0ms |
| mixed/sieve | 780.3ms | 906.3ms | — |
