# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.019ms | 0.070ms | 0.041ms | — | js |
| string/concat-long | 0.004ms | 0.024ms | 0.014ms | — | js |
| string/indexOf | 0.023ms | 0.700ms | 0.066ms | — | js |
| string/includes | 0.023ms | 1.86ms | 0.044ms | — | js |
| string/split | 0.399ms | 22.70ms | 1.09ms | — | js |
| string/replace | 0.041ms | 0.967ms | 0.149ms | — | js |
| string/case-convert | <0.001ms | 1.16ms | 4.73ms | — | js |
| string/substring | 0.004ms | 6.10ms | 0.020ms | — | js |
| string/trim | 0.153ms | 5.50ms | 0.541ms | — | js |
| string/startsWith-endsWith | 0.412ms | 12.66ms | 0.740ms | — | js |
| array/push-pop | 1.71ms | 2.18ms | 0.954ms | — | gc-native |
| array/sort-i32 | 0.842ms | 1292.2ms | — | — | js |
| array/map-filter | 0.145ms | 0.667ms | 0.050ms | — | gc-native |
| array/reduce | 2.46ms | 2.21ms | 1.65ms | — | gc-native |
| array/indexOf | 4.45ms | 3.82ms | 2.88ms | — | gc-native |
| array/slice | 0.034ms | 0.226ms | 0.025ms | — | gc-native |
| array/reverse | 8.84ms | 3.65ms | 4.42ms | — | host-call |
| array/forEach | 0.050ms | 0.147ms | 0.037ms | — | gc-native |
| array/find | 0.280ms | 1.66ms | — | — | js |
| dom/create-elements | 0.058ms | — | — | — | js |
| dom/set-attributes | 0.122ms | — | — | — | js |
| dom/read-attributes | 0.631ms | — | — | — | js |
| dom/modify-text | 0.047ms | — | — | — | js |
| mixed/csv-parse | 0.466ms | 34.37ms | 0.898ms | — | js |
| mixed/text-search | 0.234ms | 25.98ms | 1.09ms | — | js |
| mixed/fibonacci | 0.117ms | 0.264ms | — | 1.30ms | js |
| mixed/matrix-multiply | 0.183ms | 0.498ms | 0.198ms | 2.04ms | js |
| mixed/sieve | 1.84ms | 2.38ms | 1.34ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 3.73x slower | 2.19x slower | — |
| string/concat-long | 5.77x slower | 3.50x slower | — |
| string/indexOf | 30.05x slower | 2.84x slower | — |
| string/includes | 80.03x slower | 1.89x slower | — |
| string/split | 56.91x slower | 2.74x slower | — |
| string/replace | 23.79x slower | 3.68x slower | — |
| string/case-convert | 2626.23x slower | 10733.26x slower | — |
| string/substring | 1500.56x slower | 4.91x slower | — |
| string/trim | 35.99x slower | 3.54x slower | — |
| string/startsWith-endsWith | 30.75x slower | 1.80x slower | — |
| array/push-pop | 1.28x slower | 1.79x faster | — |
| array/sort-i32 | 1535.04x slower | — | — |
| array/map-filter | 4.61x slower | 2.91x faster | — |
| array/reduce | 1.12x faster | 1.49x faster | — |
| array/indexOf | 1.17x faster | 1.54x faster | — |
| array/slice | 6.57x slower | 1.40x faster | — |
| array/reverse | 2.42x faster | 2.00x faster | — |
| array/forEach | 2.91x slower | 1.38x faster | — |
| array/find | 5.92x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 73.70x slower | 1.93x slower | — |
| mixed/text-search | 111.07x slower | 4.68x slower | — |
| mixed/fibonacci | 2.25x slower | — | 11.11x slower |
| mixed/matrix-multiply | 2.72x slower | 1.08x slower | 11.17x slower |
| mixed/sieve | 1.29x slower | 1.37x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.70x faster |
| string/concat-long | 1.65x faster |
| string/indexOf | 10.58x faster |
| string/includes | 42.25x faster |
| string/split | 20.78x faster |
| string/replace | 6.47x faster |
| string/case-convert | 4.09x slower |
| string/substring | 305.75x faster |
| string/trim | 10.16x faster |
| string/startsWith-endsWith | 17.11x faster |
| array/push-pop | 2.29x faster |
| array/map-filter | 13.43x faster |
| array/reduce | 1.34x faster |
| array/indexOf | 1.33x faster |
| array/slice | 9.20x faster |
| array/reverse | 1.21x slower |
| array/forEach | 4.00x faster |
| mixed/csv-parse | 38.27x faster |
| mixed/text-search | 23.75x faster |
| mixed/matrix-multiply | 2.51x faster |
| mixed/sieve | 1.78x faster |

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
| string/concat-short | 1238.1ms | 1168.4ms | — |
| string/concat-long | 630.5ms | 1083.7ms | — |
| string/indexOf | 682.7ms | 1006.0ms | — |
| string/includes | 566.1ms | 1041.9ms | — |
| string/split | 730.9ms | 995.9ms | — |
| string/replace | 560.5ms | 1034.4ms | — |
| string/case-convert | 550.2ms | 1268.7ms | — |
| string/substring | 529.7ms | 862.7ms | — |
| string/trim | 547.5ms | 915.3ms | — |
| string/startsWith-endsWith | 628.6ms | 971.1ms | — |
| array/push-pop | 765.7ms | 843.2ms | — |
| array/sort-i32 | 802.0ms | — | — |
| array/map-filter | 924.7ms | 941.7ms | — |
| array/reduce | 803.8ms | 890.2ms | — |
| array/indexOf | 751.4ms | 846.9ms | — |
| array/slice | 755.1ms | 836.6ms | — |
| array/reverse | 765.8ms | 816.3ms | — |
| array/forEach | 833.5ms | 991.3ms | — |
| array/find | 823.7ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 789.3ms | 978.3ms | — |
| mixed/text-search | 665.9ms | 1077.2ms | — |
| mixed/fibonacci | 659.4ms | — | 671.8ms |
| mixed/matrix-multiply | 814.6ms | 888.4ms | 792.5ms |
| mixed/sieve | 792.3ms | 890.5ms | — |
