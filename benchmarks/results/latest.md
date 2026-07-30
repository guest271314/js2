# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.051ms | 0.039ms | — | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | — | js |
| string/indexOf | 0.001ms | 0.706ms | 0.016ms | — | js |
| string/includes | 0.002ms | 0.686ms | 0.017ms | — | js |
| string/split | 0.402ms | 23.17ms | 1.07ms | — | js |
| string/replace | 0.043ms | 0.874ms | 0.142ms | — | js |
| string/case-convert | <0.001ms | 1.28ms | 4.45ms | — | js |
| string/substring | 0.003ms | 6.48ms | 0.024ms | — | js |
| string/trim | 0.152ms | 6.14ms | 0.509ms | — | js |
| string/startsWith-endsWith | 0.247ms | 13.64ms | 0.659ms | — | js |
| array/push-pop | 1.47ms | 1.85ms | 0.826ms | — | gc-native |
| array/sort-i32 | 0.789ms | 1268.1ms | — | — | js |
| array/map-filter | 0.129ms | 0.609ms | 0.060ms | — | gc-native |
| array/reduce | 2.18ms | 1.86ms | 0.848ms | — | gc-native |
| array/indexOf | 3.94ms | 3.39ms | 2.57ms | — | gc-native |
| array/slice | 0.028ms | 0.034ms | 0.015ms | — | gc-native |
| array/reverse | 7.84ms | 3.40ms | 4.32ms | — | host-call |
| array/forEach | 0.095ms | 0.082ms | 0.044ms | — | gc-native |
| array/find | 0.239ms | 0.407ms | — | — | js |
| dom/create-elements | 0.042ms | — | — | — | js |
| dom/set-attributes | 0.110ms | — | — | — | js |
| dom/read-attributes | 0.054ms | — | — | — | js |
| dom/modify-text | 0.047ms | — | — | — | js |
| mixed/csv-parse | 0.465ms | 36.20ms | 0.862ms | — | js |
| mixed/text-search | 0.094ms | 28.03ms | 0.974ms | — | js |
| mixed/fibonacci | 0.109ms | 0.227ms | — | 0.226ms | js |
| mixed/matrix-multiply | 0.158ms | 0.477ms | 0.186ms | 2.13ms | js |
| mixed/sieve | 1.56ms | 2.14ms | 1.17ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.64x slower | 1.24x slower | — |
| string/concat-long | 1.44x slower | 1.40x slower | — |
| string/indexOf | 508.14x slower | 11.36x slower | — |
| string/includes | 450.79x slower | 10.96x slower | — |
| string/split | 57.60x slower | 2.65x slower | — |
| string/replace | 20.54x slower | 3.33x slower | — |
| string/case-convert | 3966.60x slower | 13798.21x slower | — |
| string/substring | 2075.05x slower | 7.78x slower | — |
| string/trim | 40.44x slower | 3.35x slower | — |
| string/startsWith-endsWith | 55.29x slower | 2.67x slower | — |
| array/push-pop | 1.26x slower | 1.78x faster | — |
| array/sort-i32 | 1607.11x slower | — | — |
| array/map-filter | 4.71x slower | 2.16x faster | — |
| array/reduce | 1.17x faster | 2.57x faster | — |
| array/indexOf | 1.16x faster | 1.54x faster | — |
| array/slice | 1.22x slower | 1.79x faster | — |
| array/reverse | 2.31x faster | 1.82x faster | — |
| array/forEach | 1.15x faster | 2.13x faster | — |
| array/find | 1.70x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 77.94x slower | 1.85x slower | — |
| mixed/text-search | 299.45x slower | 10.41x slower | — |
| mixed/fibonacci | 2.08x slower | — | 2.06x slower |
| mixed/matrix-multiply | 3.01x slower | 1.18x slower | 13.45x slower |
| mixed/sieve | 1.37x slower | 1.33x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.32x faster |
| string/concat-long | 1.03x faster |
| string/indexOf | 44.72x faster |
| string/includes | 41.14x faster |
| string/split | 21.71x faster |
| string/replace | 6.16x faster |
| string/case-convert | 3.48x slower |
| string/substring | 266.57x faster |
| string/trim | 12.06x faster |
| string/startsWith-endsWith | 20.70x faster |
| array/push-pop | 2.24x faster |
| array/map-filter | 10.19x faster |
| array/reduce | 2.20x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.19x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.86x faster |
| mixed/csv-parse | 42.02x faster |
| mixed/text-search | 28.77x faster |
| mixed/matrix-multiply | 2.56x faster |
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
| string/concat-short | 1320.3ms | 1264.8ms | — |
| string/concat-long | 681.4ms | 1092.5ms | — |
| string/indexOf | 606.9ms | 1101.2ms | — |
| string/includes | 602.8ms | 1096.1ms | — |
| string/split | 764.6ms | 1038.9ms | — |
| string/replace | 600.3ms | 1073.9ms | — |
| string/case-convert | 597.7ms | 1393.3ms | — |
| string/substring | 589.9ms | 898.7ms | — |
| string/trim | 573.0ms | 1040.3ms | — |
| string/startsWith-endsWith | 669.1ms | 1043.3ms | — |
| array/push-pop | 751.2ms | 836.1ms | — |
| array/sort-i32 | 868.5ms | — | — |
| array/map-filter | 972.7ms | 977.5ms | — |
| array/reduce | 832.1ms | 932.8ms | — |
| array/indexOf | 781.8ms | 897.1ms | — |
| array/slice | 788.8ms | 857.4ms | — |
| array/reverse | 793.3ms | 868.5ms | — |
| array/forEach | 896.5ms | 945.9ms | — |
| array/find | 909.1ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 807.1ms | 1023.1ms | — |
| mixed/text-search | 749.5ms | 1087.5ms | — |
| mixed/fibonacci | 727.5ms | — | 745.9ms |
| mixed/matrix-multiply | 885.4ms | 949.3ms | 810.9ms |
| mixed/sieve | 862.3ms | 948.9ms | — |
