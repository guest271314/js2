# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.048ms | 0.051ms | 0.055ms | — | js |
| string/concat-long | 0.005ms | 0.006ms | 0.006ms | — | js |
| string/indexOf | 0.002ms | 0.735ms | 0.016ms | — | js |
| string/includes | 0.002ms | 0.734ms | 0.016ms | — | js |
| string/split | 0.380ms | 26.95ms | 1.09ms | — | js |
| string/replace | 0.042ms | 0.890ms | 0.138ms | — | js |
| string/case-convert | <0.001ms | 1.38ms | 5.06ms | — | js |
| string/substring | 0.003ms | 7.22ms | 0.045ms | — | js |
| string/trim | 0.153ms | 6.74ms | 0.696ms | — | js |
| string/startsWith-endsWith | 0.231ms | 15.37ms | 1.69ms | — | js |
| array/push-pop | 1.61ms | 1.72ms | 0.827ms | — | gc-native |
| array/sort-i32 | 0.714ms | 1115.3ms | — | — | js |
| array/map-filter | 0.148ms | 0.621ms | 0.060ms | — | gc-native |
| array/reduce | 1.44ms | 1.69ms | 0.854ms | — | gc-native |
| array/indexOf | 4.83ms | 3.94ms | 2.59ms | — | gc-native |
| array/slice | 0.043ms | 0.041ms | 0.022ms | — | gc-native |
| array/reverse | 7.27ms | 4.13ms | 4.04ms | — | gc-native |
| array/forEach | 0.077ms | 0.065ms | 0.041ms | — | gc-native |
| array/find | 0.267ms | 0.443ms | — | — | js |
| dom/create-elements | 0.064ms | — | — | — | js |
| dom/set-attributes | 0.128ms | — | — | — | js |
| dom/read-attributes | 0.072ms | — | — | — | js |
| dom/modify-text | 0.072ms | — | — | — | js |
| mixed/csv-parse | 0.448ms | 41.20ms | 1.03ms | — | js |
| mixed/text-search | 0.228ms | 29.74ms | 1.53ms | — | js |
| mixed/fibonacci | 0.113ms | 0.218ms | 0.089ms | 0.217ms | gc-native |
| mixed/matrix-multiply | 0.206ms | 1.65ms | 0.188ms | 1.95ms | gc-native |
| mixed/sieve | 1.54ms | 2.24ms | 1.21ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.07x slower | 1.15x slower | — |
| string/concat-long | 1.26x slower | 1.35x slower | — |
| string/indexOf | 454.39x slower | 10.03x slower | — |
| string/includes | 413.36x slower | 9.19x slower | — |
| string/split | 70.88x slower | 2.86x slower | — |
| string/replace | 21.19x slower | 3.29x slower | — |
| string/case-convert | 4599.23x slower | 16852.32x slower | — |
| string/substring | 2495.77x slower | 15.64x slower | — |
| string/trim | 44.05x slower | 4.55x slower | — |
| string/startsWith-endsWith | 66.69x slower | 7.32x slower | — |
| array/push-pop | 1.06x slower | 1.95x faster | — |
| array/sort-i32 | 1561.29x slower | — | — |
| array/map-filter | 4.19x slower | 2.48x faster | — |
| array/reduce | 1.18x slower | 1.68x faster | — |
| array/indexOf | 1.23x faster | 1.87x faster | — |
| array/slice | 1.06x faster | 1.95x faster | — |
| array/reverse | 1.76x faster | 1.80x faster | — |
| array/forEach | 1.19x faster | 1.90x faster | — |
| array/find | 1.66x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 92.00x slower | 2.31x slower | — |
| mixed/text-search | 130.64x slower | 6.70x slower | — |
| mixed/fibonacci | 1.94x slower | 1.27x faster | 1.93x slower |
| mixed/matrix-multiply | 8.01x slower | 1.10x faster | 9.45x slower |
| mixed/sieve | 1.45x slower | 1.27x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.08x slower |
| string/concat-long | 1.08x slower |
| string/indexOf | 45.32x faster |
| string/includes | 44.96x faster |
| string/split | 24.78x faster |
| string/replace | 6.44x faster |
| string/case-convert | 3.66x slower |
| string/substring | 159.55x faster |
| string/trim | 9.69x faster |
| string/startsWith-endsWith | 9.10x faster |
| array/push-pop | 2.07x faster |
| array/map-filter | 10.41x faster |
| array/reduce | 1.98x faster |
| array/indexOf | 1.52x faster |
| array/slice | 1.84x faster |
| array/reverse | 1.02x faster |
| array/forEach | 1.60x faster |
| mixed/csv-parse | 39.81x faster |
| mixed/text-search | 19.50x faster |
| mixed/fibonacci | 2.45x faster |
| mixed/matrix-multiply | 8.78x faster |
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
| string/concat-short | 1201.0ms | 1220.6ms | — |
| string/concat-long | 647.2ms | 1092.7ms | — |
| string/indexOf | 589.1ms | 1055.8ms | — |
| string/includes | 574.7ms | 1058.8ms | — |
| string/split | 713.2ms | 1054.0ms | — |
| string/replace | 556.5ms | 1054.7ms | — |
| string/case-convert | 566.5ms | 1274.8ms | — |
| string/substring | 573.5ms | 864.2ms | — |
| string/trim | 555.7ms | 977.6ms | — |
| string/startsWith-endsWith | 628.9ms | 1025.1ms | — |
| array/push-pop | 758.2ms | 853.1ms | — |
| array/sort-i32 | 853.4ms | — | — |
| array/map-filter | 967.1ms | 982.6ms | — |
| array/reduce | 912.3ms | 962.1ms | — |
| array/indexOf | 769.9ms | 874.4ms | — |
| array/slice | 789.5ms | 878.9ms | — |
| array/reverse | 785.1ms | 863.6ms | — |
| array/forEach | 886.4ms | 985.0ms | — |
| array/find | 901.4ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 806.7ms | 971.2ms | — |
| mixed/text-search | 667.1ms | 1071.7ms | — |
| mixed/fibonacci | 711.7ms | 823.3ms | 706.0ms |
| mixed/matrix-multiply | 828.6ms | 964.6ms | 794.3ms |
| mixed/sieve | 849.6ms | 902.7ms | — |
