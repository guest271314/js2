# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.047ms | 0.039ms | — | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | — | js |
| string/indexOf | 0.001ms | 0.684ms | 0.016ms | — | js |
| string/includes | 0.001ms | 0.668ms | 0.017ms | — | js |
| string/split | 0.402ms | 22.10ms | 1.09ms | — | js |
| string/replace | 0.042ms | 0.834ms | 0.138ms | — | js |
| string/case-convert | <0.001ms | 1.20ms | 4.43ms | — | js |
| string/substring | 0.003ms | 6.16ms | 0.025ms | — | js |
| string/trim | 0.151ms | 5.84ms | 0.509ms | — | js |
| string/startsWith-endsWith | 0.246ms | 13.50ms | 0.658ms | — | js |
| array/push-pop | 1.44ms | 1.83ms | 0.834ms | — | gc-native |
| array/sort-i32 | 0.791ms | 1273.6ms | — | — | js |
| array/map-filter | 0.132ms | 0.612ms | 0.060ms | — | gc-native |
| array/reduce | 1.34ms | 1.83ms | 0.828ms | — | gc-native |
| array/indexOf | 3.94ms | 3.38ms | 2.57ms | — | gc-native |
| array/slice | 0.026ms | 0.032ms | 0.014ms | — | gc-native |
| array/reverse | 7.83ms | 3.40ms | 4.32ms | — | host-call |
| array/forEach | 0.086ms | 0.082ms | 0.044ms | — | gc-native |
| array/find | 0.239ms | 0.425ms | — | — | js |
| dom/create-elements | 0.036ms | — | — | — | js |
| dom/set-attributes | 0.103ms | — | — | — | js |
| dom/read-attributes | 0.056ms | — | — | — | js |
| dom/modify-text | 0.051ms | — | — | — | js |
| mixed/csv-parse | 0.505ms | 34.02ms | 0.860ms | — | js |
| mixed/text-search | 0.218ms | 26.45ms | 0.974ms | — | js |
| mixed/fibonacci | 0.109ms | 0.228ms | 0.084ms | 1.18ms | gc-native |
| mixed/matrix-multiply | 0.158ms | 0.487ms | 0.186ms | 2.12ms | js |
| mixed/sieve | 1.57ms | 2.12ms | 1.13ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.40x slower | 1.17x slower | — |
| string/concat-long | 1.49x slower | 1.27x slower | — |
| string/indexOf | 528.73x slower | 12.26x slower | — |
| string/includes | 456.15x slower | 11.33x slower | — |
| string/split | 54.99x slower | 2.72x slower | — |
| string/replace | 19.78x slower | 3.28x slower | — |
| string/case-convert | 3736.76x slower | 13745.91x slower | — |
| string/substring | 1973.34x slower | 7.87x slower | — |
| string/trim | 38.59x slower | 3.36x slower | — |
| string/startsWith-endsWith | 54.87x slower | 2.68x slower | — |
| array/push-pop | 1.27x slower | 1.73x faster | — |
| array/sort-i32 | 1611.05x slower | — | — |
| array/map-filter | 4.62x slower | 2.20x faster | — |
| array/reduce | 1.37x slower | 1.61x faster | — |
| array/indexOf | 1.16x faster | 1.54x faster | — |
| array/slice | 1.25x slower | 1.89x faster | — |
| array/reverse | 2.30x faster | 1.81x faster | — |
| array/forEach | 1.05x faster | 1.97x faster | — |
| array/find | 1.78x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 67.32x slower | 1.70x slower | — |
| mixed/text-search | 121.24x slower | 4.47x slower | — |
| mixed/fibonacci | 2.08x slower | 1.30x faster | 10.82x slower |
| mixed/matrix-multiply | 3.08x slower | 1.17x slower | 13.42x slower |
| mixed/sieve | 1.35x slower | 1.38x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.20x faster |
| string/concat-long | 1.17x faster |
| string/indexOf | 43.11x faster |
| string/includes | 40.26x faster |
| string/split | 20.19x faster |
| string/replace | 6.02x faster |
| string/case-convert | 3.68x slower |
| string/substring | 250.59x faster |
| string/trim | 11.48x faster |
| string/startsWith-endsWith | 20.50x faster |
| array/push-pop | 2.19x faster |
| array/map-filter | 10.15x faster |
| array/reduce | 2.21x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.36x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.88x faster |
| mixed/csv-parse | 39.58x faster |
| mixed/text-search | 27.15x faster |
| mixed/fibonacci | 2.70x faster |
| mixed/matrix-multiply | 2.62x faster |
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
| string/concat-short | 1248.2ms | 1198.1ms | — |
| string/concat-long | 646.5ms | 997.7ms | — |
| string/indexOf | 596.7ms | 1044.0ms | — |
| string/includes | 618.5ms | 1045.8ms | — |
| string/split | 722.6ms | 1037.1ms | — |
| string/replace | 594.5ms | 1052.6ms | — |
| string/case-convert | 587.7ms | 1412.9ms | — |
| string/substring | 580.2ms | 907.9ms | — |
| string/trim | 572.8ms | 978.3ms | — |
| string/startsWith-endsWith | 640.2ms | 1005.3ms | — |
| array/push-pop | 765.9ms | 843.6ms | — |
| array/sort-i32 | 840.7ms | — | — |
| array/map-filter | 948.8ms | 964.8ms | — |
| array/reduce | 880.7ms | 923.3ms | — |
| array/indexOf | 773.7ms | 873.9ms | — |
| array/slice | 786.6ms | 853.4ms | — |
| array/reverse | 754.7ms | 845.0ms | — |
| array/forEach | 893.9ms | 972.2ms | — |
| array/find | 865.8ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 816.7ms | 1018.1ms | — |
| mixed/text-search | 677.0ms | 1037.5ms | — |
| mixed/fibonacci | 653.6ms | 870.0ms | 677.6ms |
| mixed/matrix-multiply | 804.9ms | 901.8ms | 799.3ms |
| mixed/sieve | 817.7ms | 908.7ms | — |
