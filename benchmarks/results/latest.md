# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.037ms | 0.051ms | 0.043ms | — | js |
| string/concat-long | 0.004ms | 0.006ms | 0.005ms | — | js |
| string/indexOf | 0.002ms | 0.704ms | 0.016ms | — | js |
| string/includes | 0.002ms | 0.663ms | 0.016ms | — | js |
| string/split | 0.410ms | 23.64ms | 1.09ms | — | js |
| string/replace | 0.041ms | 0.878ms | 0.147ms | — | js |
| string/case-convert | <0.001ms | 1.22ms | 4.84ms | — | js |
| string/substring | 0.004ms | 6.29ms | 0.021ms | — | js |
| string/trim | 0.154ms | 5.68ms | 0.553ms | — | js |
| string/startsWith-endsWith | 0.302ms | 12.87ms | 0.740ms | — | js |
| array/push-pop | 1.69ms | 2.20ms | 0.973ms | — | gc-native |
| array/sort-i32 | 0.841ms | 1267.9ms | — | — | js |
| array/map-filter | 0.137ms | 0.659ms | 0.051ms | — | gc-native |
| array/reduce | 1.66ms | 2.25ms | 0.997ms | — | gc-native |
| array/indexOf | 4.45ms | 3.82ms | 2.88ms | — | gc-native |
| array/slice | 0.039ms | 0.022ms | 0.011ms | — | gc-native |
| array/reverse | 8.84ms | 3.66ms | 4.42ms | — | host-call |
| array/forEach | 0.054ms | 0.086ms | 0.034ms | — | gc-native |
| array/find | 0.283ms | 0.473ms | — | — | js |
| dom/create-elements | 0.037ms | — | — | — | js |
| dom/set-attributes | 0.110ms | — | — | — | js |
| dom/read-attributes | 0.059ms | — | — | — | js |
| dom/modify-text | 0.048ms | — | — | — | js |
| mixed/csv-parse | 0.457ms | 36.73ms | 0.892ms | — | js |
| mixed/text-search | 0.235ms | 26.76ms | 1.09ms | — | js |
| mixed/fibonacci | 0.118ms | 0.267ms | 0.095ms | 0.264ms | gc-native |
| mixed/matrix-multiply | 0.187ms | 0.493ms | 0.200ms | 2.02ms | js |
| mixed/sieve | 1.76ms | 2.32ms | 1.33ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.39x slower | 1.15x slower | — |
| string/concat-long | 1.43x slower | 1.13x slower | — |
| string/indexOf | 436.60x slower | 9.82x slower | — |
| string/includes | 377.91x slower | 9.22x slower | — |
| string/split | 57.61x slower | 2.66x slower | — |
| string/replace | 21.69x slower | 3.62x slower | — |
| string/case-convert | 3347.79x slower | 13291.79x slower | — |
| string/substring | 1784.49x slower | 5.97x slower | — |
| string/trim | 36.81x slower | 3.59x slower | — |
| string/startsWith-endsWith | 42.59x slower | 2.45x slower | — |
| array/push-pop | 1.30x slower | 1.74x faster | — |
| array/sort-i32 | 1507.02x slower | — | — |
| array/map-filter | 4.80x slower | 2.67x faster | — |
| array/reduce | 1.36x slower | 1.66x faster | — |
| array/indexOf | 1.17x faster | 1.54x faster | — |
| array/slice | 1.78x faster | 3.62x faster | — |
| array/reverse | 2.42x faster | 2.00x faster | — |
| array/forEach | 1.58x slower | 1.59x faster | — |
| array/find | 1.67x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 80.37x slower | 1.95x slower | — |
| mixed/text-search | 113.65x slower | 4.62x slower | — |
| mixed/fibonacci | 2.26x slower | 1.25x faster | 2.24x slower |
| mixed/matrix-multiply | 2.63x slower | 1.07x slower | 10.80x slower |
| mixed/sieve | 1.31x slower | 1.32x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.21x faster |
| string/concat-long | 1.27x faster |
| string/indexOf | 44.48x faster |
| string/includes | 40.98x faster |
| string/split | 21.62x faster |
| string/replace | 5.99x faster |
| string/case-convert | 3.97x slower |
| string/substring | 298.79x faster |
| string/trim | 10.26x faster |
| string/startsWith-endsWith | 17.41x faster |
| array/push-pop | 2.26x faster |
| array/map-filter | 12.83x faster |
| array/reduce | 2.26x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.03x faster |
| array/reverse | 1.21x slower |
| array/forEach | 2.51x faster |
| mixed/csv-parse | 41.19x faster |
| mixed/text-search | 24.58x faster |
| mixed/fibonacci | 2.81x faster |
| mixed/matrix-multiply | 2.47x faster |
| mixed/sieve | 1.74x faster |

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
| string/concat-short | 1201.5ms | 1172.2ms | — |
| string/concat-long | 641.4ms | 1018.9ms | — |
| string/indexOf | 594.7ms | 1063.6ms | — |
| string/includes | 584.1ms | 1040.0ms | — |
| string/split | 766.9ms | 1052.7ms | — |
| string/replace | 593.8ms | 1065.6ms | — |
| string/case-convert | 581.9ms | 1331.5ms | — |
| string/substring | 564.0ms | 869.1ms | — |
| string/trim | 556.1ms | 962.1ms | — |
| string/startsWith-endsWith | 676.9ms | 1003.0ms | — |
| array/push-pop | 769.6ms | 878.4ms | — |
| array/sort-i32 | 836.8ms | — | — |
| array/map-filter | 978.8ms | 997.0ms | — |
| array/reduce | 894.6ms | 942.0ms | — |
| array/indexOf | 791.0ms | 864.0ms | — |
| array/slice | 780.2ms | 908.3ms | — |
| array/reverse | 805.2ms | 887.1ms | — |
| array/forEach | 896.2ms | 969.4ms | — |
| array/find | 939.4ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 796.6ms | 1030.2ms | — |
| mixed/text-search | 702.6ms | 1029.1ms | — |
| mixed/fibonacci | 685.6ms | 845.2ms | 698.7ms |
| mixed/matrix-multiply | 813.0ms | 948.1ms | 802.5ms |
| mixed/sieve | 825.8ms | 947.5ms | — |
