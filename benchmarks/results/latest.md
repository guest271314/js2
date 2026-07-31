# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.044ms | 0.044ms | 0.042ms | FAILED | gc-native |
| string/concat-long | 0.005ms | 0.004ms | 0.005ms | FAILED | host-call |
| string/indexOf | 0.002ms | 0.038ms | 0.010ms | FAILED | js |
| string/includes | 0.002ms | 0.073ms | 0.010ms | FAILED | js |
| string/split | 0.257ms | 3.04ms | 0.766ms | FAILED | js |
| string/replace | 0.031ms | 0.122ms | 0.044ms | FAILED | js |
| string/case-convert | <0.001ms | 0.137ms | 0.055ms | FAILED | js |
| string/substring | 0.002ms | 0.582ms | 0.054ms | FAILED | js |
| string/trim | 0.115ms | 0.638ms | 0.127ms | FAILED | js |
| string/startsWith-endsWith | 0.181ms | 1.32ms | 0.144ms | FAILED | gc-native |
| array/push-pop | 1.28ms | 1.43ms | 0.683ms | FAILED | gc-native |
| array/sort-i32 | 0.529ms | 0.266ms | 0.229ms | FAILED | gc-native |
| array/map-filter | 0.118ms | 0.441ms | 0.045ms | FAILED | gc-native |
| array/reduce | 1.84ms | 1.50ms | 0.691ms | FAILED | gc-native |
| array/indexOf | 4.02ms | 3.34ms | 2.19ms | FAILED | gc-native |
| array/slice | 0.047ms | 0.045ms | 0.023ms | FAILED | gc-native |
| array/reverse | 5.21ms | 2.83ms | 2.60ms | FAILED | gc-native |
| array/forEach | 0.054ms | 0.054ms | 0.029ms | FAILED | gc-native |
| array/find | 0.230ms | 0.386ms | 0.230ms | 3.10ms | gc-native |
| dom/create-elements | 0.064ms | 0.189ms | — | — | js |
| dom/set-attributes | 0.114ms | 0.232ms | — | — | js |
| dom/read-attributes | 0.078ms | 0.121ms | — | — | js |
| dom/modify-text | 0.075ms | 0.119ms | — | — | js |
| mixed/csv-parse | 0.353ms | 4.29ms | 0.651ms | FAILED | js |
| mixed/text-search | 0.074ms | 2.99ms | 0.449ms | FAILED | js |
| mixed/fibonacci | 0.094ms | 0.114ms | 0.061ms | 0.110ms | gc-native |
| mixed/matrix-multiply | 0.147ms | 1.38ms | 0.148ms | 1.27ms | js |
| mixed/sieve | 1.34ms | 1.88ms | 0.872ms | FAILED | gc-native |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/includes | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/split | linear-memory | warmup | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/startsWith-endsWith | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/text-search | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.01x slower | 1.03x faster | — |
| string/concat-long | 1.24x faster | 1.04x faster | — |
| string/indexOf | 24.86x slower | 6.41x slower | — |
| string/includes | 45.06x slower | 6.12x slower | — |
| string/split | 11.86x slower | 2.98x slower | — |
| string/replace | 3.89x slower | 1.41x slower | — |
| string/case-convert | 537.11x slower | 214.62x slower | — |
| string/substring | 233.67x slower | 21.67x slower | — |
| string/trim | 5.53x slower | 1.10x slower | — |
| string/startsWith-endsWith | 7.30x slower | 1.26x faster | — |
| array/push-pop | 1.12x slower | 1.88x faster | — |
| array/sort-i32 | 1.99x faster | 2.31x faster | — |
| array/map-filter | 3.73x slower | 2.65x faster | — |
| array/reduce | 1.22x faster | 2.66x faster | — |
| array/indexOf | 1.20x faster | 1.84x faster | — |
| array/slice | 1.05x faster | 2.04x faster | — |
| array/reverse | 1.84x faster | 2.00x faster | — |
| array/forEach | 1.01x slower | 1.83x faster | — |
| array/find | 1.68x slower | 1.00x faster | 13.48x slower |
| dom/create-elements | 2.94x slower | — | — |
| dom/set-attributes | 2.03x slower | — | — |
| dom/read-attributes | 1.54x slower | — | — |
| dom/modify-text | 1.58x slower | — | — |
| mixed/csv-parse | 12.17x slower | 1.85x slower | — |
| mixed/text-search | 40.23x slower | 6.03x slower | — |
| mixed/fibonacci | 1.21x slower | 1.55x faster | 1.17x slower |
| mixed/matrix-multiply | 9.35x slower | 1.00x slower | 8.64x slower |
| mixed/sieve | 1.40x slower | 1.54x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.04x faster |
| string/concat-long | 1.18x slower |
| string/indexOf | 3.88x faster |
| string/includes | 7.36x faster |
| string/split | 3.98x faster |
| string/replace | 2.75x faster |
| string/case-convert | 2.50x faster |
| string/substring | 10.78x faster |
| string/trim | 5.04x faster |
| string/startsWith-endsWith | 9.22x faster |
| array/push-pop | 2.10x faster |
| array/sort-i32 | 1.16x faster |
| array/map-filter | 9.90x faster |
| array/reduce | 2.18x faster |
| array/indexOf | 1.53x faster |
| array/slice | 1.95x faster |
| array/reverse | 1.09x faster |
| array/forEach | 1.84x faster |
| array/find | 1.68x faster |
| mixed/csv-parse | 6.59x faster |
| mixed/text-search | 6.67x faster |
| mixed/fibonacci | 1.88x faster |
| mixed/matrix-multiply | 9.31x faster |
| mixed/sieve | 2.16x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 1.7KB | — |
| string/concat-long | 236B | 1.9KB | — |
| string/indexOf | 216B | 2.1KB | — |
| string/includes | 236B | 2.1KB | — |
| string/split | 973B | 1.5KB | — |
| string/replace | 289B | 2.7KB | — |
| string/case-convert | 249B | 11.7KB | — |
| string/substring | 239B | 1.3KB | — |
| string/trim | 205B | 1.7KB | — |
| string/startsWith-endsWith | 330B | 1.6KB | — |
| array/push-pop | 947B | 1.4KB | — |
| array/sort-i32 | 2.7KB | 3.1KB | — |
| array/map-filter | 3.3KB | 3.3KB | — |
| array/reduce | 2.3KB | 2.8KB | — |
| array/indexOf | 1022B | 1.5KB | — |
| array/slice | 1.0KB | 1.5KB | — |
| array/reverse | 1.0KB | 1.5KB | — |
| array/forEach | 2.6KB | 3.1KB | — |
| array/find | 2.7KB | 3.2KB | 623B |
| dom/create-elements | 243B | — | — |
| dom/set-attributes | 510B | — | — |
| dom/read-attributes | 358B | — | — |
| dom/modify-text | 250B | — | — |
| mixed/csv-parse | 1.4KB | 2.9KB | — |
| mixed/text-search | 600B | 2.1KB | — |
| mixed/fibonacci | 157B | 1.1KB | 173B |
| mixed/matrix-multiply | 1.3KB | 1.8KB | 950B |
| mixed/sieve | 1.5KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 895.0ms | 831.0ms | — |
| string/concat-long | 473.6ms | 738.1ms | — |
| string/indexOf | 429.5ms | 729.3ms | — |
| string/includes | 425.8ms | 757.2ms | — |
| string/split | 558.1ms | 718.3ms | — |
| string/replace | 429.2ms | 755.6ms | — |
| string/case-convert | 449.8ms | 854.1ms | — |
| string/substring | 441.1ms | 650.5ms | — |
| string/trim | 436.5ms | 729.2ms | — |
| string/startsWith-endsWith | 489.9ms | 720.6ms | — |
| array/push-pop | 566.9ms | 638.6ms | — |
| array/sort-i32 | 713.9ms | 701.6ms | — |
| array/map-filter | 738.6ms | 784.3ms | — |
| array/reduce | 674.0ms | 694.2ms | — |
| array/indexOf | 612.0ms | 688.5ms | — |
| array/slice | 598.3ms | 658.7ms | — |
| array/reverse | 607.2ms | 712.2ms | — |
| array/forEach | 678.3ms | 739.1ms | — |
| array/find | 661.6ms | 700.1ms | 635.2ms |
| dom/create-elements | 457.4ms | — | — |
| dom/set-attributes | 541.8ms | — | — |
| dom/read-attributes | 536.1ms | — | — |
| dom/modify-text | 522.2ms | — | — |
| mixed/csv-parse | 602.8ms | 758.4ms | — |
| mixed/text-search | 552.2ms | 781.3ms | — |
| mixed/fibonacci | 507.7ms | 647.4ms | 548.2ms |
| mixed/matrix-multiply | 583.7ms | 656.7ms | 607.6ms |
| mixed/sieve | 609.7ms | 646.2ms | — |
