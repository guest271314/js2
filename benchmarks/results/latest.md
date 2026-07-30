# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.046ms | 0.036ms | — | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | — | js |
| string/indexOf | 0.001ms | 0.652ms | 0.016ms | — | js |
| string/includes | 0.001ms | 0.666ms | 0.017ms | — | js |
| string/split | 0.403ms | 21.86ms | 1.06ms | — | js |
| string/replace | 0.042ms | 0.845ms | 0.140ms | — | js |
| string/case-convert | <0.001ms | 1.22ms | 4.46ms | — | js |
| string/substring | 0.003ms | 6.44ms | 0.025ms | — | js |
| string/trim | 0.151ms | 5.89ms | 0.504ms | — | js |
| string/startsWith-endsWith | 0.246ms | 13.17ms | 0.658ms | — | js |
| array/push-pop | 1.48ms | 1.84ms | 0.834ms | — | gc-native |
| array/sort-i32 | 0.794ms | 1258.2ms | — | — | js |
| array/map-filter | 0.128ms | 0.608ms | 0.058ms | — | gc-native |
| array/reduce | 2.16ms | 1.83ms | 0.835ms | — | gc-native |
| array/indexOf | 3.94ms | 3.38ms | 2.57ms | — | gc-native |
| array/slice | 0.025ms | 0.032ms | 0.013ms | — | gc-native |
| array/reverse | 7.83ms | 3.39ms | 4.32ms | — | host-call |
| array/forEach | 0.049ms | 0.082ms | 0.044ms | — | gc-native |
| array/find | 0.240ms | 0.407ms | — | — | js |
| dom/create-elements | 0.036ms | — | — | — | js |
| dom/set-attributes | 0.105ms | — | — | — | js |
| dom/read-attributes | 0.054ms | — | — | — | js |
| dom/modify-text | 0.048ms | — | — | — | js |
| mixed/csv-parse | 0.469ms | 33.66ms | 0.854ms | — | js |
| mixed/text-search | 0.217ms | 27.46ms | 0.973ms | — | js |
| mixed/fibonacci | 0.109ms | 0.228ms | — | 1.18ms | js |
| mixed/matrix-multiply | 0.158ms | 0.476ms | 0.187ms | 2.12ms | js |
| mixed/sieve | 1.55ms | 2.24ms | 1.14ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.50x slower | 1.16x slower | — |
| string/concat-long | 1.54x slower | 1.25x slower | — |
| string/indexOf | 493.62x slower | 11.94x slower | — |
| string/includes | 444.10x slower | 11.03x slower | — |
| string/split | 54.31x slower | 2.63x slower | — |
| string/replace | 20.05x slower | 3.31x slower | — |
| string/case-convert | 3786.43x slower | 13836.47x slower | — |
| string/substring | 2062.78x slower | 8.03x slower | — |
| string/trim | 38.99x slower | 3.33x slower | — |
| string/startsWith-endsWith | 53.59x slower | 2.68x slower | — |
| array/push-pop | 1.24x slower | 1.78x faster | — |
| array/sort-i32 | 1585.41x slower | — | — |
| array/map-filter | 4.75x slower | 2.19x faster | — |
| array/reduce | 1.18x faster | 2.58x faster | — |
| array/indexOf | 1.17x faster | 1.54x faster | — |
| array/slice | 1.25x slower | 1.90x faster | — |
| array/reverse | 2.31x faster | 1.81x faster | — |
| array/forEach | 1.69x slower | 1.10x faster | — |
| array/find | 1.70x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 71.84x slower | 1.82x slower | — |
| mixed/text-search | 126.82x slower | 4.50x slower | — |
| mixed/fibonacci | 2.08x slower | — | 10.80x slower |
| mixed/matrix-multiply | 3.02x slower | 1.19x slower | 13.46x slower |
| mixed/sieve | 1.45x slower | 1.36x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.29x faster |
| string/concat-long | 1.23x faster |
| string/indexOf | 41.36x faster |
| string/includes | 40.28x faster |
| string/split | 20.63x faster |
| string/replace | 6.05x faster |
| string/case-convert | 3.65x slower |
| string/substring | 256.93x faster |
| string/trim | 11.70x faster |
| string/startsWith-endsWith | 20.01x faster |
| array/push-pop | 2.21x faster |
| array/map-filter | 10.43x faster |
| array/reduce | 2.19x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.38x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.85x faster |
| mixed/csv-parse | 39.42x faster |
| mixed/text-search | 28.21x faster |
| mixed/matrix-multiply | 2.54x faster |
| mixed/sieve | 1.96x faster |

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
| string/concat-short | 1261.3ms | 1202.0ms | — |
| string/concat-long | 638.6ms | 1013.8ms | — |
| string/indexOf | 584.5ms | 1033.9ms | — |
| string/includes | 568.1ms | 1032.0ms | — |
| string/split | 730.0ms | 1008.6ms | — |
| string/replace | 543.3ms | 1012.9ms | — |
| string/case-convert | 552.7ms | 1318.3ms | — |
| string/substring | 563.4ms | 891.7ms | — |
| string/trim | 550.7ms | 938.8ms | — |
| string/startsWith-endsWith | 610.6ms | 991.8ms | — |
| array/push-pop | 752.3ms | 834.1ms | — |
| array/sort-i32 | 837.5ms | — | — |
| array/map-filter | 921.2ms | 940.0ms | — |
| array/reduce | 814.3ms | 864.5ms | — |
| array/indexOf | 747.6ms | 854.7ms | — |
| array/slice | 740.7ms | 815.6ms | — |
| array/reverse | 739.0ms | 815.5ms | — |
| array/forEach | 849.4ms | 948.8ms | — |
| array/find | 876.2ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 785.4ms | 981.7ms | — |
| mixed/text-search | 658.3ms | 1017.4ms | — |
| mixed/fibonacci | 654.4ms | — | 681.1ms |
| mixed/matrix-multiply | 829.3ms | 909.3ms | 823.0ms |
| mixed/sieve | 821.2ms | 910.4ms | — |
