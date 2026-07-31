# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.027ms | 0.048ms | 0.038ms | — | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | — | js |
| string/indexOf | 0.001ms | 0.688ms | 0.016ms | — | js |
| string/includes | 0.001ms | 0.684ms | 0.016ms | — | js |
| string/split | 0.402ms | 22.11ms | 1.06ms | — | js |
| string/replace | 0.042ms | 0.870ms | 0.140ms | — | js |
| string/case-convert | <0.001ms | 1.24ms | 4.41ms | — | js |
| string/substring | 0.003ms | 6.52ms | 0.024ms | — | js |
| string/trim | 0.151ms | 5.99ms | 0.508ms | — | js |
| string/startsWith-endsWith | 0.246ms | 13.20ms | 0.657ms | — | js |
| array/push-pop | 1.45ms | 1.82ms | 0.828ms | — | gc-native |
| array/sort-i32 | 0.788ms | 1405.3ms | — | — | js |
| array/map-filter | 0.126ms | 0.612ms | 0.060ms | — | gc-native |
| array/reduce | 2.13ms | 1.84ms | 0.843ms | — | gc-native |
| array/indexOf | 3.94ms | 3.38ms | 2.57ms | — | gc-native |
| array/slice | 0.025ms | 0.031ms | 0.013ms | — | gc-native |
| array/reverse | 7.83ms | 3.39ms | 4.31ms | — | host-call |
| array/forEach | 0.050ms | 0.081ms | 0.044ms | — | gc-native |
| array/find | 0.239ms | 0.424ms | — | — | js |
| dom/create-elements | 0.034ms | — | — | — | js |
| dom/set-attributes | 0.103ms | — | — | — | js |
| dom/read-attributes | 0.055ms | — | — | — | js |
| dom/modify-text | 0.044ms | — | — | — | js |
| mixed/csv-parse | 0.470ms | 33.53ms | 0.863ms | — | js |
| mixed/text-search | 0.218ms | 26.94ms | 0.972ms | — | js |
| mixed/fibonacci | 0.109ms | 0.228ms | 0.085ms | 0.226ms | gc-native |
| mixed/matrix-multiply | 0.157ms | 0.486ms | 0.185ms | 2.12ms | js |
| mixed/sieve | 1.53ms | 2.10ms | 1.11ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.75x slower | 1.37x slower | — |
| string/concat-long | 1.53x slower | 1.24x slower | — |
| string/indexOf | 533.93x slower | 12.13x slower | — |
| string/includes | 470.10x slower | 11.22x slower | — |
| string/split | 55.05x slower | 2.63x slower | — |
| string/replace | 20.62x slower | 3.33x slower | — |
| string/case-convert | 3844.75x slower | 13693.58x slower | — |
| string/substring | 2086.89x slower | 7.67x slower | — |
| string/trim | 39.67x slower | 3.37x slower | — |
| string/startsWith-endsWith | 53.69x slower | 2.67x slower | — |
| array/push-pop | 1.26x slower | 1.74x faster | — |
| array/sort-i32 | 1783.46x slower | — | — |
| array/map-filter | 4.85x slower | 2.09x faster | — |
| array/reduce | 1.16x faster | 2.52x faster | — |
| array/indexOf | 1.16x faster | 1.54x faster | — |
| array/slice | 1.21x slower | 1.94x faster | — |
| array/reverse | 2.31x faster | 1.81x faster | — |
| array/forEach | 1.60x slower | 1.14x faster | — |
| array/find | 1.78x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 71.31x slower | 1.84x slower | — |
| mixed/text-search | 123.60x slower | 4.46x slower | — |
| mixed/fibonacci | 2.08x slower | 1.28x faster | 2.06x slower |
| mixed/matrix-multiply | 3.09x slower | 1.18x slower | 13.50x slower |
| mixed/sieve | 1.37x slower | 1.38x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.27x faster |
| string/concat-long | 1.23x faster |
| string/indexOf | 44.03x faster |
| string/includes | 41.91x faster |
| string/split | 20.91x faster |
| string/replace | 6.19x faster |
| string/case-convert | 3.56x slower |
| string/substring | 271.91x faster |
| string/trim | 11.79x faster |
| string/startsWith-endsWith | 20.08x faster |
| array/push-pop | 2.20x faster |
| array/map-filter | 10.16x faster |
| array/reduce | 2.18x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.35x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.83x faster |
| mixed/csv-parse | 38.83x faster |
| mixed/text-search | 27.71x faster |
| mixed/fibonacci | 2.66x faster |
| mixed/matrix-multiply | 2.62x faster |
| mixed/sieve | 1.89x faster |

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
| string/concat-short | 1304.6ms | 1176.9ms | — |
| string/concat-long | 627.7ms | 988.1ms | — |
| string/indexOf | 560.2ms | 1010.8ms | — |
| string/includes | 557.4ms | 996.2ms | — |
| string/split | 723.1ms | 960.7ms | — |
| string/replace | 548.4ms | 1012.0ms | — |
| string/case-convert | 547.0ms | 1282.0ms | — |
| string/substring | 543.1ms | 835.7ms | — |
| string/trim | 535.5ms | 982.3ms | — |
| string/startsWith-endsWith | 621.0ms | 989.3ms | — |
| array/push-pop | 734.7ms | 803.3ms | — |
| array/sort-i32 | 816.9ms | — | — |
| array/map-filter | 939.8ms | 981.3ms | — |
| array/reduce | 818.9ms | 937.7ms | — |
| array/indexOf | 763.9ms | 867.4ms | — |
| array/slice | 758.2ms | 849.2ms | — |
| array/reverse | 747.6ms | 817.8ms | — |
| array/forEach | 870.4ms | 946.1ms | — |
| array/find | 861.7ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 780.0ms | 975.0ms | — |
| mixed/text-search | 651.9ms | 1062.1ms | — |
| mixed/fibonacci | 671.3ms | 807.4ms | 708.2ms |
| mixed/matrix-multiply | 785.2ms | 900.4ms | 825.5ms |
| mixed/sieve | 813.1ms | 913.5ms | — |
