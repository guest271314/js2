# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.079ms | 0.037ms | — | js |
| string/concat-long | 0.004ms | 0.011ms | 0.032ms | — | js |
| string/indexOf | 0.022ms | 0.748ms | 0.039ms | — | js |
| string/includes | 0.023ms | 0.707ms | 0.042ms | — | js |
| string/split | 0.402ms | 22.16ms | 1.07ms | — | js |
| string/replace | 0.042ms | 0.892ms | 0.140ms | — | js |
| string/case-convert | <0.001ms | 1.30ms | 4.39ms | — | js |
| string/substring | 0.004ms | 6.62ms | 0.024ms | — | js |
| string/trim | 0.150ms | 5.89ms | 0.510ms | — | js |
| string/startsWith-endsWith | 0.384ms | 13.97ms | 0.660ms | — | js |
| array/push-pop | 1.45ms | 1.82ms | 0.826ms | — | gc-native |
| array/sort-i32 | 0.793ms | 1264.7ms | — | — | js |
| array/map-filter | 0.133ms | 0.611ms | 0.060ms | — | gc-native |
| array/reduce | 2.15ms | 1.85ms | 0.828ms | — | gc-native |
| array/indexOf | 3.94ms | 3.38ms | 2.57ms | — | gc-native |
| array/slice | 0.027ms | 0.042ms | 0.023ms | — | gc-native |
| array/reverse | 7.83ms | 3.40ms | 4.32ms | — | host-call |
| array/forEach | 0.049ms | 0.082ms | 0.045ms | — | gc-native |
| array/find | 0.236ms | 0.404ms | — | — | js |
| dom/create-elements | 0.038ms | — | — | — | js |
| dom/set-attributes | 0.115ms | — | — | — | js |
| dom/read-attributes | 0.068ms | — | — | — | js |
| dom/modify-text | 0.045ms | — | — | — | js |
| mixed/csv-parse | 0.466ms | 33.94ms | 0.859ms | — | js |
| mixed/text-search | 0.213ms | 27.60ms | 0.976ms | — | js |
| mixed/fibonacci | 0.109ms | 1.18ms | — | 0.231ms | js |
| mixed/matrix-multiply | 0.161ms | 0.478ms | 0.180ms | 2.14ms | js |
| mixed/sieve | 1.61ms | 2.12ms | 2.58ms | — | js |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 2.22x slower | 1.04x slower | — |
| string/concat-long | 2.68x slower | 7.58x slower | — |
| string/indexOf | 33.85x slower | 1.79x slower | — |
| string/includes | 30.24x slower | 1.79x slower | — |
| string/split | 55.15x slower | 2.65x slower | — |
| string/replace | 21.00x slower | 3.30x slower | — |
| string/case-convert | 3098.05x slower | 10420.04x slower | — |
| string/substring | 1821.57x slower | 6.73x slower | — |
| string/trim | 39.17x slower | 3.39x slower | — |
| string/startsWith-endsWith | 36.33x slower | 1.72x slower | — |
| array/push-pop | 1.26x slower | 1.76x faster | — |
| array/sort-i32 | 1595.13x slower | — | — |
| array/map-filter | 4.58x slower | 2.23x faster | — |
| array/reduce | 1.16x faster | 2.60x faster | — |
| array/indexOf | 1.16x faster | 1.54x faster | — |
| array/slice | 1.55x slower | 1.18x faster | — |
| array/reverse | 2.30x faster | 1.81x faster | — |
| array/forEach | 1.66x slower | 1.09x faster | — |
| array/find | 1.71x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 72.79x slower | 1.84x slower | — |
| mixed/text-search | 129.52x slower | 4.58x slower | — |
| mixed/fibonacci | 10.91x slower | — | 2.13x slower |
| mixed/matrix-multiply | 2.97x slower | 1.12x slower | 13.27x slower |
| mixed/sieve | 1.31x slower | 1.60x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 2.12x faster |
| string/concat-long | 2.83x slower |
| string/indexOf | 18.95x faster |
| string/includes | 16.92x faster |
| string/split | 20.78x faster |
| string/replace | 6.37x faster |
| string/case-convert | 3.36x slower |
| string/substring | 270.66x faster |
| string/trim | 11.54x faster |
| string/startsWith-endsWith | 21.18x faster |
| array/push-pop | 2.21x faster |
| array/map-filter | 10.20x faster |
| array/reduce | 2.24x faster |
| array/indexOf | 1.32x faster |
| array/slice | 1.83x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.82x faster |
| mixed/csv-parse | 39.54x faster |
| mixed/text-search | 28.28x faster |
| mixed/matrix-multiply | 2.65x faster |
| mixed/sieve | 1.22x slower |

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
| string/concat-short | 1273.9ms | 1183.5ms | — |
| string/concat-long | 628.4ms | 995.3ms | — |
| string/indexOf | 583.1ms | 1026.2ms | — |
| string/includes | 563.5ms | 1037.2ms | — |
| string/split | 733.0ms | 994.5ms | — |
| string/replace | 552.6ms | 986.2ms | — |
| string/case-convert | 552.2ms | 1265.0ms | — |
| string/substring | 536.6ms | 837.4ms | — |
| string/trim | 546.0ms | 945.0ms | — |
| string/startsWith-endsWith | 612.1ms | 1002.3ms | — |
| array/push-pop | 748.0ms | 819.4ms | — |
| array/sort-i32 | 843.1ms | — | — |
| array/map-filter | 925.6ms | 957.8ms | — |
| array/reduce | 826.3ms | 908.3ms | — |
| array/indexOf | 725.5ms | 817.4ms | — |
| array/slice | 749.6ms | 837.4ms | — |
| array/reverse | 752.1ms | 827.5ms | — |
| array/forEach | 839.5ms | 932.2ms | — |
| array/find | 836.7ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 773.7ms | 957.3ms | — |
| mixed/text-search | 651.1ms | 1068.6ms | — |
| mixed/fibonacci | 661.4ms | — | 696.0ms |
| mixed/matrix-multiply | 834.6ms | 887.5ms | 792.9ms |
| mixed/sieve | 837.6ms | 912.8ms | — |
