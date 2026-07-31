# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.047ms | 0.038ms | — | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | — | js |
| string/indexOf | 0.001ms | 0.714ms | 0.016ms | — | js |
| string/includes | 0.001ms | 0.685ms | 0.017ms | — | js |
| string/split | 0.399ms | 22.68ms | 1.06ms | — | js |
| string/replace | 0.042ms | 0.884ms | 0.140ms | — | js |
| string/case-convert | <0.001ms | 1.25ms | 4.41ms | — | js |
| string/substring | 0.003ms | 6.55ms | 0.024ms | — | js |
| string/trim | 0.151ms | 5.99ms | 0.508ms | — | js |
| string/startsWith-endsWith | 0.246ms | 13.48ms | 0.658ms | — | js |
| array/push-pop | 1.40ms | 1.85ms | 0.831ms | — | gc-native |
| array/sort-i32 | 0.772ms | 1276.2ms | — | — | js |
| array/map-filter | 0.072ms | 0.612ms | 0.060ms | — | gc-native |
| array/reduce | 1.97ms | 1.85ms | 0.833ms | — | gc-native |
| array/indexOf | 3.94ms | 3.38ms | 2.57ms | — | gc-native |
| array/slice | 0.025ms | 0.031ms | 0.013ms | — | gc-native |
| array/reverse | 7.83ms | 3.39ms | 4.31ms | — | host-call |
| array/forEach | 0.048ms | 0.081ms | 0.044ms | — | gc-native |
| array/find | 0.238ms | 0.427ms | — | — | js |
| dom/create-elements | 0.035ms | — | — | — | js |
| dom/set-attributes | 0.104ms | — | — | — | js |
| dom/read-attributes | 0.055ms | — | — | — | js |
| dom/modify-text | 0.049ms | — | — | — | js |
| mixed/csv-parse | 0.485ms | 34.56ms | 0.856ms | — | js |
| mixed/text-search | 0.216ms | 27.54ms | 0.973ms | — | js |
| mixed/fibonacci | 0.109ms | 0.227ms | 0.084ms | 1.18ms | gc-native |
| mixed/matrix-multiply | 0.157ms | 0.486ms | 0.186ms | 2.13ms | js |
| mixed/sieve | 1.56ms | 2.11ms | 1.14ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.39x slower | 1.12x slower | — |
| string/concat-long | 1.51x slower | 1.24x slower | — |
| string/indexOf | 560.25x slower | 12.30x slower | — |
| string/includes | 470.38x slower | 11.34x slower | — |
| string/split | 56.88x slower | 2.67x slower | — |
| string/replace | 20.90x slower | 3.30x slower | — |
| string/case-convert | 3863.47x slower | 13617.39x slower | — |
| string/substring | 2095.99x slower | 7.60x slower | — |
| string/trim | 39.55x slower | 3.36x slower | — |
| string/startsWith-endsWith | 54.85x slower | 2.68x slower | — |
| array/push-pop | 1.32x slower | 1.68x faster | — |
| array/sort-i32 | 1652.87x slower | — | — |
| array/map-filter | 8.54x slower | 1.19x faster | — |
| array/reduce | 1.06x faster | 2.36x faster | — |
| array/indexOf | 1.16x faster | 1.53x faster | — |
| array/slice | 1.25x slower | 1.91x faster | — |
| array/reverse | 2.31x faster | 1.82x faster | — |
| array/forEach | 1.67x slower | 1.11x faster | — |
| array/find | 1.79x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 71.30x slower | 1.76x slower | — |
| mixed/text-search | 127.65x slower | 4.51x slower | — |
| mixed/fibonacci | 2.08x slower | 1.30x faster | 10.81x slower |
| mixed/matrix-multiply | 3.10x slower | 1.18x slower | 13.57x slower |
| mixed/sieve | 1.35x slower | 1.37x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.24x faster |
| string/concat-long | 1.21x faster |
| string/indexOf | 45.54x faster |
| string/includes | 41.47x faster |
| string/split | 21.34x faster |
| string/replace | 6.33x faster |
| string/case-convert | 3.52x slower |
| string/substring | 275.91x faster |
| string/trim | 11.78x faster |
| string/startsWith-endsWith | 20.50x faster |
| array/push-pop | 2.23x faster |
| array/map-filter | 10.16x faster |
| array/reduce | 2.22x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.38x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.86x faster |
| mixed/csv-parse | 40.40x faster |
| mixed/text-search | 28.30x faster |
| mixed/fibonacci | 2.71x faster |
| mixed/matrix-multiply | 2.62x faster |
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
| string/concat-short | 1290.4ms | 1216.1ms | — |
| string/concat-long | 672.0ms | 1032.8ms | — |
| string/indexOf | 583.5ms | 1041.5ms | — |
| string/includes | 596.3ms | 1017.5ms | — |
| string/split | 743.6ms | 1037.7ms | — |
| string/replace | 594.6ms | 1064.6ms | — |
| string/case-convert | 605.9ms | 1291.5ms | — |
| string/substring | 573.6ms | 923.8ms | — |
| string/trim | 562.6ms | 981.0ms | — |
| string/startsWith-endsWith | 647.5ms | 1011.1ms | — |
| array/push-pop | 761.1ms | 859.8ms | — |
| array/sort-i32 | 835.6ms | — | — |
| array/map-filter | 975.4ms | 999.9ms | — |
| array/reduce | 875.4ms | 937.9ms | — |
| array/indexOf | 766.3ms | 873.6ms | — |
| array/slice | 781.9ms | 901.0ms | — |
| array/reverse | 750.7ms | 846.6ms | — |
| array/forEach | 871.8ms | 964.5ms | — |
| array/find | 896.8ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 803.7ms | 986.6ms | — |
| mixed/text-search | 684.7ms | 1094.0ms | — |
| mixed/fibonacci | 656.3ms | 858.4ms | 707.4ms |
| mixed/matrix-multiply | 798.4ms | 906.8ms | 827.2ms |
| mixed/sieve | 849.8ms | 906.2ms | — |
