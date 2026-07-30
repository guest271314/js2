# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.049ms | 0.038ms | — | js |
| string/concat-long | 0.004ms | 0.006ms | 0.004ms | — | js |
| string/indexOf | 0.001ms | 0.686ms | 0.016ms | — | js |
| string/includes | 0.001ms | 0.694ms | 0.017ms | — | js |
| string/split | 0.402ms | 23.03ms | 1.06ms | — | js |
| string/replace | 0.042ms | 0.887ms | 0.140ms | — | js |
| string/case-convert | <0.001ms | 1.25ms | 4.40ms | — | js |
| string/substring | 0.003ms | 6.44ms | 0.025ms | — | js |
| string/trim | 0.152ms | 6.01ms | 0.506ms | — | js |
| string/startsWith-endsWith | 0.246ms | 13.49ms | 0.657ms | — | js |
| array/push-pop | 1.45ms | 1.87ms | 0.848ms | — | gc-native |
| array/sort-i32 | 0.794ms | 1263.1ms | — | — | js |
| array/map-filter | 0.129ms | 0.607ms | 0.059ms | — | gc-native |
| array/reduce | 1.33ms | 1.83ms | 0.854ms | — | gc-native |
| array/indexOf | 3.94ms | 3.39ms | 2.57ms | — | gc-native |
| array/slice | 0.025ms | 0.031ms | 0.013ms | — | gc-native |
| array/reverse | 7.83ms | 3.40ms | 4.31ms | — | host-call |
| array/forEach | 0.049ms | 0.081ms | 0.044ms | — | gc-native |
| array/find | 0.238ms | 0.406ms | — | — | js |
| dom/create-elements | 0.040ms | — | — | — | js |
| dom/set-attributes | 0.104ms | — | — | — | js |
| dom/read-attributes | 0.054ms | — | — | — | js |
| dom/modify-text | 0.061ms | — | — | — | js |
| mixed/csv-parse | 0.474ms | 34.54ms | 0.848ms | — | js |
| mixed/text-search | 0.219ms | 27.64ms | 0.973ms | — | js |
| mixed/fibonacci | 0.109ms | 0.227ms | — | 0.226ms | js |
| mixed/matrix-multiply | 0.158ms | 0.477ms | 0.206ms | 2.12ms | js |
| mixed/sieve | 1.57ms | 2.12ms | 1.14ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.58x slower | 1.23x slower | — |
| string/concat-long | 1.59x slower | 1.25x slower | — |
| string/indexOf | 533.66x slower | 12.47x slower | — |
| string/includes | 471.74x slower | 11.29x slower | — |
| string/split | 57.26x slower | 2.64x slower | — |
| string/replace | 20.91x slower | 3.29x slower | — |
| string/case-convert | 3867.32x slower | 13676.07x slower | — |
| string/substring | 2062.75x slower | 7.86x slower | — |
| string/trim | 39.60x slower | 3.33x slower | — |
| string/startsWith-endsWith | 54.85x slower | 2.67x slower | — |
| array/push-pop | 1.29x slower | 1.71x faster | — |
| array/sort-i32 | 1590.13x slower | — | — |
| array/map-filter | 4.69x slower | 2.21x faster | — |
| array/reduce | 1.38x slower | 1.56x faster | — |
| array/indexOf | 1.16x faster | 1.54x faster | — |
| array/slice | 1.22x slower | 1.90x faster | — |
| array/reverse | 2.31x faster | 1.82x faster | — |
| array/forEach | 1.67x slower | 1.11x faster | — |
| array/find | 1.70x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 72.83x slower | 1.79x slower | — |
| mixed/text-search | 126.09x slower | 4.44x slower | — |
| mixed/fibonacci | 2.08x slower | — | 2.06x slower |
| mixed/matrix-multiply | 3.01x slower | 1.30x slower | 13.43x slower |
| mixed/sieve | 1.35x slower | 1.37x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.28x faster |
| string/concat-long | 1.27x faster |
| string/indexOf | 42.80x faster |
| string/includes | 41.77x faster |
| string/split | 21.66x faster |
| string/replace | 6.35x faster |
| string/case-convert | 3.54x slower |
| string/substring | 262.35x faster |
| string/trim | 11.88x faster |
| string/startsWith-endsWith | 20.52x faster |
| array/push-pop | 2.20x faster |
| array/map-filter | 10.35x faster |
| array/reduce | 2.15x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.33x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.85x faster |
| mixed/csv-parse | 40.70x faster |
| mixed/text-search | 28.41x faster |
| mixed/matrix-multiply | 2.32x faster |
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
| string/concat-short | 1414.2ms | 1185.1ms | — |
| string/concat-long | 634.0ms | 1006.4ms | — |
| string/indexOf | 562.5ms | 1050.1ms | — |
| string/includes | 573.0ms | 1028.3ms | — |
| string/split | 732.1ms | 1046.1ms | — |
| string/replace | 561.5ms | 1017.0ms | — |
| string/case-convert | 594.1ms | 1302.3ms | — |
| string/substring | 561.5ms | 888.7ms | — |
| string/trim | 552.8ms | 964.3ms | — |
| string/startsWith-endsWith | 632.3ms | 949.3ms | — |
| array/push-pop | 756.6ms | 864.0ms | — |
| array/sort-i32 | 854.2ms | — | — |
| array/map-filter | 937.7ms | 1005.3ms | — |
| array/reduce | 826.2ms | 900.5ms | — |
| array/indexOf | 762.5ms | 861.1ms | — |
| array/slice | 756.2ms | 839.1ms | — |
| array/reverse | 741.0ms | 826.4ms | — |
| array/forEach | 850.2ms | 940.2ms | — |
| array/find | 846.5ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 788.9ms | 1005.2ms | — |
| mixed/text-search | 716.1ms | 1045.7ms | — |
| mixed/fibonacci | 668.5ms | — | 689.7ms |
| mixed/matrix-multiply | 815.1ms | 884.3ms | 769.9ms |
| mixed/sieve | 800.3ms | 901.8ms | — |
