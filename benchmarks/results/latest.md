# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.043ms | 0.060ms | 0.045ms | FAILED | js |
| string/concat-long | 0.005ms | 0.006ms | 0.005ms | FAILED | js |
| string/indexOf | 0.002ms | 0.079ms | 0.015ms | FAILED | js |
| string/includes | 0.002ms | 0.149ms | 0.016ms | FAILED | js |
| string/split | 0.471ms | 6.05ms | 1.01ms | FAILED | js |
| string/replace | 0.048ms | 0.217ms | 0.077ms | FAILED | js |
| string/case-convert | <0.001ms | 0.258ms | 0.082ms | FAILED | js |
| string/substring | 0.004ms | 1.16ms | 0.023ms | FAILED | js |
| string/trim | 0.179ms | 1.10ms | 0.201ms | FAILED | js |
| string/startsWith-endsWith | 0.324ms | 2.82ms | 0.271ms | FAILED | gc-native |
| array/push-pop | 1.92ms | 2.48ms | 1.10ms | FAILED | gc-native |
| array/sort-i32 | 0.980ms | 0.599ms | 0.355ms | FAILED | gc-native |
| array/map-filter | 0.153ms | 0.759ms | 0.058ms | FAILED | gc-native |
| array/reduce | 2.78ms | 2.50ms | 1.12ms | FAILED | gc-native |
| array/indexOf | 5.19ms | 4.45ms | 3.36ms | FAILED | gc-native |
| array/slice | 0.037ms | 0.022ms | 0.011ms | FAILED | gc-native |
| array/reverse | 10.31ms | 4.27ms | 5.16ms | FAILED | host-call |
| array/forEach | 0.059ms | 0.098ms | 0.039ms | FAILED | gc-native |
| array/find | 0.325ms | 0.549ms | 0.405ms | 5.71ms | js |
| dom/create-elements | 0.043ms | 0.309ms | — | — | js |
| dom/set-attributes | 0.124ms | 0.433ms | — | — | js |
| dom/read-attributes | 0.067ms | 0.209ms | — | — | js |
| dom/modify-text | 0.065ms | 0.188ms | — | — | js |
| mixed/csv-parse | 0.595ms | 7.60ms | 0.835ms | FAILED | js |
| mixed/text-search | 0.275ms | 5.89ms | 0.726ms | FAILED | js |
| mixed/fibonacci | 0.138ms | 0.311ms | 0.111ms | 0.522ms | gc-native |
| mixed/matrix-multiply | 0.212ms | 0.574ms | 0.232ms | 2.37ms | js |
| mixed/sieve | 2.01ms | 2.68ms | 1.54ms | FAILED | gc-native |

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
| string/concat-short | 1.42x slower | 1.05x slower | — |
| string/concat-long | 1.30x slower | 1.12x slower | — |
| string/indexOf | 48.22x slower | 9.24x slower | — |
| string/includes | 83.39x slower | 8.80x slower | — |
| string/split | 12.84x slower | 2.15x slower | — |
| string/replace | 4.57x slower | 1.61x slower | — |
| string/case-convert | 600.41x slower | 190.51x slower | — |
| string/substring | 281.95x slower | 5.68x slower | — |
| string/trim | 6.14x slower | 1.12x slower | — |
| string/startsWith-endsWith | 8.70x slower | 1.20x faster | — |
| array/push-pop | 1.29x slower | 1.75x faster | — |
| array/sort-i32 | 1.64x faster | 2.76x faster | — |
| array/map-filter | 4.95x slower | 2.66x faster | — |
| array/reduce | 1.11x faster | 2.49x faster | — |
| array/indexOf | 1.17x faster | 1.54x faster | — |
| array/slice | 1.65x faster | 3.27x faster | — |
| array/reverse | 2.41x faster | 2.00x faster | — |
| array/forEach | 1.67x slower | 1.51x faster | — |
| array/find | 1.69x slower | 1.25x slower | 17.56x slower |
| dom/create-elements | 7.11x slower | — | — |
| dom/set-attributes | 3.49x slower | — | — |
| dom/read-attributes | 3.12x slower | — | — |
| dom/modify-text | 2.88x slower | — | — |
| mixed/csv-parse | 12.77x slower | 1.40x slower | — |
| mixed/text-search | 21.42x slower | 2.64x slower | — |
| mixed/fibonacci | 2.25x slower | 1.25x faster | 3.78x slower |
| mixed/matrix-multiply | 2.70x slower | 1.09x slower | 11.17x slower |
| mixed/sieve | 1.33x slower | 1.30x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.35x faster |
| string/concat-long | 1.15x faster |
| string/indexOf | 5.22x faster |
| string/includes | 9.47x faster |
| string/split | 5.98x faster |
| string/replace | 2.84x faster |
| string/case-convert | 3.15x faster |
| string/substring | 49.60x faster |
| string/trim | 5.46x faster |
| string/startsWith-endsWith | 10.42x faster |
| array/push-pop | 2.25x faster |
| array/sort-i32 | 1.69x faster |
| array/map-filter | 13.17x faster |
| array/reduce | 2.24x faster |
| array/indexOf | 1.32x faster |
| array/slice | 1.99x faster |
| array/reverse | 1.21x slower |
| array/forEach | 2.52x faster |
| array/find | 1.36x faster |
| mixed/csv-parse | 9.10x faster |
| mixed/text-search | 8.12x faster |
| mixed/fibonacci | 2.81x faster |
| mixed/matrix-multiply | 2.48x faster |
| mixed/sieve | 1.74x faster |

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
| string/concat-short | 1409.0ms | 1249.2ms | — |
| string/concat-long | 686.9ms | 1205.5ms | — |
| string/indexOf | 639.5ms | 1207.6ms | — |
| string/includes | 654.7ms | 1190.0ms | — |
| string/split | 844.3ms | 1088.6ms | — |
| string/replace | 627.7ms | 1307.9ms | — |
| string/case-convert | 655.7ms | 1235.8ms | — |
| string/substring | 609.6ms | 956.8ms | — |
| string/trim | 597.1ms | 1097.8ms | — |
| string/startsWith-endsWith | 689.5ms | 1040.8ms | — |
| array/push-pop | 850.9ms | 937.1ms | — |
| array/sort-i32 | 1057.2ms | 1139.3ms | — |
| array/map-filter | 1089.5ms | 1107.3ms | — |
| array/reduce | 942.9ms | 1038.1ms | — |
| array/indexOf | 841.4ms | 971.8ms | — |
| array/slice | 911.3ms | 946.7ms | — |
| array/reverse | 854.7ms | 935.0ms | — |
| array/forEach | 1014.4ms | 1045.2ms | — |
| array/find | 964.4ms | 1088.9ms | 972.4ms |
| dom/create-elements | 678.3ms | — | — |
| dom/set-attributes | 775.9ms | — | — |
| dom/read-attributes | 752.4ms | — | — |
| dom/modify-text | 778.6ms | — | — |
| mixed/csv-parse | 849.9ms | 1159.4ms | — |
| mixed/text-search | 754.7ms | 1085.1ms | — |
| mixed/fibonacci | 759.0ms | 949.2ms | 805.7ms |
| mixed/matrix-multiply | 915.5ms | 1020.5ms | 865.3ms |
| mixed/sieve | 918.5ms | 1012.1ms | — |
