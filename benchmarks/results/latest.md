# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.023ms | 0.191ms | 0.040ms | — | js |
| string/concat-long | 0.005ms | 0.011ms | 0.031ms | — | js |
| string/indexOf | 0.022ms | 0.735ms | 0.041ms | — | js |
| string/includes | 0.023ms | 0.702ms | 0.042ms | — | js |
| string/split | 0.400ms | 22.92ms | 1.07ms | — | js |
| string/replace | 0.042ms | 0.966ms | 0.139ms | — | js |
| string/case-convert | <0.001ms | 1.29ms | 4.40ms | — | js |
| string/substring | 0.004ms | 6.61ms | 0.025ms | — | js |
| string/trim | 0.151ms | 6.05ms | 0.512ms | — | js |
| string/startsWith-endsWith | 0.376ms | 13.80ms | 0.661ms | — | js |
| array/push-pop | 1.47ms | 1.85ms | 0.837ms | — | gc-native |
| array/sort-i32 | 0.798ms | 1258.8ms | — | — | js |
| array/map-filter | 0.135ms | 0.610ms | 0.061ms | — | gc-native |
| array/reduce | 2.16ms | 1.84ms | 0.837ms | — | gc-native |
| array/indexOf | 3.94ms | 3.39ms | 2.57ms | — | gc-native |
| array/slice | 0.026ms | 0.042ms | 0.023ms | — | gc-native |
| array/reverse | 7.83ms | 3.40ms | 4.31ms | — | host-call |
| array/forEach | 0.050ms | 0.083ms | 0.046ms | — | gc-native |
| array/find | 0.236ms | 0.406ms | — | — | js |
| dom/create-elements | 0.038ms | — | — | — | js |
| dom/set-attributes | 1.00ms | — | — | — | js |
| dom/read-attributes | 0.067ms | — | — | — | js |
| dom/modify-text | 0.044ms | — | — | — | js |
| mixed/csv-parse | 0.462ms | 33.50ms | 0.864ms | — | js |
| mixed/text-search | 0.213ms | 27.93ms | 0.978ms | — | js |
| mixed/fibonacci | 0.108ms | 0.226ms | — | 0.226ms | js |
| mixed/matrix-multiply | 0.156ms | 0.475ms | 0.184ms | 2.13ms | js |
| mixed/sieve | 1.55ms | 2.10ms | 1.13ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 8.45x slower | 1.75x slower | — |
| string/concat-long | 2.42x slower | 6.60x slower | — |
| string/indexOf | 33.55x slower | 1.86x slower | — |
| string/includes | 29.89x slower | 1.78x slower | — |
| string/split | 57.34x slower | 2.67x slower | — |
| string/replace | 22.94x slower | 3.30x slower | — |
| string/case-convert | 2992.86x slower | 10202.01x slower | — |
| string/substring | 1823.68x slower | 6.96x slower | — |
| string/trim | 40.09x slower | 3.39x slower | — |
| string/startsWith-endsWith | 36.66x slower | 1.76x slower | — |
| array/push-pop | 1.26x slower | 1.76x faster | — |
| array/sort-i32 | 1577.71x slower | — | — |
| array/map-filter | 4.53x slower | 2.20x faster | — |
| array/reduce | 1.17x faster | 2.58x faster | — |
| array/indexOf | 1.16x faster | 1.53x faster | — |
| array/slice | 1.65x slower | 1.09x faster | — |
| array/reverse | 2.30x faster | 1.81x faster | — |
| array/forEach | 1.65x slower | 1.09x faster | — |
| array/find | 1.72x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 72.52x slower | 1.87x slower | — |
| mixed/text-search | 131.06x slower | 4.59x slower | — |
| mixed/fibonacci | 2.08x slower | — | 2.08x slower |
| mixed/matrix-multiply | 3.04x slower | 1.17x slower | 13.58x slower |
| mixed/sieve | 1.35x slower | 1.38x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 4.82x faster |
| string/concat-long | 2.73x slower |
| string/indexOf | 17.99x faster |
| string/includes | 16.83x faster |
| string/split | 21.46x faster |
| string/replace | 6.95x faster |
| string/case-convert | 3.41x slower |
| string/substring | 262.15x faster |
| string/trim | 11.82x faster |
| string/startsWith-endsWith | 20.87x faster |
| array/push-pop | 2.21x faster |
| array/map-filter | 9.99x faster |
| array/reduce | 2.20x faster |
| array/indexOf | 1.32x faster |
| array/slice | 1.79x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.80x faster |
| mixed/csv-parse | 38.78x faster |
| mixed/text-search | 28.57x faster |
| mixed/matrix-multiply | 2.59x faster |
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
| array/map-filter | 2.4KB | 2.5KB | — |
| array/reduce | 1.7KB | 2.2KB | — |
| array/indexOf | 1022B | 1.5KB | — |
| array/slice | 1.0KB | 1.5KB | — |
| array/reverse | 1.0KB | 1.5KB | — |
| array/forEach | 1.8KB | 2.4KB | — |
| array/find | 2.0KB | — | — |
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
| string/concat-short | 1271.0ms | 1217.8ms | — |
| string/concat-long | 655.0ms | 1033.3ms | — |
| string/indexOf | 588.0ms | 1051.4ms | — |
| string/includes | 582.8ms | 1043.7ms | — |
| string/split | 744.4ms | 999.0ms | — |
| string/replace | 566.4ms | 1069.6ms | — |
| string/case-convert | 576.3ms | 1279.4ms | — |
| string/substring | 547.8ms | 891.2ms | — |
| string/trim | 574.6ms | 1033.7ms | — |
| string/startsWith-endsWith | 638.0ms | 989.4ms | — |
| array/push-pop | 761.0ms | 857.4ms | — |
| array/sort-i32 | 880.7ms | — | — |
| array/map-filter | 937.8ms | 949.2ms | — |
| array/reduce | 815.3ms | 875.1ms | — |
| array/indexOf | 743.1ms | 820.5ms | — |
| array/slice | 742.4ms | 825.3ms | — |
| array/reverse | 743.4ms | 842.3ms | — |
| array/forEach | 843.7ms | 925.0ms | — |
| array/find | 827.1ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 759.3ms | 993.2ms | — |
| mixed/text-search | 668.1ms | 1027.3ms | — |
| mixed/fibonacci | 649.8ms | — | 666.1ms |
| mixed/matrix-multiply | 813.7ms | 877.5ms | 761.7ms |
| mixed/sieve | 816.4ms | 913.3ms | — |
