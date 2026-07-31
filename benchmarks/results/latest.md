# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.038ms | 0.052ms | 0.044ms | — | js |
| string/concat-long | 0.004ms | 0.006ms | 0.005ms | — | js |
| string/indexOf | 0.002ms | 0.648ms | 0.013ms | — | js |
| string/includes | 0.002ms | 0.646ms | 0.013ms | — | js |
| string/split | 0.410ms | 23.74ms | 0.771ms | — | js |
| string/replace | 0.041ms | 0.867ms | 0.141ms | — | js |
| string/case-convert | <0.001ms | 1.17ms | 4.77ms | — | js |
| string/substring | 0.004ms | 6.15ms | 0.021ms | — | js |
| string/trim | 0.154ms | 5.79ms | 0.174ms | — | js |
| string/startsWith-endsWith | 0.314ms | 13.77ms | 0.231ms | — | gc-native |
| array/push-pop | 1.72ms | 2.25ms | 0.984ms | — | gc-native |
| array/sort-i32 | 0.848ms | 1272.4ms | — | — | js |
| array/map-filter | 0.139ms | 0.659ms | 0.051ms | — | gc-native |
| array/reduce | 2.44ms | 2.22ms | 0.990ms | — | gc-native |
| array/indexOf | 4.45ms | 3.82ms | 2.88ms | — | gc-native |
| array/slice | 0.040ms | 0.021ms | 0.011ms | — | gc-native |
| array/reverse | 8.85ms | 3.65ms | 4.42ms | — | host-call |
| array/forEach | 0.055ms | 0.088ms | 0.034ms | — | gc-native |
| array/find | 0.283ms | 0.474ms | — | — | js |
| dom/create-elements | 0.039ms | — | — | — | js |
| dom/set-attributes | 0.112ms | — | — | — | js |
| dom/read-attributes | 0.059ms | — | — | — | js |
| dom/modify-text | 0.048ms | — | — | — | js |
| mixed/csv-parse | 0.466ms | 34.00ms | 0.784ms | — | js |
| mixed/text-search | 0.107ms | 26.20ms | 0.627ms | — | js |
| mixed/fibonacci | 0.118ms | 0.268ms | 0.095ms | 0.265ms | gc-native |
| mixed/matrix-multiply | 0.188ms | 0.494ms | 0.201ms | 2.03ms | js |
| mixed/sieve | 1.83ms | 2.35ms | 1.33ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.38x slower | 1.16x slower | — |
| string/concat-long | 1.33x slower | 1.18x slower | — |
| string/indexOf | 402.45x slower | 8.21x slower | — |
| string/includes | 370.14x slower | 7.72x slower | — |
| string/split | 57.98x slower | 1.88x slower | — |
| string/replace | 21.00x slower | 3.42x slower | — |
| string/case-convert | 3206.27x slower | 13049.26x slower | — |
| string/substring | 1744.09x slower | 6.02x slower | — |
| string/trim | 37.61x slower | 1.13x slower | — |
| string/startsWith-endsWith | 43.92x slower | 1.36x faster | — |
| array/push-pop | 1.31x slower | 1.75x faster | — |
| array/sort-i32 | 1500.12x slower | — | — |
| array/map-filter | 4.73x slower | 2.71x faster | — |
| array/reduce | 1.10x faster | 2.46x faster | — |
| array/indexOf | 1.17x faster | 1.55x faster | — |
| array/slice | 1.85x faster | 3.73x faster | — |
| array/reverse | 2.42x faster | 2.00x faster | — |
| array/forEach | 1.58x slower | 1.61x faster | — |
| array/find | 1.67x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 73.03x slower | 1.68x slower | — |
| mixed/text-search | 245.18x slower | 5.87x slower | — |
| mixed/fibonacci | 2.26x slower | 1.25x faster | 2.24x slower |
| mixed/matrix-multiply | 2.62x slower | 1.07x slower | 10.76x slower |
| mixed/sieve | 1.29x slower | 1.37x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.19x faster |
| string/concat-long | 1.12x faster |
| string/indexOf | 49.02x faster |
| string/includes | 47.92x faster |
| string/split | 30.81x faster |
| string/replace | 6.14x faster |
| string/case-convert | 4.07x slower |
| string/substring | 289.49x faster |
| string/trim | 33.36x faster |
| string/startsWith-endsWith | 59.52x faster |
| array/push-pop | 2.28x faster |
| array/map-filter | 12.81x faster |
| array/reduce | 2.24x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.01x faster |
| array/reverse | 1.21x slower |
| array/forEach | 2.55x faster |
| mixed/csv-parse | 43.38x faster |
| mixed/text-search | 41.79x faster |
| mixed/fibonacci | 2.82x faster |
| mixed/matrix-multiply | 2.46x faster |
| mixed/sieve | 1.76x faster |

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
| string/trim | 205B | 1.7KB | — |
| string/startsWith-endsWith | 330B | 1.6KB | — |
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
| mixed/text-search | 600B | 2.1KB | — |
| mixed/fibonacci | 157B | 1.1KB | 173B |
| mixed/matrix-multiply | 1.3KB | 1.8KB | 950B |
| mixed/sieve | 1.5KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1242.7ms | 1189.3ms | — |
| string/concat-long | 620.5ms | 1018.4ms | — |
| string/indexOf | 590.2ms | 1012.8ms | — |
| string/includes | 555.4ms | 992.2ms | — |
| string/split | 748.2ms | 1006.2ms | — |
| string/replace | 559.5ms | 1051.5ms | — |
| string/case-convert | 614.4ms | 1323.2ms | — |
| string/substring | 560.0ms | 864.8ms | — |
| string/trim | 552.5ms | 1003.3ms | — |
| string/startsWith-endsWith | 648.4ms | 978.5ms | — |
| array/push-pop | 791.7ms | 834.2ms | — |
| array/sort-i32 | 860.6ms | — | — |
| array/map-filter | 978.3ms | 973.6ms | — |
| array/reduce | 848.5ms | 928.0ms | — |
| array/indexOf | 786.6ms | 831.6ms | — |
| array/slice | 760.6ms | 840.3ms | — |
| array/reverse | 762.8ms | 847.4ms | — |
| array/forEach | 891.5ms | 963.0ms | — |
| array/find | 910.6ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 763.0ms | 995.5ms | — |
| mixed/text-search | 696.9ms | 986.3ms | — |
| mixed/fibonacci | 676.4ms | 866.7ms | 722.9ms |
| mixed/matrix-multiply | 794.6ms | 883.3ms | 794.4ms |
| mixed/sieve | 812.5ms | 891.5ms | — |
