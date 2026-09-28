# js2wasm Benchmark Results

Date: 2026-09-28
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.036ms | 0.047ms | 0.047ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.064ms | 0.013ms | 0.023ms | gc-native |
| string/includes | 0.019ms | 0.146ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.435ms | 8.75ms | 2.89ms | FAILED | js |
| string/replace | 0.112ms | 0.698ms | 0.339ms | FAILED | js |
| string/case-convert | 0.057ms | 0.574ms | 0.265ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.171ms | 4.06ms | 2.83ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.98ms | 2.94ms | 0.561ms | js |
| array/push-pop | 1.41ms | 0.519ms | 0.510ms | FAILED | gc-native |
| array/sort-i32 | 0.796ms | 0.295ms | 0.292ms | FAILED | gc-native |
| array/map-filter | 0.128ms | 0.070ms | 0.070ms | FAILED | host-call |
| array/reduce | 2.15ms | 0.508ms | 0.512ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.027ms | 0.029ms | 0.029ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.07ms | host-call |
| dom/create-elements | 0.037ms | 0.097ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.241ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.130ms | — | — | js |
| dom/modify-text | 0.030ms | 0.109ms | — | — | js |
| mixed/csv-parse | 0.501ms | 8.82ms | 0.632ms | FAILED | js |
| mixed/text-search | 0.390ms | 4.93ms | 2.84ms | 1.08ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.288ms | js |
| mixed/matrix-multiply | 0.158ms | 73.02ms | 77.58ms | 0.721ms | js |
| mixed/sieve | 1.56ms | 2.11ms | 2.11ms | FAILED | js |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | warmup | memory access out of bounds |
| string/split | linear-memory | mid-loop | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 3.57 | 4.68 | 4.75 | — |
| string/concat-long | 1000 | 3.83 | 4.55 | 3.82 | — |
| string/indexOf | 1000 | 19.15 | 63.76 | 12.54 | 22.90 |
| string/includes | 1000 | 19.22 | 146.48 | 15.02 | 15.43 |
| string/split | 10000 | 43.54 | 874.99 | 288.68 | — |
| string/replace | 1000 | 112.03 | 698.22 | 338.85 | — |
| string/case-convert | 2000 | 28.35 | 286.81 | 132.39 | — |
| string/substring | 10000 | 9.92 | 3.74 | 3.08 | — |
| string/trim | 10000 | 17.07 | 405.68 | 282.76 | — |
| string/startsWith-endsWith | 20000 | 20.03 | 149.17 | 146.98 | 28.07 |
| array/map-filter | 30000 | 4.26 | 2.35 | 2.35 | — |
| array/indexOf | 1000 | 3950.21 | 2641.41 | 2640.36 | — |
| dom/create-elements | 2000 | 18.27 | 48.55 | — | — |
| dom/set-attributes | 6000 | 17.50 | 40.13 | — | — |
| dom/read-attributes | 3000 | 18.64 | 43.23 | — | — |
| dom/modify-text | 2000 | 14.96 | 54.41 | — | — |
| mixed/csv-parse | 11000 | 45.52 | 801.57 | 57.47 | — |
| mixed/text-search | 40000 | 9.75 | 123.14 | 71.02 | 27.07 |
| mixed/fibonacci | 10000 | 12.01 | 28.31 | 28.30 | 28.84 |
| mixed/matrix-multiply | 125000 | 1.26 | 584.13 | 620.64 | 5.77 |
| mixed/sieve | 200000 | 7.79 | 10.54 | 10.56 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.31x slower | 1.33x slower | — |
| string/concat-long | 1.19x slower | 1.00x faster | — |
| string/indexOf | 3.33x slower | 1.53x faster | 1.20x slower |
| string/includes | 7.62x slower | 1.28x faster | 1.25x faster |
| string/split | 20.10x slower | 6.63x slower | — |
| string/replace | 6.23x slower | 3.02x slower | — |
| string/case-convert | 10.12x slower | 4.67x slower | — |
| string/substring | 2.65x faster | 3.23x faster | — |
| string/trim | 23.76x slower | 16.56x slower | — |
| string/startsWith-endsWith | 7.45x slower | 7.34x slower | 1.40x slower |
| array/push-pop | 2.72x faster | 2.76x faster | — |
| array/sort-i32 | 2.70x faster | 2.72x faster | — |
| array/map-filter | 1.82x faster | 1.81x faster | — |
| array/reduce | 4.23x faster | 4.19x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.09x slower | 1.08x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.77x faster | 1.76x faster | — |
| array/find | 16.06x faster | 15.97x faster | 4.22x slower |
| dom/create-elements | 2.66x slower | — | — |
| dom/set-attributes | 2.29x slower | — | — |
| dom/read-attributes | 2.32x slower | — | — |
| dom/modify-text | 3.64x slower | — | — |
| mixed/csv-parse | 17.61x slower | 1.26x slower | — |
| mixed/text-search | 12.63x slower | 7.28x slower | 2.78x slower |
| mixed/fibonacci | 2.36x slower | 2.36x slower | 2.40x slower |
| mixed/matrix-multiply | 463.03x slower | 491.97x slower | 4.57x slower |
| mixed/sieve | 1.35x slower | 1.36x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.01x slower |
| string/concat-long | 1.19x faster |
| string/indexOf | 5.08x faster |
| string/includes | 9.75x faster |
| string/split | 3.03x faster |
| string/replace | 2.06x faster |
| string/case-convert | 2.17x faster |
| string/substring | 1.22x faster |
| string/trim | 1.43x faster |
| string/startsWith-endsWith | 1.01x faster |
| array/push-pop | 1.02x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 13.95x faster |
| mixed/text-search | 1.73x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.06x slower |
| mixed/sieve | 1.00x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.8KB | 3.5KB | — |
| string/replace | 1.9KB | 4.4KB | — |
| string/case-convert | 1.8KB | 2.5KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.5KB | 3.1KB | — |
| string/startsWith-endsWith | 2.0KB | 4.0KB | 1.7KB |
| array/push-pop | 1.2KB | 1.6KB | — |
| array/sort-i32 | 3.3KB | 3.8KB | — |
| array/map-filter | 4.3KB | 4.8KB | — |
| array/reduce | 3.0KB | 3.5KB | — |
| array/indexOf | 2.1KB | 2.5KB | — |
| array/slice | 1.3KB | 1.7KB | — |
| array/reverse | 1.2KB | 1.7KB | — |
| array/forEach | 3.4KB | 4.0KB | — |
| array/find | 1.2KB | 1.6KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.5KB | 4.5KB | — |
| mixed/text-search | 2.2KB | 4.3KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 3.5KB | 4.0KB | 991B |
| mixed/sieve | 2.5KB | 2.7KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1182.8ms | 647.2ms | — |
| string/concat-long | 449.2ms | 696.2ms | — |
| string/indexOf | 397.3ms | 691.3ms | 557.0ms |
| string/includes | 418.7ms | 745.0ms | 567.9ms |
| string/split | 533.7ms | 719.7ms | — |
| string/replace | 520.0ms | 795.6ms | — |
| string/case-convert | 542.7ms | 643.7ms | — |
| string/substring | 408.9ms | 527.1ms | — |
| string/trim | 495.5ms | 695.6ms | — |
| string/startsWith-endsWith | 509.1ms | 721.2ms | 636.1ms |
| array/push-pop | 518.4ms | 609.3ms | — |
| array/sort-i32 | 662.6ms | 711.2ms | — |
| array/map-filter | 712.6ms | 777.9ms | — |
| array/reduce | 609.6ms | 705.1ms | — |
| array/indexOf | 610.3ms | 702.7ms | — |
| array/slice | 516.0ms | 618.6ms | — |
| array/reverse | 516.2ms | 616.5ms | — |
| array/forEach | 652.6ms | 727.1ms | — |
| array/find | 506.7ms | 621.0ms | 570.6ms |
| dom/create-elements | 441.7ms | — | — |
| dom/set-attributes | 399.2ms | — | — |
| dom/read-attributes | 394.6ms | — | — |
| dom/modify-text | 385.0ms | — | — |
| mixed/csv-parse | 541.7ms | 696.3ms | — |
| mixed/text-search | 518.7ms | 720.7ms | 634.7ms |
| mixed/fibonacci | 462.8ms | 527.3ms | 503.6ms |
| mixed/matrix-multiply | 671.9ms | 728.8ms | 534.2ms |
| mixed/sieve | 619.3ms | 692.5ms | — |
