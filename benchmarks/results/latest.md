# js2wasm Benchmark Results

Date: 2026-09-28
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.048ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.067ms | 0.012ms | 0.019ms | gc-native |
| string/includes | 0.019ms | 0.113ms | 0.015ms | 0.016ms | gc-native |
| string/split | 0.415ms | 8.39ms | 2.76ms | FAILED | js |
| string/replace | 0.105ms | 0.704ms | 0.329ms | FAILED | js |
| string/case-convert | 0.059ms | 0.652ms | 0.264ms | FAILED | js |
| string/substring | 0.098ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.95ms | 2.73ms | FAILED | js |
| string/startsWith-endsWith | 0.400ms | 2.93ms | 2.95ms | 0.562ms | js |
| array/push-pop | 1.43ms | 0.509ms | 0.505ms | FAILED | gc-native |
| array/sort-i32 | 0.791ms | 0.295ms | 0.299ms | FAILED | host-call |
| array/map-filter | 0.127ms | 0.070ms | 0.070ms | FAILED | host-call |
| array/reduce | 2.17ms | 0.510ms | 0.511ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.027ms | 0.028ms | 0.027ms | FAILED | js |
| array/reverse | 7.84ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.086ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.255ms | 0.016ms | 0.016ms | 1.07ms | host-call |
| dom/create-elements | 0.041ms | 0.105ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.232ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.137ms | — | — | js |
| dom/modify-text | 0.030ms | 0.111ms | — | — | js |
| mixed/csv-parse | 1.40ms | 8.83ms | 0.631ms | FAILED | gc-native |
| mixed/text-search | 0.388ms | 4.98ms | 2.92ms | 1.08ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 1.32ms | js |
| mixed/matrix-multiply | 0.158ms | 74.34ms | 82.74ms | 0.720ms | js |
| mixed/sieve | 1.64ms | 2.12ms | 2.11ms | FAILED | js |

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
| string/concat-short | 10000 | 3.38 | 4.83 | 4.44 | — |
| string/concat-long | 1000 | 3.58 | 4.54 | 3.74 | — |
| string/indexOf | 1000 | 19.25 | 66.91 | 12.31 | 19.44 |
| string/includes | 1000 | 19.27 | 112.75 | 14.83 | 16.31 |
| string/split | 10000 | 41.48 | 839.12 | 276.04 | — |
| string/replace | 1000 | 105.04 | 703.77 | 329.37 | — |
| string/case-convert | 2000 | 29.57 | 325.84 | 131.99 | — |
| string/substring | 10000 | 9.84 | 3.74 | 3.08 | — |
| string/trim | 10000 | 17.00 | 394.69 | 273.35 | — |
| string/startsWith-endsWith | 20000 | 20.02 | 146.42 | 147.39 | 28.11 |
| array/map-filter | 30000 | 4.23 | 2.33 | 2.34 | — |
| array/indexOf | 1000 | 3948.19 | 2641.31 | 2638.61 | — |
| dom/create-elements | 2000 | 20.29 | 52.49 | — | — |
| dom/set-attributes | 6000 | 17.50 | 38.67 | — | — |
| dom/read-attributes | 3000 | 18.51 | 45.82 | — | — |
| dom/modify-text | 2000 | 14.77 | 55.72 | — | — |
| mixed/csv-parse | 11000 | 127.71 | 802.73 | 57.37 | — |
| mixed/text-search | 40000 | 9.70 | 124.61 | 73.01 | 27.00 |
| mixed/fibonacci | 10000 | 12.02 | 28.31 | 28.32 | 131.80 |
| mixed/matrix-multiply | 125000 | 1.26 | 594.70 | 661.88 | 5.76 |
| mixed/sieve | 200000 | 8.21 | 10.61 | 10.56 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.43x slower | 1.31x slower | — |
| string/concat-long | 1.27x slower | 1.04x slower | — |
| string/indexOf | 3.48x slower | 1.56x faster | 1.01x slower |
| string/includes | 5.85x slower | 1.30x faster | 1.18x faster |
| string/split | 20.23x slower | 6.66x slower | — |
| string/replace | 6.70x slower | 3.14x slower | — |
| string/case-convert | 11.02x slower | 4.46x slower | — |
| string/substring | 2.63x faster | 3.20x faster | — |
| string/trim | 23.22x slower | 16.08x slower | — |
| string/startsWith-endsWith | 7.31x slower | 7.36x slower | 1.40x slower |
| array/push-pop | 2.81x faster | 2.83x faster | — |
| array/sort-i32 | 2.68x faster | 2.65x faster | — |
| array/map-filter | 1.82x faster | 1.81x faster | — |
| array/reduce | 4.25x faster | 4.24x faster | — |
| array/indexOf | 1.49x faster | 1.50x faster | — |
| array/slice | 1.06x slower | 1.03x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 3.09x faster | 3.10x faster | — |
| array/find | 15.96x faster | 15.93x faster | 4.22x slower |
| dom/create-elements | 2.59x slower | — | — |
| dom/set-attributes | 2.21x slower | — | — |
| dom/read-attributes | 2.48x slower | — | — |
| dom/modify-text | 3.77x slower | — | — |
| mixed/csv-parse | 6.29x slower | 2.23x faster | — |
| mixed/text-search | 12.84x slower | 7.52x slower | 2.78x slower |
| mixed/fibonacci | 2.36x slower | 2.36x slower | 10.96x slower |
| mixed/matrix-multiply | 470.40x slower | 523.55x slower | 4.55x slower |
| mixed/sieve | 1.29x slower | 1.29x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.09x faster |
| string/concat-long | 1.21x faster |
| string/indexOf | 5.43x faster |
| string/includes | 7.60x faster |
| string/split | 3.04x faster |
| string/replace | 2.14x faster |
| string/case-convert | 2.47x faster |
| string/substring | 1.21x faster |
| string/trim | 1.44x faster |
| string/startsWith-endsWith | 1.01x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.02x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 13.99x faster |
| mixed/text-search | 1.71x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.11x slower |
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
| string/concat-short | 1194.0ms | 628.9ms | — |
| string/concat-long | 438.1ms | 656.7ms | — |
| string/indexOf | 358.9ms | 681.6ms | 557.4ms |
| string/includes | 363.5ms | 658.9ms | 552.7ms |
| string/split | 504.6ms | 691.5ms | — |
| string/replace | 513.2ms | 771.3ms | — |
| string/case-convert | 559.8ms | 647.7ms | — |
| string/substring | 395.3ms | 459.6ms | — |
| string/trim | 507.0ms | 679.0ms | — |
| string/startsWith-endsWith | 496.6ms | 727.3ms | 632.2ms |
| array/push-pop | 506.5ms | 596.0ms | — |
| array/sort-i32 | 686.1ms | 763.0ms | — |
| array/map-filter | 654.9ms | 774.1ms | — |
| array/reduce | 609.1ms | 700.2ms | — |
| array/indexOf | 587.6ms | 679.2ms | — |
| array/slice | 542.5ms | 614.9ms | — |
| array/reverse | 496.2ms | 594.7ms | — |
| array/forEach | 645.9ms | 733.2ms | — |
| array/find | 504.4ms | 575.0ms | 549.7ms |
| dom/create-elements | 428.8ms | — | — |
| dom/set-attributes | 389.7ms | — | — |
| dom/read-attributes | 382.6ms | — | — |
| dom/modify-text | 372.2ms | — | — |
| mixed/csv-parse | 528.1ms | 678.8ms | — |
| mixed/text-search | 519.3ms | 715.4ms | 638.5ms |
| mixed/fibonacci | 462.7ms | 482.6ms | 461.7ms |
| mixed/matrix-multiply | 656.1ms | 729.1ms | 534.5ms |
| mixed/sieve | 625.6ms | 679.6ms | — |
