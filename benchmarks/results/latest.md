# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.052ms | 0.042ms | — | js |
| string/concat-long | 0.004ms | 0.006ms | 0.005ms | — | js |
| string/indexOf | 0.001ms | 0.684ms | 0.016ms | — | js |
| string/includes | 0.002ms | 0.682ms | 0.016ms | — | js |
| string/split | 0.407ms | 22.57ms | 1.08ms | — | js |
| string/replace | 0.041ms | 0.863ms | 0.149ms | — | js |
| string/case-convert | <0.001ms | 1.15ms | 4.75ms | — | js |
| string/substring | 0.004ms | 6.24ms | 0.020ms | — | js |
| string/trim | 0.153ms | 5.43ms | 0.537ms | — | js |
| string/startsWith-endsWith | 0.278ms | 12.82ms | 0.739ms | — | js |
| array/push-pop | 1.67ms | 2.14ms | 0.946ms | — | gc-native |
| array/sort-i32 | 0.841ms | 1292.7ms | — | — | js |
| array/map-filter | 0.133ms | 0.664ms | 0.050ms | — | gc-native |
| array/reduce | 1.60ms | 2.18ms | 0.981ms | — | gc-native |
| array/indexOf | 4.45ms | 3.81ms | 2.88ms | — | gc-native |
| array/slice | 0.032ms | 0.020ms | 0.010ms | — | gc-native |
| array/reverse | 8.84ms | 3.65ms | 4.42ms | — | host-call |
| array/forEach | 0.051ms | 0.085ms | 0.034ms | — | gc-native |
| array/find | 0.280ms | 0.472ms | — | — | js |
| dom/create-elements | 0.037ms | — | — | — | js |
| dom/set-attributes | 0.110ms | — | — | — | js |
| dom/read-attributes | 0.061ms | — | — | — | js |
| dom/modify-text | 0.055ms | — | — | — | js |
| mixed/csv-parse | 0.480ms | 34.00ms | 0.891ms | — | js |
| mixed/text-search | 0.236ms | 26.26ms | 1.09ms | — | js |
| mixed/fibonacci | 0.118ms | 0.266ms | 0.095ms | 1.30ms | gc-native |
| mixed/matrix-multiply | 0.184ms | 0.492ms | 0.200ms | 2.04ms | js |
| mixed/sieve | 1.78ms | 2.32ms | 1.29ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.58x slower | 1.27x slower | — |
| string/concat-long | 1.35x slower | 1.12x slower | — |
| string/indexOf | 484.44x slower | 11.09x slower | — |
| string/includes | 433.87x slower | 10.21x slower | — |
| string/split | 55.51x slower | 2.67x slower | — |
| string/replace | 20.86x slower | 3.60x slower | — |
| string/case-convert | 3168.57x slower | 13070.01x slower | — |
| string/substring | 1767.74x slower | 5.59x slower | — |
| string/trim | 35.38x slower | 3.50x slower | — |
| string/startsWith-endsWith | 46.14x slower | 2.66x slower | — |
| array/push-pop | 1.29x slower | 1.76x faster | — |
| array/sort-i32 | 1536.82x slower | — | — |
| array/map-filter | 5.00x slower | 2.68x faster | — |
| array/reduce | 1.36x slower | 1.63x faster | — |
| array/indexOf | 1.17x faster | 1.54x faster | — |
| array/slice | 1.62x faster | 3.37x faster | — |
| array/reverse | 2.42x faster | 2.00x faster | — |
| array/forEach | 1.66x slower | 1.52x faster | — |
| array/find | 1.69x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 70.88x slower | 1.86x slower | — |
| mixed/text-search | 111.46x slower | 4.62x slower | — |
| mixed/fibonacci | 2.25x slower | 1.25x faster | 11.03x slower |
| mixed/matrix-multiply | 2.68x slower | 1.09x slower | 11.11x slower |
| mixed/sieve | 1.30x slower | 1.38x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.24x faster |
| string/concat-long | 1.21x faster |
| string/indexOf | 43.68x faster |
| string/includes | 42.51x faster |
| string/split | 20.80x faster |
| string/replace | 5.79x faster |
| string/case-convert | 4.12x slower |
| string/substring | 316.01x faster |
| string/trim | 10.11x faster |
| string/startsWith-endsWith | 17.35x faster |
| array/push-pop | 2.26x faster |
| array/map-filter | 13.41x faster |
| array/reduce | 2.23x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.08x faster |
| array/reverse | 1.21x slower |
| array/forEach | 2.52x faster |
| mixed/csv-parse | 38.18x faster |
| mixed/text-search | 24.11x faster |
| mixed/fibonacci | 2.81x faster |
| mixed/matrix-multiply | 2.46x faster |
| mixed/sieve | 1.79x faster |

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
| string/concat-short | 1196.1ms | 1139.7ms | — |
| string/concat-long | 610.3ms | 1004.0ms | — |
| string/indexOf | 550.4ms | 1009.9ms | — |
| string/includes | 557.2ms | 958.2ms | — |
| string/split | 721.9ms | 1011.6ms | — |
| string/replace | 569.4ms | 991.9ms | — |
| string/case-convert | 560.0ms | 1273.2ms | — |
| string/substring | 553.4ms | 874.4ms | — |
| string/trim | 539.5ms | 1026.1ms | — |
| string/startsWith-endsWith | 639.1ms | 984.3ms | — |
| array/push-pop | 735.6ms | 827.3ms | — |
| array/sort-i32 | 837.6ms | — | — |
| array/map-filter | 937.9ms | 932.6ms | — |
| array/reduce | 837.6ms | 883.8ms | — |
| array/indexOf | 721.9ms | 821.4ms | — |
| array/slice | 728.8ms | 831.1ms | — |
| array/reverse | 749.8ms | 819.3ms | — |
| array/forEach | 850.8ms | 958.9ms | — |
| array/find | 843.2ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 764.0ms | 942.3ms | — |
| mixed/text-search | 655.5ms | 1052.1ms | — |
| mixed/fibonacci | 644.9ms | 826.3ms | 676.6ms |
| mixed/matrix-multiply | 791.6ms | 881.1ms | 779.2ms |
| mixed/sieve | 778.2ms | 890.8ms | — |
