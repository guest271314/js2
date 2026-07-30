# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.032ms | 0.073ms | 0.044ms | — | js |
| string/concat-long | 0.008ms | 0.012ms | 0.014ms | — | js |
| string/indexOf | 0.023ms | 0.708ms | 0.041ms | — | js |
| string/includes | 0.023ms | 0.699ms | 0.042ms | — | js |
| string/split | 0.401ms | 22.23ms | 1.09ms | — | js |
| string/replace | 0.040ms | 0.958ms | 0.148ms | — | js |
| string/case-convert | <0.001ms | 1.21ms | 4.72ms | — | js |
| string/substring | 0.004ms | 6.44ms | 0.021ms | — | js |
| string/trim | 0.152ms | 5.61ms | 0.537ms | — | js |
| string/startsWith-endsWith | 0.412ms | 13.13ms | 0.744ms | — | js |
| array/push-pop | 1.68ms | 2.22ms | 0.962ms | — | gc-native |
| array/sort-i32 | 0.852ms | 1274.1ms | — | — | js |
| array/map-filter | 0.145ms | 1.00ms | 0.049ms | — | gc-native |
| array/reduce | 2.40ms | 2.21ms | 0.983ms | — | gc-native |
| array/indexOf | 4.45ms | 3.81ms | 2.88ms | — | gc-native |
| array/slice | 0.035ms | 0.239ms | 0.024ms | — | gc-native |
| array/reverse | 8.84ms | 3.65ms | 4.42ms | — | host-call |
| array/forEach | 0.087ms | 0.086ms | 0.105ms | — | host-call |
| array/find | 0.279ms | 1.69ms | — | — | js |
| dom/create-elements | 0.056ms | — | — | — | js |
| dom/set-attributes | 0.121ms | — | — | — | js |
| dom/read-attributes | 0.642ms | — | — | — | js |
| dom/modify-text | 0.047ms | — | — | — | js |
| mixed/csv-parse | 0.464ms | 33.22ms | 0.906ms | — | js |
| mixed/text-search | 0.234ms | 26.27ms | 1.09ms | — | js |
| mixed/fibonacci | 0.126ms | 0.265ms | — | 0.265ms | js |
| mixed/matrix-multiply | 0.185ms | 0.494ms | 0.701ms | 2.02ms | js |
| mixed/sieve | 1.77ms | 2.31ms | 1.31ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 2.29x slower | 1.37x slower | — |
| string/concat-long | 1.58x slower | 1.87x slower | — |
| string/indexOf | 31.39x slower | 1.82x slower | — |
| string/includes | 29.94x slower | 1.78x slower | — |
| string/split | 55.48x slower | 2.72x slower | — |
| string/replace | 23.67x slower | 3.65x slower | — |
| string/case-convert | 2077.72x slower | 8122.56x slower | — |
| string/substring | 1580.42x slower | 5.07x slower | — |
| string/trim | 36.77x slower | 3.52x slower | — |
| string/startsWith-endsWith | 31.89x slower | 1.81x slower | — |
| array/push-pop | 1.32x slower | 1.74x faster | — |
| array/sort-i32 | 1495.39x slower | — | — |
| array/map-filter | 6.93x slower | 2.98x faster | — |
| array/reduce | 1.09x faster | 2.44x faster | — |
| array/indexOf | 1.17x faster | 1.55x faster | — |
| array/slice | 6.80x slower | 1.45x faster | — |
| array/reverse | 2.42x faster | 2.00x faster | — |
| array/forEach | 1.02x faster | 1.20x slower | — |
| array/find | 6.06x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 71.67x slower | 1.96x slower | — |
| mixed/text-search | 112.27x slower | 4.66x slower | — |
| mixed/fibonacci | 2.09x slower | — | 2.10x slower |
| mixed/matrix-multiply | 2.68x slower | 3.80x slower | 10.96x slower |
| mixed/sieve | 1.31x slower | 1.35x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.67x faster |
| string/concat-long | 1.18x slower |
| string/indexOf | 17.27x faster |
| string/includes | 16.81x faster |
| string/split | 20.36x faster |
| string/replace | 6.48x faster |
| string/case-convert | 3.91x slower |
| string/substring | 311.57x faster |
| string/trim | 10.44x faster |
| string/startsWith-endsWith | 17.65x faster |
| array/push-pop | 2.30x faster |
| array/map-filter | 20.64x faster |
| array/reduce | 2.25x faster |
| array/indexOf | 1.32x faster |
| array/slice | 9.86x faster |
| array/reverse | 1.21x slower |
| array/forEach | 1.23x slower |
| mixed/csv-parse | 36.65x faster |
| mixed/text-search | 24.11x faster |
| mixed/matrix-multiply | 1.42x slower |
| mixed/sieve | 1.77x faster |

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
| string/concat-short | 1249.3ms | 1161.0ms | — |
| string/concat-long | 587.9ms | 957.3ms | — |
| string/indexOf | 574.7ms | 988.9ms | — |
| string/includes | 554.5ms | 984.5ms | — |
| string/split | 724.2ms | 951.8ms | — |
| string/replace | 563.7ms | 1025.8ms | — |
| string/case-convert | 543.2ms | 1283.9ms | — |
| string/substring | 562.9ms | 852.7ms | — |
| string/trim | 556.5ms | 971.2ms | — |
| string/startsWith-endsWith | 614.2ms | 966.0ms | — |
| array/push-pop | 745.5ms | 818.9ms | — |
| array/sort-i32 | 815.8ms | — | — |
| array/map-filter | 922.3ms | 984.4ms | — |
| array/reduce | 798.2ms | 950.4ms | — |
| array/indexOf | 788.9ms | 885.6ms | — |
| array/slice | 759.0ms | 884.4ms | — |
| array/reverse | 747.5ms | 824.4ms | — |
| array/forEach | 851.2ms | 900.2ms | — |
| array/find | 852.3ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 753.2ms | 960.6ms | — |
| mixed/text-search | 654.4ms | 1047.7ms | — |
| mixed/fibonacci | 681.7ms | — | 667.9ms |
| mixed/matrix-multiply | 788.3ms | 882.5ms | 806.5ms |
| mixed/sieve | 816.8ms | 852.3ms | — |
