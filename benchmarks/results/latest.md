# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.049ms | 0.039ms | — | js |
| string/concat-long | 0.004ms | 0.006ms | 0.004ms | — | js |
| string/indexOf | 0.001ms | 0.674ms | 0.016ms | — | js |
| string/includes | 0.002ms | 0.676ms | 0.017ms | — | js |
| string/split | 0.404ms | 22.88ms | 1.06ms | — | js |
| string/replace | 0.042ms | 0.867ms | 0.140ms | — | js |
| string/case-convert | <0.001ms | 1.26ms | 4.60ms | — | js |
| string/substring | 0.003ms | 6.50ms | 0.024ms | — | js |
| string/trim | 0.152ms | 6.12ms | 0.509ms | — | js |
| string/startsWith-endsWith | 0.246ms | 13.44ms | 0.659ms | — | js |
| array/push-pop | 1.48ms | 1.86ms | 0.834ms | — | gc-native |
| array/sort-i32 | 0.803ms | 1257.8ms | — | — | js |
| array/map-filter | 0.128ms | 0.609ms | 0.059ms | — | gc-native |
| array/reduce | 1.35ms | 1.86ms | 0.832ms | — | gc-native |
| array/indexOf | 3.94ms | 3.39ms | 2.57ms | — | gc-native |
| array/slice | 0.025ms | 0.031ms | 0.013ms | — | gc-native |
| array/reverse | 7.83ms | 3.40ms | 4.31ms | — | host-call |
| array/forEach | 0.048ms | 0.081ms | 0.044ms | — | gc-native |
| array/find | 0.240ms | 0.406ms | — | — | js |
| dom/create-elements | 0.035ms | — | — | — | js |
| dom/set-attributes | 0.103ms | — | — | — | js |
| dom/read-attributes | 0.054ms | — | — | — | js |
| dom/modify-text | 0.047ms | — | — | — | js |
| mixed/csv-parse | 0.475ms | 34.28ms | 0.847ms | — | js |
| mixed/text-search | 0.218ms | 27.49ms | 0.973ms | — | js |
| mixed/fibonacci | 0.109ms | 0.228ms | — | 1.18ms | js |
| mixed/matrix-multiply | 0.158ms | 0.476ms | 0.186ms | 2.13ms | js |
| mixed/sieve | 1.54ms | 2.12ms | 1.13ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.41x slower | 1.13x slower | — |
| string/concat-long | 1.58x slower | 1.26x slower | — |
| string/indexOf | 509.80x slower | 12.08x slower | — |
| string/includes | 446.56x slower | 10.90x slower | — |
| string/split | 56.61x slower | 2.63x slower | — |
| string/replace | 20.49x slower | 3.32x slower | — |
| string/case-convert | 3913.02x slower | 14274.25x slower | — |
| string/substring | 2083.83x slower | 7.76x slower | — |
| string/trim | 40.33x slower | 3.36x slower | — |
| string/startsWith-endsWith | 54.66x slower | 2.68x slower | — |
| array/push-pop | 1.26x slower | 1.78x faster | — |
| array/sort-i32 | 1566.49x slower | — | — |
| array/map-filter | 4.75x slower | 2.17x faster | — |
| array/reduce | 1.37x slower | 1.62x faster | — |
| array/indexOf | 1.16x faster | 1.53x faster | — |
| array/slice | 1.23x slower | 1.93x faster | — |
| array/reverse | 2.30x faster | 1.82x faster | — |
| array/forEach | 1.69x slower | 1.10x faster | — |
| array/find | 1.70x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 72.22x slower | 1.79x slower | — |
| mixed/text-search | 125.85x slower | 4.45x slower | — |
| mixed/fibonacci | 2.08x slower | — | 10.81x slower |
| mixed/matrix-multiply | 3.02x slower | 1.18x slower | 13.49x slower |
| mixed/sieve | 1.37x slower | 1.36x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.25x faster |
| string/concat-long | 1.25x faster |
| string/indexOf | 42.21x faster |
| string/includes | 40.96x faster |
| string/split | 21.50x faster |
| string/replace | 6.18x faster |
| string/case-convert | 3.65x slower |
| string/substring | 268.54x faster |
| string/trim | 12.01x faster |
| string/startsWith-endsWith | 20.40x faster |
| array/push-pop | 2.23x faster |
| array/map-filter | 10.31x faster |
| array/reduce | 2.23x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.37x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.85x faster |
| mixed/csv-parse | 40.46x faster |
| mixed/text-search | 28.26x faster |
| mixed/matrix-multiply | 2.56x faster |
| mixed/sieve | 1.87x faster |

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
| string/concat-short | 1382.5ms | 1226.9ms | — |
| string/concat-long | 642.3ms | 1037.7ms | — |
| string/indexOf | 570.1ms | 1028.2ms | — |
| string/includes | 563.4ms | 1028.1ms | — |
| string/split | 740.1ms | 1029.0ms | — |
| string/replace | 556.8ms | 1047.0ms | — |
| string/case-convert | 569.2ms | 1448.5ms | — |
| string/substring | 551.2ms | 885.8ms | — |
| string/trim | 551.4ms | 969.2ms | — |
| string/startsWith-endsWith | 622.7ms | 1023.2ms | — |
| array/push-pop | 765.6ms | 865.2ms | — |
| array/sort-i32 | 841.5ms | — | — |
| array/map-filter | 957.1ms | 1007.6ms | — |
| array/reduce | 821.6ms | 889.8ms | — |
| array/indexOf | 760.6ms | 873.6ms | — |
| array/slice | 747.8ms | 850.7ms | — |
| array/reverse | 763.9ms | 795.7ms | — |
| array/forEach | 841.5ms | 910.8ms | — |
| array/find | 845.3ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 783.8ms | 969.6ms | — |
| mixed/text-search | 657.9ms | 1032.8ms | — |
| mixed/fibonacci | 665.6ms | — | 658.2ms |
| mixed/matrix-multiply | 856.8ms | 905.7ms | 811.6ms |
| mixed/sieve | 783.6ms | 920.9ms | — |
