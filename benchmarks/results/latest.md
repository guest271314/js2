# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.030ms | 0.046ms | 0.040ms | — | js |
| string/concat-long | 0.034ms | 0.011ms | 0.034ms | — | host-call |
| string/indexOf | 0.022ms | 1.22ms | 0.039ms | — | js |
| string/includes | 0.023ms | 0.718ms | 0.068ms | — | js |
| string/split | 0.399ms | 22.92ms | 1.07ms | — | js |
| string/replace | 0.042ms | 0.917ms | 0.140ms | — | js |
| string/case-convert | <0.001ms | 1.22ms | 4.40ms | — | js |
| string/substring | 0.004ms | 6.24ms | 0.255ms | — | js |
| string/trim | 0.151ms | 5.81ms | 0.512ms | — | js |
| string/startsWith-endsWith | 0.381ms | 13.02ms | 0.659ms | — | js |
| array/push-pop | 1.47ms | 1.86ms | 0.832ms | — | gc-native |
| array/sort-i32 | 0.795ms | 1267.3ms | — | — | js |
| array/map-filter | 0.136ms | 0.984ms | 0.060ms | — | gc-native |
| array/reduce | 2.17ms | 1.87ms | 0.820ms | — | gc-native |
| array/indexOf | 3.94ms | 3.39ms | 2.57ms | — | gc-native |
| array/slice | 0.026ms | 0.041ms | 0.026ms | — | gc-native |
| array/reverse | 7.83ms | 3.39ms | 4.31ms | — | host-call |
| array/forEach | 0.048ms | 0.083ms | 0.045ms | — | gc-native |
| array/find | 0.237ms | 0.406ms | — | — | js |
| dom/create-elements | 0.050ms | — | — | — | js |
| dom/set-attributes | 0.114ms | — | — | — | js |
| dom/read-attributes | 0.068ms | — | — | — | js |
| dom/modify-text | 0.045ms | — | — | — | js |
| mixed/csv-parse | 0.479ms | 34.37ms | 1.13ms | — | js |
| mixed/text-search | 0.213ms | 26.54ms | 0.975ms | — | js |
| mixed/fibonacci | 0.118ms | 1.19ms | — | 0.226ms | js |
| mixed/matrix-multiply | 0.157ms | 0.473ms | 0.724ms | 2.13ms | js |
| mixed/sieve | 1.63ms | 2.11ms | 1.13ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.53x slower | 1.33x slower | — |
| string/concat-long | 3.02x faster | 1.01x faster | — |
| string/indexOf | 55.37x slower | 1.77x slower | — |
| string/includes | 30.77x slower | 2.92x slower | — |
| string/split | 57.46x slower | 2.67x slower | — |
| string/replace | 21.67x slower | 3.31x slower | — |
| string/case-convert | 1844.56x slower | 6651.53x slower | — |
| string/substring | 1721.02x slower | 70.38x slower | — |
| string/trim | 38.52x slower | 3.39x slower | — |
| string/startsWith-endsWith | 34.17x slower | 1.73x slower | — |
| array/push-pop | 1.27x slower | 1.77x faster | — |
| array/sort-i32 | 1594.44x slower | — | — |
| array/map-filter | 7.23x slower | 2.25x faster | — |
| array/reduce | 1.16x faster | 2.65x faster | — |
| array/indexOf | 1.16x faster | 1.54x faster | — |
| array/slice | 1.56x slower | 1.04x faster | — |
| array/reverse | 2.31x faster | 1.82x faster | — |
| array/forEach | 1.74x slower | 1.06x faster | — |
| array/find | 1.71x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 71.71x slower | 2.36x slower | — |
| mixed/text-search | 124.53x slower | 4.57x slower | — |
| mixed/fibonacci | 10.06x slower | — | 1.92x slower |
| mixed/matrix-multiply | 3.01x slower | 4.61x slower | 13.53x slower |
| mixed/sieve | 1.29x slower | 1.44x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.15x faster |
| string/concat-long | 3.00x slower |
| string/indexOf | 31.24x faster |
| string/includes | 10.52x faster |
| string/split | 21.51x faster |
| string/replace | 6.55x faster |
| string/case-convert | 3.61x slower |
| string/substring | 24.45x faster |
| string/trim | 11.35x faster |
| string/startsWith-endsWith | 19.77x faster |
| array/push-pop | 2.24x faster |
| array/map-filter | 16.27x faster |
| array/reduce | 2.29x faster |
| array/indexOf | 1.32x faster |
| array/slice | 1.62x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.84x faster |
| mixed/csv-parse | 30.37x faster |
| mixed/text-search | 27.22x faster |
| mixed/matrix-multiply | 1.53x slower |
| mixed/sieve | 1.86x faster |

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
| string/concat-short | 1396.2ms | 1213.6ms | — |
| string/concat-long | 656.1ms | 1064.4ms | — |
| string/indexOf | 601.4ms | 1070.7ms | — |
| string/includes | 601.1ms | 1055.6ms | — |
| string/split | 757.7ms | 1064.8ms | — |
| string/replace | 582.1ms | 1071.8ms | — |
| string/case-convert | 575.3ms | 1293.0ms | — |
| string/substring | 557.8ms | 876.4ms | — |
| string/trim | 572.7ms | 1002.0ms | — |
| string/startsWith-endsWith | 644.1ms | 1054.0ms | — |
| array/push-pop | 769.3ms | 829.5ms | — |
| array/sort-i32 | 855.8ms | — | — |
| array/map-filter | 970.2ms | 981.6ms | — |
| array/reduce | 858.1ms | 949.7ms | — |
| array/indexOf | 787.0ms | 867.1ms | — |
| array/slice | 768.8ms | 846.6ms | — |
| array/reverse | 762.5ms | 864.7ms | — |
| array/forEach | 901.8ms | 961.4ms | — |
| array/find | 875.4ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 783.2ms | 1004.7ms | — |
| mixed/text-search | 718.8ms | 1108.6ms | — |
| mixed/fibonacci | 678.2ms | — | 723.2ms |
| mixed/matrix-multiply | 838.6ms | 948.7ms | 835.9ms |
| mixed/sieve | 828.1ms | 907.7ms | — |
