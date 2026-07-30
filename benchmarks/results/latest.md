# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.019ms | 0.071ms | 0.041ms | — | js |
| string/concat-long | 0.006ms | 0.017ms | 0.014ms | — | js |
| string/indexOf | 0.022ms | 0.727ms | 0.041ms | — | js |
| string/includes | 0.029ms | 0.700ms | 0.062ms | — | js |
| string/split | 0.402ms | 22.42ms | 1.09ms | — | js |
| string/replace | 0.040ms | 0.894ms | 0.148ms | — | js |
| string/case-convert | <0.001ms | 1.17ms | 4.72ms | — | js |
| string/substring | 0.004ms | 6.35ms | 0.020ms | — | js |
| string/trim | 0.153ms | 5.72ms | 0.540ms | — | js |
| string/startsWith-endsWith | 0.412ms | 13.00ms | 0.742ms | — | js |
| array/push-pop | 1.69ms | 2.20ms | 0.972ms | — | gc-native |
| array/sort-i32 | 0.843ms | 1266.4ms | — | — | js |
| array/map-filter | 0.145ms | 0.656ms | 0.050ms | — | gc-native |
| array/reduce | 2.43ms | 2.22ms | 0.999ms | — | gc-native |
| array/indexOf | 4.45ms | 3.81ms | 2.88ms | — | gc-native |
| array/slice | 0.035ms | 0.043ms | 0.024ms | — | gc-native |
| array/reverse | 8.85ms | 3.66ms | 4.42ms | — | host-call |
| array/forEach | 0.108ms | 0.086ms | 0.035ms | — | gc-native |
| array/find | 0.281ms | 0.453ms | — | — | js |
| dom/create-elements | 0.040ms | — | — | — | js |
| dom/set-attributes | 0.120ms | — | — | — | js |
| dom/read-attributes | 0.074ms | — | — | — | js |
| dom/modify-text | 0.049ms | — | — | — | js |
| mixed/csv-parse | 0.456ms | 37.15ms | 1.39ms | — | js |
| mixed/text-search | 0.234ms | 27.15ms | 1.09ms | — | js |
| mixed/fibonacci | 0.117ms | 0.265ms | — | 1.30ms | js |
| mixed/matrix-multiply | 0.185ms | 0.497ms | 0.199ms | 2.03ms | js |
| mixed/sieve | 1.86ms | 2.37ms | 2.59ms | — | js |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 3.80x slower | 2.21x slower | — |
| string/concat-long | 2.92x slower | 2.43x slower | — |
| string/indexOf | 32.65x slower | 1.83x slower | — |
| string/includes | 24.01x slower | 2.11x slower | — |
| string/split | 55.81x slower | 2.72x slower | — |
| string/replace | 22.18x slower | 3.67x slower | — |
| string/case-convert | 1944.84x slower | 7850.77x slower | — |
| string/substring | 1560.54x slower | 4.92x slower | — |
| string/trim | 37.47x slower | 3.54x slower | — |
| string/startsWith-endsWith | 31.57x slower | 1.80x slower | — |
| array/push-pop | 1.30x slower | 1.74x faster | — |
| array/sort-i32 | 1503.11x slower | — | — |
| array/map-filter | 4.54x slower | 2.91x faster | — |
| array/reduce | 1.09x faster | 2.43x faster | — |
| array/indexOf | 1.17x faster | 1.54x faster | — |
| array/slice | 1.24x slower | 1.45x faster | — |
| array/reverse | 2.42x faster | 2.00x faster | — |
| array/forEach | 1.26x faster | 3.06x faster | — |
| array/find | 1.61x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 81.41x slower | 3.04x slower | — |
| mixed/text-search | 115.99x slower | 4.67x slower | — |
| mixed/fibonacci | 2.25x slower | — | 11.10x slower |
| mixed/matrix-multiply | 2.69x slower | 1.08x slower | 10.99x slower |
| mixed/sieve | 1.27x slower | 1.39x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.72x faster |
| string/concat-long | 1.20x faster |
| string/indexOf | 17.79x faster |
| string/includes | 11.38x faster |
| string/split | 20.54x faster |
| string/replace | 6.05x faster |
| string/case-convert | 4.04x slower |
| string/substring | 317.02x faster |
| string/trim | 10.59x faster |
| string/startsWith-endsWith | 17.53x faster |
| array/push-pop | 2.27x faster |
| array/map-filter | 13.19x faster |
| array/reduce | 2.22x faster |
| array/indexOf | 1.32x faster |
| array/slice | 1.80x faster |
| array/reverse | 1.21x slower |
| array/forEach | 2.42x faster |
| mixed/csv-parse | 26.74x faster |
| mixed/text-search | 24.85x faster |
| mixed/matrix-multiply | 2.50x faster |
| mixed/sieve | 1.09x slower |

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
| array/map-filter | 2.4KB | 2.5KB | — |
| array/reduce | 1.7KB | 2.2KB | — |
| array/indexOf | 1022B | 1.5KB | — |
| array/slice | 1.0KB | 1.5KB | — |
| array/reverse | 1.0KB | 1.5KB | — |
| array/forEach | 1.8KB | 2.4KB | — |
| array/find | 2.0KB | — | — |
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
| string/concat-short | 1206.3ms | 1147.7ms | — |
| string/concat-long | 602.9ms | 1017.0ms | — |
| string/indexOf | 548.4ms | 1000.5ms | — |
| string/includes | 550.0ms | 979.5ms | — |
| string/split | 718.9ms | 973.7ms | — |
| string/replace | 556.3ms | 995.9ms | — |
| string/case-convert | 529.7ms | 1246.4ms | — |
| string/substring | 542.9ms | 818.1ms | — |
| string/trim | 532.8ms | 934.7ms | — |
| string/startsWith-endsWith | 613.5ms | 970.4ms | — |
| array/push-pop | 752.8ms | 795.5ms | — |
| array/sort-i32 | 819.0ms | — | — |
| array/map-filter | 910.8ms | 928.4ms | — |
| array/reduce | 765.7ms | 884.7ms | — |
| array/indexOf | 708.0ms | 804.2ms | — |
| array/slice | 734.0ms | 803.6ms | — |
| array/reverse | 728.0ms | 801.4ms | — |
| array/forEach | 816.6ms | 903.1ms | — |
| array/find | 852.1ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 761.4ms | 989.4ms | — |
| mixed/text-search | 660.5ms | 1043.3ms | — |
| mixed/fibonacci | 668.8ms | — | 761.2ms |
| mixed/matrix-multiply | 817.1ms | 918.6ms | 801.5ms |
| mixed/sieve | 828.1ms | 869.4ms | — |
