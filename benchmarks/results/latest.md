# js2wasm Benchmark Results

Date: 2026-09-29
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.027ms | 0.040ms | 0.039ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.047ms | 0.010ms | 0.031ms | gc-native |
| string/includes | 0.015ms | 0.082ms | 0.011ms | 0.015ms | gc-native |
| string/split | 0.329ms | 6.10ms | 2.04ms | FAILED | js |
| string/replace | 0.075ms | 0.472ms | 0.215ms | FAILED | js |
| string/case-convert | 0.045ms | 0.424ms | 0.187ms | FAILED | js |
| string/substring | 0.081ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.134ms | 2.60ms | 1.87ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 1.93ms | 2.03ms | 0.433ms | js |
| array/push-pop | 1.31ms | 0.472ms | 0.475ms | FAILED | host-call |
| array/sort-i32 | 0.661ms | 0.234ms | 0.237ms | FAILED | host-call |
| array/map-filter | 0.111ms | 0.052ms | 0.052ms | FAILED | host-call |
| array/reduce | 1.87ms | 0.470ms | 0.468ms | FAILED | gc-native |
| array/indexOf | 3.46ms | 2.22ms | 2.22ms | FAILED | gc-native |
| array/slice | 0.031ms | 0.014ms | 0.014ms | FAILED | host-call |
| array/reverse | 6.86ms | 3.08ms | 3.08ms | FAILED | host-call |
| array/forEach | 0.043ms | 0.023ms | 0.023ms | FAILED | gc-native |
| array/find | 0.213ms | 0.012ms | 0.012ms | 0.939ms | gc-native |
| dom/create-elements | 0.030ms | 0.079ms | — | — | js |
| dom/set-attributes | 0.086ms | 0.183ms | — | — | js |
| dom/read-attributes | 0.049ms | 0.103ms | — | — | js |
| dom/modify-text | 0.023ms | 0.088ms | — | — | js |
| mixed/csv-parse | 0.364ms | 6.24ms | 0.442ms | FAILED | js |
| mixed/text-search | 0.312ms | 3.44ms | 1.94ms | 0.869ms | js |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 0.252ms | js |
| mixed/matrix-multiply | 0.147ms | 51.73ms | 53.71ms | 0.560ms | js |
| mixed/sieve | 1.43ms | 1.80ms | 1.79ms | FAILED | js |

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
| string/concat-short | 10000 | 2.67 | 4.02 | 3.88 | — |
| string/concat-long | 1000 | 3.23 | 4.21 | 3.00 | — |
| string/indexOf | 1000 | 14.76 | 46.62 | 9.79 | 31.36 |
| string/includes | 1000 | 14.55 | 81.74 | 11.08 | 14.90 |
| string/split | 10000 | 32.92 | 609.56 | 204.33 | — |
| string/replace | 1000 | 75.48 | 472.44 | 214.93 | — |
| string/case-convert | 2000 | 22.45 | 211.94 | 93.68 | — |
| string/substring | 10000 | 8.07 | 3.09 | 2.67 | — |
| string/trim | 10000 | 13.41 | 260.35 | 186.87 | — |
| string/startsWith-endsWith | 20000 | 16.00 | 96.59 | 101.62 | 21.64 |
| array/map-filter | 30000 | 3.70 | 1.74 | 1.74 | — |
| array/indexOf | 1000 | 3460.02 | 2220.83 | 2219.81 | — |
| dom/create-elements | 2000 | 14.99 | 39.33 | — | — |
| dom/set-attributes | 6000 | 14.30 | 30.55 | — | — |
| dom/read-attributes | 3000 | 16.23 | 34.35 | — | — |
| dom/modify-text | 2000 | 11.47 | 43.93 | — | — |
| mixed/csv-parse | 11000 | 33.14 | 566.89 | 40.22 | — |
| mixed/text-search | 40000 | 7.81 | 86.11 | 48.41 | 21.72 |
| mixed/fibonacci | 10000 | 9.71 | 25.39 | 25.40 | 25.25 |
| mixed/matrix-multiply | 125000 | 1.17 | 413.83 | 429.67 | 4.48 |
| mixed/sieve | 200000 | 7.15 | 8.98 | 8.97 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.51x slower | 1.45x slower | — |
| string/concat-long | 1.31x slower | 1.08x faster | — |
| string/indexOf | 3.16x slower | 1.51x faster | 2.12x slower |
| string/includes | 5.62x slower | 1.31x faster | 1.02x slower |
| string/split | 18.52x slower | 6.21x slower | — |
| string/replace | 6.26x slower | 2.85x slower | — |
| string/case-convert | 9.44x slower | 4.17x slower | — |
| string/substring | 2.61x faster | 3.03x faster | — |
| string/trim | 19.42x slower | 13.94x slower | — |
| string/startsWith-endsWith | 6.04x slower | 6.35x slower | 1.35x slower |
| array/push-pop | 2.78x faster | 2.75x faster | — |
| array/sort-i32 | 2.82x faster | 2.79x faster | — |
| array/map-filter | 2.13x faster | 2.12x faster | — |
| array/reduce | 3.97x faster | 3.99x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.22x faster | 2.21x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.89x faster | 1.89x faster | — |
| array/find | 17.72x faster | 17.83x faster | 4.42x slower |
| dom/create-elements | 2.62x slower | — | — |
| dom/set-attributes | 2.14x slower | — | — |
| dom/read-attributes | 2.12x slower | — | — |
| dom/modify-text | 3.83x slower | — | — |
| mixed/csv-parse | 17.11x slower | 1.21x slower | — |
| mixed/text-search | 11.03x slower | 6.20x slower | 2.78x slower |
| mixed/fibonacci | 2.61x slower | 2.62x slower | 2.60x slower |
| mixed/matrix-multiply | 352.69x slower | 366.19x slower | 3.82x slower |
| mixed/sieve | 1.26x slower | 1.25x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.04x faster |
| string/concat-long | 1.41x faster |
| string/indexOf | 4.76x faster |
| string/includes | 7.37x faster |
| string/split | 2.98x faster |
| string/replace | 2.20x faster |
| string/case-convert | 2.26x faster |
| string/substring | 1.16x faster |
| string/trim | 1.39x faster |
| string/startsWith-endsWith | 1.05x slower |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.01x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 14.09x faster |
| mixed/text-search | 1.78x faster |
| mixed/fibonacci | 1.00x slower |
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
| string/concat-short | 868.8ms | 471.0ms | — |
| string/concat-long | 353.3ms | 495.3ms | — |
| string/indexOf | 285.7ms | 505.4ms | 420.4ms |
| string/includes | 292.5ms | 516.5ms | 427.7ms |
| string/split | 389.3ms | 515.6ms | — |
| string/replace | 383.8ms | 567.4ms | — |
| string/case-convert | 380.0ms | 456.5ms | — |
| string/substring | 297.7ms | 360.0ms | — |
| string/trim | 362.6ms | 519.0ms | — |
| string/startsWith-endsWith | 365.4ms | 509.9ms | 471.2ms |
| array/push-pop | 389.5ms | 440.4ms | — |
| array/sort-i32 | 517.1ms | 547.6ms | — |
| array/map-filter | 550.1ms | 546.6ms | — |
| array/reduce | 457.8ms | 546.8ms | — |
| array/indexOf | 448.1ms | 505.8ms | — |
| array/slice | 378.4ms | 459.8ms | — |
| array/reverse | 368.9ms | 448.7ms | — |
| array/forEach | 484.8ms | 538.9ms | — |
| array/find | 389.4ms | 446.2ms | 411.7ms |
| dom/create-elements | 329.1ms | — | — |
| dom/set-attributes | 293.3ms | — | — |
| dom/read-attributes | 301.2ms | — | — |
| dom/modify-text | 293.5ms | — | — |
| mixed/csv-parse | 398.6ms | 508.0ms | — |
| mixed/text-search | 404.5ms | 520.4ms | 465.9ms |
| mixed/fibonacci | 342.5ms | 384.4ms | 353.4ms |
| mixed/matrix-multiply | 481.6ms | 546.5ms | 389.4ms |
| mixed/sieve | 454.9ms | 518.1ms | — |
