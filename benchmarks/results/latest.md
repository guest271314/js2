# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.047ms | 0.037ms | — | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | — | js |
| string/indexOf | 0.001ms | 0.684ms | 0.016ms | — | js |
| string/includes | 0.001ms | 0.677ms | 0.016ms | — | js |
| string/split | 0.402ms | 22.12ms | 1.06ms | — | js |
| string/replace | 0.042ms | 0.859ms | 0.140ms | — | js |
| string/case-convert | <0.001ms | 1.26ms | 4.47ms | — | js |
| string/substring | 0.003ms | 6.64ms | 0.023ms | — | js |
| string/trim | 0.151ms | 6.00ms | 0.507ms | — | js |
| string/startsWith-endsWith | 0.246ms | 13.64ms | 0.658ms | — | js |
| array/push-pop | 1.44ms | 1.83ms | 0.822ms | — | gc-native |
| array/sort-i32 | 0.790ms | 1280.5ms | — | — | js |
| array/map-filter | 0.127ms | 0.610ms | 0.059ms | — | gc-native |
| array/reduce | 1.35ms | 1.81ms | 0.824ms | — | gc-native |
| array/indexOf | 3.94ms | 3.39ms | 2.57ms | — | gc-native |
| array/slice | 0.024ms | 0.031ms | 0.013ms | — | gc-native |
| array/reverse | 7.83ms | 3.39ms | 4.31ms | — | host-call |
| array/forEach | 0.048ms | 0.081ms | 0.043ms | — | gc-native |
| array/find | 0.239ms | 0.424ms | — | — | js |
| dom/create-elements | 0.036ms | — | — | — | js |
| dom/set-attributes | 0.104ms | — | — | — | js |
| dom/read-attributes | 0.054ms | — | — | — | js |
| dom/modify-text | 0.044ms | — | — | — | js |
| mixed/csv-parse | 0.465ms | 33.29ms | 0.847ms | — | js |
| mixed/text-search | 0.215ms | 27.70ms | 0.973ms | — | js |
| mixed/fibonacci | 0.109ms | 0.228ms | 0.084ms | 0.226ms | gc-native |
| mixed/matrix-multiply | 0.158ms | 0.486ms | 0.186ms | 2.13ms | js |
| mixed/sieve | 1.53ms | 2.10ms | 1.13ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.40x slower | 1.11x slower | — |
| string/concat-long | 1.50x slower | 1.26x slower | — |
| string/indexOf | 520.51x slower | 11.97x slower | — |
| string/includes | 461.28x slower | 11.05x slower | — |
| string/split | 55.01x slower | 2.64x slower | — |
| string/replace | 20.42x slower | 3.33x slower | — |
| string/case-convert | 3909.91x slower | 13878.96x slower | — |
| string/substring | 2124.99x slower | 7.47x slower | — |
| string/trim | 39.68x slower | 3.36x slower | — |
| string/startsWith-endsWith | 55.44x slower | 2.67x slower | — |
| array/push-pop | 1.27x slower | 1.75x faster | — |
| array/sort-i32 | 1620.40x slower | — | — |
| array/map-filter | 4.82x slower | 2.14x faster | — |
| array/reduce | 1.34x slower | 1.64x faster | — |
| array/indexOf | 1.16x faster | 1.54x faster | — |
| array/slice | 1.26x slower | 1.88x faster | — |
| array/reverse | 2.31x faster | 1.81x faster | — |
| array/forEach | 1.69x slower | 1.11x faster | — |
| array/find | 1.78x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 71.54x slower | 1.82x slower | — |
| mixed/text-search | 128.82x slower | 4.52x slower | — |
| mixed/fibonacci | 2.08x slower | 1.30x faster | 2.06x slower |
| mixed/matrix-multiply | 3.08x slower | 1.18x slower | 13.50x slower |
| mixed/sieve | 1.37x slower | 1.35x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.26x faster |
| string/concat-long | 1.19x faster |
| string/indexOf | 43.50x faster |
| string/includes | 41.76x faster |
| string/split | 20.86x faster |
| string/replace | 6.13x faster |
| string/case-convert | 3.55x slower |
| string/substring | 284.32x faster |
| string/trim | 11.83x faster |
| string/startsWith-endsWith | 20.73x faster |
| array/push-pop | 2.22x faster |
| array/map-filter | 10.30x faster |
| array/reduce | 2.19x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.38x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.87x faster |
| mixed/csv-parse | 39.28x faster |
| mixed/text-search | 28.48x faster |
| mixed/fibonacci | 2.71x faster |
| mixed/matrix-multiply | 2.61x faster |
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
| string/concat-short | 1260.0ms | 1170.7ms | — |
| string/concat-long | 636.7ms | 1004.0ms | — |
| string/indexOf | 594.7ms | 1017.8ms | — |
| string/includes | 558.7ms | 1008.6ms | — |
| string/split | 732.6ms | 995.7ms | — |
| string/replace | 566.7ms | 1049.8ms | — |
| string/case-convert | 563.4ms | 1263.6ms | — |
| string/substring | 541.8ms | 845.6ms | — |
| string/trim | 536.5ms | 993.0ms | — |
| string/startsWith-endsWith | 607.2ms | 1008.8ms | — |
| array/push-pop | 731.8ms | 830.1ms | — |
| array/sort-i32 | 840.2ms | — | — |
| array/map-filter | 967.4ms | 995.5ms | — |
| array/reduce | 871.1ms | 895.4ms | — |
| array/indexOf | 752.5ms | 837.5ms | — |
| array/slice | 750.2ms | 838.1ms | — |
| array/reverse | 742.9ms | 837.0ms | — |
| array/forEach | 855.9ms | 942.3ms | — |
| array/find | 871.3ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 759.3ms | 1014.7ms | — |
| mixed/text-search | 670.6ms | 1056.3ms | — |
| mixed/fibonacci | 675.0ms | 832.8ms | 677.6ms |
| mixed/matrix-multiply | 791.6ms | 896.5ms | 769.2ms |
| mixed/sieve | 810.4ms | 900.6ms | — |
