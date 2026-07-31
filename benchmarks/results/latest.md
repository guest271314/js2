# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.048ms | 0.036ms | — | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | — | js |
| string/indexOf | 0.001ms | 0.704ms | 0.016ms | — | js |
| string/includes | 0.001ms | 0.687ms | 0.017ms | — | js |
| string/split | 0.401ms | 22.10ms | 1.06ms | — | js |
| string/replace | 0.042ms | 0.876ms | 0.139ms | — | js |
| string/case-convert | <0.001ms | 1.27ms | 4.39ms | — | js |
| string/substring | 0.003ms | 6.39ms | 0.023ms | — | js |
| string/trim | 0.151ms | 6.02ms | 0.507ms | — | js |
| string/startsWith-endsWith | 0.246ms | 13.60ms | 0.657ms | — | js |
| array/push-pop | 1.46ms | 1.83ms | 0.832ms | — | gc-native |
| array/sort-i32 | 0.789ms | 1289.3ms | — | — | js |
| array/map-filter | 0.125ms | 0.611ms | 0.060ms | — | gc-native |
| array/reduce | 1.34ms | 1.82ms | 0.833ms | — | gc-native |
| array/indexOf | 3.94ms | 3.38ms | 2.57ms | — | gc-native |
| array/slice | 0.025ms | 0.031ms | 0.013ms | — | gc-native |
| array/reverse | 7.83ms | 3.39ms | 4.31ms | — | host-call |
| array/forEach | 0.092ms | 0.082ms | 0.044ms | — | gc-native |
| array/find | 0.238ms | 0.425ms | — | — | js |
| dom/create-elements | 0.035ms | — | — | — | js |
| dom/set-attributes | 0.103ms | — | — | — | js |
| dom/read-attributes | 0.053ms | — | — | — | js |
| dom/modify-text | 0.052ms | — | — | — | js |
| mixed/csv-parse | 0.529ms | 33.65ms | 0.854ms | — | js |
| mixed/text-search | 0.215ms | 27.86ms | 0.973ms | — | js |
| mixed/fibonacci | 0.109ms | 0.227ms | 0.084ms | 1.18ms | gc-native |
| mixed/matrix-multiply | 0.162ms | 0.486ms | 0.186ms | 2.12ms | js |
| mixed/sieve | 1.54ms | 2.10ms | 1.15ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.44x slower | 1.08x slower | — |
| string/concat-long | 1.51x slower | 1.26x slower | — |
| string/indexOf | 543.59x slower | 12.47x slower | — |
| string/includes | 463.82x slower | 11.16x slower | — |
| string/split | 55.05x slower | 2.65x slower | — |
| string/replace | 20.73x slower | 3.30x slower | — |
| string/case-convert | 3945.35x slower | 13626.49x slower | — |
| string/substring | 2047.72x slower | 7.42x slower | — |
| string/trim | 39.83x slower | 3.35x slower | — |
| string/startsWith-endsWith | 55.33x slower | 2.67x slower | — |
| array/push-pop | 1.26x slower | 1.75x faster | — |
| array/sort-i32 | 1633.25x slower | — | — |
| array/map-filter | 4.87x slower | 2.07x faster | — |
| array/reduce | 1.36x slower | 1.60x faster | — |
| array/indexOf | 1.16x faster | 1.53x faster | — |
| array/slice | 1.25x slower | 1.88x faster | — |
| array/reverse | 2.31x faster | 1.81x faster | — |
| array/forEach | 1.12x faster | 2.09x faster | — |
| array/find | 1.78x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 63.64x slower | 1.62x slower | — |
| mixed/text-search | 129.72x slower | 4.53x slower | — |
| mixed/fibonacci | 2.08x slower | 1.30x faster | 10.80x slower |
| mixed/matrix-multiply | 3.00x slower | 1.15x slower | 13.11x slower |
| mixed/sieve | 1.36x slower | 1.35x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.34x faster |
| string/concat-long | 1.20x faster |
| string/indexOf | 43.58x faster |
| string/includes | 41.55x faster |
| string/split | 20.79x faster |
| string/replace | 6.28x faster |
| string/case-convert | 3.45x slower |
| string/substring | 275.79x faster |
| string/trim | 11.87x faster |
| string/startsWith-endsWith | 20.70x faster |
| array/push-pop | 2.20x faster |
| array/map-filter | 10.10x faster |
| array/reduce | 2.19x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.36x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.87x faster |
| mixed/csv-parse | 39.41x faster |
| mixed/text-search | 28.64x faster |
| mixed/fibonacci | 2.70x faster |
| mixed/matrix-multiply | 2.61x faster |
| mixed/sieve | 1.83x faster |

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
| string/concat-short | 1284.2ms | 1163.3ms | — |
| string/concat-long | 672.3ms | 1024.5ms | — |
| string/indexOf | 593.3ms | 1045.5ms | — |
| string/includes | 592.8ms | 1042.7ms | — |
| string/split | 737.3ms | 1049.8ms | — |
| string/replace | 591.1ms | 1011.8ms | — |
| string/case-convert | 575.7ms | 1294.7ms | — |
| string/substring | 575.1ms | 896.4ms | — |
| string/trim | 567.2ms | 979.4ms | — |
| string/startsWith-endsWith | 637.4ms | 987.8ms | — |
| array/push-pop | 770.7ms | 851.3ms | — |
| array/sort-i32 | 842.0ms | — | — |
| array/map-filter | 994.3ms | 992.4ms | — |
| array/reduce | 876.4ms | 920.2ms | — |
| array/indexOf | 749.0ms | 865.8ms | — |
| array/slice | 779.0ms | 867.8ms | — |
| array/reverse | 775.9ms | 848.8ms | — |
| array/forEach | 882.6ms | 980.5ms | — |
| array/find | 898.5ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 789.3ms | 1006.0ms | — |
| mixed/text-search | 671.2ms | 1060.8ms | — |
| mixed/fibonacci | 654.3ms | 848.4ms | 701.0ms |
| mixed/matrix-multiply | 810.8ms | 910.5ms | 794.5ms |
| mixed/sieve | 806.9ms | 924.2ms | — |
