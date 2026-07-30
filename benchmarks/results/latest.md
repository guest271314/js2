# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.032ms | 0.076ms | 0.040ms | — | js |
| string/concat-long | 0.004ms | 0.013ms | 0.031ms | — | js |
| string/indexOf | 0.022ms | 0.722ms | 0.039ms | — | js |
| string/includes | 0.023ms | 0.744ms | 0.064ms | — | js |
| string/split | 0.399ms | 23.29ms | 1.07ms | — | js |
| string/replace | 0.042ms | 0.888ms | 0.141ms | — | js |
| string/case-convert | <0.001ms | 1.27ms | 4.39ms | — | js |
| string/substring | 0.004ms | 6.46ms | 0.025ms | — | js |
| string/trim | 0.151ms | 5.91ms | 0.511ms | — | js |
| string/startsWith-endsWith | 0.377ms | 13.41ms | 0.661ms | — | js |
| array/push-pop | 1.50ms | 1.88ms | 0.833ms | — | gc-native |
| array/sort-i32 | 0.808ms | 1261.3ms | — | — | js |
| array/map-filter | 0.143ms | 1.20ms | 0.060ms | — | gc-native |
| array/reduce | 2.16ms | 1.83ms | 0.824ms | — | gc-native |
| array/indexOf | 3.95ms | 3.38ms | 2.57ms | — | gc-native |
| array/slice | 0.027ms | 0.192ms | 0.025ms | — | gc-native |
| array/reverse | 7.84ms | 3.40ms | 4.32ms | — | host-call |
| array/forEach | 0.059ms | 0.082ms | 0.046ms | — | gc-native |
| array/find | 0.231ms | 0.719ms | — | — | js |
| dom/create-elements | 0.057ms | — | — | — | js |
| dom/set-attributes | 0.116ms | — | — | — | js |
| dom/read-attributes | 0.675ms | — | — | — | js |
| dom/modify-text | 0.046ms | — | — | — | js |
| mixed/csv-parse | 0.462ms | 34.39ms | 0.863ms | — | js |
| mixed/text-search | 0.213ms | 27.65ms | 0.981ms | — | js |
| mixed/fibonacci | 0.118ms | 0.226ms | — | 1.18ms | js |
| mixed/matrix-multiply | 0.156ms | 0.478ms | 0.185ms | 2.12ms | js |
| mixed/sieve | 1.65ms | 2.12ms | 1.15ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 2.39x slower | 1.25x slower | — |
| string/concat-long | 3.10x slower | 7.23x slower | — |
| string/indexOf | 33.09x slower | 1.78x slower | — |
| string/includes | 31.74x slower | 2.75x slower | — |
| string/split | 58.39x slower | 2.69x slower | — |
| string/replace | 21.08x slower | 3.35x slower | — |
| string/case-convert | 1925.91x slower | 6646.14x slower | — |
| string/substring | 1775.62x slower | 6.79x slower | — |
| string/trim | 39.20x slower | 3.39x slower | — |
| string/startsWith-endsWith | 35.56x slower | 1.75x slower | — |
| array/push-pop | 1.25x slower | 1.80x faster | — |
| array/sort-i32 | 1560.12x slower | — | — |
| array/map-filter | 8.40x slower | 2.37x faster | — |
| array/reduce | 1.18x faster | 2.63x faster | — |
| array/indexOf | 1.17x faster | 1.54x faster | — |
| array/slice | 7.22x slower | 1.05x faster | — |
| array/reverse | 2.31x faster | 1.82x faster | — |
| array/forEach | 1.39x slower | 1.29x faster | — |
| array/find | 3.11x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 74.44x slower | 1.87x slower | — |
| mixed/text-search | 129.78x slower | 4.61x slower | — |
| mixed/fibonacci | 1.92x slower | — | 10.03x slower |
| mixed/matrix-multiply | 3.07x slower | 1.19x slower | 13.63x slower |
| mixed/sieve | 1.29x slower | 1.43x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.91x faster |
| string/concat-long | 2.33x slower |
| string/indexOf | 18.59x faster |
| string/includes | 11.56x faster |
| string/split | 21.71x faster |
| string/replace | 6.28x faster |
| string/case-convert | 3.45x slower |
| string/substring | 261.33x faster |
| string/trim | 11.55x faster |
| string/startsWith-endsWith | 20.29x faster |
| array/push-pop | 2.26x faster |
| array/map-filter | 19.90x faster |
| array/reduce | 2.23x faster |
| array/indexOf | 1.32x faster |
| array/slice | 7.57x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.80x faster |
| mixed/csv-parse | 39.87x faster |
| mixed/text-search | 28.17x faster |
| mixed/matrix-multiply | 2.58x faster |
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
| string/trim | 205B | 1.8KB | — |
| string/startsWith-endsWith | 330B | 1.7KB | — |
| array/push-pop | 947B | 1.4KB | — |
| array/sort-i32 | 1.2KB | — | — |
| array/map-filter | 2.4KB | 2.5KB | — |
| array/reduce | 1.7KB | 2.2KB | — |
| array/indexOf | 1022B | 1.5KB | — |
| array/slice | 1.0KB | 1.5KB | — |
| array/reverse | 1.0KB | 1.5KB | — |
| array/forEach | 1.8KB | 2.4KB | — |
| array/find | 2.0KB | — | — |
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
| string/concat-short | 1332.0ms | 1261.3ms | — |
| string/concat-long | 658.7ms | 1071.9ms | — |
| string/indexOf | 606.8ms | 1073.1ms | — |
| string/includes | 616.3ms | 1089.9ms | — |
| string/split | 763.6ms | 1036.4ms | — |
| string/replace | 604.6ms | 1063.5ms | — |
| string/case-convert | 560.2ms | 1259.9ms | — |
| string/substring | 551.5ms | 888.9ms | — |
| string/trim | 574.4ms | 1032.5ms | — |
| string/startsWith-endsWith | 637.9ms | 1028.1ms | — |
| array/push-pop | 825.0ms | 864.2ms | — |
| array/sort-i32 | 885.2ms | — | — |
| array/map-filter | 947.7ms | 963.8ms | — |
| array/reduce | 819.2ms | 923.3ms | — |
| array/indexOf | 765.2ms | 834.3ms | — |
| array/slice | 757.6ms | 858.6ms | — |
| array/reverse | 755.6ms | 858.9ms | — |
| array/forEach | 881.8ms | 952.7ms | — |
| array/find | 835.3ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 795.9ms | 980.7ms | — |
| mixed/text-search | 666.2ms | 1074.5ms | — |
| mixed/fibonacci | 688.6ms | — | 689.3ms |
| mixed/matrix-multiply | 890.4ms | 916.4ms | 795.0ms |
| mixed/sieve | 815.0ms | 900.8ms | — |
