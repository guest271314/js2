# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.048ms | 0.037ms | — | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | — | js |
| string/indexOf | 0.001ms | 0.681ms | 0.016ms | — | js |
| string/includes | 0.001ms | 0.677ms | 0.016ms | — | js |
| string/split | 0.402ms | 22.54ms | 1.06ms | — | js |
| string/replace | 0.042ms | 0.872ms | 0.139ms | — | js |
| string/case-convert | <0.001ms | 1.27ms | 4.42ms | — | js |
| string/substring | 0.003ms | 6.44ms | 0.024ms | — | js |
| string/trim | 0.151ms | 5.95ms | 0.507ms | — | js |
| string/startsWith-endsWith | 0.246ms | 13.46ms | 0.658ms | — | js |
| array/push-pop | 1.46ms | 1.84ms | 0.830ms | — | gc-native |
| array/sort-i32 | 0.792ms | 1258.3ms | — | — | js |
| array/map-filter | 0.131ms | 0.612ms | 0.060ms | — | gc-native |
| array/reduce | 2.15ms | 1.84ms | 0.834ms | — | gc-native |
| array/indexOf | 3.94ms | 3.38ms | 2.56ms | — | gc-native |
| array/slice | 0.025ms | 0.032ms | 0.014ms | — | gc-native |
| array/reverse | 7.83ms | 3.39ms | 4.31ms | — | host-call |
| array/forEach | 0.048ms | 0.082ms | 0.044ms | — | gc-native |
| array/find | 0.239ms | 0.425ms | — | — | js |
| dom/create-elements | 0.036ms | — | — | — | js |
| dom/set-attributes | 0.104ms | — | — | — | js |
| dom/read-attributes | 0.054ms | — | — | — | js |
| dom/modify-text | 0.049ms | — | — | — | js |
| mixed/csv-parse | 0.465ms | 34.39ms | 0.858ms | — | js |
| mixed/text-search | 0.093ms | 26.99ms | 0.973ms | — | js |
| mixed/fibonacci | 0.109ms | 0.227ms | 0.084ms | 0.226ms | gc-native |
| mixed/matrix-multiply | 0.164ms | 0.487ms | 0.204ms | 2.13ms | js |
| mixed/sieve | 1.56ms | 2.11ms | 1.13ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.44x slower | 1.11x slower | — |
| string/concat-long | 1.55x slower | 1.26x slower | — |
| string/indexOf | 524.22x slower | 12.32x slower | — |
| string/includes | 469.47x slower | 11.42x slower | — |
| string/split | 56.05x slower | 2.64x slower | — |
| string/replace | 20.71x slower | 3.30x slower | — |
| string/case-convert | 3941.60x slower | 13710.45x slower | — |
| string/substring | 2061.03x slower | 7.63x slower | — |
| string/trim | 39.30x slower | 3.35x slower | — |
| string/startsWith-endsWith | 54.74x slower | 2.67x slower | — |
| array/push-pop | 1.27x slower | 1.75x faster | — |
| array/sort-i32 | 1589.40x slower | — | — |
| array/map-filter | 4.68x slower | 2.18x faster | — |
| array/reduce | 1.17x faster | 2.58x faster | — |
| array/indexOf | 1.17x faster | 1.54x faster | — |
| array/slice | 1.26x slower | 1.88x faster | — |
| array/reverse | 2.31x faster | 1.82x faster | — |
| array/forEach | 1.70x slower | 1.10x faster | — |
| array/find | 1.78x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 73.91x slower | 1.84x slower | — |
| mixed/text-search | 290.05x slower | 10.45x slower | — |
| mixed/fibonacci | 2.08x slower | 1.30x faster | 2.07x slower |
| mixed/matrix-multiply | 2.98x slower | 1.25x slower | 13.00x slower |
| mixed/sieve | 1.35x slower | 1.38x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.29x faster |
| string/concat-long | 1.22x faster |
| string/indexOf | 42.56x faster |
| string/includes | 41.12x faster |
| string/split | 21.27x faster |
| string/replace | 6.27x faster |
| string/case-convert | 3.48x slower |
| string/substring | 270.10x faster |
| string/trim | 11.72x faster |
| string/startsWith-endsWith | 20.47x faster |
| array/push-pop | 2.22x faster |
| array/map-filter | 10.18x faster |
| array/reduce | 2.21x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.36x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.87x faster |
| mixed/csv-parse | 40.10x faster |
| mixed/text-search | 27.75x faster |
| mixed/fibonacci | 2.71x faster |
| mixed/matrix-multiply | 2.38x faster |
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
| string/concat-short | 1292.9ms | 1129.6ms | — |
| string/concat-long | 635.1ms | 1018.5ms | — |
| string/indexOf | 578.4ms | 1031.6ms | — |
| string/includes | 571.4ms | 1014.8ms | — |
| string/split | 750.6ms | 1046.0ms | — |
| string/replace | 583.0ms | 1038.1ms | — |
| string/case-convert | 580.3ms | 1328.2ms | — |
| string/substring | 575.4ms | 878.9ms | — |
| string/trim | 557.2ms | 937.5ms | — |
| string/startsWith-endsWith | 616.3ms | 993.8ms | — |
| array/push-pop | 757.6ms | 819.0ms | — |
| array/sort-i32 | 837.8ms | — | — |
| array/map-filter | 962.7ms | 961.8ms | — |
| array/reduce | 866.5ms | 936.7ms | — |
| array/indexOf | 759.4ms | 836.2ms | — |
| array/slice | 765.9ms | 807.9ms | — |
| array/reverse | 735.3ms | 818.0ms | — |
| array/forEach | 867.1ms | 964.1ms | — |
| array/find | 866.1ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 786.3ms | 1007.4ms | — |
| mixed/text-search | 727.0ms | 1023.2ms | — |
| mixed/fibonacci | 680.7ms | 855.0ms | 707.8ms |
| mixed/matrix-multiply | 792.0ms | 902.7ms | 811.3ms |
| mixed/sieve | 838.5ms | 903.4ms | — |
