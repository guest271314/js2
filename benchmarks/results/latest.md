# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.053ms | 0.044ms | — | js |
| string/concat-long | 0.005ms | 0.005ms | 0.007ms | — | host-call |
| string/indexOf | 0.001ms | 0.427ms | 0.014ms | — | js |
| string/includes | 0.001ms | 0.443ms | 0.015ms | — | js |
| string/split | 0.275ms | 19.99ms | 0.918ms | — | js |
| string/replace | 0.033ms | 0.533ms | 0.110ms | — | js |
| string/case-convert | <0.001ms | 0.824ms | 3.75ms | — | js |
| string/substring | 0.003ms | 4.09ms | 0.027ms | — | js |
| string/trim | 0.138ms | 3.79ms | 0.526ms | — | js |
| string/startsWith-endsWith | 0.214ms | 8.84ms | 1.60ms | — | js |
| array/push-pop | 1.22ms | 1.31ms | 0.725ms | — | gc-native |
| array/sort-i32 | 0.542ms | 887.5ms | — | — | js |
| array/map-filter | 0.123ms | 0.526ms | 0.041ms | — | gc-native |
| array/reduce | 1.15ms | 1.31ms | 0.773ms | — | gc-native |
| array/indexOf | 4.48ms | 3.78ms | 2.34ms | — | gc-native |
| array/slice | 0.019ms | 0.022ms | 0.011ms | — | gc-native |
| array/reverse | 7.05ms | 3.21ms | 2.83ms | — | gc-native |
| array/forEach | 0.069ms | 0.053ms | 0.029ms | — | gc-native |
| array/find | 0.248ms | 0.425ms | — | — | js |
| dom/create-elements | 0.039ms | — | — | — | js |
| dom/set-attributes | 0.119ms | — | — | — | js |
| dom/read-attributes | 0.043ms | — | — | — | js |
| dom/modify-text | 0.076ms | — | — | — | js |
| mixed/csv-parse | 0.334ms | 27.42ms | 0.917ms | — | js |
| mixed/text-search | 0.221ms | 18.03ms | 1.42ms | — | js |
| mixed/fibonacci | 0.107ms | 0.125ms | 0.068ms | 0.756ms | gc-native |
| mixed/matrix-multiply | 0.161ms | 1.56ms | 0.169ms | 1.41ms | js |
| mixed/sieve | 1.44ms | 2.03ms | 1.09ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.51x slower | 1.26x slower | — |
| string/concat-long | 1.01x faster | 1.44x slower | — |
| string/indexOf | 414.10x slower | 13.98x slower | — |
| string/includes | 386.07x slower | 12.73x slower | — |
| string/split | 72.75x slower | 3.34x slower | — |
| string/replace | 15.94x slower | 3.28x slower | — |
| string/case-convert | 2833.30x slower | 12891.36x slower | — |
| string/substring | 1457.58x slower | 9.51x slower | — |
| string/trim | 27.47x slower | 3.81x slower | — |
| string/startsWith-endsWith | 41.24x slower | 7.48x slower | — |
| array/push-pop | 1.07x slower | 1.69x faster | — |
| array/sort-i32 | 1636.54x slower | — | — |
| array/map-filter | 4.29x slower | 2.99x faster | — |
| array/reduce | 1.14x slower | 1.49x faster | — |
| array/indexOf | 1.19x faster | 1.92x faster | — |
| array/slice | 1.19x slower | 1.75x faster | — |
| array/reverse | 2.20x faster | 2.49x faster | — |
| array/forEach | 1.29x faster | 2.39x faster | — |
| array/find | 1.71x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 82.03x slower | 2.74x slower | — |
| mixed/text-search | 81.58x slower | 6.41x slower | — |
| mixed/fibonacci | 1.17x slower | 1.59x faster | 7.03x slower |
| mixed/matrix-multiply | 9.70x slower | 1.05x slower | 8.76x slower |
| mixed/sieve | 1.40x slower | 1.33x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.19x faster |
| string/concat-long | 1.45x slower |
| string/indexOf | 29.63x faster |
| string/includes | 30.33x faster |
| string/split | 21.78x faster |
| string/replace | 4.86x faster |
| string/case-convert | 4.55x slower |
| string/substring | 153.29x faster |
| string/trim | 7.21x faster |
| string/startsWith-endsWith | 5.52x faster |
| array/push-pop | 1.81x faster |
| array/map-filter | 12.85x faster |
| array/reduce | 1.70x faster |
| array/indexOf | 1.62x faster |
| array/slice | 2.09x faster |
| array/reverse | 1.13x faster |
| array/forEach | 1.85x faster |
| mixed/csv-parse | 29.91x faster |
| mixed/text-search | 12.73x faster |
| mixed/fibonacci | 1.85x faster |
| mixed/matrix-multiply | 9.24x faster |
| mixed/sieve | 1.86x faster |

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
| string/concat-short | 958.3ms | 953.4ms | — |
| string/concat-long | 523.3ms | 837.1ms | — |
| string/indexOf | 467.8ms | 873.6ms | — |
| string/includes | 451.9ms | 860.8ms | — |
| string/split | 593.4ms | 852.2ms | — |
| string/replace | 474.0ms | 841.6ms | — |
| string/case-convert | 457.7ms | 1048.4ms | — |
| string/substring | 445.0ms | 754.3ms | — |
| string/trim | 452.0ms | 799.9ms | — |
| string/startsWith-endsWith | 509.6ms | 869.7ms | — |
| array/push-pop | 647.9ms | 706.9ms | — |
| array/sort-i32 | 668.6ms | — | — |
| array/map-filter | 762.8ms | 785.2ms | — |
| array/reduce | 684.5ms | 753.2ms | — |
| array/indexOf | 614.2ms | 679.6ms | — |
| array/slice | 631.7ms | 701.4ms | — |
| array/reverse | 615.9ms | 676.2ms | — |
| array/forEach | 695.7ms | 770.6ms | — |
| array/find | 715.9ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 635.8ms | 809.4ms | — |
| mixed/text-search | 541.3ms | 861.4ms | — |
| mixed/fibonacci | 531.0ms | 690.0ms | 561.3ms |
| mixed/matrix-multiply | 686.9ms | 747.3ms | 675.0ms |
| mixed/sieve | 644.4ms | 726.0ms | — |
