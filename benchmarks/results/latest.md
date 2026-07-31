# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.028ms | 0.041ms | 0.033ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.001ms | 0.049ms | 0.011ms | FAILED | js |
| string/includes | 0.001ms | 0.096ms | 0.011ms | FAILED | js |
| string/split | 0.313ms | 3.98ms | 0.678ms | FAILED | js |
| string/replace | 0.032ms | 0.145ms | 0.052ms | FAILED | js |
| string/case-convert | <0.001ms | 0.186ms | 0.055ms | FAILED | js |
| string/substring | 0.003ms | 0.770ms | 0.017ms | FAILED | js |
| string/trim | 0.120ms | 0.738ms | 0.134ms | FAILED | js |
| string/startsWith-endsWith | 0.243ms | 1.89ms | 0.180ms | FAILED | gc-native |
| array/push-pop | 1.30ms | 1.72ms | 0.760ms | FAILED | gc-native |
| array/sort-i32 | 0.655ms | 987.8ms | FAILED | FAILED | js |
| array/map-filter | 0.107ms | 0.507ms | 0.040ms | FAILED | gc-native |
| array/reduce | 1.87ms | 1.69ms | 0.757ms | FAILED | gc-native |
| array/indexOf | 3.46ms | 2.96ms | 2.24ms | FAILED | gc-native |
| array/slice | 0.031ms | 0.017ms | 0.009ms | FAILED | gc-native |
| array/reverse | 6.86ms | 2.83ms | 3.43ms | FAILED | host-call |
| array/forEach | 0.043ms | 0.067ms | 0.027ms | FAILED | gc-native |
| array/find | 0.221ms | 0.367ms | — | 3.80ms | js |
| dom/create-elements | 0.216ms | 0.206ms | — | — | host-call |
| dom/set-attributes | 0.088ms | 0.292ms | — | — | js |
| dom/read-attributes | 0.052ms | 0.139ms | — | — | js |
| dom/modify-text | 0.045ms | 0.127ms | — | — | js |
| mixed/csv-parse | 0.358ms | 5.33ms | 0.561ms | FAILED | js |
| mixed/text-search | 0.183ms | 3.95ms | 0.481ms | FAILED | js |
| mixed/fibonacci | 0.092ms | 0.207ms | 0.074ms | 1.01ms | gc-native |
| mixed/matrix-multiply | 0.146ms | 0.384ms | 0.155ms | 1.57ms | js |
| mixed/sieve | 1.42ms | 1.79ms | 1.03ms | FAILED | gc-native |

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
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/text-search | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.45x slower | 1.16x slower | — |
| string/concat-long | 1.42x slower | 1.22x slower | — |
| string/indexOf | 41.65x slower | 8.95x slower | — |
| string/includes | 73.05x slower | 8.19x slower | — |
| string/split | 12.72x slower | 2.17x slower | — |
| string/replace | 4.51x slower | 1.62x slower | — |
| string/case-convert | 664.14x slower | 195.81x slower | — |
| string/substring | 281.65x slower | 6.07x slower | — |
| string/trim | 6.18x slower | 1.12x slower | — |
| string/startsWith-endsWith | 7.79x slower | 1.35x faster | — |
| array/push-pop | 1.33x slower | 1.71x faster | — |
| array/sort-i32 | 1509.01x slower | — | — |
| array/map-filter | 4.73x slower | 2.68x faster | — |
| array/reduce | 1.11x faster | 2.46x faster | — |
| array/indexOf | 1.17x faster | 1.55x faster | — |
| array/slice | 1.79x faster | 3.62x faster | — |
| array/reverse | 2.42x faster | 2.00x faster | — |
| array/forEach | 1.57x slower | 1.57x faster | — |
| array/find | 1.66x slower | — | 17.21x slower |
| dom/create-elements | 1.05x faster | — | — |
| dom/set-attributes | 3.30x slower | — | — |
| dom/read-attributes | 2.66x slower | — | — |
| dom/modify-text | 2.85x slower | — | — |
| mixed/csv-parse | 14.89x slower | 1.57x slower | — |
| mixed/text-search | 21.62x slower | 2.64x slower | — |
| mixed/fibonacci | 2.25x slower | 1.25x faster | 10.99x slower |
| mixed/matrix-multiply | 2.63x slower | 1.06x slower | 10.77x slower |
| mixed/sieve | 1.25x slower | 1.38x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.25x faster |
| string/concat-long | 1.16x faster |
| string/indexOf | 4.65x faster |
| string/includes | 8.92x faster |
| string/split | 5.86x faster |
| string/replace | 2.79x faster |
| string/case-convert | 3.39x faster |
| string/substring | 46.39x faster |
| string/trim | 5.51x faster |
| string/startsWith-endsWith | 10.51x faster |
| array/push-pop | 2.27x faster |
| array/map-filter | 12.68x faster |
| array/reduce | 2.23x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.02x faster |
| array/reverse | 1.21x slower |
| array/forEach | 2.45x faster |
| mixed/csv-parse | 9.51x faster |
| mixed/text-search | 8.20x faster |
| mixed/fibonacci | 2.81x faster |
| mixed/matrix-multiply | 2.47x faster |
| mixed/sieve | 1.73x faster |

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
| array/find | 2.7KB | — | 623B |
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
| string/concat-short | 961.4ms | 882.2ms | — |
| string/concat-long | 470.8ms | 779.3ms | — |
| string/indexOf | 448.1ms | 758.4ms | — |
| string/includes | 441.6ms | 772.2ms | — |
| string/split | 566.2ms | 760.4ms | — |
| string/replace | 438.8ms | 798.6ms | — |
| string/case-convert | 435.2ms | 844.8ms | — |
| string/substring | 424.5ms | 666.0ms | — |
| string/trim | 426.3ms | 752.8ms | — |
| string/startsWith-endsWith | 493.5ms | 727.3ms | — |
| array/push-pop | 569.2ms | 644.5ms | — |
| array/sort-i32 | 662.6ms | — | — |
| array/map-filter | 734.0ms | 745.2ms | — |
| array/reduce | 646.7ms | 708.9ms | — |
| array/indexOf | 581.4ms | 631.5ms | — |
| array/slice | 572.9ms | 659.1ms | — |
| array/reverse | 594.6ms | 652.1ms | — |
| array/forEach | 692.7ms | 745.8ms | — |
| array/find | 664.8ms | — | 655.0ms |
| dom/create-elements | 506.1ms | — | — |
| dom/set-attributes | 556.9ms | — | — |
| dom/read-attributes | 541.6ms | — | — |
| dom/modify-text | 532.9ms | — | — |
| mixed/csv-parse | 617.0ms | 779.5ms | — |
| mixed/text-search | 537.8ms | 756.7ms | — |
| mixed/fibonacci | 529.1ms | 636.7ms | 534.3ms |
| mixed/matrix-multiply | 623.9ms | 697.7ms | 627.2ms |
| mixed/sieve | 641.1ms | 688.9ms | — |
