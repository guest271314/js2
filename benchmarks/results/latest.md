# js2wasm Benchmark Results

Date: 2026-08-01
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.030ms | 0.045ms | 0.040ms | FAILED | js |
| string/concat-long | 0.004ms | 0.007ms | 0.008ms | FAILED | js |
| string/indexOf | 0.001ms | 0.062ms | 0.015ms | FAILED | js |
| string/includes | 0.001ms | 0.144ms | 0.016ms | FAILED | js |
| string/split | 0.402ms | 5.60ms | 0.891ms | FAILED | js |
| string/replace | 0.042ms | 0.243ms | 0.041ms | FAILED | gc-native |
| string/case-convert | <0.001ms | 0.222ms | 0.066ms | FAILED | js |
| string/substring | 0.003ms | 1.05ms | 0.023ms | FAILED | js |
| string/trim | 0.151ms | 0.992ms | 0.165ms | FAILED | js |
| string/startsWith-endsWith | 0.246ms | 2.83ms | 0.189ms | FAILED | gc-native |
| array/push-pop | 1.44ms | 2.15ms | 2.17ms | FAILED | js |
| array/sort-i32 | 0.789ms | 0.393ms | 0.392ms | FAILED | gc-native |
| array/map-filter | 0.127ms | 0.644ms | 0.644ms | FAILED | js |
| array/reduce | 2.13ms | 2.16ms | 2.19ms | FAILED | js |
| array/indexOf | 3.94ms | 3.42ms | 3.42ms | FAILED | host-call |
| array/slice | 0.025ms | 0.036ms | 0.036ms | FAILED | js |
| array/reverse | 7.83ms | 3.43ms | 3.43ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.115ms | 0.115ms | FAILED | js |
| array/find | 0.238ms | 0.459ms | 0.458ms | 4.86ms | js |
| dom/create-elements | 0.181ms | 0.297ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.400ms | — | — | js |
| dom/read-attributes | 0.060ms | 0.170ms | — | — | js |
| dom/modify-text | 0.050ms | 0.169ms | — | — | js |
| mixed/csv-parse | 2.16ms | 7.21ms | 0.719ms | FAILED | gc-native |
| mixed/text-search | 0.218ms | 5.61ms | 0.622ms | FAILED | js |
| mixed/fibonacci | 0.109ms | 0.246ms | 0.246ms | 1.10ms | js |
| mixed/matrix-multiply | 0.162ms | 0.554ms | 0.555ms | 2.12ms | js |
| mixed/sieve | 1.54ms | 1.39ms | 1.38ms | FAILED | gc-native |

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
| string/concat-short | 1.49x slower | 1.31x slower | — |
| string/concat-long | 2.08x slower | 2.26x slower | — |
| string/indexOf | 48.54x slower | 11.78x slower | — |
| string/includes | 99.18x slower | 10.77x slower | — |
| string/split | 13.93x slower | 2.22x slower | — |
| string/replace | 5.76x slower | 1.03x faster | — |
| string/case-convert | 691.28x slower | 204.82x slower | — |
| string/substring | 337.72x slower | 7.37x slower | — |
| string/trim | 6.57x slower | 1.09x slower | — |
| string/startsWith-endsWith | 11.49x slower | 1.30x faster | — |
| array/push-pop | 1.49x slower | 1.50x slower | — |
| array/sort-i32 | 2.01x faster | 2.01x faster | — |
| array/map-filter | 5.08x slower | 5.08x slower | — |
| array/reduce | 1.01x slower | 1.03x slower | — |
| array/indexOf | 1.15x faster | 1.15x faster | — |
| array/slice | 1.44x slower | 1.46x slower | — |
| array/reverse | 2.28x faster | 2.28x faster | — |
| array/forEach | 2.35x slower | 2.35x slower | — |
| array/find | 1.92x slower | 1.92x slower | 20.36x slower |
| dom/create-elements | 1.64x slower | — | — |
| dom/set-attributes | 3.86x slower | — | — |
| dom/read-attributes | 2.86x slower | — | — |
| dom/modify-text | 3.41x slower | — | — |
| mixed/csv-parse | 3.33x slower | 3.01x faster | — |
| mixed/text-search | 25.66x slower | 2.85x slower | — |
| mixed/fibonacci | 2.25x slower | 2.25x slower | 10.06x slower |
| mixed/matrix-multiply | 3.41x slower | 3.42x slower | 13.07x slower |
| mixed/sieve | 1.11x faster | 1.12x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.14x faster |
| string/concat-long | 1.09x slower |
| string/indexOf | 4.12x faster |
| string/includes | 9.21x faster |
| string/split | 6.28x faster |
| string/replace | 5.95x faster |
| string/case-convert | 3.38x faster |
| string/substring | 45.80x faster |
| string/trim | 6.03x faster |
| string/startsWith-endsWith | 14.98x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 10.02x faster |
| mixed/text-search | 9.02x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
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
| string/concat-short | 1309.8ms | 1168.3ms | — |
| string/concat-long | 626.3ms | 1005.2ms | — |
| string/indexOf | 578.2ms | 1008.1ms | — |
| string/includes | 628.0ms | 1016.7ms | — |
| string/split | 718.5ms | 989.5ms | — |
| string/replace | 555.1ms | 1024.5ms | — |
| string/case-convert | 549.5ms | 1083.5ms | — |
| string/substring | 551.9ms | 878.6ms | — |
| string/trim | 543.1ms | 993.2ms | — |
| string/startsWith-endsWith | 647.7ms | 956.1ms | — |
| array/push-pop | 793.2ms | 832.2ms | — |
| array/sort-i32 | 946.9ms | 979.1ms | — |
| array/map-filter | 910.1ms | 976.4ms | — |
| array/reduce | 814.7ms | 887.0ms | — |
| array/indexOf | 744.9ms | 831.5ms | — |
| array/slice | 742.2ms | 827.6ms | — |
| array/reverse | 764.2ms | 806.5ms | — |
| array/forEach | 883.2ms | 971.4ms | — |
| array/find | 875.0ms | 952.4ms | 828.3ms |
| dom/create-elements | 652.6ms | — | — |
| dom/set-attributes | 729.4ms | — | — |
| dom/read-attributes | 709.4ms | — | — |
| dom/modify-text | 681.4ms | — | — |
| mixed/csv-parse | 781.6ms | 1020.0ms | — |
| mixed/text-search | 661.9ms | 976.1ms | — |
| mixed/fibonacci | 666.2ms | 863.0ms | 692.7ms |
| mixed/matrix-multiply | 883.4ms | 973.6ms | 792.4ms |
| mixed/sieve | 829.5ms | 881.8ms | — |
