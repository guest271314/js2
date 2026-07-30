# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.037ms | 0.058ms | 0.042ms | — | js |
| string/concat-long | 0.004ms | 0.006ms | 0.005ms | — | js |
| string/indexOf | 0.001ms | 0.655ms | 0.016ms | — | js |
| string/includes | 0.002ms | 0.648ms | 0.016ms | — | js |
| string/split | 0.404ms | 21.82ms | 1.08ms | — | js |
| string/replace | 0.041ms | 0.861ms | 0.147ms | — | js |
| string/case-convert | <0.001ms | 1.13ms | 4.73ms | — | js |
| string/substring | 0.004ms | 6.00ms | 0.020ms | — | js |
| string/trim | 0.153ms | 5.50ms | 0.537ms | — | js |
| string/startsWith-endsWith | 0.313ms | 12.63ms | 0.739ms | — | js |
| array/push-pop | 1.67ms | 2.16ms | 0.953ms | — | gc-native |
| array/sort-i32 | 0.841ms | 1269.0ms | — | — | js |
| array/map-filter | 0.133ms | 0.641ms | 0.050ms | — | gc-native |
| array/reduce | 1.58ms | 2.15ms | 0.957ms | — | gc-native |
| array/indexOf | 4.45ms | 3.82ms | 2.88ms | — | gc-native |
| array/slice | 0.033ms | 0.020ms | 0.010ms | — | gc-native |
| array/reverse | 8.85ms | 3.65ms | 4.42ms | — | host-call |
| array/forEach | 0.052ms | 0.085ms | 0.035ms | — | gc-native |
| array/find | 0.281ms | 0.472ms | — | — | js |
| dom/create-elements | 0.034ms | — | — | — | js |
| dom/set-attributes | 0.107ms | — | — | — | js |
| dom/read-attributes | 0.057ms | — | — | — | js |
| dom/modify-text | 0.046ms | — | — | — | js |
| mixed/csv-parse | 2.13ms | 33.14ms | 0.888ms | — | gc-native |
| mixed/text-search | 0.236ms | 26.53ms | 1.09ms | — | js |
| mixed/fibonacci | 0.118ms | 0.270ms | 0.095ms | 0.264ms | gc-native |
| mixed/matrix-multiply | 0.184ms | 0.492ms | 0.200ms | 2.02ms | js |
| mixed/sieve | 1.75ms | 2.31ms | 1.29ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.56x slower | 1.14x slower | — |
| string/concat-long | 1.55x slower | 1.22x slower | — |
| string/indexOf | 456.05x slower | 11.17x slower | — |
| string/includes | 398.00x slower | 10.08x slower | — |
| string/split | 54.00x slower | 2.68x slower | — |
| string/replace | 21.20x slower | 3.62x slower | — |
| string/case-convert | 3111.88x slower | 12984.50x slower | — |
| string/substring | 1700.59x slower | 5.58x slower | — |
| string/trim | 35.91x slower | 3.50x slower | — |
| string/startsWith-endsWith | 40.30x slower | 2.36x slower | — |
| array/push-pop | 1.29x slower | 1.75x faster | — |
| array/sort-i32 | 1509.68x slower | — | — |
| array/map-filter | 4.82x slower | 2.67x faster | — |
| array/reduce | 1.36x slower | 1.65x faster | — |
| array/indexOf | 1.17x faster | 1.54x faster | — |
| array/slice | 1.66x faster | 3.43x faster | — |
| array/reverse | 2.42x faster | 2.00x faster | — |
| array/forEach | 1.64x slower | 1.49x faster | — |
| array/find | 1.68x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 15.55x slower | 2.40x faster | — |
| mixed/text-search | 112.63x slower | 4.62x slower | — |
| mixed/fibonacci | 2.29x slower | 1.25x faster | 2.24x slower |
| mixed/matrix-multiply | 2.67x slower | 1.09x slower | 10.95x slower |
| mixed/sieve | 1.32x slower | 1.35x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.38x faster |
| string/concat-long | 1.27x faster |
| string/indexOf | 40.84x faster |
| string/includes | 39.48x faster |
| string/split | 20.12x faster |
| string/replace | 5.85x faster |
| string/case-convert | 4.17x slower |
| string/substring | 304.68x faster |
| string/trim | 10.26x faster |
| string/startsWith-endsWith | 17.09x faster |
| array/push-pop | 2.26x faster |
| array/map-filter | 12.88x faster |
| array/reduce | 2.25x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.06x faster |
| array/reverse | 1.21x slower |
| array/forEach | 2.44x faster |
| mixed/csv-parse | 37.31x faster |
| mixed/text-search | 24.38x faster |
| mixed/fibonacci | 2.85x faster |
| mixed/matrix-multiply | 2.46x faster |
| mixed/sieve | 1.78x faster |

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
| string/concat-short | 1183.1ms | 1117.9ms | — |
| string/concat-long | 619.5ms | 975.3ms | — |
| string/indexOf | 572.4ms | 945.5ms | — |
| string/includes | 557.4ms | 996.2ms | — |
| string/split | 712.4ms | 973.3ms | — |
| string/replace | 550.0ms | 984.3ms | — |
| string/case-convert | 538.8ms | 1229.2ms | — |
| string/substring | 534.1ms | 869.6ms | — |
| string/trim | 543.0ms | 892.5ms | — |
| string/startsWith-endsWith | 609.0ms | 986.5ms | — |
| array/push-pop | 724.1ms | 825.1ms | — |
| array/sort-i32 | 808.7ms | — | — |
| array/map-filter | 908.3ms | 938.4ms | — |
| array/reduce | 845.9ms | 886.6ms | — |
| array/indexOf | 736.9ms | 821.4ms | — |
| array/slice | 748.8ms | 819.4ms | — |
| array/reverse | 725.4ms | 775.9ms | — |
| array/forEach | 864.7ms | 925.6ms | — |
| array/find | 834.9ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 753.3ms | 963.1ms | — |
| mixed/text-search | 652.5ms | 999.9ms | — |
| mixed/fibonacci | 641.2ms | 759.8ms | 653.7ms |
| mixed/matrix-multiply | 758.1ms | 848.7ms | 743.0ms |
| mixed/sieve | 790.9ms | 865.8ms | — |
