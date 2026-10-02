# js2wasm Benchmark Results

Date: 2026-10-02
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.047ms | 0.042ms | 0.048ms | FAILED | host-call |
| string/concat-long | 0.004ms | 0.005ms | 0.007ms | FAILED | js |
| string/indexOf | 0.013ms | 0.041ms | 0.010ms | 0.016ms | gc-native |
| string/includes | 0.013ms | 0.087ms | 0.012ms | 0.033ms | gc-native |
| string/split | 0.296ms | 5.09ms | 1.95ms | FAILED | js |
| string/replace | 0.070ms | 0.421ms | 0.245ms | FAILED | js |
| string/case-convert | 0.046ms | 0.374ms | 0.180ms | FAILED | js |
| string/substring | 0.132ms | 0.030ms | 0.026ms | FAILED | gc-native |
| string/trim | 0.258ms | 2.59ms | 2.00ms | FAILED | js |
| string/startsWith-endsWith | 0.410ms | 2.14ms | 2.25ms | 0.448ms | js |
| array/push-pop | 1.31ms | 0.439ms | 0.439ms | FAILED | host-call |
| array/sort-i32 | 0.544ms | 0.280ms | 0.280ms | FAILED | host-call |
| array/map-filter | 0.125ms | 0.074ms | 0.073ms | FAILED | gc-native |
| array/reduce | 1.27ms | 0.438ms | 0.440ms | FAILED | host-call |
| array/indexOf | 4.45ms | 2.13ms | 2.13ms | FAILED | gc-native |
| array/slice | 0.048ms | 0.046ms | 0.046ms | FAILED | gc-native |
| array/reverse | 5.63ms | 3.10ms | 3.10ms | FAILED | host-call |
| array/forEach | 0.057ms | 0.023ms | 0.023ms | FAILED | host-call |
| array/find | 0.247ms | 0.016ms | 0.016ms | 0.810ms | host-call |
| dom/create-elements | 0.068ms | 0.098ms | — | — | js |
| dom/set-attributes | 0.124ms | 0.158ms | — | — | js |
| dom/read-attributes | 0.074ms | 0.101ms | — | — | js |
| dom/modify-text | 0.061ms | 0.095ms | — | — | js |
| mixed/csv-parse | 0.341ms | 5.50ms | 0.470ms | FAILED | js |
| mixed/text-search | 0.348ms | 3.18ms | 2.00ms | 0.940ms | js |
| mixed/fibonacci | 0.111ms | 0.178ms | 0.178ms | 0.176ms | js |
| mixed/matrix-multiply | 0.161ms | 49.22ms | 50.97ms | 0.602ms | js |
| mixed/sieve | 1.47ms | 2.05ms | 2.11ms | FAILED | js |

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
| string/concat-short | 10000 | 4.72 | 4.18 | 4.82 | — |
| string/concat-long | 1000 | 4.00 | 4.52 | 6.64 | — |
| string/indexOf | 1000 | 13.32 | 41.26 | 9.71 | 16.12 |
| string/includes | 1000 | 13.37 | 86.72 | 11.97 | 33.16 |
| string/split | 10000 | 29.64 | 509.21 | 194.61 | — |
| string/replace | 1000 | 69.90 | 421.40 | 244.57 | — |
| string/case-convert | 2000 | 22.81 | 186.75 | 89.95 | — |
| string/substring | 10000 | 13.22 | 3.02 | 2.62 | — |
| string/trim | 10000 | 25.77 | 258.64 | 199.80 | — |
| string/startsWith-endsWith | 20000 | 20.52 | 106.96 | 112.34 | 22.40 |
| array/map-filter | 30000 | 4.16 | 2.45 | 2.44 | — |
| array/indexOf | 1000 | 4445.12 | 2132.87 | 2132.21 | — |
| dom/create-elements | 2000 | 33.86 | 48.80 | — | — |
| dom/set-attributes | 6000 | 20.63 | 26.33 | — | — |
| dom/read-attributes | 3000 | 24.79 | 33.77 | — | — |
| dom/modify-text | 2000 | 30.31 | 47.71 | — | — |
| mixed/csv-parse | 11000 | 31.00 | 500.00 | 42.69 | — |
| mixed/text-search | 40000 | 8.69 | 79.40 | 50.11 | 23.49 |
| mixed/fibonacci | 10000 | 11.10 | 17.77 | 17.80 | 17.63 |
| mixed/matrix-multiply | 125000 | 1.29 | 393.76 | 407.75 | 4.82 |
| mixed/sieve | 200000 | 7.37 | 10.23 | 10.55 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.13x faster | 1.02x slower | — |
| string/concat-long | 1.13x slower | 1.66x slower | — |
| string/indexOf | 3.10x slower | 1.37x faster | 1.21x slower |
| string/includes | 6.49x slower | 1.12x faster | 2.48x slower |
| string/split | 17.18x slower | 6.57x slower | — |
| string/replace | 6.03x slower | 3.50x slower | — |
| string/case-convert | 8.19x slower | 3.94x slower | — |
| string/substring | 4.37x faster | 5.05x faster | — |
| string/trim | 10.03x slower | 7.75x slower | — |
| string/startsWith-endsWith | 5.21x slower | 5.47x slower | 1.09x slower |
| array/push-pop | 2.98x faster | 2.98x faster | — |
| array/sort-i32 | 1.94x faster | 1.94x faster | — |
| array/map-filter | 1.69x faster | 1.71x faster | — |
| array/reduce | 2.91x faster | 2.90x faster | — |
| array/indexOf | 2.08x faster | 2.08x faster | — |
| array/slice | 1.04x faster | 1.05x faster | — |
| array/reverse | 1.82x faster | 1.82x faster | — |
| array/forEach | 2.49x faster | 2.48x faster | — |
| array/find | 15.34x faster | 15.14x faster | 3.28x slower |
| dom/create-elements | 1.44x slower | — | — |
| dom/set-attributes | 1.28x slower | — | — |
| dom/read-attributes | 1.36x slower | — | — |
| dom/modify-text | 1.57x slower | — | — |
| mixed/csv-parse | 16.13x slower | 1.38x slower | — |
| mixed/text-search | 9.13x slower | 5.76x slower | 2.70x slower |
| mixed/fibonacci | 1.60x slower | 1.60x slower | 1.59x slower |
| mixed/matrix-multiply | 304.92x slower | 315.75x slower | 3.73x slower |
| mixed/sieve | 1.39x slower | 1.43x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.15x slower |
| string/concat-long | 1.47x slower |
| string/indexOf | 4.25x faster |
| string/includes | 7.24x faster |
| string/split | 2.62x faster |
| string/replace | 1.72x faster |
| string/case-convert | 2.08x faster |
| string/substring | 1.16x faster |
| string/trim | 1.29x faster |
| string/startsWith-endsWith | 1.05x slower |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.01x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 11.71x faster |
| mixed/text-search | 1.58x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.04x slower |
| mixed/sieve | 1.03x slower |

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
| string/concat-short | 973.1ms | 485.8ms | — |
| string/concat-long | 379.7ms | 558.9ms | — |
| string/indexOf | 334.7ms | 541.5ms | 440.9ms |
| string/includes | 327.3ms | 541.0ms | 456.0ms |
| string/split | 431.4ms | 555.1ms | — |
| string/replace | 412.7ms | 601.6ms | — |
| string/case-convert | 431.5ms | 483.2ms | — |
| string/substring | 335.3ms | 375.2ms | — |
| string/trim | 387.5ms | 561.1ms | — |
| string/startsWith-endsWith | 418.7ms | 577.4ms | 518.6ms |
| array/push-pop | 413.1ms | 467.0ms | — |
| array/sort-i32 | 543.9ms | 609.2ms | — |
| array/map-filter | 571.6ms | 631.6ms | — |
| array/reduce | 501.9ms | 568.3ms | — |
| array/indexOf | 492.0ms | 541.5ms | — |
| array/slice | 432.5ms | 507.4ms | — |
| array/reverse | 416.0ms | 437.2ms | — |
| array/forEach | 532.0ms | 573.2ms | — |
| array/find | 442.4ms | 508.4ms | 461.4ms |
| dom/create-elements | 373.8ms | — | — |
| dom/set-attributes | 340.6ms | — | — |
| dom/read-attributes | 349.3ms | — | — |
| dom/modify-text | 333.0ms | — | — |
| mixed/csv-parse | 446.9ms | 583.6ms | — |
| mixed/text-search | 423.0ms | 589.7ms | 519.9ms |
| mixed/fibonacci | 393.6ms | 401.4ms | 427.2ms |
| mixed/matrix-multiply | 526.3ms | 569.6ms | 424.0ms |
| mixed/sieve | 495.4ms | 568.5ms | — |
