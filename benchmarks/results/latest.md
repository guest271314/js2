# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.048ms | 0.037ms | — | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | — | js |
| string/indexOf | 0.001ms | 0.645ms | 0.016ms | — | js |
| string/includes | 0.001ms | 0.650ms | 0.016ms | — | js |
| string/split | 0.402ms | 21.43ms | 1.06ms | — | js |
| string/replace | 0.042ms | 0.842ms | 0.141ms | — | js |
| string/case-convert | <0.001ms | 1.20ms | 4.38ms | — | js |
| string/substring | 0.003ms | 6.36ms | 0.022ms | — | js |
| string/trim | 0.151ms | 5.71ms | 0.506ms | — | js |
| string/startsWith-endsWith | 0.246ms | 13.21ms | 0.658ms | — | js |
| array/push-pop | 1.42ms | 1.81ms | 0.827ms | — | gc-native |
| array/sort-i32 | 0.788ms | 1247.2ms | — | — | js |
| array/map-filter | 0.133ms | 0.609ms | 0.060ms | — | gc-native |
| array/reduce | 2.12ms | 1.80ms | 0.823ms | — | gc-native |
| array/indexOf | 3.94ms | 3.38ms | 2.57ms | — | gc-native |
| array/slice | 0.025ms | 0.031ms | 0.013ms | — | gc-native |
| array/reverse | 7.83ms | 3.39ms | 4.31ms | — | host-call |
| array/forEach | 0.085ms | 0.081ms | 0.043ms | — | gc-native |
| array/find | 0.238ms | 0.424ms | — | — | js |
| dom/create-elements | 0.035ms | — | — | — | js |
| dom/set-attributes | 0.103ms | — | — | — | js |
| dom/read-attributes | 0.054ms | — | — | — | js |
| dom/modify-text | 0.047ms | — | — | — | js |
| mixed/csv-parse | 0.466ms | 32.57ms | 0.855ms | — | js |
| mixed/text-search | 0.216ms | 26.82ms | 0.974ms | — | js |
| mixed/fibonacci | 0.109ms | 0.228ms | 0.084ms | 1.18ms | gc-native |
| mixed/matrix-multiply | 0.157ms | 0.486ms | 0.203ms | 2.12ms | js |
| mixed/sieve | 1.51ms | 2.08ms | 1.14ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.44x slower | 1.10x slower | — |
| string/concat-long | 1.54x slower | 1.25x slower | — |
| string/indexOf | 514.54x slower | 12.64x slower | — |
| string/includes | 445.31x slower | 11.26x slower | — |
| string/split | 53.28x slower | 2.65x slower | — |
| string/replace | 19.91x slower | 3.33x slower | — |
| string/case-convert | 3734.88x slower | 13583.77x slower | — |
| string/substring | 2037.48x slower | 7.15x slower | — |
| string/trim | 37.79x slower | 3.34x slower | — |
| string/startsWith-endsWith | 53.71x slower | 2.67x slower | — |
| array/push-pop | 1.27x slower | 1.72x faster | — |
| array/sort-i32 | 1582.52x slower | — | — |
| array/map-filter | 4.60x slower | 2.21x faster | — |
| array/reduce | 1.18x faster | 2.58x faster | — |
| array/indexOf | 1.16x faster | 1.53x faster | — |
| array/slice | 1.24x slower | 1.96x faster | — |
| array/reverse | 2.31x faster | 1.82x faster | — |
| array/forEach | 1.05x faster | 1.96x faster | — |
| array/find | 1.78x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 69.91x slower | 1.84x slower | — |
| mixed/text-search | 124.46x slower | 4.52x slower | — |
| mixed/fibonacci | 2.08x slower | 1.30x faster | 10.80x slower |
| mixed/matrix-multiply | 3.09x slower | 1.29x slower | 13.51x slower |
| mixed/sieve | 1.37x slower | 1.33x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.31x faster |
| string/concat-long | 1.23x faster |
| string/indexOf | 40.71x faster |
| string/includes | 39.54x faster |
| string/split | 20.13x faster |
| string/replace | 5.98x faster |
| string/case-convert | 3.64x slower |
| string/substring | 285.11x faster |
| string/trim | 11.30x faster |
| string/startsWith-endsWith | 20.09x faster |
| array/push-pop | 2.19x faster |
| array/map-filter | 10.18x faster |
| array/reduce | 2.19x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.42x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.87x faster |
| mixed/csv-parse | 38.08x faster |
| mixed/text-search | 27.55x faster |
| mixed/fibonacci | 2.71x faster |
| mixed/matrix-multiply | 2.39x faster |
| mixed/sieve | 1.83x faster |

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
| string/concat-short | 1258.2ms | 1120.9ms | — |
| string/concat-long | 603.8ms | 980.7ms | — |
| string/indexOf | 554.0ms | 983.4ms | — |
| string/includes | 571.1ms | 975.3ms | — |
| string/split | 714.1ms | 1005.8ms | — |
| string/replace | 554.6ms | 978.1ms | — |
| string/case-convert | 549.2ms | 1240.6ms | — |
| string/substring | 531.6ms | 836.3ms | — |
| string/trim | 535.6ms | 929.0ms | — |
| string/startsWith-endsWith | 612.3ms | 968.9ms | — |
| array/push-pop | 741.8ms | 808.1ms | — |
| array/sort-i32 | 819.0ms | — | — |
| array/map-filter | 927.4ms | 935.6ms | — |
| array/reduce | 813.0ms | 897.2ms | — |
| array/indexOf | 741.7ms | 843.9ms | — |
| array/slice | 749.2ms | 828.3ms | — |
| array/reverse | 754.9ms | 836.2ms | — |
| array/forEach | 877.0ms | 931.4ms | — |
| array/find | 844.4ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 759.9ms | 968.0ms | — |
| mixed/text-search | 639.9ms | 1015.2ms | — |
| mixed/fibonacci | 642.1ms | 791.0ms | 630.9ms |
| mixed/matrix-multiply | 796.2ms | 903.0ms | 753.1ms |
| mixed/sieve | 791.7ms | 922.2ms | — |
