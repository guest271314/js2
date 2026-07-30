# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.054ms | 0.056ms | 0.066ms | — | js |
| string/concat-long | 0.006ms | 0.006ms | 0.007ms | — | js |
| string/indexOf | 0.002ms | 0.514ms | 0.017ms | — | js |
| string/includes | 0.002ms | 0.514ms | 0.017ms | — | js |
| string/split | 0.330ms | 23.34ms | 1.09ms | — | js |
| string/replace | 0.040ms | 0.660ms | 0.127ms | — | js |
| string/case-convert | <0.001ms | 0.981ms | 4.78ms | — | js |
| string/substring | 0.003ms | 4.95ms | 0.048ms | — | js |
| string/trim | 0.173ms | 4.55ms | 0.626ms | — | js |
| string/startsWith-endsWith | 0.268ms | 10.33ms | 1.91ms | — | js |
| array/push-pop | 1.55ms | 1.78ms | 0.902ms | — | gc-native |
| array/sort-i32 | 0.642ms | 1073.5ms | — | — | js |
| array/map-filter | 0.142ms | 0.631ms | 0.053ms | — | gc-native |
| array/reduce | 1.44ms | 1.84ms | 0.929ms | — | gc-native |
| array/indexOf | 5.38ms | 4.53ms | 2.77ms | — | gc-native |
| array/slice | 0.044ms | 0.044ms | 0.024ms | — | gc-native |
| array/reverse | 8.40ms | 3.85ms | 3.40ms | — | gc-native |
| array/forEach | 0.061ms | 0.063ms | 0.037ms | — | gc-native |
| array/find | 0.293ms | 0.507ms | — | — | js |
| dom/create-elements | 0.064ms | — | — | — | js |
| dom/set-attributes | 0.133ms | — | — | — | js |
| dom/read-attributes | 0.072ms | — | — | — | js |
| dom/modify-text | 0.081ms | — | — | — | js |
| mixed/csv-parse | 0.402ms | 34.36ms | 0.978ms | — | js |
| mixed/text-search | 0.264ms | 20.99ms | 1.68ms | — | js |
| mixed/fibonacci | 0.128ms | 0.150ms | 0.081ms | 0.150ms | gc-native |
| mixed/matrix-multiply | 0.187ms | 1.86ms | 0.198ms | 1.68ms | js |
| mixed/sieve | 1.65ms | 2.45ms | 1.28ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.03x slower | 1.22x slower | — |
| string/concat-long | 1.13x slower | 1.35x slower | — |
| string/indexOf | 301.16x slower | 10.04x slower | — |
| string/includes | 280.67x slower | 9.54x slower | — |
| string/split | 70.85x slower | 3.29x slower | — |
| string/replace | 16.31x slower | 3.14x slower | — |
| string/case-convert | 2811.12x slower | 13694.63x slower | — |
| string/substring | 1469.77x slower | 14.31x slower | — |
| string/trim | 26.32x slower | 3.62x slower | — |
| string/startsWith-endsWith | 38.49x slower | 7.11x slower | — |
| array/push-pop | 1.15x slower | 1.71x faster | — |
| array/sort-i32 | 1673.24x slower | — | — |
| array/map-filter | 4.45x slower | 2.66x faster | — |
| array/reduce | 1.28x slower | 1.55x faster | — |
| array/indexOf | 1.19x faster | 1.94x faster | — |
| array/slice | 1.00x slower | 1.88x faster | — |
| array/reverse | 2.18x faster | 2.47x faster | — |
| array/forEach | 1.03x slower | 1.65x faster | — |
| array/find | 1.73x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 85.38x slower | 2.43x slower | — |
| mixed/text-search | 79.45x slower | 6.36x slower | — |
| mixed/fibonacci | 1.18x slower | 1.58x faster | 1.17x slower |
| mixed/matrix-multiply | 9.96x slower | 1.06x slower | 9.02x slower |
| mixed/sieve | 1.48x slower | 1.28x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.18x slower |
| string/concat-long | 1.19x slower |
| string/indexOf | 29.99x faster |
| string/includes | 29.42x faster |
| string/split | 21.51x faster |
| string/replace | 5.20x faster |
| string/case-convert | 4.87x slower |
| string/substring | 102.71x faster |
| string/trim | 7.26x faster |
| string/startsWith-endsWith | 5.41x faster |
| array/push-pop | 1.97x faster |
| array/map-filter | 11.86x faster |
| array/reduce | 1.98x faster |
| array/indexOf | 1.64x faster |
| array/slice | 1.88x faster |
| array/reverse | 1.13x faster |
| array/forEach | 1.71x faster |
| mixed/csv-parse | 35.13x faster |
| mixed/text-search | 12.50x faster |
| mixed/fibonacci | 1.86x faster |
| mixed/matrix-multiply | 9.41x faster |
| mixed/sieve | 1.90x faster |

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
| string/concat-short | 1167.9ms | 1102.4ms | — |
| string/concat-long | 619.1ms | 1016.8ms | — |
| string/indexOf | 547.2ms | 961.4ms | — |
| string/includes | 547.6ms | 971.5ms | — |
| string/split | 710.2ms | 1024.3ms | — |
| string/replace | 569.6ms | 1002.4ms | — |
| string/case-convert | 544.4ms | 1230.6ms | — |
| string/substring | 538.0ms | 857.4ms | — |
| string/trim | 527.0ms | 940.7ms | — |
| string/startsWith-endsWith | 585.9ms | 992.2ms | — |
| array/push-pop | 742.6ms | 818.8ms | — |
| array/sort-i32 | 844.4ms | — | — |
| array/map-filter | 953.1ms | 962.8ms | — |
| array/reduce | 866.1ms | 922.6ms | — |
| array/indexOf | 739.0ms | 817.4ms | — |
| array/slice | 732.6ms | 822.6ms | — |
| array/reverse | 732.5ms | 834.7ms | — |
| array/forEach | 889.1ms | 958.2ms | — |
| array/find | 869.3ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 741.5ms | 941.8ms | — |
| mixed/text-search | 644.5ms | 1021.1ms | — |
| mixed/fibonacci | 644.0ms | 797.4ms | 655.0ms |
| mixed/matrix-multiply | 759.2ms | 847.3ms | 743.4ms |
| mixed/sieve | 766.5ms | 871.5ms | — |
