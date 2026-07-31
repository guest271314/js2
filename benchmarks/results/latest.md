# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.041ms | 0.041ms | 0.045ms | — | js |
| string/concat-long | 0.005ms | 0.005ms | 0.005ms | — | host-call |
| string/indexOf | 0.002ms | 0.352ms | 0.014ms | — | js |
| string/includes | 0.002ms | 0.356ms | 0.013ms | — | js |
| string/split | 0.248ms | 13.37ms | 0.850ms | — | js |
| string/replace | 0.031ms | 0.436ms | 0.100ms | — | js |
| string/case-convert | <0.001ms | 0.661ms | 4.23ms | — | js |
| string/substring | 0.002ms | 3.44ms | 0.050ms | — | js |
| string/trim | 0.110ms | 3.18ms | 0.486ms | — | js |
| string/startsWith-endsWith | 0.179ms | 7.10ms | 1.38ms | — | js |
| array/push-pop | 1.33ms | 1.41ms | 0.651ms | — | gc-native |
| array/sort-i32 | 0.462ms | 769.7ms | — | — | js |
| array/map-filter | 0.115ms | 0.438ms | 0.043ms | — | gc-native |
| array/reduce | 1.17ms | 1.45ms | 0.681ms | — | gc-native |
| array/indexOf | 4.00ms | 3.34ms | 2.03ms | — | gc-native |
| array/slice | 0.037ms | 0.044ms | 0.022ms | — | gc-native |
| array/reverse | 4.98ms | 2.76ms | 2.48ms | — | gc-native |
| array/forEach | 0.058ms | 0.052ms | 0.031ms | — | gc-native |
| array/find | 0.219ms | 0.426ms | — | — | js |
| dom/create-elements | 0.065ms | — | — | — | js |
| dom/set-attributes | 0.111ms | — | — | — | js |
| dom/read-attributes | 0.080ms | — | — | — | js |
| dom/modify-text | 0.073ms | — | — | — | js |
| mixed/csv-parse | 0.280ms | 19.70ms | 0.785ms | — | js |
| mixed/text-search | 0.233ms | 14.77ms | 1.21ms | — | js |
| mixed/fibonacci | 0.094ms | 0.111ms | 0.059ms | 0.110ms | gc-native |
| mixed/matrix-multiply | 0.146ms | 1.37ms | 0.147ms | 1.24ms | js |
| mixed/sieve | 1.33ms | 1.83ms | 0.842ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.02x slower | 1.11x slower | — |
| string/concat-long | 1.06x faster | 1.00x slower | — |
| string/indexOf | 228.62x slower | 9.34x slower | — |
| string/includes | 211.41x slower | 7.88x slower | — |
| string/split | 53.80x slower | 3.42x slower | — |
| string/replace | 14.21x slower | 3.27x slower | — |
| string/case-convert | 2592.40x slower | 16598.99x slower | — |
| string/substring | 1392.89x slower | 20.29x slower | — |
| string/trim | 28.96x slower | 4.42x slower | — |
| string/startsWith-endsWith | 39.55x slower | 7.67x slower | — |
| array/push-pop | 1.06x slower | 2.04x faster | — |
| array/sort-i32 | 1664.65x slower | — | — |
| array/map-filter | 3.82x slower | 2.65x faster | — |
| array/reduce | 1.24x slower | 1.71x faster | — |
| array/indexOf | 1.20x faster | 1.98x faster | — |
| array/slice | 1.17x slower | 1.73x faster | — |
| array/reverse | 1.80x faster | 2.01x faster | — |
| array/forEach | 1.11x faster | 1.86x faster | — |
| array/find | 1.94x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 70.42x slower | 2.80x slower | — |
| mixed/text-search | 63.47x slower | 5.19x slower | — |
| mixed/fibonacci | 1.18x slower | 1.59x faster | 1.17x slower |
| mixed/matrix-multiply | 9.38x slower | 1.01x slower | 8.49x slower |
| mixed/sieve | 1.38x slower | 1.58x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.09x slower |
| string/concat-long | 1.06x slower |
| string/indexOf | 24.49x faster |
| string/includes | 26.84x faster |
| string/split | 15.73x faster |
| string/replace | 4.35x faster |
| string/case-convert | 6.40x slower |
| string/substring | 68.65x faster |
| string/trim | 6.55x faster |
| string/startsWith-endsWith | 5.16x faster |
| array/push-pop | 2.17x faster |
| array/map-filter | 10.11x faster |
| array/reduce | 2.13x faster |
| array/indexOf | 1.65x faster |
| array/slice | 2.01x faster |
| array/reverse | 1.11x faster |
| array/forEach | 1.67x faster |
| mixed/csv-parse | 25.11x faster |
| mixed/text-search | 12.23x faster |
| mixed/fibonacci | 1.88x faster |
| mixed/matrix-multiply | 9.32x faster |
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
| array/map-filter | 3.3KB | 3.3KB | — |
| array/reduce | 2.3KB | 2.8KB | — |
| array/indexOf | 1022B | 1.5KB | — |
| array/slice | 1.0KB | 1.5KB | — |
| array/reverse | 1.0KB | 1.5KB | — |
| array/forEach | 2.6KB | 3.1KB | — |
| array/find | 2.7KB | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 1.4KB | 2.9KB | — |
| mixed/text-search | 600B | 2.2KB | — |
| mixed/fibonacci | 157B | 1.1KB | 173B |
| mixed/matrix-multiply | 1.3KB | 1.8KB | 950B |
| mixed/sieve | 1.5KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1041.2ms | 862.4ms | — |
| string/concat-long | 471.6ms | 744.6ms | — |
| string/indexOf | 440.5ms | 745.0ms | — |
| string/includes | 433.7ms | 742.2ms | — |
| string/split | 536.7ms | 705.8ms | — |
| string/replace | 416.9ms | 736.2ms | — |
| string/case-convert | 405.8ms | 902.7ms | — |
| string/substring | 415.7ms | 651.8ms | — |
| string/trim | 413.3ms | 699.4ms | — |
| string/startsWith-endsWith | 472.3ms | 707.0ms | — |
| array/push-pop | 546.2ms | 620.1ms | — |
| array/sort-i32 | 619.7ms | — | — |
| array/map-filter | 679.9ms | 695.9ms | — |
| array/reduce | 628.1ms | 739.1ms | — |
| array/indexOf | 556.9ms | 626.8ms | — |
| array/slice | 566.9ms | 613.6ms | — |
| array/reverse | 555.1ms | 584.2ms | — |
| array/forEach | 669.5ms | 690.4ms | — |
| array/find | 617.2ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 589.1ms | 740.8ms | — |
| mixed/text-search | 484.6ms | 757.7ms | — |
| mixed/fibonacci | 490.2ms | 619.1ms | 522.6ms |
| mixed/matrix-multiply | 583.1ms | 645.8ms | 599.3ms |
| mixed/sieve | 572.5ms | 634.2ms | — |
