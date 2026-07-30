# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.032ms | 0.049ms | 0.039ms | — | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | — | js |
| string/indexOf | 0.001ms | 0.679ms | 0.016ms | — | js |
| string/includes | 0.002ms | 0.678ms | 0.017ms | — | js |
| string/split | 0.403ms | 22.99ms | 1.07ms | — | js |
| string/replace | 0.043ms | 0.862ms | 0.141ms | — | js |
| string/case-convert | <0.001ms | 1.26ms | 4.42ms | — | js |
| string/substring | 0.003ms | 6.58ms | 0.025ms | — | js |
| string/trim | 0.152ms | 6.01ms | 0.510ms | — | js |
| string/startsWith-endsWith | 0.246ms | 13.71ms | 0.657ms | — | js |
| array/push-pop | 1.46ms | 1.87ms | 0.860ms | — | gc-native |
| array/sort-i32 | 0.794ms | 1277.7ms | — | — | js |
| array/map-filter | 0.130ms | 0.613ms | 0.061ms | — | gc-native |
| array/reduce | 1.38ms | 1.87ms | 0.842ms | — | gc-native |
| array/indexOf | 3.94ms | 3.38ms | 2.57ms | — | gc-native |
| array/slice | 0.026ms | 0.032ms | 0.014ms | — | gc-native |
| array/reverse | 7.83ms | 3.40ms | 4.31ms | — | host-call |
| array/forEach | 0.086ms | 0.083ms | 0.044ms | — | gc-native |
| array/find | 0.240ms | 0.427ms | — | — | js |
| dom/create-elements | 0.036ms | — | — | — | js |
| dom/set-attributes | 0.106ms | — | — | — | js |
| dom/read-attributes | 0.055ms | — | — | — | js |
| dom/modify-text | 0.049ms | — | — | — | js |
| mixed/csv-parse | 0.464ms | 35.19ms | 0.855ms | — | js |
| mixed/text-search | 0.093ms | 27.27ms | 0.972ms | — | js |
| mixed/fibonacci | 0.109ms | 0.228ms | 0.084ms | 0.226ms | gc-native |
| mixed/matrix-multiply | 0.158ms | 0.486ms | 0.186ms | 2.12ms | js |
| mixed/sieve | 1.56ms | 2.11ms | 1.16ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.54x slower | 1.25x slower | — |
| string/concat-long | 1.51x slower | 1.32x slower | — |
| string/indexOf | 527.31x slower | 12.44x slower | — |
| string/includes | 441.87x slower | 10.80x slower | — |
| string/split | 57.12x slower | 2.65x slower | — |
| string/replace | 20.24x slower | 3.31x slower | — |
| string/case-convert | 3902.70x slower | 13713.26x slower | — |
| string/substring | 2107.36x slower | 8.13x slower | — |
| string/trim | 39.61x slower | 3.36x slower | — |
| string/startsWith-endsWith | 55.73x slower | 2.67x slower | — |
| array/push-pop | 1.28x slower | 1.70x faster | — |
| array/sort-i32 | 1608.54x slower | — | — |
| array/map-filter | 4.72x slower | 2.14x faster | — |
| array/reduce | 1.36x slower | 1.63x faster | — |
| array/indexOf | 1.17x faster | 1.54x faster | — |
| array/slice | 1.24x slower | 1.87x faster | — |
| array/reverse | 2.31x faster | 1.82x faster | — |
| array/forEach | 1.04x faster | 1.98x faster | — |
| array/find | 1.78x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 75.91x slower | 1.84x slower | — |
| mixed/text-search | 291.84x slower | 10.40x slower | — |
| mixed/fibonacci | 2.09x slower | 1.30x faster | 2.07x slower |
| mixed/matrix-multiply | 3.09x slower | 1.18x slower | 13.47x slower |
| mixed/sieve | 1.35x slower | 1.35x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.23x faster |
| string/concat-long | 1.15x faster |
| string/indexOf | 42.38x faster |
| string/includes | 40.91x faster |
| string/split | 21.58x faster |
| string/replace | 6.12x faster |
| string/case-convert | 3.51x slower |
| string/substring | 259.28x faster |
| string/trim | 11.79x faster |
| string/startsWith-endsWith | 20.86x faster |
| array/push-pop | 2.18x faster |
| array/map-filter | 10.10x faster |
| array/reduce | 2.22x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.31x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.89x faster |
| mixed/csv-parse | 41.17x faster |
| mixed/text-search | 28.05x faster |
| mixed/fibonacci | 2.71x faster |
| mixed/matrix-multiply | 2.61x faster |
| mixed/sieve | 1.82x faster |

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
| string/concat-short | 1402.8ms | 1240.0ms | — |
| string/concat-long | 652.9ms | 1029.0ms | — |
| string/indexOf | 579.2ms | 1051.2ms | — |
| string/includes | 593.5ms | 1020.6ms | — |
| string/split | 743.5ms | 1040.3ms | — |
| string/replace | 570.8ms | 1023.5ms | — |
| string/case-convert | 570.6ms | 1327.9ms | — |
| string/substring | 579.8ms | 879.6ms | — |
| string/trim | 558.2ms | 997.9ms | — |
| string/startsWith-endsWith | 647.3ms | 1032.9ms | — |
| array/push-pop | 768.9ms | 864.6ms | — |
| array/sort-i32 | 892.5ms | — | — |
| array/map-filter | 985.9ms | 1036.8ms | — |
| array/reduce | 864.1ms | 944.9ms | — |
| array/indexOf | 788.0ms | 871.2ms | — |
| array/slice | 782.4ms | 888.6ms | — |
| array/reverse | 761.6ms | 886.0ms | — |
| array/forEach | 879.1ms | 995.4ms | — |
| array/find | 923.5ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 771.5ms | 978.9ms | — |
| mixed/text-search | 692.2ms | 1039.4ms | — |
| mixed/fibonacci | 667.2ms | 847.3ms | 685.3ms |
| mixed/matrix-multiply | 807.9ms | 889.2ms | 775.1ms |
| mixed/sieve | 807.0ms | 909.9ms | — |
