# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.041ms | 0.052ms | 0.040ms | — | gc-native |
| string/concat-long | 0.003ms | 0.005ms | 0.005ms | — | js |
| string/indexOf | 0.001ms | 0.436ms | 0.014ms | — | js |
| string/includes | 0.001ms | 0.432ms | 0.015ms | — | js |
| string/split | 0.273ms | 19.08ms | 0.937ms | — | js |
| string/replace | 0.033ms | 0.553ms | 0.102ms | — | js |
| string/case-convert | <0.001ms | 0.830ms | 3.89ms | — | js |
| string/substring | 0.003ms | 4.18ms | 0.026ms | — | js |
| string/trim | 0.139ms | 3.81ms | 0.525ms | — | js |
| string/startsWith-endsWith | 0.221ms | 8.70ms | 1.60ms | — | js |
| array/push-pop | 1.26ms | 1.34ms | 0.758ms | — | gc-native |
| array/sort-i32 | 0.549ms | 890.7ms | — | — | js |
| array/map-filter | 0.115ms | 0.513ms | 0.040ms | — | gc-native |
| array/reduce | 1.76ms | 1.32ms | 0.773ms | — | gc-native |
| array/indexOf | 4.48ms | 3.78ms | 2.31ms | — | gc-native |
| array/slice | 0.018ms | 0.021ms | 0.012ms | — | gc-native |
| array/reverse | 7.04ms | 3.21ms | 2.84ms | — | gc-native |
| array/forEach | 0.052ms | 0.047ms | 0.028ms | — | gc-native |
| array/find | 0.246ms | 0.424ms | — | — | js |
| dom/create-elements | 0.056ms | — | — | — | js |
| dom/set-attributes | 0.106ms | — | — | — | js |
| dom/read-attributes | 0.054ms | — | — | — | js |
| dom/modify-text | 0.057ms | — | — | — | js |
| mixed/csv-parse | 0.328ms | 26.11ms | 0.897ms | — | js |
| mixed/text-search | 0.221ms | 17.86ms | 1.41ms | — | js |
| mixed/fibonacci | 0.107ms | 0.125ms | — | 0.132ms | js |
| mixed/matrix-multiply | 0.160ms | 1.56ms | 0.169ms | 1.41ms | js |
| mixed/sieve | 1.42ms | 2.07ms | 1.12ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.27x slower | 1.01x faster | — |
| string/concat-long | 1.50x slower | 1.64x slower | — |
| string/indexOf | 392.15x slower | 12.87x slower | — |
| string/includes | 386.54x slower | 12.96x slower | — |
| string/split | 69.77x slower | 3.43x slower | — |
| string/replace | 16.62x slower | 3.07x slower | — |
| string/case-convert | 2854.64x slower | 13395.24x slower | — |
| string/substring | 1488.27x slower | 9.33x slower | — |
| string/trim | 27.49x slower | 3.79x slower | — |
| string/startsWith-endsWith | 39.37x slower | 7.25x slower | — |
| array/push-pop | 1.06x slower | 1.67x faster | — |
| array/sort-i32 | 1622.69x slower | — | — |
| array/map-filter | 4.46x slower | 2.87x faster | — |
| array/reduce | 1.33x faster | 2.28x faster | — |
| array/indexOf | 1.18x faster | 1.94x faster | — |
| array/slice | 1.18x slower | 1.52x faster | — |
| array/reverse | 2.19x faster | 2.48x faster | — |
| array/forEach | 1.09x faster | 1.85x faster | — |
| array/find | 1.72x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 79.51x slower | 2.73x slower | — |
| mixed/text-search | 80.76x slower | 6.38x slower | — |
| mixed/fibonacci | 1.17x slower | — | 1.23x slower |
| mixed/matrix-multiply | 9.76x slower | 1.05x slower | 8.81x slower |
| mixed/sieve | 1.46x slower | 1.27x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.29x faster |
| string/concat-long | 1.09x slower |
| string/indexOf | 30.46x faster |
| string/includes | 29.82x faster |
| string/split | 20.37x faster |
| string/replace | 5.41x faster |
| string/case-convert | 4.69x slower |
| string/substring | 159.57x faster |
| string/trim | 7.26x faster |
| string/startsWith-endsWith | 5.43x faster |
| array/push-pop | 1.76x faster |
| array/map-filter | 12.80x faster |
| array/reduce | 1.71x faster |
| array/indexOf | 1.64x faster |
| array/slice | 1.78x faster |
| array/reverse | 1.13x faster |
| array/forEach | 1.69x faster |
| mixed/csv-parse | 29.09x faster |
| mixed/text-search | 12.66x faster |
| mixed/matrix-multiply | 9.26x faster |
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
| string/concat-short | 983.4ms | 915.0ms | — |
| string/concat-long | 527.9ms | 810.6ms | — |
| string/indexOf | 467.3ms | 861.2ms | — |
| string/includes | 465.2ms | 834.0ms | — |
| string/split | 585.1ms | 833.3ms | — |
| string/replace | 455.0ms | 873.4ms | — |
| string/case-convert | 467.2ms | 1040.3ms | — |
| string/substring | 453.2ms | 752.0ms | — |
| string/trim | 462.5ms | 792.1ms | — |
| string/startsWith-endsWith | 518.1ms | 800.1ms | — |
| array/push-pop | 600.8ms | 670.2ms | — |
| array/sort-i32 | 690.0ms | — | — |
| array/map-filter | 763.2ms | 782.0ms | — |
| array/reduce | 679.0ms | 721.9ms | — |
| array/indexOf | 616.0ms | 701.2ms | — |
| array/slice | 616.3ms | 667.4ms | — |
| array/reverse | 626.1ms | 686.5ms | — |
| array/forEach | 667.6ms | 726.0ms | — |
| array/find | 684.8ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 626.2ms | 791.1ms | — |
| mixed/text-search | 544.1ms | 843.3ms | — |
| mixed/fibonacci | 544.4ms | — | 559.5ms |
| mixed/matrix-multiply | 672.9ms | 731.5ms | 626.6ms |
| mixed/sieve | 651.1ms | 712.9ms | — |
