# js2wasm Benchmark Results

Date: 2026-09-28
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.050ms | 0.052ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.099ms | 0.014ms | 0.017ms | gc-native |
| string/split | 0.421ms | 7.77ms | 2.69ms | FAILED | js |
| string/replace | 0.095ms | 0.618ms | 0.289ms | FAILED | js |
| string/case-convert | 0.058ms | 0.572ms | 0.243ms | FAILED | js |
| string/substring | 0.105ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 3.58ms | 2.55ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 2.55ms | 2.64ms | 0.558ms | js |
| array/push-pop | 1.70ms | 0.607ms | 0.607ms | FAILED | host-call |
| array/sort-i32 | 0.845ms | 0.299ms | 0.301ms | FAILED | host-call |
| array/map-filter | 0.139ms | 0.067ms | 0.067ms | FAILED | host-call |
| array/reduce | 2.41ms | 0.603ms | 0.605ms | FAILED | host-call |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.039ms | 0.018ms | 0.018ms | FAILED | host-call |
| array/reverse | 8.85ms | 3.97ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.054ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/find | 0.273ms | 0.015ms | 0.015ms | 1.21ms | host-call |
| dom/create-elements | 0.040ms | 0.103ms | — | — | js |
| dom/set-attributes | 0.111ms | 0.237ms | — | — | js |
| dom/read-attributes | 0.060ms | 0.135ms | — | — | js |
| dom/modify-text | 0.030ms | 0.114ms | — | — | js |
| mixed/csv-parse | 0.468ms | 8.07ms | 0.552ms | FAILED | js |
| mixed/text-search | 0.403ms | 4.32ms | 2.46ms | 1.11ms | js |
| mixed/fibonacci | 0.126ms | 0.328ms | 0.328ms | 0.325ms | js |
| mixed/matrix-multiply | 0.188ms | 66.89ms | 71.10ms | 0.725ms | js |
| mixed/sieve | 1.86ms | 2.35ms | 2.33ms | FAILED | js |

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
| string/concat-short | 10000 | 3.09 | 4.98 | 5.16 | — |
| string/concat-long | 1000 | 4.44 | 5.45 | 3.75 | — |
| string/indexOf | 1000 | 19.01 | 60.38 | 12.25 | 16.23 |
| string/includes | 1000 | 18.77 | 98.59 | 13.87 | 16.74 |
| string/split | 10000 | 42.08 | 776.65 | 269.04 | — |
| string/replace | 1000 | 95.13 | 617.57 | 289.02 | — |
| string/case-convert | 2000 | 29.04 | 286.24 | 121.50 | — |
| string/substring | 10000 | 10.47 | 3.98 | 3.43 | — |
| string/trim | 10000 | 17.31 | 358.37 | 255.29 | — |
| string/startsWith-endsWith | 20000 | 20.66 | 127.71 | 131.92 | 27.88 |
| array/map-filter | 30000 | 4.64 | 2.23 | 2.23 | — |
| array/indexOf | 1000 | 4460.24 | 2864.39 | 2861.54 | — |
| dom/create-elements | 2000 | 19.87 | 51.53 | — | — |
| dom/set-attributes | 6000 | 18.45 | 39.55 | — | — |
| dom/read-attributes | 3000 | 20.01 | 45.10 | — | — |
| dom/modify-text | 2000 | 14.99 | 56.82 | — | — |
| mixed/csv-parse | 11000 | 42.50 | 733.53 | 50.21 | — |
| mixed/text-search | 40000 | 10.08 | 108.11 | 61.55 | 27.70 |
| mixed/fibonacci | 10000 | 12.56 | 32.75 | 32.76 | 32.49 |
| mixed/matrix-multiply | 125000 | 1.51 | 535.11 | 568.83 | 5.80 |
| mixed/sieve | 200000 | 9.29 | 11.73 | 11.66 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.61x slower | 1.67x slower | — |
| string/concat-long | 1.23x slower | 1.19x faster | — |
| string/indexOf | 3.18x slower | 1.55x faster | 1.17x faster |
| string/includes | 5.25x slower | 1.35x faster | 1.12x faster |
| string/split | 18.46x slower | 6.39x slower | — |
| string/replace | 6.49x slower | 3.04x slower | — |
| string/case-convert | 9.86x slower | 4.18x slower | — |
| string/substring | 2.63x faster | 3.05x faster | — |
| string/trim | 20.70x slower | 14.75x slower | — |
| string/startsWith-endsWith | 6.18x slower | 6.38x slower | 1.35x slower |
| array/push-pop | 2.80x faster | 2.80x faster | — |
| array/sort-i32 | 2.82x faster | 2.80x faster | — |
| array/map-filter | 2.08x faster | 2.08x faster | — |
| array/reduce | 4.00x faster | 3.99x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.20x faster | 2.19x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.88x faster | 1.88x faster | — |
| array/find | 18.17x faster | 18.17x faster | 4.41x slower |
| dom/create-elements | 2.59x slower | — | — |
| dom/set-attributes | 2.14x slower | — | — |
| dom/read-attributes | 2.25x slower | — | — |
| dom/modify-text | 3.79x slower | — | — |
| mixed/csv-parse | 17.26x slower | 1.18x slower | — |
| mixed/text-search | 10.73x slower | 6.11x slower | 2.75x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.59x slower |
| mixed/matrix-multiply | 355.39x slower | 377.78x slower | 3.85x slower |
| mixed/sieve | 1.26x slower | 1.26x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.04x slower |
| string/concat-long | 1.45x faster |
| string/indexOf | 4.93x faster |
| string/includes | 7.11x faster |
| string/split | 2.89x faster |
| string/replace | 2.14x faster |
| string/case-convert | 2.36x faster |
| string/substring | 1.16x faster |
| string/trim | 1.40x faster |
| string/startsWith-endsWith | 1.03x slower |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 14.61x faster |
| mixed/text-search | 1.76x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.06x slower |
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
| mixed/matrix-multiply | 3.5KB | 4.0KB | 991B |
| mixed/sieve | 2.5KB | 2.7KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1140.7ms | 639.8ms | — |
| string/concat-long | 458.3ms | 668.7ms | — |
| string/indexOf | 388.7ms | 673.2ms | 559.0ms |
| string/includes | 388.7ms | 678.8ms | 562.9ms |
| string/split | 509.2ms | 719.5ms | — |
| string/replace | 514.1ms | 793.3ms | — |
| string/case-convert | 530.2ms | 617.0ms | — |
| string/substring | 401.0ms | 517.6ms | — |
| string/trim | 499.3ms | 702.3ms | — |
| string/startsWith-endsWith | 497.1ms | 704.7ms | 623.1ms |
| array/push-pop | 510.7ms | 594.2ms | — |
| array/sort-i32 | 665.1ms | 774.5ms | — |
| array/map-filter | 671.9ms | 743.5ms | — |
| array/reduce | 616.9ms | 690.5ms | — |
| array/indexOf | 581.3ms | 678.0ms | — |
| array/slice | 524.7ms | 618.2ms | — |
| array/reverse | 503.6ms | 603.8ms | — |
| array/forEach | 661.5ms | 695.2ms | — |
| array/find | 496.3ms | 606.6ms | 553.5ms |
| dom/create-elements | 437.2ms | — | — |
| dom/set-attributes | 397.7ms | — | — |
| dom/read-attributes | 398.7ms | — | — |
| dom/modify-text | 391.0ms | — | — |
| mixed/csv-parse | 528.3ms | 694.9ms | — |
| mixed/text-search | 503.7ms | 705.0ms | 627.1ms |
| mixed/fibonacci | 483.3ms | 507.0ms | 476.3ms |
| mixed/matrix-multiply | 677.2ms | 707.1ms | 540.9ms |
| mixed/sieve | 610.4ms | 699.0ms | — |
