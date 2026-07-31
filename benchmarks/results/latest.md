# js2wasm Benchmark Results

Date: 2026-07-31
Node: v22.22.2
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.136ms | 0.126ms | 0.136ms | — | host-call |
| string/concat-long | 0.009ms | 0.014ms | 0.013ms | — | js |
| string/indexOf | 0.030ms | 1.07ms | 0.055ms | — | js |
| string/includes | 0.031ms | 1.10ms | 0.035ms | — | js |
| string/split | 0.632ms | 68.29ms | 5.58ms | — | js |
| string/replace | 0.110ms | 1.67ms | 0.363ms | — | js |
| string/case-convert | 0.155ms | 2.66ms | 14.94ms | — | js |
| string/substring | 0.146ms | 15.97ms | 0.040ms | — | gc-native |
| string/trim | 0.584ms | 12.08ms | 2.37ms | — | js |
| string/startsWith-endsWith | 0.857ms | 30.02ms | 4.83ms | — | js |
| array/push-pop | 3.48ms | 3.62ms | 2.02ms | — | gc-native |
| array/sort-i32 | 2.00ms | 2647.9ms | — | — | js |
| array/map-filter | 0.287ms | 0.895ms | 0.148ms | — | gc-native |
| array/reduce | 3.89ms | 2.77ms | 1.67ms | — | gc-native |
| array/indexOf | 5.92ms | 7.31ms | 5.54ms | — | gc-native |
| array/slice | 0.082ms | 0.149ms | 0.043ms | — | gc-native |
| array/reverse | 9.48ms | 7.31ms | 7.79ms | — | host-call |
| array/forEach | 0.111ms | 0.127ms | 0.109ms | — | gc-native |
| array/find | 0.704ms | 0.851ms | — | — | js |
| dom/create-elements | 0.139ms | — | — | — | js |
| dom/set-attributes | 0.298ms | — | — | — | js |
| dom/read-attributes | 0.200ms | — | — | — | js |
| dom/modify-text | 0.133ms | — | — | — | js |
| mixed/csv-parse | 0.729ms | 87.64ms | 2.83ms | — | js |
| mixed/text-search | 0.663ms | 51.99ms | 5.29ms | — | js |
| mixed/fibonacci | 0.308ms | 0.361ms | 0.167ms | 0.345ms | gc-native |
| mixed/matrix-multiply | 0.267ms | 1.10ms | 0.311ms | 3.18ms | js |
| mixed/sieve | 2.97ms | 4.27ms | 1.98ms | — | gc-native |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 13.60 | 12.59 | 13.55 | — |
| string/concat-long | 1000 | 8.96 | 13.86 | 13.49 | — |
| string/indexOf | 1000 | 29.82 | 1066.29 | 54.87 | — |
| string/includes | 1000 | 31.14 | 1096.92 | 35.17 | — |
| string/split | 10000 | 63.17 | 6829.14 | 557.96 | — |
| string/replace | 1000 | 110.13 | 1673.10 | 363.03 | — |
| string/case-convert | 2000 | 77.34 | 1329.32 | 7467.78 | — |
| string/substring | 10000 | 14.60 | 1597.32 | 4.02 | — |
| string/trim | 10000 | 58.38 | 1208.24 | 237.29 | — |
| string/startsWith-endsWith | 20000 | 42.85 | 1501.03 | 241.60 | — |
| mixed/csv-parse | 11000 | 66.31 | 7967.62 | 257.49 | — |
| mixed/text-search | 40000 | 16.58 | 1299.72 | 132.20 | — |
| mixed/fibonacci | 10000 | 30.82 | 36.12 | 16.69 | 34.49 |
| mixed/matrix-multiply | 125000 | 2.14 | 8.78 | 2.48 | 25.44 |
| mixed/sieve | 200000 | 14.85 | 21.35 | 9.90 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.08x faster | 1.00x faster | — |
| string/concat-long | 1.55x slower | 1.51x slower | — |
| string/indexOf | 35.75x slower | 1.84x slower | — |
| string/includes | 35.23x slower | 1.13x slower | — |
| string/split | 108.11x slower | 8.83x slower | — |
| string/replace | 15.19x slower | 3.30x slower | — |
| string/case-convert | 17.19x slower | 96.56x slower | — |
| string/substring | 109.42x slower | 3.63x faster | — |
| string/trim | 20.70x slower | 4.06x slower | — |
| string/startsWith-endsWith | 35.03x slower | 5.64x slower | — |
| array/push-pop | 1.04x slower | 1.72x faster | — |
| array/sort-i32 | 1321.02x slower | — | — |
| array/map-filter | 3.12x slower | 1.94x faster | — |
| array/reduce | 1.40x faster | 2.33x faster | — |
| array/indexOf | 1.24x slower | 1.07x faster | — |
| array/slice | 1.82x slower | 1.91x faster | — |
| array/reverse | 1.30x faster | 1.22x faster | — |
| array/forEach | 1.14x slower | 1.02x faster | — |
| array/find | 1.21x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 120.15x slower | 3.88x slower | — |
| mixed/text-search | 78.39x slower | 7.97x slower | — |
| mixed/fibonacci | 1.17x slower | 1.85x faster | 1.12x slower |
| mixed/matrix-multiply | 4.11x slower | 1.16x slower | 11.90x slower |
| mixed/sieve | 1.44x slower | 1.50x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.08x slower |
| string/concat-long | 1.03x faster |
| string/indexOf | 19.43x faster |
| string/includes | 31.19x faster |
| string/split | 12.24x faster |
| string/replace | 4.61x faster |
| string/case-convert | 5.62x slower |
| string/substring | 397.35x faster |
| string/trim | 5.09x faster |
| string/startsWith-endsWith | 6.21x faster |
| array/push-pop | 1.79x faster |
| array/map-filter | 6.06x faster |
| array/reduce | 1.66x faster |
| array/indexOf | 1.32x faster |
| array/slice | 3.46x faster |
| array/reverse | 1.06x slower |
| array/forEach | 1.17x faster |
| mixed/csv-parse | 30.94x faster |
| mixed/text-search | 9.83x faster |
| mixed/fibonacci | 2.16x faster |
| mixed/matrix-multiply | 3.53x faster |
| mixed/sieve | 2.16x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 1.7KB | — |
| string/concat-long | 236B | 1.9KB | — |
| string/indexOf | 411B | 2.1KB | — |
| string/includes | 398B | 2.1KB | — |
| string/split | 1.7KB | 3.5KB | — |
| string/replace | 1.6KB | 3.6KB | — |
| string/case-convert | 1.4KB | 12.7KB | — |
| string/substring | 448B | 1.1KB | — |
| string/trim | 1.4KB | 2.7KB | — |
| string/startsWith-endsWith | 1.8KB | 3.7KB | — |
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
| mixed/csv-parse | 2.2KB | 4.4KB | — |
| mixed/text-search | 2.0KB | 4.3KB | — |
| mixed/fibonacci | 320B | 1.1KB | 336B |
| mixed/matrix-multiply | 1.3KB | 1.8KB | 950B |
| mixed/sieve | 1.5KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 5643.9ms | 4670.1ms | — |
| string/concat-long | 1492.3ms | 3334.5ms | — |
| string/indexOf | 2846.8ms | 4610.5ms | — |
| string/includes | 2669.3ms | 4211.9ms | — |
| string/split | 2933.3ms | 4929.4ms | — |
| string/replace | 3612.3ms | 7217.4ms | — |
| string/case-convert | 3911.7ms | 5989.8ms | — |
| string/substring | 3281.8ms | 4231.3ms | — |
| string/trim | 5076.2ms | 5884.7ms | — |
| string/startsWith-endsWith | 4957.5ms | 5983.3ms | — |
| array/push-pop | 3393.5ms | 3945.4ms | — |
| array/sort-i32 | 3935.5ms | — | — |
| array/map-filter | 3863.1ms | 4663.1ms | — |
| array/reduce | 3148.0ms | 4413.0ms | — |
| array/indexOf | 2609.9ms | 2913.6ms | — |
| array/slice | 3357.1ms | 2390.7ms | — |
| array/reverse | 1697.5ms | 2544.9ms | — |
| array/forEach | 2590.8ms | 5160.8ms | — |
| array/find | 3481.4ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 2630.3ms | 4468.9ms | — |
| mixed/text-search | 2529.9ms | 4102.5ms | — |
| mixed/fibonacci | 2187.7ms | 2147.7ms | 1908.6ms |
| mixed/matrix-multiply | 2879.7ms | 3161.5ms | 2506.5ms |
| mixed/sieve | 2952.0ms | 2759.6ms | — |
