# js2wasm Benchmark Results

Date: 2026-09-27
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.048ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.025ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.025ms | 0.123ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.423ms | 8.35ms | 2.98ms | FAILED | js |
| string/replace | 0.107ms | 0.703ms | 0.316ms | FAILED | js |
| string/case-convert | 0.056ms | 0.581ms | 0.273ms | FAILED | js |
| string/substring | 0.099ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 4.04ms | 2.90ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 3.19ms | 3.14ms | 0.561ms | js |
| array/push-pop | 1.38ms | 0.502ms | 0.501ms | FAILED | gc-native |
| array/sort-i32 | 0.789ms | 0.293ms | 0.292ms | FAILED | gc-native |
| array/map-filter | 0.125ms | 0.069ms | 0.069ms | FAILED | host-call |
| array/reduce | 2.12ms | 0.504ms | 0.500ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.023ms | 0.026ms | 0.026ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.048ms | 0.027ms | 0.027ms | FAILED | host-call |
| array/find | 0.252ms | 0.016ms | 0.016ms | 1.07ms | host-call |
| dom/create-elements | 0.035ms | 0.093ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.216ms | — | — | js |
| dom/read-attributes | 0.054ms | 0.118ms | — | — | js |
| dom/modify-text | 0.030ms | 0.105ms | — | — | js |
| mixed/csv-parse | 1.01ms | 8.68ms | 0.625ms | FAILED | gc-native |
| mixed/text-search | 0.389ms | 5.34ms | 2.78ms | 1.10ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.156ms | 72.26ms | 74.22ms | 0.717ms | js |
| mixed/sieve | 1.53ms | 2.10ms | 2.09ms | FAILED | js |

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
| string/concat-short | 10000 | 3.14 | 4.81 | 4.37 | — |
| string/concat-long | 1000 | 3.65 | 4.54 | 3.45 | — |
| string/indexOf | 1000 | 24.66 | 63.51 | 12.19 | 14.74 |
| string/includes | 1000 | 24.69 | 122.81 | 14.69 | 15.41 |
| string/split | 10000 | 42.32 | 835.45 | 297.72 | — |
| string/replace | 1000 | 106.96 | 703.23 | 316.36 | — |
| string/case-convert | 2000 | 27.78 | 290.53 | 136.63 | — |
| string/substring | 10000 | 9.87 | 3.76 | 3.07 | — |
| string/trim | 10000 | 16.96 | 403.73 | 289.53 | — |
| string/startsWith-endsWith | 20000 | 20.09 | 159.35 | 156.79 | 28.06 |
| array/map-filter | 30000 | 4.17 | 2.30 | 2.31 | — |
| array/indexOf | 1000 | 3948.67 | 2640.03 | 2639.82 | — |
| dom/create-elements | 2000 | 17.42 | 46.62 | — | — |
| dom/set-attributes | 6000 | 17.19 | 35.99 | — | — |
| dom/read-attributes | 3000 | 18.04 | 39.49 | — | — |
| dom/modify-text | 2000 | 14.91 | 52.46 | — | — |
| mixed/csv-parse | 11000 | 91.92 | 789.54 | 56.78 | — |
| mixed/text-search | 40000 | 9.72 | 133.53 | 69.49 | 27.41 |
| mixed/fibonacci | 10000 | 12.18 | 28.32 | 28.30 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.25 | 578.06 | 593.78 | 5.74 |
| mixed/sieve | 200000 | 7.66 | 10.51 | 10.45 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.53x slower | 1.39x slower | — |
| string/concat-long | 1.24x slower | 1.06x faster | — |
| string/indexOf | 2.58x slower | 2.02x faster | 1.67x faster |
| string/includes | 4.97x slower | 1.68x faster | 1.60x faster |
| string/split | 19.74x slower | 7.04x slower | — |
| string/replace | 6.57x slower | 2.96x slower | — |
| string/case-convert | 10.46x slower | 4.92x slower | — |
| string/substring | 2.63x faster | 3.22x faster | — |
| string/trim | 23.81x slower | 17.07x slower | — |
| string/startsWith-endsWith | 7.93x slower | 7.80x slower | 1.40x slower |
| array/push-pop | 2.76x faster | 2.76x faster | — |
| array/sort-i32 | 2.69x faster | 2.70x faster | — |
| array/map-filter | 1.81x faster | 1.80x faster | — |
| array/reduce | 4.21x faster | 4.25x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.11x slower | 1.10x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.74x faster | 1.74x faster | — |
| array/find | 16.15x faster | 16.08x faster | 4.25x slower |
| dom/create-elements | 2.68x slower | — | — |
| dom/set-attributes | 2.09x slower | — | — |
| dom/read-attributes | 2.19x slower | — | — |
| dom/modify-text | 3.52x slower | — | — |
| mixed/csv-parse | 8.59x slower | 1.62x faster | — |
| mixed/text-search | 13.73x slower | 7.15x slower | 2.82x slower |
| mixed/fibonacci | 2.33x slower | 2.32x slower | 2.31x slower |
| mixed/matrix-multiply | 463.80x slower | 476.42x slower | 4.60x slower |
| mixed/sieve | 1.37x slower | 1.36x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.10x faster |
| string/concat-long | 1.32x faster |
| string/indexOf | 5.21x faster |
| string/includes | 8.36x faster |
| string/split | 2.81x faster |
| string/replace | 2.22x faster |
| string/case-convert | 2.13x faster |
| string/substring | 1.22x faster |
| string/trim | 1.39x faster |
| string/startsWith-endsWith | 1.02x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.00x slower |
| mixed/csv-parse | 13.90x faster |
| mixed/text-search | 1.92x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.03x slower |
| mixed/sieve | 1.01x faster |

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
| mixed/matrix-multiply | 3.0KB | 3.6KB | 991B |
| mixed/sieve | 2.0KB | 2.4KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1131.2ms | 615.4ms | — |
| string/concat-long | 424.9ms | 659.2ms | — |
| string/indexOf | 362.7ms | 651.3ms | 533.5ms |
| string/includes | 373.2ms | 649.3ms | 549.2ms |
| string/split | 507.7ms | 683.5ms | — |
| string/replace | 504.2ms | 740.8ms | — |
| string/case-convert | 498.7ms | 617.8ms | — |
| string/substring | 393.8ms | 492.5ms | — |
| string/trim | 481.7ms | 672.1ms | — |
| string/startsWith-endsWith | 472.5ms | 705.9ms | 629.1ms |
| array/push-pop | 512.7ms | 589.6ms | — |
| array/sort-i32 | 651.9ms | 709.5ms | — |
| array/map-filter | 655.8ms | 740.9ms | — |
| array/reduce | 599.4ms | 665.8ms | — |
| array/indexOf | 577.8ms | 680.4ms | — |
| array/slice | 510.7ms | 609.1ms | — |
| array/reverse | 501.2ms | 597.6ms | — |
| array/forEach | 645.7ms | 739.1ms | — |
| array/find | 486.2ms | 603.2ms | 554.4ms |
| dom/create-elements | 448.5ms | — | — |
| dom/set-attributes | 367.6ms | — | — |
| dom/read-attributes | 374.4ms | — | — |
| dom/modify-text | 365.4ms | — | — |
| mixed/csv-parse | 510.6ms | 682.9ms | — |
| mixed/text-search | 500.8ms | 699.6ms | 607.8ms |
| mixed/fibonacci | 465.1ms | 497.8ms | 459.8ms |
| mixed/matrix-multiply | 618.2ms | 698.9ms | 514.6ms |
| mixed/sieve | 590.2ms | 666.9ms | — |
