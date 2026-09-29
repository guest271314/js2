# js2wasm Benchmark Results

Date: 2026-09-29
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.024ms | 0.040ms | 0.038ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.047ms | 0.010ms | 0.031ms | gc-native |
| string/includes | 0.015ms | 0.082ms | 0.011ms | 0.013ms | gc-native |
| string/split | 0.326ms | 6.19ms | 2.09ms | FAILED | js |
| string/replace | 0.075ms | 0.472ms | 0.219ms | FAILED | js |
| string/case-convert | 0.045ms | 0.438ms | 0.186ms | FAILED | js |
| string/substring | 0.081ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.134ms | 2.75ms | 1.87ms | FAILED | js |
| string/startsWith-endsWith | 0.318ms | 1.98ms | 2.05ms | 0.434ms | js |
| array/push-pop | 1.31ms | 0.476ms | 0.468ms | FAILED | gc-native |
| array/sort-i32 | 0.661ms | 0.236ms | 0.234ms | FAILED | gc-native |
| array/map-filter | 0.112ms | 0.053ms | 0.053ms | FAILED | host-call |
| array/reduce | 1.89ms | 0.470ms | 0.478ms | FAILED | host-call |
| array/indexOf | 3.46ms | 2.22ms | 2.22ms | FAILED | gc-native |
| array/slice | 0.031ms | 0.014ms | 0.014ms | FAILED | gc-native |
| array/reverse | 6.86ms | 3.08ms | 3.08ms | FAILED | gc-native |
| array/forEach | 0.045ms | 0.023ms | 0.023ms | FAILED | gc-native |
| array/find | 0.214ms | 0.012ms | 0.012ms | 0.936ms | host-call |
| dom/create-elements | 0.030ms | 0.081ms | — | — | js |
| dom/set-attributes | 0.085ms | 0.182ms | — | — | js |
| dom/read-attributes | 0.049ms | 0.108ms | — | — | js |
| dom/modify-text | 0.023ms | 0.088ms | — | — | js |
| mixed/csv-parse | 0.364ms | 6.32ms | 0.441ms | FAILED | js |
| mixed/text-search | 0.315ms | 3.26ms | 2.00ms | 0.879ms | js |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 0.252ms | js |
| mixed/matrix-multiply | 0.147ms | 52.99ms | 57.26ms | 0.562ms | js |
| mixed/sieve | 1.41ms | 1.79ms | 1.80ms | FAILED | js |

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
| string/concat-short | 10000 | 2.36 | 3.97 | 3.81 | — |
| string/concat-long | 1000 | 3.32 | 4.26 | 2.98 | — |
| string/indexOf | 1000 | 14.76 | 46.62 | 9.80 | 31.49 |
| string/includes | 1000 | 14.54 | 82.13 | 11.14 | 13.43 |
| string/split | 10000 | 32.59 | 618.67 | 208.65 | — |
| string/replace | 1000 | 75.33 | 471.59 | 219.11 | — |
| string/case-convert | 2000 | 22.48 | 219.17 | 92.88 | — |
| string/substring | 10000 | 8.08 | 3.09 | 2.67 | — |
| string/trim | 10000 | 13.41 | 275.26 | 186.52 | — |
| string/startsWith-endsWith | 20000 | 15.92 | 98.80 | 102.26 | 21.72 |
| array/map-filter | 30000 | 3.73 | 1.75 | 1.77 | — |
| array/indexOf | 1000 | 3462.24 | 2220.61 | 2219.66 | — |
| dom/create-elements | 2000 | 14.92 | 40.36 | — | — |
| dom/set-attributes | 6000 | 14.24 | 30.32 | — | — |
| dom/read-attributes | 3000 | 16.27 | 35.98 | — | — |
| dom/modify-text | 2000 | 11.44 | 43.85 | — | — |
| mixed/csv-parse | 11000 | 33.09 | 574.36 | 40.06 | — |
| mixed/text-search | 40000 | 7.87 | 81.42 | 50.03 | 21.97 |
| mixed/fibonacci | 10000 | 9.72 | 25.40 | 25.39 | 25.25 |
| mixed/matrix-multiply | 125000 | 1.17 | 423.95 | 458.08 | 4.49 |
| mixed/sieve | 200000 | 7.03 | 8.94 | 9.02 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.68x slower | 1.61x slower | — |
| string/concat-long | 1.28x slower | 1.11x faster | — |
| string/indexOf | 3.16x slower | 1.51x faster | 2.13x slower |
| string/includes | 5.65x slower | 1.31x faster | 1.08x faster |
| string/split | 18.98x slower | 6.40x slower | — |
| string/replace | 6.26x slower | 2.91x slower | — |
| string/case-convert | 9.75x slower | 4.13x slower | — |
| string/substring | 2.61x faster | 3.03x faster | — |
| string/trim | 20.53x slower | 13.91x slower | — |
| string/startsWith-endsWith | 6.20x slower | 6.42x slower | 1.36x slower |
| array/push-pop | 2.76x faster | 2.80x faster | — |
| array/sort-i32 | 2.79x faster | 2.83x faster | — |
| array/map-filter | 2.13x faster | 2.11x faster | — |
| array/reduce | 4.02x faster | 3.96x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.22x faster | 2.24x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.96x faster | 1.98x faster | — |
| array/find | 17.77x faster | 17.73x faster | 4.39x slower |
| dom/create-elements | 2.70x slower | — | — |
| dom/set-attributes | 2.13x slower | — | — |
| dom/read-attributes | 2.21x slower | — | — |
| dom/modify-text | 3.83x slower | — | — |
| mixed/csv-parse | 17.36x slower | 1.21x slower | — |
| mixed/text-search | 10.34x slower | 6.35x slower | 2.79x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.60x slower |
| mixed/matrix-multiply | 360.84x slower | 389.88x slower | 3.83x slower |
| mixed/sieve | 1.27x slower | 1.28x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.04x faster |
| string/concat-long | 1.43x faster |
| string/indexOf | 4.76x faster |
| string/includes | 7.37x faster |
| string/split | 2.97x faster |
| string/replace | 2.15x faster |
| string/case-convert | 2.36x faster |
| string/substring | 1.16x faster |
| string/trim | 1.48x faster |
| string/startsWith-endsWith | 1.04x slower |
| array/push-pop | 1.02x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.01x slower |
| array/reduce | 1.02x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 14.34x faster |
| mixed/text-search | 1.63x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.08x slower |
| mixed/sieve | 1.01x slower |

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
| string/concat-short | 875.1ms | 485.3ms | — |
| string/concat-long | 348.8ms | 510.4ms | — |
| string/indexOf | 301.1ms | 510.7ms | 414.4ms |
| string/includes | 285.6ms | 532.9ms | 422.5ms |
| string/split | 395.3ms | 537.0ms | — |
| string/replace | 400.7ms | 583.8ms | — |
| string/case-convert | 416.5ms | 479.1ms | — |
| string/substring | 312.4ms | 386.1ms | — |
| string/trim | 367.4ms | 527.4ms | — |
| string/startsWith-endsWith | 390.4ms | 545.7ms | 478.3ms |
| array/push-pop | 396.1ms | 461.3ms | — |
| array/sort-i32 | 500.7ms | 576.9ms | — |
| array/map-filter | 502.2ms | 569.3ms | — |
| array/reduce | 483.1ms | 529.5ms | — |
| array/indexOf | 467.7ms | 505.2ms | — |
| array/slice | 413.0ms | 454.4ms | — |
| array/reverse | 379.5ms | 449.4ms | — |
| array/forEach | 482.4ms | 560.1ms | — |
| array/find | 393.8ms | 453.1ms | 416.8ms |
| dom/create-elements | 327.4ms | — | — |
| dom/set-attributes | 316.5ms | — | — |
| dom/read-attributes | 305.2ms | — | — |
| dom/modify-text | 297.0ms | — | — |
| mixed/csv-parse | 405.5ms | 530.6ms | — |
| mixed/text-search | 395.8ms | 528.0ms | 470.1ms |
| mixed/fibonacci | 346.0ms | 387.6ms | 361.9ms |
| mixed/matrix-multiply | 500.3ms | 529.7ms | 419.3ms |
| mixed/sieve | 484.8ms | 508.7ms | — |
