# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.043ms | 0.045ms | 0.048ms | — | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | — | js |
| string/indexOf | 0.001ms | 0.397ms | 0.013ms | — | js |
| string/includes | 0.001ms | 0.353ms | 0.013ms | — | js |
| string/split | 0.250ms | 13.11ms | 0.842ms | — | js |
| string/replace | 0.038ms | 0.494ms | 0.091ms | — | js |
| string/case-convert | <0.001ms | 0.687ms | 4.06ms | — | js |
| string/substring | 0.002ms | 3.36ms | 0.034ms | — | js |
| string/trim | 0.102ms | 3.12ms | 0.462ms | — | js |
| string/startsWith-endsWith | 0.177ms | 7.21ms | 1.38ms | — | js |
| array/push-pop | 1.01ms | 1.14ms | 0.573ms | — | gc-native |
| array/sort-i32 | 0.464ms | 756.8ms | — | — | js |
| array/map-filter | 0.101ms | 0.428ms | 0.035ms | — | gc-native |
| array/reduce | 1.56ms | 1.16ms | 0.624ms | — | gc-native |
| array/indexOf | 3.91ms | 3.26ms | 1.98ms | — | gc-native |
| array/slice | 0.030ms | 0.030ms | 0.014ms | — | gc-native |
| array/reverse | 4.95ms | 2.75ms | 2.42ms | — | gc-native |
| array/forEach | 0.045ms | 0.044ms | 0.028ms | — | gc-native |
| array/find | 0.218ms | 0.368ms | — | — | js |
| dom/create-elements | 0.053ms | — | — | — | js |
| dom/set-attributes | 0.110ms | — | — | — | js |
| dom/read-attributes | 0.060ms | — | — | — | js |
| dom/modify-text | 0.071ms | — | — | — | js |
| mixed/csv-parse | 0.280ms | 19.23ms | 0.764ms | — | js |
| mixed/text-search | 0.233ms | 15.12ms | 1.23ms | — | js |
| mixed/fibonacci | 0.096ms | 0.120ms | 0.062ms | 0.113ms | gc-native |
| mixed/matrix-multiply | 0.149ms | 1.41ms | 0.158ms | 1.22ms | js |
| mixed/sieve | 1.31ms | 1.81ms | 0.832ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.03x slower | 1.11x slower | — |
| string/concat-long | 1.14x slower | 1.29x slower | — |
| string/indexOf | 342.60x slower | 11.04x slower | — |
| string/includes | 276.35x slower | 10.27x slower | — |
| string/split | 52.44x slower | 3.37x slower | — |
| string/replace | 12.98x slower | 2.39x slower | — |
| string/case-convert | 2693.86x slower | 15903.09x slower | — |
| string/substring | 1394.01x slower | 14.11x slower | — |
| string/trim | 30.45x slower | 4.52x slower | — |
| string/startsWith-endsWith | 40.70x slower | 7.76x slower | — |
| array/push-pop | 1.13x slower | 1.75x faster | — |
| array/sort-i32 | 1629.88x slower | — | — |
| array/map-filter | 4.23x slower | 2.91x faster | — |
| array/reduce | 1.35x faster | 2.50x faster | — |
| array/indexOf | 1.20x faster | 1.98x faster | — |
| array/slice | 1.00x faster | 2.23x faster | — |
| array/reverse | 1.80x faster | 2.04x faster | — |
| array/forEach | 1.03x faster | 1.58x faster | — |
| array/find | 1.68x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 68.65x slower | 2.73x slower | — |
| mixed/text-search | 64.84x slower | 5.28x slower | — |
| mixed/fibonacci | 1.24x slower | 1.56x faster | 1.17x slower |
| mixed/matrix-multiply | 9.46x slower | 1.06x slower | 8.17x slower |
| mixed/sieve | 1.38x slower | 1.58x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.07x slower |
| string/concat-long | 1.13x slower |
| string/indexOf | 31.02x faster |
| string/includes | 26.91x faster |
| string/split | 15.56x faster |
| string/replace | 5.44x faster |
| string/case-convert | 5.90x slower |
| string/substring | 98.81x faster |
| string/trim | 6.74x faster |
| string/startsWith-endsWith | 5.24x faster |
| array/push-pop | 1.98x faster |
| array/map-filter | 12.32x faster |
| array/reduce | 1.85x faster |
| array/indexOf | 1.64x faster |
| array/slice | 2.22x faster |
| array/reverse | 1.14x faster |
| array/forEach | 1.54x faster |
| mixed/csv-parse | 25.16x faster |
| mixed/text-search | 12.27x faster |
| mixed/fibonacci | 1.93x faster |
| mixed/matrix-multiply | 8.91x faster |
| mixed/sieve | 2.18x faster |

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
| string/concat-short | 879.4ms | 813.6ms | — |
| string/concat-long | 452.7ms | 714.0ms | — |
| string/indexOf | 414.3ms | 734.6ms | — |
| string/includes | 422.4ms | 717.1ms | — |
| string/split | 544.9ms | 730.9ms | — |
| string/replace | 404.8ms | 745.8ms | — |
| string/case-convert | 410.8ms | 903.7ms | — |
| string/substring | 411.3ms | 597.2ms | — |
| string/trim | 391.6ms | 689.4ms | — |
| string/startsWith-endsWith | 457.2ms | 678.9ms | — |
| array/push-pop | 561.3ms | 576.7ms | — |
| array/sort-i32 | 650.4ms | — | — |
| array/map-filter | 667.5ms | 698.8ms | — |
| array/reduce | 589.3ms | 644.6ms | — |
| array/indexOf | 539.6ms | 590.9ms | — |
| array/slice | 541.4ms | 597.2ms | — |
| array/reverse | 520.5ms | 606.3ms | — |
| array/forEach | 627.0ms | 666.7ms | — |
| array/find | 620.6ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 556.7ms | 672.9ms | — |
| mixed/text-search | 562.4ms | 757.1ms | — |
| mixed/fibonacci | 508.7ms | 618.0ms | 523.6ms |
| mixed/matrix-multiply | 571.5ms | 644.4ms | 573.9ms |
| mixed/sieve | 564.3ms | 717.3ms | — |
