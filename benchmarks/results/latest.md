# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.047ms | 0.037ms | — | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | — | js |
| string/indexOf | 0.001ms | 0.659ms | 0.016ms | — | js |
| string/includes | 0.001ms | 0.663ms | 0.017ms | — | js |
| string/split | 0.402ms | 21.90ms | 1.07ms | — | js |
| string/replace | 0.042ms | 0.856ms | 0.141ms | — | js |
| string/case-convert | <0.001ms | 1.21ms | 4.47ms | — | js |
| string/substring | 0.003ms | 6.28ms | 0.027ms | — | js |
| string/trim | 0.151ms | 5.84ms | 0.507ms | — | js |
| string/startsWith-endsWith | 0.246ms | 13.07ms | 0.657ms | — | js |
| array/push-pop | 1.47ms | 1.87ms | 0.841ms | — | gc-native |
| array/sort-i32 | 0.821ms | 1273.4ms | — | — | js |
| array/map-filter | 0.130ms | 0.612ms | 0.059ms | — | gc-native |
| array/reduce | 2.15ms | 1.83ms | 0.831ms | — | gc-native |
| array/indexOf | 3.94ms | 3.39ms | 2.57ms | — | gc-native |
| array/slice | 0.027ms | 0.033ms | 0.014ms | — | gc-native |
| array/reverse | 7.83ms | 3.39ms | 4.31ms | — | host-call |
| array/forEach | 0.048ms | 0.082ms | 0.044ms | — | gc-native |
| array/find | 0.239ms | 0.406ms | — | — | js |
| dom/create-elements | 0.036ms | — | — | — | js |
| dom/set-attributes | 0.103ms | — | — | — | js |
| dom/read-attributes | 0.054ms | — | — | — | js |
| dom/modify-text | 0.045ms | — | — | — | js |
| mixed/csv-parse | 0.465ms | 33.93ms | 0.849ms | — | js |
| mixed/text-search | 0.217ms | 26.87ms | 0.972ms | — | js |
| mixed/fibonacci | 0.109ms | 0.228ms | 0.084ms | 1.18ms | gc-native |
| mixed/matrix-multiply | 0.158ms | 0.487ms | 0.186ms | 2.12ms | js |
| mixed/sieve | 1.59ms | 2.12ms | 1.15ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.35x slower | 1.05x slower | — |
| string/concat-long | 1.50x slower | 1.32x slower | — |
| string/indexOf | 489.34x slower | 11.65x slower | — |
| string/includes | 453.87x slower | 11.35x slower | — |
| string/split | 54.47x slower | 2.65x slower | — |
| string/replace | 20.21x slower | 3.32x slower | — |
| string/case-convert | 3760.62x slower | 13894.20x slower | — |
| string/substring | 2010.72x slower | 8.63x slower | — |
| string/trim | 38.58x slower | 3.35x slower | — |
| string/startsWith-endsWith | 53.09x slower | 2.67x slower | — |
| array/push-pop | 1.27x slower | 1.75x faster | — |
| array/sort-i32 | 1551.80x slower | — | — |
| array/map-filter | 4.70x slower | 2.19x faster | — |
| array/reduce | 1.17x faster | 2.59x faster | — |
| array/indexOf | 1.16x faster | 1.54x faster | — |
| array/slice | 1.22x slower | 1.91x faster | — |
| array/reverse | 2.31x faster | 1.82x faster | — |
| array/forEach | 1.70x slower | 1.09x faster | — |
| array/find | 1.70x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 73.01x slower | 1.83x slower | — |
| mixed/text-search | 124.02x slower | 4.49x slower | — |
| mixed/fibonacci | 2.08x slower | 1.30x faster | 10.81x slower |
| mixed/matrix-multiply | 3.08x slower | 1.18x slower | 13.44x slower |
| mixed/sieve | 1.33x slower | 1.39x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.28x faster |
| string/concat-long | 1.13x faster |
| string/indexOf | 42.00x faster |
| string/includes | 39.97x faster |
| string/split | 20.55x faster |
| string/replace | 6.09x faster |
| string/case-convert | 3.69x slower |
| string/substring | 233.03x faster |
| string/trim | 11.51x faster |
| string/startsWith-endsWith | 19.88x faster |
| array/push-pop | 2.22x faster |
| array/map-filter | 10.29x faster |
| array/reduce | 2.21x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.33x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.85x faster |
| mixed/csv-parse | 39.96x faster |
| mixed/text-search | 27.64x faster |
| mixed/fibonacci | 2.71x faster |
| mixed/matrix-multiply | 2.62x faster |
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
| mixed/fibonacci | 157B | 1.1KB | 173B |
| mixed/matrix-multiply | 1.3KB | 1.8KB | 950B |
| mixed/sieve | 1.5KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1346.9ms | 1189.1ms | — |
| string/concat-long | 635.4ms | 1006.7ms | — |
| string/indexOf | 581.9ms | 1081.4ms | — |
| string/includes | 602.3ms | 1030.0ms | — |
| string/split | 728.3ms | 1040.1ms | — |
| string/replace | 569.0ms | 1059.5ms | — |
| string/case-convert | 566.8ms | 1287.4ms | — |
| string/substring | 592.5ms | 906.6ms | — |
| string/trim | 553.0ms | 1015.2ms | — |
| string/startsWith-endsWith | 670.6ms | 997.9ms | — |
| array/push-pop | 808.7ms | 830.1ms | — |
| array/sort-i32 | 895.7ms | — | — |
| array/map-filter | 956.7ms | 1014.0ms | — |
| array/reduce | 845.2ms | 926.8ms | — |
| array/indexOf | 760.6ms | 856.5ms | — |
| array/slice | 762.1ms | 856.7ms | — |
| array/reverse | 810.1ms | 814.6ms | — |
| array/forEach | 833.2ms | 896.8ms | — |
| array/find | 844.9ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 796.9ms | 999.6ms | — |
| mixed/text-search | 682.1ms | 1057.9ms | — |
| mixed/fibonacci | 673.4ms | 820.9ms | 691.6ms |
| mixed/matrix-multiply | 844.7ms | 903.1ms | 813.8ms |
| mixed/sieve | 850.7ms | 881.3ms | — |
