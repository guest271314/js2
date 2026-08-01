# js2wasm Benchmark Results

Date: 2026-08-01
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.036ms | 0.066ms | 0.043ms | FAILED | js |
| string/concat-long | 0.004ms | 0.008ms | 0.009ms | FAILED | js |
| string/indexOf | 0.001ms | 0.063ms | 0.014ms | FAILED | js |
| string/includes | 0.002ms | 0.125ms | 0.014ms | FAILED | js |
| string/split | 0.406ms | 5.19ms | 0.885ms | FAILED | js |
| string/replace | 0.041ms | 0.181ms | 0.043ms | FAILED | js |
| string/case-convert | <0.001ms | 0.238ms | 0.070ms | FAILED | js |
| string/substring | 0.004ms | 0.987ms | 0.021ms | FAILED | js |
| string/trim | 0.154ms | 0.930ms | 0.173ms | FAILED | js |
| string/startsWith-endsWith | 0.302ms | 2.46ms | 0.341ms | FAILED | js |
| array/push-pop | 1.65ms | 2.52ms | 2.54ms | FAILED | js |
| array/sort-i32 | 0.841ms | 0.411ms | 0.404ms | FAILED | gc-native |
| array/map-filter | 0.146ms | 0.688ms | 0.689ms | FAILED | js |
| array/reduce | 2.39ms | 2.54ms | 2.55ms | FAILED | js |
| array/indexOf | 4.46ms | 3.85ms | 3.85ms | FAILED | host-call |
| array/slice | 0.035ms | 0.024ms | 0.025ms | FAILED | host-call |
| array/reverse | 8.84ms | 3.68ms | 3.68ms | FAILED | host-call |
| array/forEach | 0.052ms | 0.122ms | 0.123ms | FAILED | js |
| array/find | 0.280ms | 0.510ms | 0.509ms | 4.93ms | js |
| dom/create-elements | 0.037ms | 0.232ms | — | — | js |
| dom/set-attributes | 0.108ms | 0.373ms | — | — | js |
| dom/read-attributes | 0.058ms | 0.180ms | — | — | js |
| dom/modify-text | 0.051ms | 0.166ms | — | — | js |
| mixed/csv-parse | 0.460ms | 6.74ms | 0.738ms | FAILED | js |
| mixed/text-search | 0.106ms | 5.23ms | 0.632ms | FAILED | js |
| mixed/fibonacci | 0.119ms | 0.284ms | 0.283ms | 0.282ms | js |
| mixed/matrix-multiply | 0.184ms | 0.565ms | 0.565ms | 2.04ms | js |
| mixed/sieve | 1.82ms | 1.48ms | 1.46ms | FAILED | gc-native |

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
| string/concat-short | 1.81x slower | 1.20x slower | — |
| string/concat-long | 1.97x slower | 2.12x slower | — |
| string/indexOf | 42.08x slower | 9.69x slower | — |
| string/includes | 76.28x slower | 8.79x slower | — |
| string/split | 12.78x slower | 2.18x slower | — |
| string/replace | 4.44x slower | 1.06x slower | — |
| string/case-convert | 655.30x slower | 192.23x slower | — |
| string/substring | 280.06x slower | 5.99x slower | — |
| string/trim | 6.06x slower | 1.12x slower | — |
| string/startsWith-endsWith | 8.13x slower | 1.13x slower | — |
| array/push-pop | 1.52x slower | 1.54x slower | — |
| array/sort-i32 | 2.05x faster | 2.08x faster | — |
| array/map-filter | 4.73x slower | 4.73x slower | — |
| array/reduce | 1.06x slower | 1.07x slower | — |
| array/indexOf | 1.16x faster | 1.16x faster | — |
| array/slice | 1.45x faster | 1.40x faster | — |
| array/reverse | 2.40x faster | 2.40x faster | — |
| array/forEach | 2.35x slower | 2.36x slower | — |
| array/find | 1.82x slower | 1.82x slower | 17.60x slower |
| dom/create-elements | 6.18x slower | — | — |
| dom/set-attributes | 3.45x slower | — | — |
| dom/read-attributes | 3.12x slower | — | — |
| dom/modify-text | 3.27x slower | — | — |
| mixed/csv-parse | 14.63x slower | 1.60x slower | — |
| mixed/text-search | 49.38x slower | 5.97x slower | — |
| mixed/fibonacci | 2.38x slower | 2.37x slower | 2.36x slower |
| mixed/matrix-multiply | 3.07x slower | 3.07x slower | 11.08x slower |
| mixed/sieve | 1.23x faster | 1.25x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.51x faster |
| string/concat-long | 1.08x slower |
| string/indexOf | 4.34x faster |
| string/includes | 8.68x faster |
| string/split | 5.86x faster |
| string/replace | 4.20x faster |
| string/case-convert | 3.41x faster |
| string/substring | 46.73x faster |
| string/trim | 5.39x faster |
| string/startsWith-endsWith | 7.21x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.02x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.04x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.00x faster |
| mixed/csv-parse | 9.13x faster |
| mixed/text-search | 8.28x faster |
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
| string/concat-short | 1189.2ms | 1129.3ms | — |
| string/concat-long | 600.2ms | 1023.2ms | — |
| string/indexOf | 565.0ms | 1008.8ms | — |
| string/includes | 630.4ms | 988.7ms | — |
| string/split | 716.4ms | 963.8ms | — |
| string/replace | 547.4ms | 1032.9ms | — |
| string/case-convert | 555.0ms | 1089.1ms | — |
| string/substring | 536.6ms | 880.7ms | — |
| string/trim | 531.8ms | 954.0ms | — |
| string/startsWith-endsWith | 615.2ms | 899.5ms | — |
| array/push-pop | 735.1ms | 807.3ms | — |
| array/sort-i32 | 925.2ms | 981.5ms | — |
| array/map-filter | 941.2ms | 990.3ms | — |
| array/reduce | 865.8ms | 884.0ms | — |
| array/indexOf | 752.2ms | 816.5ms | — |
| array/slice | 745.8ms | 829.1ms | — |
| array/reverse | 759.1ms | 810.0ms | — |
| array/forEach | 850.1ms | 891.2ms | — |
| array/find | 867.2ms | 899.3ms | 810.3ms |
| dom/create-elements | 594.7ms | — | — |
| dom/set-attributes | 723.5ms | — | — |
| dom/read-attributes | 665.9ms | — | — |
| dom/modify-text | 682.0ms | — | — |
| mixed/csv-parse | 758.2ms | 995.5ms | — |
| mixed/text-search | 685.1ms | 996.4ms | — |
| mixed/fibonacci | 676.9ms | 843.5ms | 684.9ms |
| mixed/matrix-multiply | 871.4ms | 921.0ms | 762.0ms |
| mixed/sieve | 792.7ms | 838.3ms | — |
