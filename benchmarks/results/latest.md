# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.048ms | 0.043ms | — | js |
| string/concat-long | 0.008ms | 0.022ms | 0.034ms | — | js |
| string/indexOf | 0.022ms | 1.58ms | 0.041ms | — | js |
| string/includes | 0.023ms | 0.735ms | 0.062ms | — | js |
| string/split | 0.400ms | 22.09ms | 1.09ms | — | js |
| string/replace | 0.040ms | 0.967ms | 0.147ms | — | js |
| string/case-convert | <0.001ms | 1.19ms | 4.72ms | — | js |
| string/substring | 0.004ms | 6.12ms | 0.020ms | — | js |
| string/trim | 0.153ms | 5.48ms | 0.550ms | — | js |
| string/startsWith-endsWith | 0.412ms | 13.04ms | 0.742ms | — | js |
| array/push-pop | 1.68ms | 2.17ms | 0.944ms | — | gc-native |
| array/sort-i32 | 0.843ms | 1265.9ms | — | — | js |
| array/map-filter | 0.143ms | 0.692ms | 0.048ms | — | gc-native |
| array/reduce | 2.39ms | 2.17ms | 0.972ms | — | gc-native |
| array/indexOf | 4.45ms | 3.81ms | 2.88ms | — | gc-native |
| array/slice | 0.034ms | 0.199ms | 0.024ms | — | gc-native |
| array/reverse | 8.84ms | 3.65ms | 4.42ms | — | host-call |
| array/forEach | 0.086ms | 0.085ms | 0.106ms | — | host-call |
| array/find | 0.280ms | 1.67ms | — | — | js |
| dom/create-elements | 0.056ms | — | — | — | js |
| dom/set-attributes | 0.121ms | — | — | — | js |
| dom/read-attributes | 0.074ms | — | — | — | js |
| dom/modify-text | 0.342ms | — | — | — | js |
| mixed/csv-parse | 0.457ms | 33.25ms | 0.887ms | — | js |
| mixed/text-search | 0.234ms | 26.61ms | 1.09ms | — | js |
| mixed/fibonacci | 0.117ms | 0.265ms | — | 1.30ms | js |
| mixed/matrix-multiply | 0.182ms | 0.497ms | 0.198ms | 2.02ms | js |
| mixed/sieve | 1.80ms | 2.32ms | 1.32ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.56x slower | 1.38x slower | — |
| string/concat-long | 2.86x slower | 4.29x slower | — |
| string/indexOf | 70.23x slower | 1.82x slower | — |
| string/includes | 31.32x slower | 2.64x slower | — |
| string/split | 55.29x slower | 2.72x slower | — |
| string/replace | 24.01x slower | 3.65x slower | — |
| string/case-convert | 2704.70x slower | 10706.88x slower | — |
| string/substring | 1501.23x slower | 4.86x slower | — |
| string/trim | 35.87x slower | 3.60x slower | — |
| string/startsWith-endsWith | 31.67x slower | 1.80x slower | — |
| array/push-pop | 1.29x slower | 1.78x faster | — |
| array/sort-i32 | 1501.50x slower | — | — |
| array/map-filter | 4.84x slower | 2.98x faster | — |
| array/reduce | 1.10x faster | 2.46x faster | — |
| array/indexOf | 1.17x faster | 1.54x faster | — |
| array/slice | 5.84x slower | 1.39x faster | — |
| array/reverse | 2.42x faster | 2.00x faster | — |
| array/forEach | 1.01x faster | 1.23x slower | — |
| array/find | 5.97x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 72.73x slower | 1.94x slower | — |
| mixed/text-search | 113.80x slower | 4.66x slower | — |
| mixed/fibonacci | 2.25x slower | — | 11.11x slower |
| mixed/matrix-multiply | 2.73x slower | 1.08x slower | 11.08x slower |
| mixed/sieve | 1.29x slower | 1.36x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.13x faster |
| string/concat-long | 1.50x slower |
| string/indexOf | 38.65x faster |
| string/includes | 11.88x faster |
| string/split | 20.31x faster |
| string/replace | 6.58x faster |
| string/case-convert | 3.96x slower |
| string/substring | 308.65x faster |
| string/trim | 9.97x faster |
| string/startsWith-endsWith | 17.58x faster |
| array/push-pop | 2.30x faster |
| array/map-filter | 14.41x faster |
| array/reduce | 2.23x faster |
| array/indexOf | 1.32x faster |
| array/slice | 8.13x faster |
| array/reverse | 1.21x slower |
| array/forEach | 1.24x slower |
| mixed/csv-parse | 37.51x faster |
| mixed/text-search | 24.41x faster |
| mixed/matrix-multiply | 2.52x faster |
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
| string/trim | 205B | 1.8KB | — |
| string/startsWith-endsWith | 330B | 1.7KB | — |
| array/push-pop | 947B | 1.4KB | — |
| array/sort-i32 | 1.2KB | — | — |
| array/map-filter | 2.7KB | 2.8KB | — |
| array/reduce | 1.9KB | 2.5KB | — |
| array/indexOf | 1022B | 1.5KB | — |
| array/slice | 1.0KB | 1.5KB | — |
| array/reverse | 1.0KB | 1.5KB | — |
| array/forEach | 2.1KB | 2.7KB | — |
| array/find | 2.3KB | — | — |
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
| string/concat-short | 1209.2ms | 1101.4ms | — |
| string/concat-long | 619.8ms | 981.4ms | — |
| string/indexOf | 567.7ms | 1019.4ms | — |
| string/includes | 582.0ms | 999.7ms | — |
| string/split | 721.2ms | 991.9ms | — |
| string/replace | 554.2ms | 1045.1ms | — |
| string/case-convert | 559.3ms | 1261.6ms | — |
| string/substring | 532.4ms | 823.9ms | — |
| string/trim | 535.7ms | 978.1ms | — |
| string/startsWith-endsWith | 611.1ms | 988.1ms | — |
| array/push-pop | 729.6ms | 811.8ms | — |
| array/sort-i32 | 823.1ms | — | — |
| array/map-filter | 924.0ms | 949.5ms | — |
| array/reduce | 810.4ms | 881.2ms | — |
| array/indexOf | 744.6ms | 823.0ms | — |
| array/slice | 742.4ms | 853.3ms | — |
| array/reverse | 741.4ms | 808.0ms | — |
| array/forEach | 846.9ms | 890.0ms | — |
| array/find | 841.4ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 750.9ms | 963.8ms | — |
| mixed/text-search | 649.5ms | 1036.6ms | — |
| mixed/fibonacci | 658.8ms | — | 646.8ms |
| mixed/matrix-multiply | 818.4ms | 898.7ms | 770.8ms |
| mixed/sieve | 788.2ms | 895.0ms | — |
