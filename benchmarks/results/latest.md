# js2wasm Benchmark Results

Date: 2026-08-01
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.045ms | 0.037ms | FAILED | js |
| string/concat-long | 0.004ms | 0.007ms | 0.008ms | FAILED | js |
| string/indexOf | 0.001ms | 0.062ms | 0.015ms | FAILED | js |
| string/includes | 0.001ms | 0.128ms | 0.016ms | FAILED | js |
| string/split | 0.401ms | 5.46ms | 0.886ms | FAILED | js |
| string/replace | 0.042ms | 0.251ms | 0.041ms | FAILED | gc-native |
| string/case-convert | <0.001ms | 0.217ms | 0.066ms | FAILED | js |
| string/substring | 0.003ms | 1.05ms | 0.023ms | FAILED | js |
| string/trim | 0.151ms | 0.932ms | 0.165ms | FAILED | js |
| string/startsWith-endsWith | 0.246ms | 2.68ms | 0.190ms | FAILED | gc-native |
| array/push-pop | 1.43ms | 2.16ms | 2.15ms | FAILED | js |
| array/sort-i32 | 0.789ms | 0.391ms | 0.391ms | FAILED | host-call |
| array/map-filter | 0.128ms | 0.641ms | 0.640ms | FAILED | js |
| array/reduce | 1.33ms | 2.15ms | 2.17ms | FAILED | js |
| array/indexOf | 3.95ms | 3.42ms | 3.42ms | FAILED | host-call |
| array/slice | 0.024ms | 0.033ms | 0.033ms | FAILED | js |
| array/reverse | 7.84ms | 3.43ms | 3.43ms | FAILED | gc-native |
| array/forEach | 0.048ms | 0.114ms | 0.114ms | FAILED | js |
| array/find | 0.238ms | 0.458ms | 0.457ms | 4.84ms | js |
| dom/create-elements | 0.034ms | 0.283ms | — | — | js |
| dom/set-attributes | 0.102ms | 0.386ms | — | — | js |
| dom/read-attributes | 0.054ms | 0.178ms | — | — | js |
| dom/modify-text | 0.043ms | 0.159ms | — | — | js |
| mixed/csv-parse | 0.453ms | 7.49ms | 0.726ms | FAILED | js |
| mixed/text-search | 0.215ms | 5.59ms | 0.664ms | FAILED | js |
| mixed/fibonacci | 0.109ms | 0.245ms | 0.246ms | 0.243ms | js |
| mixed/matrix-multiply | 0.156ms | 0.555ms | 0.551ms | 2.12ms | js |
| mixed/sieve | 1.53ms | 1.39ms | 1.38ms | FAILED | gc-native |

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
| string/concat-short | 1.46x slower | 1.20x slower | — |
| string/concat-long | 2.10x slower | 2.31x slower | — |
| string/indexOf | 50.19x slower | 12.11x slower | — |
| string/includes | 91.38x slower | 11.19x slower | — |
| string/split | 13.59x slower | 2.21x slower | — |
| string/replace | 6.00x slower | 1.03x faster | — |
| string/case-convert | 674.34x slower | 204.52x slower | — |
| string/substring | 336.16x slower | 7.36x slower | — |
| string/trim | 6.18x slower | 1.09x slower | — |
| string/startsWith-endsWith | 10.90x slower | 1.30x faster | — |
| array/push-pop | 1.51x slower | 1.51x slower | — |
| array/sort-i32 | 2.02x faster | 2.01x faster | — |
| array/map-filter | 5.02x slower | 5.01x slower | — |
| array/reduce | 1.62x slower | 1.63x slower | — |
| array/indexOf | 1.15x faster | 1.15x faster | — |
| array/slice | 1.42x slower | 1.42x slower | — |
| array/reverse | 2.28x faster | 2.28x faster | — |
| array/forEach | 2.40x slower | 2.40x slower | — |
| array/find | 1.93x slower | 1.92x slower | 20.35x slower |
| dom/create-elements | 8.24x slower | — | — |
| dom/set-attributes | 3.79x slower | — | — |
| dom/read-attributes | 3.28x slower | — | — |
| dom/modify-text | 3.68x slower | — | — |
| mixed/csv-parse | 16.52x slower | 1.60x slower | — |
| mixed/text-search | 25.97x slower | 3.08x slower | — |
| mixed/fibonacci | 2.24x slower | 2.25x slower | 2.23x slower |
| mixed/matrix-multiply | 3.55x slower | 3.52x slower | 13.59x slower |
| mixed/sieve | 1.10x faster | 1.11x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.21x faster |
| string/concat-long | 1.10x slower |
| string/indexOf | 4.14x faster |
| string/includes | 8.17x faster |
| string/split | 6.16x faster |
| string/replace | 6.15x faster |
| string/case-convert | 3.30x faster |
| string/substring | 45.68x faster |
| string/trim | 5.65x faster |
| string/startsWith-endsWith | 14.14x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.00x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 10.31x faster |
| mixed/text-search | 8.42x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.01x faster |
| mixed/sieve | 1.01x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 1.7KB | — |
| string/concat-long | 233B | 1.9KB | — |
| string/indexOf | 215B | 2.1KB | — |
| string/includes | 235B | 2.1KB | — |
| string/split | 973B | 1.6KB | — |
| string/replace | 276B | 2.5KB | — |
| string/case-convert | 236B | 11.7KB | — |
| string/substring | 227B | 1.3KB | — |
| string/trim | 193B | 1.7KB | — |
| string/startsWith-endsWith | 320B | 1.6KB | — |
| array/push-pop | 956B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
| array/map-filter | 3.3KB | 3.6KB | — |
| array/reduce | 2.3KB | 2.6KB | — |
| array/indexOf | 1.0KB | 1.3KB | — |
| array/slice | 1.0KB | 1.3KB | — |
| array/reverse | 1020B | 1.3KB | — |
| array/forEach | 2.6KB | 2.9KB | — |
| array/find | 2.7KB | 3.0KB | 623B |
| dom/create-elements | 240B | — | — |
| dom/set-attributes | 507B | — | — |
| dom/read-attributes | 357B | — | — |
| dom/modify-text | 247B | — | — |
| mixed/csv-parse | 1.4KB | 2.9KB | — |
| mixed/text-search | 590B | 2.2KB | — |
| mixed/fibonacci | 134B | 1.1KB | 150B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 950B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1289.8ms | 1171.9ms | — |
| string/concat-long | 610.0ms | 1024.5ms | — |
| string/indexOf | 555.2ms | 1000.8ms | — |
| string/includes | 612.9ms | 1005.6ms | — |
| string/split | 712.0ms | 947.0ms | — |
| string/replace | 538.3ms | 1013.4ms | — |
| string/case-convert | 539.1ms | 1057.7ms | — |
| string/substring | 539.7ms | 881.7ms | — |
| string/trim | 538.5ms | 964.1ms | — |
| string/startsWith-endsWith | 611.5ms | 940.5ms | — |
| array/push-pop | 750.6ms | 817.5ms | — |
| array/sort-i32 | 914.3ms | 946.4ms | — |
| array/map-filter | 895.0ms | 964.4ms | — |
| array/reduce | 872.2ms | 897.7ms | — |
| array/indexOf | 749.7ms | 817.5ms | — |
| array/slice | 754.3ms | 806.4ms | — |
| array/reverse | 740.7ms | 812.5ms | — |
| array/forEach | 832.5ms | 920.7ms | — |
| array/find | 862.4ms | 956.0ms | 801.7ms |
| dom/create-elements | 599.6ms | — | — |
| dom/set-attributes | 693.6ms | — | — |
| dom/read-attributes | 664.8ms | — | — |
| dom/modify-text | 688.0ms | — | — |
| mixed/csv-parse | 765.1ms | 984.2ms | — |
| mixed/text-search | 661.0ms | 976.9ms | — |
| mixed/fibonacci | 643.1ms | 828.5ms | 665.2ms |
| mixed/matrix-multiply | 856.7ms | 935.8ms | 794.2ms |
| mixed/sieve | 808.8ms | 858.6ms | — |
