# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.073ms | 0.044ms | — | js |
| string/concat-long | 0.005ms | 0.012ms | 0.014ms | — | js |
| string/indexOf | 0.023ms | 0.715ms | 0.041ms | — | js |
| string/includes | 0.024ms | 0.707ms | 0.041ms | — | js |
| string/split | 0.408ms | 22.54ms | 1.09ms | — | js |
| string/replace | 0.041ms | 0.887ms | 0.146ms | — | js |
| string/case-convert | <0.001ms | 1.20ms | 4.74ms | — | js |
| string/substring | 0.004ms | 6.23ms | 0.246ms | — | js |
| string/trim | 0.154ms | 5.47ms | 0.544ms | — | js |
| string/startsWith-endsWith | 0.412ms | 12.96ms | 0.741ms | — | js |
| array/push-pop | 1.72ms | 2.18ms | 0.973ms | — | gc-native |
| array/sort-i32 | 0.858ms | 1275.0ms | — | — | js |
| array/map-filter | 0.147ms | 1.26ms | 0.048ms | — | gc-native |
| array/reduce | 2.43ms | 2.21ms | 0.983ms | — | gc-native |
| array/indexOf | 4.45ms | 3.81ms | 2.88ms | — | gc-native |
| array/slice | 0.036ms | 0.043ms | 0.119ms | — | js |
| array/reverse | 8.84ms | 3.66ms | 4.42ms | — | host-call |
| array/forEach | 0.051ms | 0.086ms | 0.107ms | — | js |
| array/find | 0.282ms | 1.67ms | — | — | js |
| dom/create-elements | 0.042ms | — | — | — | js |
| dom/set-attributes | 0.123ms | — | — | — | js |
| dom/read-attributes | 0.079ms | — | — | — | js |
| dom/modify-text | 0.490ms | — | — | — | js |
| mixed/csv-parse | 1.70ms | 33.66ms | 0.890ms | — | gc-native |
| mixed/text-search | 0.234ms | 26.24ms | 1.09ms | — | js |
| mixed/fibonacci | 0.126ms | 0.265ms | — | 1.30ms | js |
| mixed/matrix-multiply | 0.184ms | 0.502ms | 0.199ms | 2.03ms | js |
| mixed/sieve | 1.74ms | 2.34ms | 1.32ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 2.12x slower | 1.27x slower | — |
| string/concat-long | 2.18x slower | 2.60x slower | — |
| string/indexOf | 31.58x slower | 1.81x slower | — |
| string/includes | 30.08x slower | 1.74x slower | — |
| string/split | 55.25x slower | 2.68x slower | — |
| string/replace | 21.68x slower | 3.57x slower | — |
| string/case-convert | 2721.64x slower | 10753.48x slower | — |
| string/substring | 1532.74x slower | 60.44x slower | — |
| string/trim | 35.49x slower | 3.53x slower | — |
| string/startsWith-endsWith | 31.48x slower | 1.80x slower | — |
| array/push-pop | 1.27x slower | 1.76x faster | — |
| array/sort-i32 | 1485.12x slower | — | — |
| array/map-filter | 8.59x slower | 3.03x faster | — |
| array/reduce | 1.10x faster | 2.47x faster | — |
| array/indexOf | 1.17x faster | 1.55x faster | — |
| array/slice | 1.19x slower | 3.31x slower | — |
| array/reverse | 2.42x faster | 2.00x faster | — |
| array/forEach | 1.68x slower | 2.08x slower | — |
| array/find | 5.91x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 19.77x slower | 1.91x faster | — |
| mixed/text-search | 112.22x slower | 4.67x slower | — |
| mixed/fibonacci | 2.09x slower | — | 10.30x slower |
| mixed/matrix-multiply | 2.73x slower | 1.08x slower | 11.02x slower |
| mixed/sieve | 1.34x slower | 1.32x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.67x faster |
| string/concat-long | 1.19x slower |
| string/indexOf | 17.42x faster |
| string/includes | 17.24x faster |
| string/split | 20.59x faster |
| string/replace | 6.06x faster |
| string/case-convert | 3.95x slower |
| string/substring | 25.36x faster |
| string/trim | 10.06x faster |
| string/startsWith-endsWith | 17.48x faster |
| array/push-pop | 2.24x faster |
| array/map-filter | 26.01x faster |
| array/reduce | 2.25x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.77x slower |
| array/reverse | 1.21x slower |
| array/forEach | 1.24x slower |
| mixed/csv-parse | 37.82x faster |
| mixed/text-search | 24.02x faster |
| mixed/matrix-multiply | 2.53x faster |
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
| string/concat-short | 1259.6ms | 1165.6ms | — |
| string/concat-long | 628.8ms | 1011.1ms | — |
| string/indexOf | 566.7ms | 997.2ms | — |
| string/includes | 566.8ms | 1010.8ms | — |
| string/split | 721.3ms | 995.8ms | — |
| string/replace | 552.3ms | 1034.3ms | — |
| string/case-convert | 555.3ms | 1272.6ms | — |
| string/substring | 562.5ms | 861.0ms | — |
| string/trim | 556.8ms | 991.5ms | — |
| string/startsWith-endsWith | 642.2ms | 1014.5ms | — |
| array/push-pop | 746.1ms | 803.7ms | — |
| array/sort-i32 | 824.3ms | — | — |
| array/map-filter | 915.7ms | 926.4ms | — |
| array/reduce | 835.5ms | 917.8ms | — |
| array/indexOf | 750.2ms | 832.3ms | — |
| array/slice | 763.8ms | 816.8ms | — |
| array/reverse | 719.3ms | 810.3ms | — |
| array/forEach | 817.1ms | 938.9ms | — |
| array/find | 862.4ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 770.9ms | 973.9ms | — |
| mixed/text-search | 668.0ms | 1062.1ms | — |
| mixed/fibonacci | 697.5ms | — | 665.7ms |
| mixed/matrix-multiply | 832.9ms | 888.3ms | 801.8ms |
| mixed/sieve | 791.8ms | 922.8ms | — |
