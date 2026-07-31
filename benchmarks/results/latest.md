# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.051ms | 0.042ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | FAILED | js |
| string/indexOf | 0.001ms | 0.062ms | 0.013ms | FAILED | js |
| string/includes | 0.002ms | 0.122ms | 0.014ms | FAILED | js |
| string/split | 0.406ms | 5.43ms | 0.876ms | FAILED | js |
| string/replace | 0.041ms | 0.184ms | 0.065ms | FAILED | js |
| string/case-convert | <0.001ms | 0.223ms | 0.070ms | FAILED | js |
| string/substring | 0.004ms | 0.985ms | 0.020ms | FAILED | js |
| string/trim | 0.154ms | 0.926ms | 0.173ms | FAILED | js |
| string/startsWith-endsWith | 0.313ms | 2.72ms | 0.231ms | FAILED | gc-native |
| array/push-pop | 1.68ms | 2.19ms | 0.975ms | FAILED | gc-native |
| array/sort-i32 | 1.00ms | 1272.2ms | FAILED | FAILED | js |
| array/map-filter | 0.134ms | 0.649ms | 0.050ms | FAILED | gc-native |
| array/reduce | 2.40ms | 2.21ms | 0.967ms | FAILED | gc-native |
| array/indexOf | 4.45ms | 3.82ms | 2.88ms | FAILED | gc-native |
| array/slice | 0.034ms | 0.021ms | 0.010ms | FAILED | gc-native |
| array/reverse | 8.84ms | 3.66ms | 4.42ms | FAILED | host-call |
| array/forEach | 0.091ms | 0.085ms | 0.034ms | FAILED | gc-native |
| array/find | 0.281ms | 0.473ms | — | FAILED | js |
| dom/create-elements | 0.039ms | 0.262ms | — | — | js |
| dom/set-attributes | 0.108ms | 0.370ms | — | — | js |
| dom/read-attributes | 0.061ms | 0.178ms | — | — | js |
| dom/modify-text | 0.050ms | 0.160ms | — | — | js |
| mixed/csv-parse | 0.457ms | 6.70ms | 0.717ms | FAILED | js |
| mixed/text-search | 0.235ms | 5.02ms | 0.621ms | FAILED | js |
| mixed/fibonacci | 0.118ms | 0.266ms | 0.095ms | 1.30ms | gc-native |
| mixed/matrix-multiply | 0.184ms | 0.492ms | 0.200ms | 2.02ms | js |
| mixed/sieve | 1.71ms | 2.30ms | 1.30ms | FAILED | gc-native |

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
| array/sort-i32 | gc-native | warmup | illegal cast |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/find | linear-memory | setup | WebAssembly.instantiate(): Compiling function #50:"run" failed: local.set[0] expected type i32, found local.get of type f64 @+4412 |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/text-search | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.55x slower | 1.29x slower | — |
| string/concat-long | 1.23x slower | 1.15x slower | — |
| string/indexOf | 44.20x slower | 9.45x slower | — |
| string/includes | 77.04x slower | 8.59x slower | — |
| string/split | 13.36x slower | 2.16x slower | — |
| string/replace | 4.49x slower | 1.57x slower | — |
| string/case-convert | 611.79x slower | 192.89x slower | — |
| string/substring | 279.28x slower | 5.68x slower | — |
| string/trim | 6.02x slower | 1.12x slower | — |
| string/startsWith-endsWith | 8.67x slower | 1.35x faster | — |
| array/push-pop | 1.30x slower | 1.72x faster | — |
| array/sort-i32 | 1271.81x slower | — | — |
| array/map-filter | 4.85x slower | 2.65x faster | — |
| array/reduce | 1.09x faster | 2.48x faster | — |
| array/indexOf | 1.16x faster | 1.54x faster | — |
| array/slice | 1.62x faster | 3.55x faster | — |
| array/reverse | 2.42x faster | 2.00x faster | — |
| array/forEach | 1.07x faster | 2.69x faster | — |
| array/find | 1.68x slower | — | — |
| dom/create-elements | 6.76x slower | — | — |
| dom/set-attributes | 3.44x slower | — | — |
| dom/read-attributes | 2.91x slower | — | — |
| dom/modify-text | 3.18x slower | — | — |
| mixed/csv-parse | 14.65x slower | 1.57x slower | — |
| mixed/text-search | 21.31x slower | 2.64x slower | — |
| mixed/fibonacci | 2.25x slower | 1.25x faster | 11.02x slower |
| mixed/matrix-multiply | 2.67x slower | 1.09x slower | 10.98x slower |
| mixed/sieve | 1.34x slower | 1.32x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.20x faster |
| string/concat-long | 1.07x faster |
| string/indexOf | 4.68x faster |
| string/includes | 8.97x faster |
| string/split | 6.20x faster |
| string/replace | 2.86x faster |
| string/case-convert | 3.17x faster |
| string/substring | 49.13x faster |
| string/trim | 5.35x faster |
| string/startsWith-endsWith | 11.74x faster |
| array/push-pop | 2.24x faster |
| array/map-filter | 12.86x faster |
| array/reduce | 2.29x faster |
| array/indexOf | 1.33x faster |
| array/slice | 2.19x faster |
| array/reverse | 1.21x slower |
| array/forEach | 2.51x faster |
| mixed/csv-parse | 9.35x faster |
| mixed/text-search | 8.08x faster |
| mixed/fibonacci | 2.81x faster |
| mixed/matrix-multiply | 2.46x faster |
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
| array/sort-i32 | 1.2KB | — | — |
| array/map-filter | 3.3KB | 3.3KB | — |
| array/reduce | 2.3KB | 2.8KB | — |
| array/indexOf | 1022B | 1.5KB | — |
| array/slice | 1.0KB | 1.5KB | — |
| array/reverse | 1.0KB | 1.5KB | — |
| array/forEach | 2.6KB | 3.1KB | — |
| array/find | 2.7KB | — | — |
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
| string/concat-short | 1214.6ms | 1114.7ms | — |
| string/concat-long | 632.5ms | 981.7ms | — |
| string/indexOf | 564.5ms | 1000.4ms | — |
| string/includes | 544.1ms | 989.6ms | — |
| string/split | 740.2ms | 977.0ms | — |
| string/replace | 564.9ms | 1051.9ms | — |
| string/case-convert | 559.5ms | 1075.3ms | — |
| string/substring | 537.4ms | 876.6ms | — |
| string/trim | 548.3ms | 954.9ms | — |
| string/startsWith-endsWith | 622.2ms | 925.9ms | — |
| array/push-pop | 768.6ms | 837.6ms | — |
| array/sort-i32 | 824.4ms | — | — |
| array/map-filter | 973.1ms | 982.3ms | — |
| array/reduce | 847.6ms | 924.8ms | — |
| array/indexOf | 745.4ms | 822.4ms | — |
| array/slice | 788.8ms | 817.3ms | — |
| array/reverse | 741.0ms | 816.0ms | — |
| array/forEach | 881.5ms | 921.7ms | — |
| array/find | 882.7ms | — | — |
| dom/create-elements | 624.9ms | — | — |
| dom/set-attributes | 709.5ms | — | — |
| dom/read-attributes | 694.5ms | — | — |
| dom/modify-text | 681.3ms | — | — |
| mixed/csv-parse | 775.3ms | 987.8ms | — |
| mixed/text-search | 660.5ms | 1005.3ms | — |
| mixed/fibonacci | 666.2ms | 811.2ms | 673.7ms |
| mixed/matrix-multiply | 802.2ms | 920.8ms | 766.4ms |
| mixed/sieve | 776.7ms | 855.6ms | — |
