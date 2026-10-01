# js2wasm Benchmark Results

Date: 2026-10-01
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.048ms | 0.041ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.110ms | 0.015ms | 0.017ms | gc-native |
| string/split | 0.423ms | 8.36ms | 2.78ms | FAILED | js |
| string/replace | 0.112ms | 0.693ms | 0.337ms | FAILED | js |
| string/case-convert | 0.056ms | 0.621ms | 0.260ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.98ms | 2.72ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 3.00ms | 2.88ms | 0.560ms | js |
| array/push-pop | 1.39ms | 0.498ms | 0.502ms | FAILED | host-call |
| array/sort-i32 | 0.799ms | 0.294ms | 0.293ms | FAILED | gc-native |
| array/map-filter | 0.126ms | 0.070ms | 0.070ms | FAILED | host-call |
| array/reduce | 1.35ms | 0.501ms | 0.508ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.048ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.252ms | 0.016ms | 0.016ms | 1.08ms | host-call |
| dom/create-elements | 0.034ms | 0.095ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.219ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.121ms | — | — | js |
| dom/modify-text | 0.028ms | 0.110ms | — | — | js |
| mixed/csv-parse | 0.483ms | 8.81ms | 0.646ms | FAILED | js |
| mixed/text-search | 0.389ms | 5.12ms | 2.83ms | 1.08ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.289ms | js |
| mixed/matrix-multiply | 0.157ms | 79.94ms | 81.19ms | 0.727ms | js |
| mixed/sieve | 1.56ms | 2.11ms | 2.12ms | FAILED | js |

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
| string/concat-short | 10000 | 3.48 | 4.80 | 4.12 | — |
| string/concat-long | 1000 | 3.58 | 4.51 | 3.66 | — |
| string/indexOf | 1000 | 19.15 | 63.60 | 12.13 | 14.57 |
| string/includes | 1000 | 19.19 | 109.73 | 14.76 | 16.57 |
| string/split | 10000 | 42.32 | 836.06 | 277.74 | — |
| string/replace | 1000 | 112.42 | 693.18 | 337.28 | — |
| string/case-convert | 2000 | 27.77 | 310.45 | 129.99 | — |
| string/substring | 10000 | 9.86 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.03 | 398.37 | 271.90 | — |
| string/startsWith-endsWith | 20000 | 20.04 | 149.99 | 144.13 | 28.01 |
| array/map-filter | 30000 | 4.20 | 2.33 | 2.33 | — |
| array/indexOf | 1000 | 3949.84 | 2641.65 | 2638.65 | — |
| dom/create-elements | 2000 | 16.88 | 47.52 | — | — |
| dom/set-attributes | 6000 | 17.21 | 36.55 | — | — |
| dom/read-attributes | 3000 | 18.39 | 40.35 | — | — |
| dom/modify-text | 2000 | 14.21 | 54.80 | — | — |
| mixed/csv-parse | 11000 | 43.88 | 801.32 | 58.70 | — |
| mixed/text-search | 40000 | 9.72 | 128.05 | 70.69 | 26.98 |
| mixed/fibonacci | 10000 | 12.01 | 28.32 | 28.31 | 28.89 |
| mixed/matrix-multiply | 125000 | 1.26 | 639.50 | 649.49 | 5.81 |
| mixed/sieve | 200000 | 7.79 | 10.57 | 10.58 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.38x slower | 1.18x slower | — |
| string/concat-long | 1.26x slower | 1.02x slower | — |
| string/indexOf | 3.32x slower | 1.58x faster | 1.31x faster |
| string/includes | 5.72x slower | 1.30x faster | 1.16x faster |
| string/split | 19.76x slower | 6.56x slower | — |
| string/replace | 6.17x slower | 3.00x slower | — |
| string/case-convert | 11.18x slower | 4.68x slower | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 23.39x slower | 15.96x slower | — |
| string/startsWith-endsWith | 7.49x slower | 7.19x slower | 1.40x slower |
| array/push-pop | 2.80x faster | 2.78x faster | — |
| array/sort-i32 | 2.72x faster | 2.73x faster | — |
| array/map-filter | 1.80x faster | 1.80x faster | — |
| array/reduce | 2.70x faster | 2.66x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.09x slower | 1.07x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.74x faster | 1.73x faster | — |
| array/find | 16.28x faster | 16.12x faster | 4.26x slower |
| dom/create-elements | 2.82x slower | — | — |
| dom/set-attributes | 2.12x slower | — | — |
| dom/read-attributes | 2.19x slower | — | — |
| dom/modify-text | 3.86x slower | — | — |
| mixed/csv-parse | 18.26x slower | 1.34x slower | — |
| mixed/text-search | 13.17x slower | 7.27x slower | 2.78x slower |
| mixed/fibonacci | 2.36x slower | 2.36x slower | 2.40x slower |
| mixed/matrix-multiply | 508.73x slower | 516.68x slower | 4.62x slower |
| mixed/sieve | 1.36x slower | 1.36x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.17x faster |
| string/concat-long | 1.23x faster |
| string/indexOf | 5.24x faster |
| string/includes | 7.43x faster |
| string/split | 3.01x faster |
| string/replace | 2.06x faster |
| string/case-convert | 2.39x faster |
| string/substring | 1.22x faster |
| string/trim | 1.47x faster |
| string/startsWith-endsWith | 1.04x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 13.65x faster |
| mixed/text-search | 1.81x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.02x slower |
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
| string/concat-short | 1198.3ms | 591.8ms | — |
| string/concat-long | 435.4ms | 650.7ms | — |
| string/indexOf | 378.7ms | 652.3ms | 542.1ms |
| string/includes | 362.7ms | 664.4ms | 548.1ms |
| string/split | 522.0ms | 702.5ms | — |
| string/replace | 512.1ms | 715.3ms | — |
| string/case-convert | 509.6ms | 622.9ms | — |
| string/substring | 370.9ms | 458.7ms | — |
| string/trim | 494.7ms | 677.8ms | — |
| string/startsWith-endsWith | 492.8ms | 694.8ms | 619.4ms |
| array/push-pop | 520.8ms | 590.8ms | — |
| array/sort-i32 | 689.7ms | 697.1ms | — |
| array/map-filter | 686.2ms | 730.0ms | — |
| array/reduce | 614.3ms | 696.0ms | — |
| array/indexOf | 600.1ms | 678.7ms | — |
| array/slice | 516.3ms | 611.9ms | — |
| array/reverse | 497.5ms | 566.0ms | — |
| array/forEach | 650.5ms | 696.4ms | — |
| array/find | 482.4ms | 601.0ms | 553.5ms |
| dom/create-elements | 416.6ms | — | — |
| dom/set-attributes | 373.4ms | — | — |
| dom/read-attributes | 384.0ms | — | — |
| dom/modify-text | 370.8ms | — | — |
| mixed/csv-parse | 539.4ms | 671.9ms | — |
| mixed/text-search | 491.7ms | 686.9ms | 624.4ms |
| mixed/fibonacci | 451.6ms | 512.2ms | 460.3ms |
| mixed/matrix-multiply | 628.1ms | 686.9ms | 525.6ms |
| mixed/sieve | 615.4ms | 721.4ms | — |
