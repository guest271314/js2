# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.042ms | 0.049ms | 0.043ms | — | js |
| string/concat-long | 0.005ms | 0.005ms | 0.005ms | — | gc-native |
| string/indexOf | 0.001ms | 0.388ms | 0.013ms | — | js |
| string/includes | 0.002ms | 0.428ms | 0.013ms | — | js |
| string/split | 0.247ms | 12.91ms | 0.848ms | — | js |
| string/replace | 0.031ms | 0.428ms | 0.098ms | — | js |
| string/case-convert | <0.001ms | 0.668ms | 3.97ms | — | js |
| string/substring | 0.002ms | 3.36ms | 0.049ms | — | js |
| string/trim | 0.120ms | 3.44ms | 0.509ms | — | js |
| string/startsWith-endsWith | 0.194ms | 7.04ms | 1.38ms | — | js |
| array/push-pop | 1.21ms | 1.41ms | 0.647ms | — | gc-native |
| array/sort-i32 | 0.463ms | 803.6ms | — | — | js |
| array/map-filter | 0.111ms | 0.424ms | 0.042ms | — | gc-native |
| array/reduce | 1.68ms | 1.38ms | 0.660ms | — | gc-native |
| array/indexOf | 3.91ms | 3.26ms | 1.98ms | — | gc-native |
| array/slice | 0.036ms | 0.044ms | 0.020ms | — | gc-native |
| array/reverse | 4.94ms | 2.75ms | 2.72ms | — | gc-native |
| array/forEach | 0.052ms | 0.054ms | 0.026ms | — | gc-native |
| array/find | 0.219ms | 0.368ms | — | — | js |
| dom/create-elements | 0.065ms | — | — | — | js |
| dom/set-attributes | 0.117ms | — | — | — | js |
| dom/read-attributes | 0.069ms | — | — | — | js |
| dom/modify-text | 0.072ms | — | — | — | js |
| mixed/csv-parse | 0.304ms | 19.19ms | 0.778ms | — | js |
| mixed/text-search | 0.232ms | 15.12ms | 1.18ms | — | js |
| mixed/fibonacci | 0.092ms | 0.108ms | — | 0.107ms | js |
| mixed/matrix-multiply | 0.144ms | 1.35ms | 0.161ms | 1.22ms | js |
| mixed/sieve | 1.33ms | 1.81ms | 0.830ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.17x slower | 1.04x slower | — |
| string/concat-long | 1.04x faster | 1.07x faster | — |
| string/indexOf | 264.84x slower | 8.82x slower | — |
| string/includes | 267.20x slower | 8.08x slower | — |
| string/split | 52.37x slower | 3.44x slower | — |
| string/replace | 13.63x slower | 3.12x slower | — |
| string/case-convert | 2675.24x slower | 15901.54x slower | — |
| string/substring | 1394.28x slower | 20.46x slower | — |
| string/trim | 28.70x slower | 4.24x slower | — |
| string/startsWith-endsWith | 36.29x slower | 7.09x slower | — |
| array/push-pop | 1.17x slower | 1.87x faster | — |
| array/sort-i32 | 1737.16x slower | — | — |
| array/map-filter | 3.81x slower | 2.65x faster | — |
| array/reduce | 1.21x faster | 2.54x faster | — |
| array/indexOf | 1.20x faster | 1.98x faster | — |
| array/slice | 1.21x slower | 1.78x faster | — |
| array/reverse | 1.80x faster | 1.82x faster | — |
| array/forEach | 1.05x slower | 1.99x faster | — |
| array/find | 1.68x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 63.17x slower | 2.56x slower | — |
| mixed/text-search | 65.12x slower | 5.08x slower | — |
| mixed/fibonacci | 1.18x slower | — | 1.17x slower |
| mixed/matrix-multiply | 9.39x slower | 1.12x slower | 8.45x slower |
| mixed/sieve | 1.36x slower | 1.61x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.13x faster |
| string/concat-long | 1.03x faster |
| string/indexOf | 30.01x faster |
| string/includes | 33.08x faster |
| string/split | 15.22x faster |
| string/replace | 4.37x faster |
| string/case-convert | 5.94x slower |
| string/substring | 68.16x faster |
| string/trim | 6.76x faster |
| string/startsWith-endsWith | 5.12x faster |
| array/push-pop | 2.18x faster |
| array/map-filter | 10.11x faster |
| array/reduce | 2.09x faster |
| array/indexOf | 1.64x faster |
| array/slice | 2.16x faster |
| array/reverse | 1.01x faster |
| array/forEach | 2.08x faster |
| mixed/csv-parse | 24.68x faster |
| mixed/text-search | 12.82x faster |
| mixed/matrix-multiply | 8.38x faster |
| mixed/sieve | 2.18x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 1.7KB | — |
| string/concat-long | 236B | 1.9KB | — |
| string/indexOf | 216B | 2.1KB | — |
| string/includes | 236B | 2.1KB | — |
| string/split | 973B | 1.7KB | — |
| string/replace | 289B | 2.5KB | — |
| string/case-convert | 249B | 11.5KB | — |
| string/substring | 239B | 1.3KB | — |
| string/trim | 205B | 1.8KB | — |
| string/startsWith-endsWith | 330B | 1.7KB | — |
| array/push-pop | 947B | 1.4KB | — |
| array/sort-i32 | 1.2KB | — | — |
| array/map-filter | 2.7KB | 2.8KB | — |
| array/reduce | 1.9KB | 2.5KB | — |
| array/indexOf | 1022B | 1.5KB | — |
| array/slice | 1.0KB | 1.5KB | — |
| array/reverse | 1.0KB | 1.5KB | — |
| array/forEach | 2.1KB | 2.7KB | — |
| array/find | 2.3KB | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 1.4KB | 2.9KB | — |
| mixed/text-search | 600B | 2.2KB | — |
| mixed/fibonacci | 157B | — | 173B |
| mixed/matrix-multiply | 1.5KB | 1.8KB | 950B |
| mixed/sieve | 1.5KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 952.2ms | 808.0ms | — |
| string/concat-long | 466.2ms | 774.0ms | — |
| string/indexOf | 447.4ms | 797.8ms | — |
| string/includes | 423.0ms | 791.1ms | — |
| string/split | 525.7ms | 719.4ms | — |
| string/replace | 407.7ms | 739.0ms | — |
| string/case-convert | 401.1ms | 881.9ms | — |
| string/substring | 415.3ms | 621.9ms | — |
| string/trim | 433.9ms | 737.9ms | — |
| string/startsWith-endsWith | 492.9ms | 720.4ms | — |
| array/push-pop | 588.3ms | 608.7ms | — |
| array/sort-i32 | 605.4ms | — | — |
| array/map-filter | 648.4ms | 689.7ms | — |
| array/reduce | 583.5ms | 633.6ms | — |
| array/indexOf | 546.5ms | 629.9ms | — |
| array/slice | 545.1ms | 607.4ms | — |
| array/reverse | 542.6ms | 581.5ms | — |
| array/forEach | 656.0ms | 637.8ms | — |
| array/find | 597.3ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 548.8ms | 721.9ms | — |
| mixed/text-search | 487.2ms | 735.5ms | — |
| mixed/fibonacci | 498.2ms | — | 501.2ms |
| mixed/matrix-multiply | 588.2ms | 726.0ms | 576.5ms |
| mixed/sieve | 568.7ms | 630.1ms | — |
