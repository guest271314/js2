# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.049ms | 0.040ms | — | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | — | js |
| string/indexOf | 0.001ms | 0.692ms | 0.016ms | — | js |
| string/includes | 0.002ms | 0.692ms | 0.016ms | — | js |
| string/split | 0.403ms | 22.58ms | 1.07ms | — | js |
| string/replace | 0.043ms | 0.866ms | 0.141ms | — | js |
| string/case-convert | <0.001ms | 1.23ms | 4.43ms | — | js |
| string/substring | 0.003ms | 6.61ms | 0.027ms | — | js |
| string/trim | 0.152ms | 6.08ms | 0.506ms | — | js |
| string/startsWith-endsWith | 0.246ms | 13.55ms | 0.659ms | — | js |
| array/push-pop | 1.48ms | 1.86ms | 0.859ms | — | gc-native |
| array/sort-i32 | 0.787ms | 1248.8ms | — | — | js |
| array/map-filter | 0.136ms | 0.612ms | 0.061ms | — | gc-native |
| array/reduce | 2.16ms | 1.85ms | 0.849ms | — | gc-native |
| array/indexOf | 3.95ms | 3.39ms | 2.57ms | — | gc-native |
| array/slice | 0.027ms | 0.032ms | 0.014ms | — | gc-native |
| array/reverse | 7.82ms | 3.40ms | 4.32ms | — | host-call |
| array/forEach | 0.050ms | 0.082ms | 0.044ms | — | gc-native |
| array/find | 0.240ms | 0.426ms | — | — | js |
| dom/create-elements | 0.218ms | — | — | — | js |
| dom/set-attributes | 0.106ms | — | — | — | js |
| dom/read-attributes | 0.057ms | — | — | — | js |
| dom/modify-text | 0.052ms | — | — | — | js |
| mixed/csv-parse | 0.461ms | 35.14ms | 0.860ms | — | js |
| mixed/text-search | 0.219ms | 27.66ms | 0.972ms | — | js |
| mixed/fibonacci | 0.109ms | 0.228ms | 0.084ms | 0.226ms | gc-native |
| mixed/matrix-multiply | 0.160ms | 0.487ms | 0.188ms | 2.12ms | js |
| mixed/sieve | 1.57ms | 2.11ms | 1.16ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.45x slower | 1.18x slower | — |
| string/concat-long | 1.50x slower | 1.31x slower | — |
| string/indexOf | 522.96x slower | 11.92x slower | — |
| string/includes | 452.51x slower | 10.76x slower | — |
| string/split | 56.09x slower | 2.66x slower | — |
| string/replace | 20.12x slower | 3.27x slower | — |
| string/case-convert | 3812.35x slower | 13764.54x slower | — |
| string/substring | 2117.28x slower | 8.54x slower | — |
| string/trim | 40.00x slower | 3.33x slower | — |
| string/startsWith-endsWith | 55.00x slower | 2.67x slower | — |
| array/push-pop | 1.26x slower | 1.72x faster | — |
| array/sort-i32 | 1586.97x slower | — | — |
| array/map-filter | 4.49x slower | 2.25x faster | — |
| array/reduce | 1.17x faster | 2.55x faster | — |
| array/indexOf | 1.17x faster | 1.54x faster | — |
| array/slice | 1.18x slower | 1.96x faster | — |
| array/reverse | 2.30x faster | 1.81x faster | — |
| array/forEach | 1.64x slower | 1.13x faster | — |
| array/find | 1.77x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 76.17x slower | 1.87x slower | — |
| mixed/text-search | 126.28x slower | 4.44x slower | — |
| mixed/fibonacci | 2.08x slower | 1.30x faster | 2.07x slower |
| mixed/matrix-multiply | 3.05x slower | 1.18x slower | 13.30x slower |
| mixed/sieve | 1.34x slower | 1.35x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.22x faster |
| string/concat-long | 1.15x faster |
| string/indexOf | 43.86x faster |
| string/includes | 42.05x faster |
| string/split | 21.13x faster |
| string/replace | 6.16x faster |
| string/case-convert | 3.61x slower |
| string/substring | 247.89x faster |
| string/trim | 12.01x faster |
| string/startsWith-endsWith | 20.57x faster |
| array/push-pop | 2.17x faster |
| array/map-filter | 10.11x faster |
| array/reduce | 2.18x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.30x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.86x faster |
| mixed/csv-parse | 40.84x faster |
| mixed/text-search | 28.47x faster |
| mixed/fibonacci | 2.71x faster |
| mixed/matrix-multiply | 2.60x faster |
| mixed/sieve | 1.81x faster |

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
| string/concat-short | 1317.7ms | 1208.5ms | — |
| string/concat-long | 639.6ms | 1039.2ms | — |
| string/indexOf | 601.1ms | 1040.4ms | — |
| string/includes | 602.8ms | 1063.0ms | — |
| string/split | 758.8ms | 996.1ms | — |
| string/replace | 600.3ms | 1093.9ms | — |
| string/case-convert | 577.5ms | 1331.8ms | — |
| string/substring | 566.1ms | 867.6ms | — |
| string/trim | 546.6ms | 976.8ms | — |
| string/startsWith-endsWith | 613.8ms | 1013.4ms | — |
| array/push-pop | 764.9ms | 844.8ms | — |
| array/sort-i32 | 833.5ms | — | — |
| array/map-filter | 971.3ms | 973.1ms | — |
| array/reduce | 848.1ms | 949.5ms | — |
| array/indexOf | 764.0ms | 829.4ms | — |
| array/slice | 774.2ms | 859.3ms | — |
| array/reverse | 759.1ms | 865.5ms | — |
| array/forEach | 874.8ms | 988.7ms | — |
| array/find | 892.4ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 799.1ms | 1026.5ms | — |
| mixed/text-search | 674.9ms | 1052.1ms | — |
| mixed/fibonacci | 675.9ms | 823.9ms | 680.5ms |
| mixed/matrix-multiply | 812.0ms | 890.2ms | 789.1ms |
| mixed/sieve | 793.6ms | 870.7ms | — |
