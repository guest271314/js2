# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.027ms | 0.048ms | 0.040ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | FAILED | js |
| string/indexOf | 0.001ms | 0.066ms | 0.019ms | FAILED | js |
| string/includes | 0.001ms | 0.145ms | 0.014ms | FAILED | js |
| string/split | 0.403ms | 5.86ms | 0.871ms | FAILED | js |
| string/replace | 0.042ms | 0.255ms | 0.064ms | FAILED | js |
| string/case-convert | <0.001ms | 0.219ms | 0.066ms | FAILED | js |
| string/substring | 0.003ms | 0.992ms | 0.023ms | FAILED | js |
| string/trim | 0.151ms | 0.929ms | 0.164ms | FAILED | js |
| string/startsWith-endsWith | 0.246ms | 2.62ms | 0.214ms | FAILED | gc-native |
| array/push-pop | 1.46ms | 1.86ms | 0.832ms | FAILED | gc-native |
| array/sort-i32 | 0.790ms | 0.372ms | 0.333ms | FAILED | gc-native |
| array/map-filter | 0.133ms | 0.612ms | 0.061ms | FAILED | gc-native |
| array/reduce | 1.35ms | 1.87ms | 0.847ms | FAILED | gc-native |
| array/indexOf | 3.94ms | 3.38ms | 2.56ms | FAILED | gc-native |
| array/slice | 0.024ms | 0.030ms | 0.013ms | FAILED | gc-native |
| array/reverse | 7.83ms | 3.39ms | 4.32ms | FAILED | host-call |
| array/forEach | 0.048ms | 0.082ms | 0.043ms | FAILED | gc-native |
| array/find | 0.239ms | 0.426ms | 0.316ms | 4.86ms | js |
| dom/create-elements | 0.193ms | 0.305ms | — | — | js |
| dom/set-attributes | 0.106ms | 0.369ms | — | — | js |
| dom/read-attributes | 0.059ms | 0.174ms | — | — | js |
| dom/modify-text | 0.051ms | 0.166ms | — | — | js |
| mixed/csv-parse | 0.466ms | 7.78ms | 0.710ms | FAILED | js |
| mixed/text-search | 0.218ms | 6.02ms | 0.609ms | FAILED | js |
| mixed/fibonacci | 0.109ms | 0.227ms | 0.084ms | 0.226ms | gc-native |
| mixed/matrix-multiply | 0.157ms | 0.486ms | 0.186ms | 2.12ms | js |
| mixed/sieve | 1.97ms | 2.11ms | 1.14ms | FAILED | gc-native |

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
| string/concat-short | 1.76x slower | 1.47x slower | — |
| string/concat-long | 1.30x slower | 1.25x slower | — |
| string/indexOf | 50.97x slower | 14.80x slower | — |
| string/includes | 101.41x slower | 9.86x slower | — |
| string/split | 14.55x slower | 2.16x slower | — |
| string/replace | 6.03x slower | 1.51x slower | — |
| string/case-convert | 680.37x slower | 205.11x slower | — |
| string/substring | 317.59x slower | 7.22x slower | — |
| string/trim | 6.13x slower | 1.09x slower | — |
| string/startsWith-endsWith | 10.68x slower | 1.15x faster | — |
| array/push-pop | 1.27x slower | 1.76x faster | — |
| array/sort-i32 | 2.12x faster | 2.37x faster | — |
| array/map-filter | 4.61x slower | 2.19x faster | — |
| array/reduce | 1.38x slower | 1.59x faster | — |
| array/indexOf | 1.17x faster | 1.54x faster | — |
| array/slice | 1.28x slower | 1.83x faster | — |
| array/reverse | 2.31x faster | 1.81x faster | — |
| array/forEach | 1.71x slower | 1.10x faster | — |
| array/find | 1.78x slower | 1.32x slower | 20.34x slower |
| dom/create-elements | 1.58x slower | — | — |
| dom/set-attributes | 3.48x slower | — | — |
| dom/read-attributes | 2.95x slower | — | — |
| dom/modify-text | 3.28x slower | — | — |
| mixed/csv-parse | 16.72x slower | 1.52x slower | — |
| mixed/text-search | 27.54x slower | 2.79x slower | — |
| mixed/fibonacci | 2.08x slower | 1.30x faster | 2.06x slower |
| mixed/matrix-multiply | 3.10x slower | 1.18x slower | 13.53x slower |
| mixed/sieve | 1.07x slower | 1.73x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.20x faster |
| string/concat-long | 1.04x faster |
| string/indexOf | 3.44x faster |
| string/includes | 10.29x faster |
| string/split | 6.73x faster |
| string/replace | 3.98x faster |
| string/case-convert | 3.32x faster |
| string/substring | 44.01x faster |
| string/trim | 5.65x faster |
| string/startsWith-endsWith | 12.25x faster |
| array/push-pop | 2.23x faster |
| array/sort-i32 | 1.12x faster |
| array/map-filter | 10.10x faster |
| array/reduce | 2.20x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.35x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.88x faster |
| array/find | 1.35x faster |
| mixed/csv-parse | 10.96x faster |
| mixed/text-search | 9.88x faster |
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
| string/concat-short | 1257.8ms | 1158.1ms | — |
| string/concat-long | 653.0ms | 1001.2ms | — |
| string/indexOf | 584.6ms | 1006.2ms | — |
| string/includes | 567.2ms | 1005.9ms | — |
| string/split | 728.7ms | 981.3ms | — |
| string/replace | 553.3ms | 1046.8ms | — |
| string/case-convert | 566.9ms | 1125.6ms | — |
| string/substring | 562.1ms | 854.6ms | — |
| string/trim | 615.9ms | 974.6ms | — |
| string/startsWith-endsWith | 632.5ms | 946.5ms | — |
| array/push-pop | 772.9ms | 849.1ms | — |
| array/sort-i32 | 953.2ms | 1006.2ms | — |
| array/map-filter | 981.6ms | 984.0ms | — |
| array/reduce | 874.1ms | 951.4ms | — |
| array/indexOf | 770.1ms | 869.8ms | — |
| array/slice | 766.2ms | 871.6ms | — |
| array/reverse | 765.8ms | 866.0ms | — |
| array/forEach | 921.2ms | 980.7ms | — |
| array/find | 908.6ms | 993.7ms | 842.1ms |
| dom/create-elements | 668.9ms | — | — |
| dom/set-attributes | 742.7ms | — | — |
| dom/read-attributes | 747.5ms | — | — |
| dom/modify-text | 700.1ms | — | — |
| mixed/csv-parse | 790.4ms | 1022.6ms | — |
| mixed/text-search | 700.2ms | 980.4ms | — |
| mixed/fibonacci | 683.7ms | 850.4ms | 683.1ms |
| mixed/matrix-multiply | 807.3ms | 907.5ms | 798.9ms |
| mixed/sieve | 811.1ms | 905.8ms | — |
