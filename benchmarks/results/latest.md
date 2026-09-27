# js2wasm Benchmark Results

Date: 2026-09-27
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.049ms | 0.041ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.013ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.114ms | 0.015ms | 0.021ms | gc-native |
| string/split | 0.424ms | 8.39ms | 2.81ms | FAILED | js |
| string/replace | 0.103ms | 0.696ms | 0.329ms | FAILED | js |
| string/case-convert | 0.056ms | 0.596ms | 0.277ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.169ms | 4.07ms | 2.95ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 2.99ms | 3.07ms | 0.560ms | js |
| array/push-pop | 1.45ms | 0.520ms | 0.509ms | FAILED | gc-native |
| array/sort-i32 | 0.792ms | 0.294ms | 0.294ms | FAILED | host-call |
| array/map-filter | 0.128ms | 0.071ms | 0.071ms | FAILED | host-call |
| array/reduce | 2.14ms | 0.512ms | 0.514ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.026ms | 0.028ms | 0.029ms | FAILED | js |
| array/reverse | 7.82ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.07ms | gc-native |
| dom/create-elements | 0.036ms | 0.156ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.215ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.126ms | — | — | js |
| dom/modify-text | 0.030ms | 0.107ms | — | — | js |
| mixed/csv-parse | 0.485ms | 8.75ms | 0.645ms | FAILED | js |
| mixed/text-search | 0.389ms | 5.18ms | 2.91ms | 1.09ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.160ms | 72.05ms | 74.66ms | 0.721ms | js |
| mixed/sieve | 1.56ms | 2.10ms | 2.10ms | FAILED | js |

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
| string/concat-short | 10000 | 3.35 | 4.90 | 4.14 | — |
| string/concat-long | 1000 | 3.56 | 4.57 | 3.81 | — |
| string/indexOf | 1000 | 19.19 | 63.95 | 12.54 | 14.59 |
| string/includes | 1000 | 19.24 | 114.05 | 14.83 | 21.24 |
| string/split | 10000 | 42.43 | 839.12 | 281.00 | — |
| string/replace | 1000 | 102.85 | 695.72 | 329.33 | — |
| string/case-convert | 2000 | 27.80 | 297.87 | 138.31 | — |
| string/substring | 10000 | 9.86 | 3.74 | 3.07 | — |
| string/trim | 10000 | 16.94 | 407.09 | 295.28 | — |
| string/startsWith-endsWith | 20000 | 20.09 | 149.48 | 153.40 | 27.99 |
| array/map-filter | 30000 | 4.25 | 2.36 | 2.37 | — |
| array/indexOf | 1000 | 3949.74 | 2643.15 | 2639.43 | — |
| dom/create-elements | 2000 | 18.13 | 78.15 | — | — |
| dom/set-attributes | 6000 | 17.56 | 35.87 | — | — |
| dom/read-attributes | 3000 | 18.51 | 41.84 | — | — |
| dom/modify-text | 2000 | 15.04 | 53.59 | — | — |
| mixed/csv-parse | 11000 | 44.09 | 795.53 | 58.64 | — |
| mixed/text-search | 40000 | 9.71 | 129.45 | 72.76 | 27.19 |
| mixed/fibonacci | 10000 | 12.18 | 28.32 | 28.31 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.28 | 576.40 | 597.28 | 5.77 |
| mixed/sieve | 200000 | 7.80 | 10.48 | 10.48 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.46x slower | 1.24x slower | — |
| string/concat-long | 1.28x slower | 1.07x slower | — |
| string/indexOf | 3.33x slower | 1.53x faster | 1.32x faster |
| string/includes | 5.93x slower | 1.30x faster | 1.10x slower |
| string/split | 19.78x slower | 6.62x slower | — |
| string/replace | 6.76x slower | 3.20x slower | — |
| string/case-convert | 10.71x slower | 4.97x slower | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 24.03x slower | 17.43x slower | — |
| string/startsWith-endsWith | 7.44x slower | 7.63x slower | 1.39x slower |
| array/push-pop | 2.78x faster | 2.84x faster | — |
| array/sort-i32 | 2.70x faster | 2.69x faster | — |
| array/map-filter | 1.81x faster | 1.79x faster | — |
| array/reduce | 4.18x faster | 4.16x faster | — |
| array/indexOf | 1.49x faster | 1.50x faster | — |
| array/slice | 1.08x slower | 1.09x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.77x faster | 1.76x faster | — |
| array/find | 16.03x faster | 16.22x faster | 4.22x slower |
| dom/create-elements | 4.31x slower | — | — |
| dom/set-attributes | 2.04x slower | — | — |
| dom/read-attributes | 2.26x slower | — | — |
| dom/modify-text | 3.56x slower | — | — |
| mixed/csv-parse | 18.04x slower | 1.33x slower | — |
| mixed/text-search | 13.33x slower | 7.49x slower | 2.80x slower |
| mixed/fibonacci | 2.32x slower | 2.32x slower | 2.31x slower |
| mixed/matrix-multiply | 450.58x slower | 466.90x slower | 4.51x slower |
| mixed/sieve | 1.34x slower | 1.34x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.18x faster |
| string/concat-long | 1.20x faster |
| string/indexOf | 5.10x faster |
| string/includes | 7.69x faster |
| string/split | 2.99x faster |
| string/replace | 2.11x faster |
| string/case-convert | 2.15x faster |
| string/substring | 1.22x faster |
| string/trim | 1.38x faster |
| string/startsWith-endsWith | 1.03x slower |
| array/push-pop | 1.02x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.01x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 13.57x faster |
| mixed/text-search | 1.78x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.04x slower |
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
| string/concat-short | 1149.1ms | 629.8ms | — |
| string/concat-long | 437.8ms | 679.9ms | — |
| string/indexOf | 371.8ms | 676.5ms | 532.4ms |
| string/includes | 366.3ms | 706.7ms | 548.6ms |
| string/split | 507.4ms | 697.6ms | — |
| string/replace | 503.4ms | 731.8ms | — |
| string/case-convert | 515.8ms | 608.0ms | — |
| string/substring | 378.1ms | 482.4ms | — |
| string/trim | 536.2ms | 677.1ms | — |
| string/startsWith-endsWith | 461.3ms | 690.1ms | 630.2ms |
| array/push-pop | 498.3ms | 576.9ms | — |
| array/sort-i32 | 667.3ms | 728.1ms | — |
| array/map-filter | 699.9ms | 718.8ms | — |
| array/reduce | 605.1ms | 689.8ms | — |
| array/indexOf | 598.8ms | 665.0ms | — |
| array/slice | 523.4ms | 591.7ms | — |
| array/reverse | 495.1ms | 589.7ms | — |
| array/forEach | 652.9ms | 718.0ms | — |
| array/find | 486.1ms | 589.1ms | 542.2ms |
| dom/create-elements | 420.9ms | — | — |
| dom/set-attributes | 370.1ms | — | — |
| dom/read-attributes | 385.2ms | — | — |
| dom/modify-text | 366.1ms | — | — |
| mixed/csv-parse | 520.6ms | 687.8ms | — |
| mixed/text-search | 503.2ms | 686.0ms | 638.0ms |
| mixed/fibonacci | 480.7ms | 503.1ms | 483.0ms |
| mixed/matrix-multiply | 704.2ms | 713.7ms | 523.3ms |
| mixed/sieve | 611.7ms | 693.0ms | — |
