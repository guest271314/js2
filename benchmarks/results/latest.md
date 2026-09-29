# js2wasm Benchmark Results

Date: 2026-09-29
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.049ms | 0.042ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.102ms | 0.015ms | 0.016ms | gc-native |
| string/split | 0.425ms | 8.34ms | 2.95ms | FAILED | js |
| string/replace | 0.101ms | 0.697ms | 0.336ms | FAILED | js |
| string/case-convert | 0.056ms | 0.627ms | 0.278ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.95ms | 2.88ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 3.07ms | 2.98ms | 0.563ms | js |
| array/push-pop | 1.42ms | 0.512ms | 0.513ms | FAILED | host-call |
| array/sort-i32 | 0.801ms | 0.292ms | 0.293ms | FAILED | host-call |
| array/map-filter | 0.128ms | 0.071ms | 0.071ms | FAILED | host-call |
| array/reduce | 1.37ms | 0.503ms | 0.502ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | host-call |
| array/slice | 0.025ms | 0.028ms | 0.030ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.08ms | host-call |
| dom/create-elements | 0.036ms | 0.154ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.216ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.132ms | — | — | js |
| dom/modify-text | 0.030ms | 0.111ms | — | — | js |
| mixed/csv-parse | 1.18ms | 8.86ms | 0.650ms | FAILED | gc-native |
| mixed/text-search | 0.390ms | 5.21ms | 2.79ms | 1.09ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.159ms | 76.84ms | 76.59ms | 0.716ms | js |
| mixed/sieve | 1.56ms | 2.12ms | 2.11ms | FAILED | js |

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
| string/concat-short | 10000 | 3.42 | 4.86 | 4.23 | — |
| string/concat-long | 1000 | 3.74 | 4.68 | 3.77 | — |
| string/indexOf | 1000 | 19.18 | 63.54 | 12.24 | 14.86 |
| string/includes | 1000 | 19.19 | 102.40 | 14.76 | 15.63 |
| string/split | 10000 | 42.46 | 833.50 | 294.58 | — |
| string/replace | 1000 | 101.20 | 696.83 | 336.49 | — |
| string/case-convert | 2000 | 27.83 | 313.54 | 139.06 | — |
| string/substring | 10000 | 9.86 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.01 | 395.26 | 287.90 | — |
| string/startsWith-endsWith | 20000 | 20.03 | 153.31 | 149.18 | 28.13 |
| array/map-filter | 30000 | 4.28 | 2.36 | 2.36 | — |
| array/indexOf | 1000 | 3951.30 | 2641.42 | 2643.08 | — |
| dom/create-elements | 2000 | 18.02 | 77.13 | — | — |
| dom/set-attributes | 6000 | 17.51 | 35.93 | — | — |
| dom/read-attributes | 3000 | 18.28 | 43.89 | — | — |
| dom/modify-text | 2000 | 14.85 | 55.27 | — | — |
| mixed/csv-parse | 11000 | 107.37 | 805.20 | 59.07 | — |
| mixed/text-search | 40000 | 9.74 | 130.23 | 69.77 | 27.15 |
| mixed/fibonacci | 10000 | 12.02 | 28.31 | 28.31 | 28.07 |
| mixed/matrix-multiply | 125000 | 1.27 | 614.75 | 612.69 | 5.73 |
| mixed/sieve | 200000 | 7.82 | 10.61 | 10.56 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.42x slower | 1.24x slower | — |
| string/concat-long | 1.25x slower | 1.01x slower | — |
| string/indexOf | 3.31x slower | 1.57x faster | 1.29x faster |
| string/includes | 5.34x slower | 1.30x faster | 1.23x faster |
| string/split | 19.63x slower | 6.94x slower | — |
| string/replace | 6.89x slower | 3.33x slower | — |
| string/case-convert | 11.27x slower | 5.00x slower | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 23.24x slower | 16.93x slower | — |
| string/startsWith-endsWith | 7.66x slower | 7.45x slower | 1.40x slower |
| array/push-pop | 2.77x faster | 2.77x faster | — |
| array/sort-i32 | 2.74x faster | 2.73x faster | — |
| array/map-filter | 1.82x faster | 1.81x faster | — |
| array/reduce | 2.73x faster | 2.74x faster | — |
| array/indexOf | 1.50x faster | 1.49x faster | — |
| array/slice | 1.10x slower | 1.20x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.75x faster | 1.75x faster | — |
| array/find | 16.22x faster | 16.20x faster | 4.24x slower |
| dom/create-elements | 4.28x slower | — | — |
| dom/set-attributes | 2.05x slower | — | — |
| dom/read-attributes | 2.40x slower | — | — |
| dom/modify-text | 3.72x slower | — | — |
| mixed/csv-parse | 7.50x slower | 1.82x faster | — |
| mixed/text-search | 13.37x slower | 7.16x slower | 2.79x slower |
| mixed/fibonacci | 2.36x slower | 2.36x slower | 2.34x slower |
| mixed/matrix-multiply | 482.40x slower | 480.78x slower | 4.49x slower |
| mixed/sieve | 1.36x slower | 1.35x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.15x faster |
| string/concat-long | 1.24x faster |
| string/indexOf | 5.19x faster |
| string/includes | 6.94x faster |
| string/split | 2.83x faster |
| string/replace | 2.07x faster |
| string/case-convert | 2.25x faster |
| string/substring | 1.22x faster |
| string/trim | 1.37x faster |
| string/startsWith-endsWith | 1.03x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.09x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 13.63x faster |
| mixed/text-search | 1.87x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.00x faster |

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
| string/concat-short | 1193.6ms | 607.7ms | — |
| string/concat-long | 451.1ms | 666.4ms | — |
| string/indexOf | 374.2ms | 663.9ms | 563.6ms |
| string/includes | 370.8ms | 671.4ms | 551.7ms |
| string/split | 507.2ms | 691.4ms | — |
| string/replace | 513.1ms | 737.7ms | — |
| string/case-convert | 513.1ms | 604.0ms | — |
| string/substring | 373.9ms | 459.7ms | — |
| string/trim | 488.9ms | 704.2ms | — |
| string/startsWith-endsWith | 499.8ms | 683.3ms | 628.4ms |
| array/push-pop | 506.6ms | 593.5ms | — |
| array/sort-i32 | 648.1ms | 709.5ms | — |
| array/map-filter | 666.9ms | 760.1ms | — |
| array/reduce | 612.2ms | 726.0ms | — |
| array/indexOf | 599.1ms | 686.5ms | — |
| array/slice | 507.4ms | 616.5ms | — |
| array/reverse | 490.7ms | 571.8ms | — |
| array/forEach | 638.8ms | 680.4ms | — |
| array/find | 501.7ms | 575.9ms | 555.2ms |
| dom/create-elements | 410.0ms | — | — |
| dom/set-attributes | 374.1ms | — | — |
| dom/read-attributes | 400.8ms | — | — |
| dom/modify-text | 375.6ms | — | — |
| mixed/csv-parse | 540.1ms | 686.7ms | — |
| mixed/text-search | 489.9ms | 700.1ms | 622.8ms |
| mixed/fibonacci | 445.5ms | 492.2ms | 465.7ms |
| mixed/matrix-multiply | 650.8ms | 714.9ms | 515.6ms |
| mixed/sieve | 609.0ms | 680.0ms | — |
