# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.016ms | 0.029ms | 0.018ms | — | js |
| string/concat-long | 0.002ms | 0.004ms | 0.002ms | — | js |
| string/indexOf | 0.001ms | 0.383ms | 0.008ms | — | js |
| string/includes | 0.001ms | 0.379ms | 0.009ms | — | js |
| string/split | 0.211ms | 12.60ms | 0.485ms | — | js |
| string/replace | 0.021ms | 0.498ms | 0.074ms | — | js |
| string/case-convert | <0.001ms | 0.685ms | 2.67ms | — | js |
| string/substring | 0.002ms | 3.66ms | 0.012ms | — | js |
| string/trim | 0.076ms | 3.33ms | 0.294ms | — | js |
| string/startsWith-endsWith | 0.123ms | 7.71ms | 0.366ms | — | js |
| array/push-pop | 0.986ms | 1.36ms | 0.578ms | — | gc-native |
| array/sort-i32 | 0.417ms | 657.2ms | — | — | js |
| array/map-filter | 0.078ms | 0.420ms | 0.025ms | — | gc-native |
| array/reduce | 0.927ms | 1.29ms | 0.581ms | — | gc-native |
| array/indexOf | 2.51ms | 1.84ms | 1.26ms | — | gc-native |
| array/slice | 0.018ms | 0.021ms | 0.009ms | — | gc-native |
| array/reverse | 4.50ms | 1.79ms | 2.30ms | — | host-call |
| array/forEach | 0.035ms | 0.045ms | 0.016ms | — | gc-native |
| array/find | 0.184ms | 0.226ms | — | — | js |
| dom/create-elements | 0.023ms | — | — | — | js |
| dom/set-attributes | 0.062ms | — | — | — | js |
| dom/read-attributes | 0.034ms | — | — | — | js |
| dom/modify-text | 0.030ms | — | — | — | js |
| mixed/csv-parse | 0.259ms | 18.86ms | 0.431ms | — | js |
| mixed/text-search | 0.046ms | 15.00ms | 0.510ms | — | js |
| mixed/fibonacci | 0.064ms | 0.137ms | 0.051ms | 0.140ms | gc-native |
| mixed/matrix-multiply | 0.102ms | 0.257ms | 0.096ms | 1.22ms | gc-native |
| mixed/sieve | 1.02ms | 1.37ms | 0.705ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.78x slower | 1.10x slower | — |
| string/concat-long | 1.56x slower | 1.02x slower | — |
| string/indexOf | 315.47x slower | 6.58x slower | — |
| string/includes | 282.36x slower | 6.33x slower | — |
| string/split | 59.60x slower | 2.29x slower | — |
| string/replace | 23.75x slower | 3.52x slower | — |
| string/case-convert | 2916.37x slower | 11346.28x slower | — |
| string/substring | 1586.70x slower | 5.26x slower | — |
| string/trim | 43.98x slower | 3.89x slower | — |
| string/startsWith-endsWith | 62.53x slower | 2.97x slower | — |
| array/push-pop | 1.38x slower | 1.70x faster | — |
| array/sort-i32 | 1577.04x slower | — | — |
| array/map-filter | 5.36x slower | 3.16x faster | — |
| array/reduce | 1.39x slower | 1.60x faster | — |
| array/indexOf | 1.36x faster | 2.00x faster | — |
| array/slice | 1.18x slower | 2.01x faster | — |
| array/reverse | 2.52x faster | 1.96x faster | — |
| array/forEach | 1.30x slower | 2.14x faster | — |
| array/find | 1.23x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 72.76x slower | 1.66x slower | — |
| mixed/text-search | 327.54x slower | 11.14x slower | — |
| mixed/fibonacci | 2.13x slower | 1.26x faster | 2.18x slower |
| mixed/matrix-multiply | 2.53x slower | 1.06x faster | 12.02x slower |
| mixed/sieve | 1.35x slower | 1.44x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.62x faster |
| string/concat-long | 1.52x faster |
| string/indexOf | 47.96x faster |
| string/includes | 44.63x faster |
| string/split | 25.99x faster |
| string/replace | 6.75x faster |
| string/case-convert | 3.89x slower |
| string/substring | 301.77x faster |
| string/trim | 11.32x faster |
| string/startsWith-endsWith | 21.03x faster |
| array/push-pop | 2.36x faster |
| array/map-filter | 16.96x faster |
| array/reduce | 2.22x faster |
| array/indexOf | 1.47x faster |
| array/slice | 2.36x faster |
| array/reverse | 1.29x slower |
| array/forEach | 2.79x faster |
| mixed/csv-parse | 43.74x faster |
| mixed/text-search | 29.39x faster |
| mixed/fibonacci | 2.69x faster |
| mixed/matrix-multiply | 2.68x faster |
| mixed/sieve | 1.95x faster |

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
| string/concat-short | 736.9ms | 675.7ms | — |
| string/concat-long | 370.5ms | 582.8ms | — |
| string/indexOf | 348.0ms | 642.4ms | — |
| string/includes | 352.2ms | 601.7ms | — |
| string/split | 436.1ms | 582.6ms | — |
| string/replace | 333.4ms | 586.7ms | — |
| string/case-convert | 345.1ms | 742.3ms | — |
| string/substring | 337.8ms | 511.5ms | — |
| string/trim | 339.6ms | 577.1ms | — |
| string/startsWith-endsWith | 384.4ms | 610.4ms | — |
| array/push-pop | 453.5ms | 523.9ms | — |
| array/sort-i32 | 505.7ms | — | — |
| array/map-filter | 595.2ms | 564.1ms | — |
| array/reduce | 520.5ms | 568.9ms | — |
| array/indexOf | 459.9ms | 501.2ms | — |
| array/slice | 443.8ms | 490.9ms | — |
| array/reverse | 448.3ms | 497.2ms | — |
| array/forEach | 519.2ms | 544.2ms | — |
| array/find | 527.7ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 481.0ms | 570.5ms | — |
| mixed/text-search | 412.2ms | 627.5ms | — |
| mixed/fibonacci | 396.5ms | 482.2ms | 403.1ms |
| mixed/matrix-multiply | 476.6ms | 534.2ms | 455.5ms |
| mixed/sieve | 472.7ms | 508.1ms | — |
