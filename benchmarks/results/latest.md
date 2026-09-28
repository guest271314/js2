# js2wasm Benchmark Results

Date: 2026-09-28
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.054ms | 0.057ms | 0.053ms | FAILED | gc-native |
| string/concat-long | 0.005ms | 0.005ms | 0.006ms | FAILED | js |
| string/indexOf | 0.016ms | 0.052ms | 0.011ms | 0.014ms | gc-native |
| string/includes | 0.016ms | 0.101ms | 0.014ms | 0.021ms | gc-native |
| string/split | 0.355ms | 6.95ms | 2.46ms | FAILED | js |
| string/replace | 0.099ms | 0.535ms | 0.306ms | FAILED | js |
| string/case-convert | 0.051ms | 0.491ms | 0.242ms | FAILED | js |
| string/substring | 0.107ms | 0.038ms | 0.033ms | FAILED | gc-native |
| string/trim | 0.165ms | 3.41ms | 2.50ms | FAILED | js |
| string/startsWith-endsWith | 0.477ms | 2.66ms | 2.71ms | 0.559ms | js |
| array/push-pop | 1.43ms | 0.484ms | 0.483ms | FAILED | gc-native |
| array/sort-i32 | 0.651ms | 0.340ms | 0.337ms | FAILED | gc-native |
| array/map-filter | 0.130ms | 0.083ms | 0.082ms | FAILED | gc-native |
| array/reduce | 2.07ms | 0.479ms | 0.481ms | FAILED | host-call |
| array/indexOf | 5.38ms | 2.66ms | 2.66ms | FAILED | gc-native |
| array/slice | 0.022ms | 0.020ms | 0.020ms | FAILED | host-call |
| array/reverse | 8.48ms | 3.80ms | 3.81ms | FAILED | host-call |
| array/forEach | 0.060ms | 0.025ms | 0.025ms | FAILED | host-call |
| array/find | 0.304ms | 0.014ms | 0.015ms | 0.989ms | host-call |
| dom/create-elements | 0.063ms | 0.100ms | — | — | js |
| dom/set-attributes | 0.129ms | 0.192ms | — | — | js |
| dom/read-attributes | 0.058ms | 0.117ms | — | — | js |
| dom/modify-text | 0.034ms | 0.096ms | — | — | js |
| mixed/csv-parse | 0.406ms | 7.06ms | 0.589ms | FAILED | js |
| mixed/text-search | 0.437ms | 4.12ms | 2.61ms | 1.24ms | js |
| mixed/fibonacci | 0.136ms | 0.214ms | 0.217ms | 0.216ms | js |
| mixed/matrix-multiply | 0.188ms | 61.88ms | 65.30ms | 0.721ms | js |
| mixed/sieve | 1.59ms | 2.42ms | 2.45ms | FAILED | js |

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
| string/concat-short | 10000 | 5.42 | 5.66 | 5.27 | — |
| string/concat-long | 1000 | 5.16 | 5.45 | 6.30 | — |
| string/indexOf | 1000 | 16.43 | 52.01 | 11.08 | 13.98 |
| string/includes | 1000 | 16.28 | 101.41 | 13.94 | 21.47 |
| string/split | 10000 | 35.53 | 694.63 | 246.14 | — |
| string/replace | 1000 | 99.48 | 534.63 | 306.35 | — |
| string/case-convert | 2000 | 25.56 | 245.54 | 121.13 | — |
| string/substring | 10000 | 10.66 | 3.81 | 3.26 | — |
| string/trim | 10000 | 16.53 | 340.56 | 249.75 | — |
| string/startsWith-endsWith | 20000 | 23.86 | 132.76 | 135.71 | 27.97 |
| array/map-filter | 30000 | 4.33 | 2.77 | 2.72 | — |
| array/indexOf | 1000 | 5380.32 | 2663.67 | 2662.59 | — |
| dom/create-elements | 2000 | 31.34 | 49.86 | — | — |
| dom/set-attributes | 6000 | 21.53 | 31.94 | — | — |
| dom/read-attributes | 3000 | 19.42 | 39.07 | — | — |
| dom/modify-text | 2000 | 17.04 | 48.06 | — | — |
| mixed/csv-parse | 11000 | 36.93 | 641.44 | 53.54 | — |
| mixed/text-search | 40000 | 10.94 | 102.92 | 65.17 | 31.11 |
| mixed/fibonacci | 10000 | 13.64 | 21.43 | 21.71 | 21.58 |
| mixed/matrix-multiply | 125000 | 1.51 | 495.07 | 522.41 | 5.77 |
| mixed/sieve | 200000 | 7.93 | 12.08 | 12.27 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.04x slower | 1.03x faster | — |
| string/concat-long | 1.06x slower | 1.22x slower | — |
| string/indexOf | 3.16x slower | 1.48x faster | 1.18x faster |
| string/includes | 6.23x slower | 1.17x faster | 1.32x slower |
| string/split | 19.55x slower | 6.93x slower | — |
| string/replace | 5.37x slower | 3.08x slower | — |
| string/case-convert | 9.61x slower | 4.74x slower | — |
| string/substring | 2.79x faster | 3.27x faster | — |
| string/trim | 20.60x slower | 15.11x slower | — |
| string/startsWith-endsWith | 5.56x slower | 5.69x slower | 1.17x slower |
| array/push-pop | 2.96x faster | 2.96x faster | — |
| array/sort-i32 | 1.91x faster | 1.93x faster | — |
| array/map-filter | 1.56x faster | 1.59x faster | — |
| array/reduce | 4.33x faster | 4.31x faster | — |
| array/indexOf | 2.02x faster | 2.02x faster | — |
| array/slice | 1.12x faster | 1.10x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 2.43x faster | 2.40x faster | — |
| array/find | 20.98x faster | 19.82x faster | 3.25x slower |
| dom/create-elements | 1.59x slower | — | — |
| dom/set-attributes | 1.48x slower | — | — |
| dom/read-attributes | 2.01x slower | — | — |
| dom/modify-text | 2.82x slower | — | — |
| mixed/csv-parse | 17.37x slower | 1.45x slower | — |
| mixed/text-search | 9.41x slower | 5.96x slower | 2.84x slower |
| mixed/fibonacci | 1.57x slower | 1.59x slower | 1.58x slower |
| mixed/matrix-multiply | 328.93x slower | 347.09x slower | 3.83x slower |
| mixed/sieve | 1.52x slower | 1.55x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.07x faster |
| string/concat-long | 1.16x slower |
| string/indexOf | 4.69x faster |
| string/includes | 7.28x faster |
| string/split | 2.82x faster |
| string/replace | 1.75x faster |
| string/case-convert | 2.03x faster |
| string/substring | 1.17x faster |
| string/trim | 1.36x faster |
| string/startsWith-endsWith | 1.02x slower |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.02x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.02x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x slower |
| array/find | 1.06x slower |
| mixed/csv-parse | 11.98x faster |
| mixed/text-search | 1.58x faster |
| mixed/fibonacci | 1.01x slower |
| mixed/matrix-multiply | 1.06x slower |
| mixed/sieve | 1.02x slower |

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
| string/concat-short | 1084.0ms | 626.2ms | — |
| string/concat-long | 441.4ms | 644.2ms | — |
| string/indexOf | 364.7ms | 637.9ms | 537.4ms |
| string/includes | 374.9ms | 649.6ms | 545.7ms |
| string/split | 495.2ms | 690.6ms | — |
| string/replace | 509.0ms | 734.2ms | — |
| string/case-convert | 519.8ms | 612.8ms | — |
| string/substring | 379.0ms | 463.3ms | — |
| string/trim | 474.3ms | 680.2ms | — |
| string/startsWith-endsWith | 478.2ms | 699.6ms | 598.3ms |
| array/push-pop | 512.9ms | 588.1ms | — |
| array/sort-i32 | 654.2ms | 709.7ms | — |
| array/map-filter | 677.2ms | 767.6ms | — |
| array/reduce | 608.3ms | 681.8ms | — |
| array/indexOf | 576.1ms | 656.9ms | — |
| array/slice | 528.8ms | 608.7ms | — |
| array/reverse | 478.2ms | 580.4ms | — |
| array/forEach | 620.5ms | 711.6ms | — |
| array/find | 469.5ms | 572.4ms | 529.2ms |
| dom/create-elements | 400.2ms | — | — |
| dom/set-attributes | 390.1ms | — | — |
| dom/read-attributes | 374.5ms | — | — |
| dom/modify-text | 371.4ms | — | — |
| mixed/csv-parse | 527.1ms | 664.3ms | — |
| mixed/text-search | 499.3ms | 693.5ms | 603.8ms |
| mixed/fibonacci | 477.0ms | 498.3ms | 464.6ms |
| mixed/matrix-multiply | 625.6ms | 685.0ms | 498.6ms |
| mixed/sieve | 615.9ms | 659.8ms | — |
