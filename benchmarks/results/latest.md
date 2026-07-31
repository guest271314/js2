# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.047ms | 0.037ms | — | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | — | js |
| string/indexOf | 0.001ms | 0.066ms | 0.020ms | — | js |
| string/includes | 0.001ms | 0.146ms | 0.014ms | — | js |
| string/split | 0.402ms | 5.58ms | 0.722ms | — | js |
| string/replace | 0.042ms | 0.251ms | 0.140ms | — | js |
| string/case-convert | <0.001ms | 0.217ms | 4.40ms | — | js |
| string/substring | 0.003ms | 1.13ms | 0.024ms | — | js |
| string/trim | 0.151ms | 1.06ms | 0.164ms | — | js |
| string/startsWith-endsWith | 0.246ms | 2.67ms | 0.215ms | — | gc-native |
| array/push-pop | 1.44ms | 1.84ms | 0.827ms | — | gc-native |
| array/sort-i32 | 0.791ms | 1257.5ms | — | — | js |
| array/map-filter | 0.128ms | 0.612ms | 0.060ms | — | gc-native |
| array/reduce | 2.13ms | 1.81ms | 0.834ms | — | gc-native |
| array/indexOf | 3.95ms | 3.39ms | 2.56ms | — | gc-native |
| array/slice | 0.024ms | 0.031ms | 0.013ms | — | gc-native |
| array/reverse | 7.83ms | 3.39ms | 4.31ms | — | host-call |
| array/forEach | 0.048ms | 0.081ms | 0.044ms | — | gc-native |
| array/find | 0.238ms | 0.425ms | — | — | js |
| dom/create-elements | 0.035ms | — | — | — | js |
| dom/set-attributes | 0.103ms | — | — | — | js |
| dom/read-attributes | 0.054ms | — | — | — | js |
| dom/modify-text | 0.045ms | — | — | — | js |
| mixed/csv-parse | 0.455ms | 7.57ms | 0.772ms | — | js |
| mixed/text-search | 0.216ms | 5.44ms | 0.610ms | — | js |
| mixed/fibonacci | 0.109ms | 0.228ms | 0.085ms | 0.232ms | gc-native |
| mixed/matrix-multiply | 0.162ms | 0.486ms | 0.204ms | 2.12ms | js |
| mixed/sieve | 1.56ms | 2.11ms | 1.15ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.40x slower | 1.10x slower | — |
| string/concat-long | 1.26x slower | 1.21x slower | — |
| string/indexOf | 51.55x slower | 15.31x slower | — |
| string/includes | 104.51x slower | 10.07x slower | — |
| string/split | 13.90x slower | 1.80x slower | — |
| string/replace | 5.94x slower | 3.32x slower | — |
| string/case-convert | 673.70x slower | 13652.53x slower | — |
| string/substring | 363.18x slower | 7.59x slower | — |
| string/trim | 7.02x slower | 1.09x slower | — |
| string/startsWith-endsWith | 10.85x slower | 1.15x faster | — |
| array/push-pop | 1.28x slower | 1.74x faster | — |
| array/sort-i32 | 1590.50x slower | — | — |
| array/map-filter | 4.80x slower | 2.13x faster | — |
| array/reduce | 1.17x faster | 2.55x faster | — |
| array/indexOf | 1.17x faster | 1.54x faster | — |
| array/slice | 1.28x slower | 1.88x faster | — |
| array/reverse | 2.31x faster | 1.81x faster | — |
| array/forEach | 1.69x slower | 1.10x faster | — |
| array/find | 1.79x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 16.64x slower | 1.70x slower | — |
| mixed/text-search | 25.20x slower | 2.83x slower | — |
| mixed/fibonacci | 2.08x slower | 1.28x faster | 2.12x slower |
| mixed/matrix-multiply | 3.00x slower | 1.26x slower | 13.12x slower |
| mixed/sieve | 1.36x slower | 1.36x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.27x faster |
| string/concat-long | 1.04x faster |
| string/indexOf | 3.37x faster |
| string/includes | 10.38x faster |
| string/split | 7.74x faster |
| string/replace | 1.79x faster |
| string/case-convert | 20.27x slower |
| string/substring | 47.82x faster |
| string/trim | 6.45x faster |
| string/startsWith-endsWith | 12.43x faster |
| array/push-pop | 2.22x faster |
| array/map-filter | 10.20x faster |
| array/reduce | 2.18x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.39x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.86x faster |
| mixed/csv-parse | 9.81x faster |
| mixed/text-search | 8.91x faster |
| mixed/fibonacci | 2.67x faster |
| mixed/matrix-multiply | 2.38x faster |
| mixed/sieve | 1.84x faster |

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
| string/trim | 205B | 1.7KB | — |
| string/startsWith-endsWith | 330B | 1.6KB | — |
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
| mixed/text-search | 600B | 2.1KB | — |
| mixed/fibonacci | 157B | 1.1KB | 173B |
| mixed/matrix-multiply | 1.3KB | 1.8KB | 950B |
| mixed/sieve | 1.5KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1240.2ms | 1199.1ms | — |
| string/concat-long | 640.6ms | 999.5ms | — |
| string/indexOf | 567.2ms | 1001.5ms | — |
| string/includes | 575.4ms | 1010.1ms | — |
| string/split | 713.6ms | 1002.8ms | — |
| string/replace | 571.8ms | 1041.9ms | — |
| string/case-convert | 558.8ms | 1285.5ms | — |
| string/substring | 550.7ms | 843.4ms | — |
| string/trim | 540.5ms | 997.4ms | — |
| string/startsWith-endsWith | 623.3ms | 941.8ms | — |
| array/push-pop | 739.7ms | 830.9ms | — |
| array/sort-i32 | 816.4ms | — | — |
| array/map-filter | 949.2ms | 948.9ms | — |
| array/reduce | 855.9ms | 896.5ms | — |
| array/indexOf | 750.3ms | 836.9ms | — |
| array/slice | 742.8ms | 822.9ms | — |
| array/reverse | 741.6ms | 802.8ms | — |
| array/forEach | 848.2ms | 952.0ms | — |
| array/find | 874.1ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 760.7ms | 978.0ms | — |
| mixed/text-search | 671.7ms | 1020.5ms | — |
| mixed/fibonacci | 671.9ms | 804.7ms | 703.0ms |
| mixed/matrix-multiply | 803.5ms | 906.5ms | 773.1ms |
| mixed/sieve | 811.0ms | 899.8ms | — |
