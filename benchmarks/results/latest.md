# js2wasm Benchmark Results

Date: 2026-08-01
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.046ms | 0.041ms | FAILED | js |
| string/concat-long | 0.004ms | 0.007ms | 0.008ms | FAILED | js |
| string/indexOf | 0.001ms | 0.063ms | 0.015ms | FAILED | js |
| string/includes | 0.001ms | 0.138ms | 0.016ms | FAILED | js |
| string/split | 0.406ms | 5.66ms | 0.888ms | FAILED | js |
| string/replace | 0.042ms | 0.244ms | 0.041ms | FAILED | gc-native |
| string/case-convert | <0.001ms | 0.222ms | 0.066ms | FAILED | js |
| string/substring | 0.003ms | 1.09ms | 0.026ms | FAILED | js |
| string/trim | 0.152ms | 0.975ms | 0.165ms | FAILED | js |
| string/startsWith-endsWith | 0.246ms | 2.71ms | 0.189ms | FAILED | gc-native |
| array/push-pop | 1.45ms | 2.20ms | 2.20ms | FAILED | js |
| array/sort-i32 | 0.792ms | 0.398ms | 0.392ms | FAILED | gc-native |
| array/map-filter | 0.130ms | 0.643ms | 0.642ms | FAILED | js |
| array/reduce | 2.16ms | 2.22ms | 2.22ms | FAILED | js |
| array/indexOf | 3.94ms | 3.42ms | 3.42ms | FAILED | host-call |
| array/slice | 0.028ms | 0.037ms | 0.037ms | FAILED | js |
| array/reverse | 7.82ms | 3.43ms | 3.43ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.119ms | 0.118ms | FAILED | js |
| array/find | 0.239ms | 0.459ms | 0.458ms | 4.85ms | js |
| dom/create-elements | 0.038ms | 0.289ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.361ms | — | — | js |
| dom/read-attributes | 0.058ms | 0.172ms | — | — | js |
| dom/modify-text | 0.048ms | 0.165ms | — | — | js |
| mixed/csv-parse | 0.464ms | 7.49ms | 0.720ms | FAILED | js |
| mixed/text-search | 0.218ms | 5.56ms | 0.628ms | FAILED | js |
| mixed/fibonacci | 0.109ms | 0.246ms | 0.246ms | 1.10ms | js |
| mixed/matrix-multiply | 0.158ms | 0.556ms | 0.555ms | 2.14ms | js |
| mixed/sieve | 1.56ms | 1.40ms | 1.39ms | FAILED | gc-native |

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
| string/concat-short | 1.47x slower | 1.31x slower | — |
| string/concat-long | 2.00x slower | 2.19x slower | — |
| string/indexOf | 46.58x slower | 11.01x slower | — |
| string/includes | 92.42x slower | 10.46x slower | — |
| string/split | 13.94x slower | 2.19x slower | — |
| string/replace | 5.75x slower | 1.03x faster | — |
| string/case-convert | 690.64x slower | 205.29x slower | — |
| string/substring | 349.52x slower | 8.27x slower | — |
| string/trim | 6.42x slower | 1.09x slower | — |
| string/startsWith-endsWith | 11.00x slower | 1.30x faster | — |
| array/push-pop | 1.51x slower | 1.51x slower | — |
| array/sort-i32 | 1.99x faster | 2.02x faster | — |
| array/map-filter | 4.93x slower | 4.93x slower | — |
| array/reduce | 1.03x slower | 1.03x slower | — |
| array/indexOf | 1.15x faster | 1.15x faster | — |
| array/slice | 1.32x slower | 1.31x slower | — |
| array/reverse | 2.28x faster | 2.28x faster | — |
| array/forEach | 2.41x slower | 2.40x slower | — |
| array/find | 1.91x slower | 1.91x slower | 20.24x slower |
| dom/create-elements | 7.67x slower | — | — |
| dom/set-attributes | 3.44x slower | — | — |
| dom/read-attributes | 2.98x slower | — | — |
| dom/modify-text | 3.42x slower | — | — |
| mixed/csv-parse | 16.14x slower | 1.55x slower | — |
| mixed/text-search | 25.47x slower | 2.88x slower | — |
| mixed/fibonacci | 2.25x slower | 2.25x slower | 10.09x slower |
| mixed/matrix-multiply | 3.52x slower | 3.52x slower | 13.55x slower |
| mixed/sieve | 1.12x faster | 1.12x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.12x faster |
| string/concat-long | 1.10x slower |
| string/indexOf | 4.23x faster |
| string/includes | 8.84x faster |
| string/split | 6.37x faster |
| string/replace | 5.91x faster |
| string/case-convert | 3.36x faster |
| string/substring | 42.26x faster |
| string/trim | 5.90x faster |
| string/startsWith-endsWith | 14.34x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.02x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 10.40x faster |
| mixed/text-search | 8.85x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.01x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 1.7KB | — |
| string/concat-long | 233B | 1.9KB | — |
| string/indexOf | 215B | 2.1KB | — |
| string/includes | 235B | 2.1KB | — |
| string/split | 973B | 1.6KB | — |
| string/replace | 276B | 2.5KB | — |
| string/case-convert | 236B | 11.7KB | — |
| string/substring | 227B | 1.3KB | — |
| string/trim | 193B | 1.7KB | — |
| string/startsWith-endsWith | 320B | 1.6KB | — |
| array/push-pop | 947B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
| array/map-filter | 3.3KB | 3.6KB | — |
| array/reduce | 2.3KB | 2.6KB | — |
| array/indexOf | 1018B | 1.3KB | — |
| array/slice | 1.0KB | 1.3KB | — |
| array/reverse | 1011B | 1.3KB | — |
| array/forEach | 2.6KB | 2.9KB | — |
| array/find | 2.7KB | 3.0KB | 623B |
| dom/create-elements | 240B | — | — |
| dom/set-attributes | 507B | — | — |
| dom/read-attributes | 357B | — | — |
| dom/modify-text | 247B | — | — |
| mixed/csv-parse | 1.4KB | 2.9KB | — |
| mixed/text-search | 590B | 2.2KB | — |
| mixed/fibonacci | 134B | 1.1KB | 150B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 950B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1462.9ms | 1215.5ms | — |
| string/concat-long | 663.4ms | 1055.9ms | — |
| string/indexOf | 602.3ms | 1043.3ms | — |
| string/includes | 687.5ms | 1057.7ms | — |
| string/split | 772.0ms | 1036.5ms | — |
| string/replace | 612.0ms | 1153.6ms | — |
| string/case-convert | 596.5ms | 1196.2ms | — |
| string/substring | 574.0ms | 958.3ms | — |
| string/trim | 591.4ms | 1023.0ms | — |
| string/startsWith-endsWith | 654.8ms | 998.9ms | — |
| array/push-pop | 798.9ms | 915.4ms | — |
| array/sort-i32 | 1007.0ms | 1040.0ms | — |
| array/map-filter | 1038.3ms | 1070.0ms | — |
| array/reduce | 866.4ms | 943.8ms | — |
| array/indexOf | 794.2ms | 863.4ms | — |
| array/slice | 787.3ms | 855.7ms | — |
| array/reverse | 763.2ms | 837.3ms | — |
| array/forEach | 903.1ms | 997.5ms | — |
| array/find | 927.1ms | 982.5ms | 885.8ms |
| dom/create-elements | 647.0ms | — | — |
| dom/set-attributes | 745.2ms | — | — |
| dom/read-attributes | 704.2ms | — | — |
| dom/modify-text | 707.3ms | — | — |
| mixed/csv-parse | 797.9ms | 1046.9ms | — |
| mixed/text-search | 694.7ms | 1007.5ms | — |
| mixed/fibonacci | 701.8ms | 841.1ms | 693.5ms |
| mixed/matrix-multiply | 918.6ms | 957.9ms | 857.8ms |
| mixed/sieve | 835.3ms | 906.6ms | — |
