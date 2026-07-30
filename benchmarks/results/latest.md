# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.073ms | 0.038ms | — | js |
| string/concat-long | 0.004ms | 0.006ms | 0.005ms | — | js |
| string/indexOf | 0.001ms | 0.676ms | 0.016ms | — | js |
| string/includes | 0.002ms | 0.704ms | 0.016ms | — | js |
| string/split | 0.402ms | 22.75ms | 1.06ms | — | js |
| string/replace | 0.042ms | 0.874ms | 0.140ms | — | js |
| string/case-convert | <0.001ms | 1.24ms | 4.39ms | — | js |
| string/substring | 0.003ms | 6.52ms | 0.024ms | — | js |
| string/trim | 0.152ms | 5.97ms | 0.509ms | — | js |
| string/startsWith-endsWith | 0.246ms | 13.97ms | 0.659ms | — | js |
| array/push-pop | 1.46ms | 1.83ms | 0.839ms | — | gc-native |
| array/sort-i32 | 0.791ms | 1252.1ms | — | — | js |
| array/map-filter | 0.125ms | 0.609ms | 0.059ms | — | gc-native |
| array/reduce | 2.13ms | 1.84ms | 0.855ms | — | gc-native |
| array/indexOf | 3.94ms | 3.39ms | 2.57ms | — | gc-native |
| array/slice | 0.025ms | 0.032ms | 0.013ms | — | gc-native |
| array/reverse | 7.83ms | 3.39ms | 4.31ms | — | host-call |
| array/forEach | 0.049ms | 0.082ms | 0.044ms | — | gc-native |
| array/find | 0.239ms | 0.405ms | — | — | js |
| dom/create-elements | 0.032ms | — | — | — | js |
| dom/set-attributes | 0.104ms | — | — | — | js |
| dom/read-attributes | 0.054ms | — | — | — | js |
| dom/modify-text | 0.044ms | — | — | — | js |
| mixed/csv-parse | 0.465ms | 34.72ms | 0.857ms | — | js |
| mixed/text-search | 0.215ms | 27.78ms | 0.973ms | — | js |
| mixed/fibonacci | 0.109ms | 0.228ms | — | 0.226ms | js |
| mixed/matrix-multiply | 0.163ms | 0.476ms | 0.204ms | 2.12ms | js |
| mixed/sieve | 1.57ms | 2.13ms | 1.17ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 2.33x slower | 1.20x slower | — |
| string/concat-long | 1.51x slower | 1.24x slower | — |
| string/indexOf | 474.82x slower | 11.17x slower | — |
| string/includes | 452.73x slower | 10.51x slower | — |
| string/split | 56.57x slower | 2.64x slower | — |
| string/replace | 20.61x slower | 3.30x slower | — |
| string/case-convert | 3856.18x slower | 13622.68x slower | — |
| string/substring | 2087.30x slower | 7.56x slower | — |
| string/trim | 39.34x slower | 3.35x slower | — |
| string/startsWith-endsWith | 56.81x slower | 2.68x slower | — |
| array/push-pop | 1.26x slower | 1.73x faster | — |
| array/sort-i32 | 1582.76x slower | — | — |
| array/map-filter | 4.89x slower | 2.12x faster | — |
| array/reduce | 1.16x faster | 2.49x faster | — |
| array/indexOf | 1.16x faster | 1.54x faster | — |
| array/slice | 1.25x slower | 1.88x faster | — |
| array/reverse | 2.31x faster | 1.81x faster | — |
| array/forEach | 1.67x slower | 1.11x faster | — |
| array/find | 1.70x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 74.61x slower | 1.84x slower | — |
| mixed/text-search | 128.93x slower | 4.51x slower | — |
| mixed/fibonacci | 2.08x slower | — | 2.07x slower |
| mixed/matrix-multiply | 2.92x slower | 1.26x slower | 13.05x slower |
| mixed/sieve | 1.36x slower | 1.34x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.95x faster |
| string/concat-long | 1.22x faster |
| string/indexOf | 42.50x faster |
| string/includes | 43.09x faster |
| string/split | 21.44x faster |
| string/replace | 6.24x faster |
| string/case-convert | 3.53x slower |
| string/substring | 275.98x faster |
| string/trim | 11.73x faster |
| string/startsWith-endsWith | 21.21x faster |
| array/push-pop | 2.18x faster |
| array/map-filter | 10.37x faster |
| array/reduce | 2.15x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.36x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.86x faster |
| mixed/csv-parse | 40.52x faster |
| mixed/text-search | 28.56x faster |
| mixed/matrix-multiply | 2.33x faster |
| mixed/sieve | 1.82x faster |

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
| string/concat-short | 1297.4ms | 1166.3ms | — |
| string/concat-long | 648.0ms | 1024.6ms | — |
| string/indexOf | 579.9ms | 1058.6ms | — |
| string/includes | 582.0ms | 1019.8ms | — |
| string/split | 729.1ms | 1001.8ms | — |
| string/replace | 563.8ms | 1038.8ms | — |
| string/case-convert | 571.5ms | 1319.2ms | — |
| string/substring | 548.2ms | 857.9ms | — |
| string/trim | 568.9ms | 948.0ms | — |
| string/startsWith-endsWith | 621.7ms | 1049.0ms | — |
| array/push-pop | 780.7ms | 848.8ms | — |
| array/sort-i32 | 841.0ms | — | — |
| array/map-filter | 961.4ms | 968.3ms | — |
| array/reduce | 815.2ms | 888.6ms | — |
| array/indexOf | 745.7ms | 831.9ms | — |
| array/slice | 769.0ms | 824.5ms | — |
| array/reverse | 743.4ms | 813.0ms | — |
| array/forEach | 852.2ms | 906.8ms | — |
| array/find | 833.4ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 798.3ms | 983.6ms | — |
| mixed/text-search | 675.7ms | 1080.8ms | — |
| mixed/fibonacci | 681.0ms | — | 697.4ms |
| mixed/matrix-multiply | 834.6ms | 961.7ms | 829.5ms |
| mixed/sieve | 851.2ms | 934.3ms | — |
