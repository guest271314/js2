# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.048ms | 0.039ms | — | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | — | js |
| string/indexOf | 0.001ms | 0.667ms | 0.016ms | — | js |
| string/includes | 0.001ms | 0.679ms | 0.016ms | — | js |
| string/split | 0.405ms | 22.28ms | 1.06ms | — | js |
| string/replace | 0.042ms | 0.867ms | 0.139ms | — | js |
| string/case-convert | <0.001ms | 1.26ms | 4.41ms | — | js |
| string/substring | 0.003ms | 6.51ms | 0.025ms | — | js |
| string/trim | 0.151ms | 6.03ms | 0.507ms | — | js |
| string/startsWith-endsWith | 0.246ms | 13.61ms | 0.658ms | — | js |
| array/push-pop | 1.44ms | 1.83ms | 0.830ms | — | gc-native |
| array/sort-i32 | 0.791ms | 1258.0ms | — | — | js |
| array/map-filter | 0.129ms | 0.613ms | 0.060ms | — | gc-native |
| array/reduce | 2.14ms | 1.79ms | 0.837ms | — | gc-native |
| array/indexOf | 3.94ms | 3.39ms | 2.57ms | — | gc-native |
| array/slice | 0.026ms | 0.032ms | 0.014ms | — | gc-native |
| array/reverse | 7.83ms | 3.39ms | 4.32ms | — | host-call |
| array/forEach | 0.086ms | 0.082ms | 0.044ms | — | gc-native |
| array/find | 0.240ms | 0.425ms | — | — | js |
| dom/create-elements | 0.035ms | — | — | — | js |
| dom/set-attributes | 0.106ms | — | — | — | js |
| dom/read-attributes | 0.054ms | — | — | — | js |
| dom/modify-text | 0.048ms | — | — | — | js |
| mixed/csv-parse | 0.468ms | 34.08ms | 0.854ms | — | js |
| mixed/text-search | 0.218ms | 27.72ms | 0.973ms | — | js |
| mixed/fibonacci | 0.109ms | 0.228ms | 0.084ms | 0.226ms | gc-native |
| mixed/matrix-multiply | 0.159ms | 0.487ms | 0.186ms | 2.12ms | js |
| mixed/sieve | 1.56ms | 2.10ms | 1.14ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.40x slower | 1.14x slower | — |
| string/concat-long | 1.50x slower | 1.29x slower | — |
| string/indexOf | 504.79x slower | 12.13x slower | — |
| string/includes | 456.37x slower | 11.06x slower | — |
| string/split | 55.02x slower | 2.62x slower | — |
| string/replace | 20.53x slower | 3.29x slower | — |
| string/case-convert | 3905.62x slower | 13674.24x slower | — |
| string/substring | 2083.97x slower | 7.99x slower | — |
| string/trim | 39.93x slower | 3.36x slower | — |
| string/startsWith-endsWith | 55.35x slower | 2.68x slower | — |
| array/push-pop | 1.27x slower | 1.74x faster | — |
| array/sort-i32 | 1591.19x slower | — | — |
| array/map-filter | 4.75x slower | 2.13x faster | — |
| array/reduce | 1.19x faster | 2.55x faster | — |
| array/indexOf | 1.16x faster | 1.53x faster | — |
| array/slice | 1.24x slower | 1.91x faster | — |
| array/reverse | 2.31x faster | 1.81x faster | — |
| array/forEach | 1.04x faster | 1.96x faster | — |
| array/find | 1.77x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 72.86x slower | 1.83x slower | — |
| mixed/text-search | 127.17x slower | 4.46x slower | — |
| mixed/fibonacci | 2.08x slower | 1.30x faster | 2.06x slower |
| mixed/matrix-multiply | 3.06x slower | 1.17x slower | 13.32x slower |
| mixed/sieve | 1.35x slower | 1.37x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.23x faster |
| string/concat-long | 1.16x faster |
| string/indexOf | 41.62x faster |
| string/includes | 41.28x faster |
| string/split | 21.01x faster |
| string/replace | 6.24x faster |
| string/case-convert | 3.50x slower |
| string/substring | 260.73x faster |
| string/trim | 11.90x faster |
| string/startsWith-endsWith | 20.69x faster |
| array/push-pop | 2.21x faster |
| array/map-filter | 10.14x faster |
| array/reduce | 2.14x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.36x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.88x faster |
| mixed/csv-parse | 39.90x faster |
| mixed/text-search | 28.49x faster |
| mixed/fibonacci | 2.71x faster |
| mixed/matrix-multiply | 2.61x faster |
| mixed/sieve | 1.85x faster |

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
| string/concat-short | 1251.4ms | 1184.6ms | — |
| string/concat-long | 616.7ms | 1027.0ms | — |
| string/indexOf | 573.1ms | 977.2ms | — |
| string/includes | 570.1ms | 1001.7ms | — |
| string/split | 739.1ms | 1055.3ms | — |
| string/replace | 594.7ms | 1014.2ms | — |
| string/case-convert | 567.7ms | 1355.3ms | — |
| string/substring | 557.6ms | 885.7ms | — |
| string/trim | 557.8ms | 951.3ms | — |
| string/startsWith-endsWith | 639.0ms | 987.0ms | — |
| array/push-pop | 754.3ms | 810.3ms | — |
| array/sort-i32 | 822.8ms | — | — |
| array/map-filter | 923.6ms | 991.2ms | — |
| array/reduce | 852.5ms | 886.6ms | — |
| array/indexOf | 752.8ms | 816.4ms | — |
| array/slice | 789.4ms | 831.6ms | — |
| array/reverse | 759.8ms | 848.7ms | — |
| array/forEach | 902.7ms | 972.2ms | — |
| array/find | 873.4ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 768.4ms | 1004.0ms | — |
| mixed/text-search | 678.1ms | 1036.4ms | — |
| mixed/fibonacci | 665.5ms | 821.4ms | 684.9ms |
| mixed/matrix-multiply | 803.3ms | 878.8ms | 772.1ms |
| mixed/sieve | 813.9ms | 854.9ms | — |
