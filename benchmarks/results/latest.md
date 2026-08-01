# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.051ms | 0.043ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | FAILED | js |
| string/indexOf | 0.001ms | 0.062ms | 0.013ms | FAILED | js |
| string/includes | 0.002ms | 0.123ms | 0.013ms | FAILED | js |
| string/split | 0.403ms | 5.08ms | 0.867ms | FAILED | js |
| string/replace | 0.041ms | 0.195ms | 0.063ms | FAILED | js |
| string/case-convert | <0.001ms | 0.218ms | 0.070ms | FAILED | js |
| string/substring | 0.004ms | 1.03ms | 0.020ms | FAILED | js |
| string/trim | 0.154ms | 0.934ms | 0.173ms | FAILED | js |
| string/startsWith-endsWith | 0.313ms | 2.56ms | 0.232ms | FAILED | gc-native |
| array/push-pop | 1.69ms | 2.18ms | 0.954ms | FAILED | gc-native |
| array/sort-i32 | 0.845ms | 0.382ms | 0.305ms | FAILED | gc-native |
| array/map-filter | 0.134ms | 0.649ms | 0.050ms | FAILED | gc-native |
| array/reduce | 2.38ms | 2.17ms | 0.958ms | FAILED | gc-native |
| array/indexOf | 4.46ms | 3.81ms | 2.88ms | FAILED | gc-native |
| array/slice | 0.035ms | 0.023ms | 0.011ms | FAILED | gc-native |
| array/reverse | 10.32ms | 4.26ms | 5.16ms | FAILED | host-call |
| array/forEach | 0.059ms | 0.098ms | 0.039ms | FAILED | gc-native |
| array/find | 0.326ms | 0.550ms | 0.406ms | 5.71ms | js |
| dom/create-elements | 0.275ms | 0.309ms | — | — | js |
| dom/set-attributes | 0.135ms | 0.449ms | — | — | js |
| dom/read-attributes | 0.073ms | 0.211ms | — | — | js |
| dom/modify-text | 0.063ms | 0.191ms | — | — | js |
| mixed/csv-parse | 0.530ms | 7.92ms | 0.842ms | FAILED | js |
| mixed/text-search | 0.275ms | 6.19ms | 0.725ms | FAILED | js |
| mixed/fibonacci | 0.138ms | 0.311ms | 0.111ms | 0.308ms | gc-native |
| mixed/matrix-multiply | 0.213ms | 0.574ms | 0.232ms | 2.36ms | js |
| mixed/sieve | 2.01ms | 2.66ms | 1.50ms | FAILED | gc-native |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/includes | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/split | linear-memory | warmup | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/startsWith-endsWith | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/text-search | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.53x slower | 1.29x slower | — |
| string/concat-long | 1.33x slower | 1.16x slower | — |
| string/indexOf | 43.95x slower | 9.26x slower | — |
| string/includes | 75.98x slower | 8.29x slower | — |
| string/split | 12.59x slower | 2.15x slower | — |
| string/replace | 4.74x slower | 1.53x slower | — |
| string/case-convert | 603.07x slower | 193.44x slower | — |
| string/substring | 292.81x slower | 5.68x slower | — |
| string/trim | 6.07x slower | 1.12x slower | — |
| string/startsWith-endsWith | 8.17x slower | 1.35x faster | — |
| array/push-pop | 1.29x slower | 1.77x faster | — |
| array/sort-i32 | 2.21x faster | 2.78x faster | — |
| array/map-filter | 4.83x slower | 2.67x faster | — |
| array/reduce | 1.10x faster | 2.49x faster | — |
| array/indexOf | 1.17x faster | 1.55x faster | — |
| array/slice | 1.56x faster | 3.20x faster | — |
| array/reverse | 2.42x faster | 2.00x faster | — |
| array/forEach | 1.67x slower | 1.51x faster | — |
| array/find | 1.69x slower | 1.24x slower | 17.50x slower |
| dom/create-elements | 1.12x slower | — | — |
| dom/set-attributes | 3.33x slower | — | — |
| dom/read-attributes | 2.89x slower | — | — |
| dom/modify-text | 3.04x slower | — | — |
| mixed/csv-parse | 14.95x slower | 1.59x slower | — |
| mixed/text-search | 22.51x slower | 2.64x slower | — |
| mixed/fibonacci | 2.25x slower | 1.25x faster | 2.23x slower |
| mixed/matrix-multiply | 2.70x slower | 1.09x slower | 11.09x slower |
| mixed/sieve | 1.32x slower | 1.34x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.19x faster |
| string/concat-long | 1.14x faster |
| string/indexOf | 4.75x faster |
| string/includes | 9.17x faster |
| string/split | 5.86x faster |
| string/replace | 3.09x faster |
| string/case-convert | 3.12x faster |
| string/substring | 51.58x faster |
| string/trim | 5.39x faster |
| string/startsWith-endsWith | 11.03x faster |
| array/push-pop | 2.28x faster |
| array/sort-i32 | 1.26x faster |
| array/map-filter | 12.89x faster |
| array/reduce | 2.26x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.06x faster |
| array/reverse | 1.21x slower |
| array/forEach | 2.53x faster |
| array/find | 1.36x faster |
| mixed/csv-parse | 9.41x faster |
| mixed/text-search | 8.54x faster |
| mixed/fibonacci | 2.81x faster |
| mixed/matrix-multiply | 2.47x faster |
| mixed/sieve | 1.77x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 1.7KB | — |
| string/concat-long | 236B | 1.9KB | — |
| string/indexOf | 216B | 2.1KB | — |
| string/includes | 236B | 2.1KB | — |
| string/split | 973B | 1.5KB | — |
| string/replace | 289B | 2.7KB | — |
| string/case-convert | 249B | 11.7KB | — |
| string/substring | 239B | 1.3KB | — |
| string/trim | 205B | 1.7KB | — |
| string/startsWith-endsWith | 330B | 1.6KB | — |
| array/push-pop | 947B | 1.4KB | — |
| array/sort-i32 | 2.7KB | 3.1KB | — |
| array/map-filter | 3.3KB | 3.3KB | — |
| array/reduce | 2.3KB | 2.8KB | — |
| array/indexOf | 1022B | 1.5KB | — |
| array/slice | 1.0KB | 1.5KB | — |
| array/reverse | 1.0KB | 1.5KB | — |
| array/forEach | 2.6KB | 3.1KB | — |
| array/find | 2.7KB | 3.2KB | 623B |
| dom/create-elements | 243B | — | — |
| dom/set-attributes | 510B | — | — |
| dom/read-attributes | 358B | — | — |
| dom/modify-text | 250B | — | — |
| mixed/csv-parse | 1.4KB | 2.9KB | — |
| mixed/text-search | 600B | 2.1KB | — |
| mixed/fibonacci | 157B | 1.1KB | 173B |
| mixed/matrix-multiply | 1.3KB | 1.8KB | 950B |
| mixed/sieve | 1.5KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1277.9ms | 1140.6ms | — |
| string/concat-long | 610.1ms | 978.5ms | — |
| string/indexOf | 563.5ms | 1004.0ms | — |
| string/includes | 544.4ms | 963.4ms | — |
| string/split | 716.3ms | 984.0ms | — |
| string/replace | 549.0ms | 1033.0ms | — |
| string/case-convert | 537.8ms | 1092.1ms | — |
| string/substring | 537.0ms | 827.8ms | — |
| string/trim | 539.7ms | 964.1ms | — |
| string/startsWith-endsWith | 614.7ms | 926.8ms | — |
| array/push-pop | 755.1ms | 839.9ms | — |
| array/sort-i32 | 943.8ms | 946.0ms | — |
| array/map-filter | 950.5ms | 921.9ms | — |
| array/reduce | 807.6ms | 897.7ms | — |
| array/indexOf | 722.2ms | 824.2ms | — |
| array/slice | 804.6ms | 952.1ms | — |
| array/reverse | 863.9ms | 954.0ms | — |
| array/forEach | 1018.7ms | 1038.6ms | — |
| array/find | 990.9ms | 1067.5ms | 924.5ms |
| dom/create-elements | 706.1ms | — | — |
| dom/set-attributes | 792.9ms | — | — |
| dom/read-attributes | 787.6ms | — | — |
| dom/modify-text | 748.1ms | — | — |
| mixed/csv-parse | 875.3ms | 1114.9ms | — |
| mixed/text-search | 744.9ms | 1084.8ms | — |
| mixed/fibonacci | 747.4ms | 912.5ms | 777.6ms |
| mixed/matrix-multiply | 911.8ms | 1011.5ms | 880.6ms |
| mixed/sieve | 942.4ms | 993.1ms | — |
