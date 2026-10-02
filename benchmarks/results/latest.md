# js2wasm Benchmark Results

Date: 2026-10-02
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.036ms | 0.052ms | 0.050ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.017ms | gc-native |
| string/includes | 0.019ms | 0.126ms | 0.014ms | 0.037ms | gc-native |
| string/split | 0.424ms | 7.90ms | 2.66ms | FAILED | js |
| string/replace | 0.094ms | 0.574ms | 0.282ms | FAILED | js |
| string/case-convert | 0.058ms | 0.556ms | 0.242ms | FAILED | js |
| string/substring | 0.105ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.174ms | 3.48ms | 2.41ms | FAILED | js |
| string/startsWith-endsWith | 0.414ms | 2.53ms | 2.54ms | 0.558ms | js |
| array/push-pop | 1.69ms | 0.618ms | 0.616ms | FAILED | gc-native |
| array/sort-i32 | 0.853ms | 0.305ms | 0.300ms | FAILED | gc-native |
| array/map-filter | 0.140ms | 0.067ms | 0.067ms | FAILED | gc-native |
| array/reduce | 1.64ms | 0.608ms | 0.612ms | FAILED | host-call |
| array/indexOf | 4.46ms | 2.88ms | 2.87ms | FAILED | gc-native |
| array/slice | 0.039ms | 0.018ms | 0.018ms | FAILED | gc-native |
| array/reverse | 8.85ms | 3.97ms | 3.97ms | FAILED | host-call |
| array/forEach | 0.055ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/find | 0.274ms | 0.015ms | 0.015ms | 1.21ms | host-call |
| dom/create-elements | 0.036ms | 0.104ms | — | — | js |
| dom/set-attributes | 0.110ms | 0.237ms | — | — | js |
| dom/read-attributes | 0.060ms | 0.136ms | — | — | js |
| dom/modify-text | 0.030ms | 0.114ms | — | — | js |
| mixed/csv-parse | 0.468ms | 8.63ms | 0.565ms | FAILED | js |
| mixed/text-search | 0.403ms | 4.72ms | 2.53ms | 1.13ms | js |
| mixed/fibonacci | 0.125ms | 0.327ms | 0.327ms | 0.325ms | js |
| mixed/matrix-multiply | 0.187ms | 69.84ms | 71.14ms | 0.724ms | js |
| mixed/sieve | 1.81ms | 2.34ms | 2.34ms | FAILED | js |

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
| string/concat-short | 10000 | 3.57 | 5.20 | 5.05 | — |
| string/concat-long | 1000 | 4.04 | 5.46 | 3.76 | — |
| string/indexOf | 1000 | 19.02 | 60.37 | 12.41 | 17.48 |
| string/includes | 1000 | 18.76 | 125.53 | 14.05 | 36.80 |
| string/split | 10000 | 42.36 | 789.55 | 266.14 | — |
| string/replace | 1000 | 94.42 | 574.49 | 282.16 | — |
| string/case-convert | 2000 | 29.11 | 277.83 | 120.84 | — |
| string/substring | 10000 | 10.50 | 3.98 | 3.44 | — |
| string/trim | 10000 | 17.37 | 347.95 | 241.39 | — |
| string/startsWith-endsWith | 20000 | 20.69 | 126.54 | 126.92 | 27.88 |
| array/map-filter | 30000 | 4.68 | 2.22 | 2.22 | — |
| array/indexOf | 1000 | 4459.99 | 2875.48 | 2871.61 | — |
| dom/create-elements | 2000 | 18.13 | 51.90 | — | — |
| dom/set-attributes | 6000 | 18.36 | 39.51 | — | — |
| dom/read-attributes | 3000 | 19.98 | 45.22 | — | — |
| dom/modify-text | 2000 | 15.10 | 56.77 | — | — |
| mixed/csv-parse | 11000 | 42.58 | 784.91 | 51.34 | — |
| mixed/text-search | 40000 | 10.07 | 118.11 | 63.23 | 28.33 |
| mixed/fibonacci | 10000 | 12.54 | 32.71 | 32.75 | 32.49 |
| mixed/matrix-multiply | 125000 | 1.50 | 558.68 | 569.14 | 5.79 |
| mixed/sieve | 200000 | 9.05 | 11.71 | 11.69 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.46x slower | 1.42x slower | — |
| string/concat-long | 1.35x slower | 1.07x faster | — |
| string/indexOf | 3.17x slower | 1.53x faster | 1.09x faster |
| string/includes | 6.69x slower | 1.34x faster | 1.96x slower |
| string/split | 18.64x slower | 6.28x slower | — |
| string/replace | 6.08x slower | 2.99x slower | — |
| string/case-convert | 9.55x slower | 4.15x slower | — |
| string/substring | 2.63x faster | 3.05x faster | — |
| string/trim | 20.03x slower | 13.90x slower | — |
| string/startsWith-endsWith | 6.11x slower | 6.13x slower | 1.35x slower |
| array/push-pop | 2.74x faster | 2.75x faster | — |
| array/sort-i32 | 2.80x faster | 2.84x faster | — |
| array/map-filter | 2.10x faster | 2.10x faster | — |
| array/reduce | 2.70x faster | 2.68x faster | — |
| array/indexOf | 1.55x faster | 1.55x faster | — |
| array/slice | 2.19x faster | 2.20x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.89x faster | 1.89x faster | — |
| array/find | 18.31x faster | 18.23x faster | 4.41x slower |
| dom/create-elements | 2.86x slower | — | — |
| dom/set-attributes | 2.15x slower | — | — |
| dom/read-attributes | 2.26x slower | — | — |
| dom/modify-text | 3.76x slower | — | — |
| mixed/csv-parse | 18.43x slower | 1.21x slower | — |
| mixed/text-search | 11.72x slower | 6.28x slower | 2.81x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.59x slower |
| mixed/matrix-multiply | 373.49x slower | 380.48x slower | 3.87x slower |
| mixed/sieve | 1.29x slower | 1.29x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x faster |
| string/concat-long | 1.45x faster |
| string/indexOf | 4.87x faster |
| string/includes | 8.94x faster |
| string/split | 2.97x faster |
| string/replace | 2.04x faster |
| string/case-convert | 2.30x faster |
| string/substring | 1.16x faster |
| string/trim | 1.44x faster |
| string/startsWith-endsWith | 1.00x slower |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.02x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 15.29x faster |
| mixed/text-search | 1.87x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.02x slower |
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
| string/concat-short | 1142.7ms | 597.7ms | — |
| string/concat-long | 448.1ms | 648.3ms | — |
| string/indexOf | 393.9ms | 647.9ms | 570.6ms |
| string/includes | 429.5ms | 672.7ms | 551.2ms |
| string/split | 535.3ms | 684.1ms | — |
| string/replace | 512.2ms | 762.7ms | — |
| string/case-convert | 514.3ms | 598.4ms | — |
| string/substring | 390.2ms | 481.1ms | — |
| string/trim | 494.0ms | 666.5ms | — |
| string/startsWith-endsWith | 469.0ms | 681.7ms | 627.7ms |
| array/push-pop | 497.4ms | 597.3ms | — |
| array/sort-i32 | 657.8ms | 713.4ms | — |
| array/map-filter | 657.4ms | 726.8ms | — |
| array/reduce | 602.0ms | 671.4ms | — |
| array/indexOf | 601.1ms | 664.3ms | — |
| array/slice | 520.6ms | 584.2ms | — |
| array/reverse | 491.2ms | 561.5ms | — |
| array/forEach | 633.3ms | 683.4ms | — |
| array/find | 494.7ms | 585.6ms | 531.0ms |
| dom/create-elements | 436.9ms | — | — |
| dom/set-attributes | 390.9ms | — | — |
| dom/read-attributes | 395.6ms | — | — |
| dom/modify-text | 388.2ms | — | — |
| mixed/csv-parse | 552.8ms | 669.7ms | — |
| mixed/text-search | 511.7ms | 688.9ms | 629.5ms |
| mixed/fibonacci | 467.0ms | 532.4ms | 471.1ms |
| mixed/matrix-multiply | 658.2ms | 724.9ms | 531.7ms |
| mixed/sieve | 595.1ms | 690.4ms | — |
