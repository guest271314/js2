# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.022ms | 0.080ms | 0.037ms | — | js |
| string/concat-long | 0.004ms | 0.011ms | 0.032ms | — | js |
| string/indexOf | 0.022ms | 0.723ms | 0.068ms | — | js |
| string/includes | 0.024ms | 0.706ms | 0.065ms | — | js |
| string/split | 0.399ms | 22.17ms | 1.07ms | — | js |
| string/replace | 0.042ms | 0.893ms | 0.139ms | — | js |
| string/case-convert | <0.001ms | 1.30ms | 4.39ms | — | js |
| string/substring | 0.004ms | 6.62ms | 0.024ms | — | js |
| string/trim | 0.151ms | 6.07ms | 0.513ms | — | js |
| string/startsWith-endsWith | 0.377ms | 13.61ms | 0.660ms | — | js |
| array/push-pop | 1.44ms | 1.85ms | 1.46ms | — | js |
| array/sort-i32 | 0.804ms | 1255.3ms | — | — | js |
| array/map-filter | 0.134ms | 0.607ms | 0.191ms | — | js |
| array/reduce | 2.15ms | 1.83ms | 0.820ms | — | gc-native |
| array/indexOf | 3.94ms | 3.39ms | 2.57ms | — | gc-native |
| array/slice | 0.026ms | 0.238ms | 0.022ms | — | gc-native |
| array/reverse | 7.83ms | 3.40ms | 4.31ms | — | host-call |
| array/forEach | 0.086ms | 0.082ms | 0.046ms | — | gc-native |
| array/find | 0.223ms | 0.405ms | — | — | js |
| dom/create-elements | 0.072ms | — | — | — | js |
| dom/set-attributes | 0.119ms | — | — | — | js |
| dom/read-attributes | 0.068ms | — | — | — | js |
| dom/modify-text | 0.045ms | — | — | — | js |
| mixed/csv-parse | 0.481ms | 34.44ms | 0.870ms | — | js |
| mixed/text-search | 0.213ms | 27.42ms | 0.974ms | — | js |
| mixed/fibonacci | 0.118ms | 0.226ms | — | 0.226ms | js |
| mixed/matrix-multiply | 0.156ms | 0.473ms | 0.184ms | 2.12ms | js |
| mixed/sieve | 1.59ms | 2.12ms | 1.14ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 3.64x slower | 1.67x slower | — |
| string/concat-long | 2.65x slower | 7.55x slower | — |
| string/indexOf | 32.87x slower | 3.07x slower | — |
| string/includes | 29.80x slower | 2.76x slower | — |
| string/split | 55.60x slower | 2.67x slower | — |
| string/replace | 21.08x slower | 3.29x slower | — |
| string/case-convert | 2158.03x slower | 7297.98x slower | — |
| string/substring | 1826.16x slower | 6.65x slower | — |
| string/trim | 40.24x slower | 3.40x slower | — |
| string/startsWith-endsWith | 36.10x slower | 1.75x slower | — |
| array/push-pop | 1.29x slower | 1.01x slower | — |
| array/sort-i32 | 1561.30x slower | — | — |
| array/map-filter | 4.52x slower | 1.42x slower | — |
| array/reduce | 1.17x faster | 2.62x faster | — |
| array/indexOf | 1.16x faster | 1.54x faster | — |
| array/slice | 9.34x slower | 1.14x faster | — |
| array/reverse | 2.31x faster | 1.82x faster | — |
| array/forEach | 1.05x faster | 1.89x faster | — |
| array/find | 1.82x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 71.63x slower | 1.81x slower | — |
| mixed/text-search | 128.52x slower | 4.56x slower | — |
| mixed/fibonacci | 1.92x slower | — | 1.92x slower |
| mixed/matrix-multiply | 3.03x slower | 1.18x slower | 13.62x slower |
| mixed/sieve | 1.33x slower | 1.39x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 2.17x faster |
| string/concat-long | 2.85x slower |
| string/indexOf | 10.70x faster |
| string/includes | 10.81x faster |
| string/split | 20.81x faster |
| string/replace | 6.40x faster |
| string/case-convert | 3.38x slower |
| string/substring | 274.49x faster |
| string/trim | 11.84x faster |
| string/startsWith-endsWith | 20.62x faster |
| array/push-pop | 1.27x faster |
| array/map-filter | 3.18x faster |
| array/reduce | 2.24x faster |
| array/indexOf | 1.32x faster |
| array/slice | 10.63x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.80x faster |
| mixed/csv-parse | 39.59x faster |
| mixed/text-search | 28.15x faster |
| mixed/matrix-multiply | 2.57x faster |
| mixed/sieve | 1.85x faster |

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
| string/concat-short | 1325.6ms | 1193.5ms | — |
| string/concat-long | 606.6ms | 1015.9ms | — |
| string/indexOf | 560.4ms | 1045.2ms | — |
| string/includes | 577.5ms | 984.6ms | — |
| string/split | 726.1ms | 1003.3ms | — |
| string/replace | 557.1ms | 1018.5ms | — |
| string/case-convert | 547.8ms | 1251.3ms | — |
| string/substring | 535.2ms | 850.7ms | — |
| string/trim | 544.6ms | 975.7ms | — |
| string/startsWith-endsWith | 623.2ms | 1014.4ms | — |
| array/push-pop | 750.7ms | 815.0ms | — |
| array/sort-i32 | 833.5ms | — | — |
| array/map-filter | 948.2ms | 930.8ms | — |
| array/reduce | 819.8ms | 912.3ms | — |
| array/indexOf | 758.4ms | 824.0ms | — |
| array/slice | 746.6ms | 864.7ms | — |
| array/reverse | 725.5ms | 811.0ms | — |
| array/forEach | 853.0ms | 912.0ms | — |
| array/find | 856.1ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 776.5ms | 1009.6ms | — |
| mixed/text-search | 679.1ms | 1029.9ms | — |
| mixed/fibonacci | 649.1ms | — | 652.5ms |
| mixed/matrix-multiply | 802.7ms | 866.2ms | 756.7ms |
| mixed/sieve | 807.2ms | 877.1ms | — |
