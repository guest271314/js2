# js2wasm Benchmark Results

Date: 2026-09-28
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.029ms | 0.040ms | 0.038ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.047ms | 0.010ms | 0.020ms | gc-native |
| string/includes | 0.015ms | 0.082ms | 0.011ms | 0.020ms | gc-native |
| string/split | 0.327ms | 6.32ms | 2.14ms | FAILED | js |
| string/replace | 0.075ms | 0.469ms | 0.225ms | FAILED | js |
| string/case-convert | 0.045ms | 0.439ms | 0.196ms | FAILED | js |
| string/substring | 0.081ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.134ms | 2.72ms | 2.00ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 2.03ms | 2.15ms | 0.429ms | js |
| array/push-pop | 1.35ms | 0.480ms | 0.480ms | FAILED | host-call |
| array/sort-i32 | 0.657ms | 0.230ms | 0.241ms | FAILED | host-call |
| array/map-filter | 0.109ms | 0.053ms | 0.053ms | FAILED | gc-native |
| array/reduce | 1.89ms | 0.475ms | 0.474ms | FAILED | gc-native |
| array/indexOf | 3.46ms | 2.22ms | 2.22ms | FAILED | gc-native |
| array/slice | 0.032ms | 0.014ms | 0.015ms | FAILED | host-call |
| array/reverse | 6.86ms | 3.08ms | 3.08ms | FAILED | gc-native |
| array/forEach | 0.043ms | 0.023ms | 0.023ms | FAILED | gc-native |
| array/find | 0.213ms | 0.012ms | 0.013ms | 0.940ms | host-call |
| dom/create-elements | 0.031ms | 0.119ms | — | — | js |
| dom/set-attributes | 0.086ms | 0.187ms | — | — | js |
| dom/read-attributes | 0.051ms | 0.109ms | — | — | js |
| dom/modify-text | 0.023ms | 0.088ms | — | — | js |
| mixed/csv-parse | 0.366ms | 6.26ms | 0.435ms | FAILED | js |
| mixed/text-search | 0.312ms | 3.54ms | 2.02ms | 0.873ms | js |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 0.252ms | js |
| mixed/matrix-multiply | 0.147ms | 53.90ms | 57.26ms | 0.564ms | js |
| mixed/sieve | 1.39ms | 1.83ms | 1.83ms | FAILED | js |

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
| string/concat-short | 10000 | 2.87 | 4.00 | 3.80 | — |
| string/concat-long | 1000 | 3.36 | 4.20 | 2.94 | — |
| string/indexOf | 1000 | 14.80 | 47.23 | 9.83 | 19.55 |
| string/includes | 1000 | 14.58 | 81.54 | 11.02 | 20.26 |
| string/split | 10000 | 32.71 | 631.55 | 213.58 | — |
| string/replace | 1000 | 74.56 | 469.49 | 224.88 | — |
| string/case-convert | 2000 | 22.50 | 219.59 | 98.19 | — |
| string/substring | 10000 | 8.08 | 3.09 | 2.67 | — |
| string/trim | 10000 | 13.43 | 271.67 | 200.02 | — |
| string/startsWith-endsWith | 20000 | 15.99 | 101.45 | 107.48 | 21.43 |
| array/map-filter | 30000 | 3.62 | 1.76 | 1.76 | — |
| array/indexOf | 1000 | 3459.29 | 2221.44 | 2219.15 | — |
| dom/create-elements | 2000 | 15.47 | 59.40 | — | — |
| dom/set-attributes | 6000 | 14.28 | 31.15 | — | — |
| dom/read-attributes | 3000 | 17.10 | 36.35 | — | — |
| dom/modify-text | 2000 | 11.71 | 43.76 | — | — |
| mixed/csv-parse | 11000 | 33.30 | 569.30 | 39.50 | — |
| mixed/text-search | 40000 | 7.81 | 88.60 | 50.39 | 21.82 |
| mixed/fibonacci | 10000 | 9.71 | 25.41 | 25.41 | 25.23 |
| mixed/matrix-multiply | 125000 | 1.17 | 431.16 | 458.07 | 4.52 |
| mixed/sieve | 200000 | 6.96 | 9.17 | 9.14 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.39x slower | 1.32x slower | — |
| string/concat-long | 1.25x slower | 1.15x faster | — |
| string/indexOf | 3.19x slower | 1.51x faster | 1.32x slower |
| string/includes | 5.59x slower | 1.32x faster | 1.39x slower |
| string/split | 19.31x slower | 6.53x slower | — |
| string/replace | 6.30x slower | 3.02x slower | — |
| string/case-convert | 9.76x slower | 4.36x slower | — |
| string/substring | 2.62x faster | 3.03x faster | — |
| string/trim | 20.23x slower | 14.89x slower | — |
| string/startsWith-endsWith | 6.34x slower | 6.72x slower | 1.34x slower |
| array/push-pop | 2.82x faster | 2.81x faster | — |
| array/sort-i32 | 2.86x faster | 2.73x faster | — |
| array/map-filter | 2.06x faster | 2.06x faster | — |
| array/reduce | 3.97x faster | 3.98x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.31x faster | 2.15x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.90x faster | 1.91x faster | — |
| array/find | 17.70x faster | 16.68x faster | 4.41x slower |
| dom/create-elements | 3.84x slower | — | — |
| dom/set-attributes | 2.18x slower | — | — |
| dom/read-attributes | 2.13x slower | — | — |
| dom/modify-text | 3.74x slower | — | — |
| mixed/csv-parse | 17.10x slower | 1.19x slower | — |
| mixed/text-search | 11.35x slower | 6.45x slower | 2.79x slower |
| mixed/fibonacci | 2.62x slower | 2.62x slower | 2.60x slower |
| mixed/matrix-multiply | 367.19x slower | 390.11x slower | 3.85x slower |
| mixed/sieve | 1.32x slower | 1.31x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.05x faster |
| string/concat-long | 1.43x faster |
| string/indexOf | 4.81x faster |
| string/includes | 7.40x faster |
| string/split | 2.96x faster |
| string/replace | 2.09x faster |
| string/case-convert | 2.24x faster |
| string/substring | 1.16x faster |
| string/trim | 1.36x faster |
| string/startsWith-endsWith | 1.06x slower |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.05x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.07x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.06x slower |
| mixed/csv-parse | 14.41x faster |
| mixed/text-search | 1.76x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.06x slower |
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
| string/concat-short | 867.7ms | 477.1ms | — |
| string/concat-long | 341.8ms | 511.1ms | — |
| string/indexOf | 290.9ms | 520.0ms | 428.8ms |
| string/includes | 297.0ms | 507.6ms | 427.6ms |
| string/split | 391.1ms | 540.1ms | — |
| string/replace | 389.7ms | 599.3ms | — |
| string/case-convert | 406.1ms | 474.1ms | — |
| string/substring | 296.2ms | 395.0ms | — |
| string/trim | 371.3ms | 554.2ms | — |
| string/startsWith-endsWith | 385.3ms | 887.7ms | 473.7ms |
| array/push-pop | 414.0ms | 476.5ms | — |
| array/sort-i32 | 525.2ms | 588.9ms | — |
| array/map-filter | 514.3ms | 596.7ms | — |
| array/reduce | 467.6ms | 533.1ms | — |
| array/indexOf | 456.4ms | 511.0ms | — |
| array/slice | 396.0ms | 472.3ms | — |
| array/reverse | 395.4ms | 476.4ms | — |
| array/forEach | 519.4ms | 554.5ms | — |
| array/find | 401.5ms | 464.6ms | 415.5ms |
| dom/create-elements | 350.9ms | — | — |
| dom/set-attributes | 304.8ms | — | — |
| dom/read-attributes | 320.1ms | — | — |
| dom/modify-text | 302.5ms | — | — |
| mixed/csv-parse | 410.1ms | 527.5ms | — |
| mixed/text-search | 401.8ms | 561.6ms | 479.3ms |
| mixed/fibonacci | 374.2ms | 404.2ms | 368.4ms |
| mixed/matrix-multiply | 495.3ms | 561.2ms | 418.3ms |
| mixed/sieve | 495.9ms | 535.7ms | — |
