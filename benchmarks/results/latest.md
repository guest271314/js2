# js2wasm Benchmark Results

Date: 2026-07-31
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.028ms | 0.048ms | 0.039ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.001ms | 0.062ms | 0.019ms | FAILED | js |
| string/includes | 0.001ms | 0.134ms | 0.014ms | FAILED | js |
| string/split | 0.402ms | 5.57ms | 0.870ms | FAILED | js |
| string/replace | 0.042ms | 0.240ms | 0.064ms | FAILED | js |
| string/case-convert | <0.001ms | 0.215ms | 0.066ms | FAILED | js |
| string/substring | 0.003ms | 1.09ms | 0.023ms | FAILED | js |
| string/trim | 0.151ms | 0.967ms | 0.164ms | FAILED | js |
| string/startsWith-endsWith | 0.246ms | 2.53ms | 0.214ms | FAILED | gc-native |
| array/push-pop | 1.46ms | 1.84ms | 0.832ms | FAILED | gc-native |
| array/sort-i32 | 0.792ms | 0.371ms | 0.333ms | FAILED | gc-native |
| array/map-filter | 0.127ms | 0.612ms | 0.060ms | FAILED | gc-native |
| array/reduce | 1.39ms | 1.84ms | 0.841ms | FAILED | gc-native |
| array/indexOf | 3.94ms | 3.38ms | 2.56ms | FAILED | gc-native |
| array/slice | 0.026ms | 0.031ms | 0.013ms | FAILED | gc-native |
| array/reverse | 7.83ms | 3.39ms | 4.31ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.081ms | 0.043ms | FAILED | gc-native |
| array/find | 0.239ms | 0.425ms | 0.317ms | 4.86ms | js |
| dom/create-elements | 0.035ms | 0.288ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.367ms | — | — | js |
| dom/read-attributes | 0.053ms | 0.191ms | — | — | js |
| dom/modify-text | 0.048ms | 0.168ms | — | — | js |
| mixed/csv-parse | 0.465ms | 7.38ms | 0.721ms | FAILED | js |
| mixed/text-search | 0.092ms | 5.68ms | 0.610ms | FAILED | js |
| mixed/fibonacci | 0.109ms | 0.227ms | 0.084ms | 0.234ms | gc-native |
| mixed/matrix-multiply | 0.157ms | 0.486ms | 0.204ms | 2.13ms | js |
| mixed/sieve | 1.59ms | 2.11ms | 1.14ms | FAILED | gc-native |

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
| string/concat-short | 1.72x slower | 1.37x slower | — |
| string/concat-long | 1.34x slower | 1.26x slower | — |
| string/indexOf | 47.51x slower | 14.59x slower | — |
| string/includes | 91.12x slower | 9.69x slower | — |
| string/split | 13.86x slower | 2.16x slower | — |
| string/replace | 5.70x slower | 1.51x slower | — |
| string/case-convert | 667.51x slower | 205.02x slower | — |
| string/substring | 350.65x slower | 7.27x slower | — |
| string/trim | 6.40x slower | 1.09x slower | — |
| string/startsWith-endsWith | 10.30x slower | 1.15x faster | — |
| array/push-pop | 1.26x slower | 1.76x faster | — |
| array/sort-i32 | 2.13x faster | 2.38x faster | — |
| array/map-filter | 4.80x slower | 2.12x faster | — |
| array/reduce | 1.32x slower | 1.65x faster | — |
| array/indexOf | 1.16x faster | 1.54x faster | — |
| array/slice | 1.22x slower | 1.90x faster | — |
| array/reverse | 2.31x faster | 1.82x faster | — |
| array/forEach | 1.67x slower | 1.12x faster | — |
| array/find | 1.78x slower | 1.33x slower | 20.35x slower |
| dom/create-elements | 8.11x slower | — | — |
| dom/set-attributes | 3.54x slower | — | — |
| dom/read-attributes | 3.57x slower | — | — |
| dom/modify-text | 3.49x slower | — | — |
| mixed/csv-parse | 15.86x slower | 1.55x slower | — |
| mixed/text-search | 61.43x slower | 6.60x slower | — |
| mixed/fibonacci | 2.08x slower | 1.30x faster | 2.14x slower |
| mixed/matrix-multiply | 3.09x slower | 1.30x slower | 13.54x slower |
| mixed/sieve | 1.33x slower | 1.39x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.25x faster |
| string/concat-long | 1.06x faster |
| string/indexOf | 3.26x faster |
| string/includes | 9.41x faster |
| string/split | 6.41x faster |
| string/replace | 3.78x faster |
| string/case-convert | 3.26x faster |
| string/substring | 48.25x faster |
| string/trim | 5.88x faster |
| string/startsWith-endsWith | 11.82x faster |
| array/push-pop | 2.21x faster |
| array/sort-i32 | 1.12x faster |
| array/map-filter | 10.18x faster |
| array/reduce | 2.19x faster |
| array/indexOf | 1.32x faster |
| array/slice | 2.32x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.87x faster |
| array/find | 1.34x faster |
| mixed/csv-parse | 10.24x faster |
| mixed/text-search | 9.31x faster |
| mixed/fibonacci | 2.71x faster |
| mixed/matrix-multiply | 2.39x faster |
| mixed/sieve | 1.85x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 1.7KB | — |
| string/concat-long | 236B | 1.9KB | — |
| string/indexOf | 216B | 2.1KB | — |
| string/includes | 236B | 2.1KB | — |
| string/split | 973B | 1.5KB | — |
| string/replace | 289B | 2.7KB | — |
| string/case-convert | 249B | 11.7KB | — |
| string/substring | 239B | 1.3KB | — |
| string/trim | 205B | 1.7KB | — |
| string/startsWith-endsWith | 330B | 1.6KB | — |
| array/push-pop | 947B | 1.4KB | — |
| array/sort-i32 | 2.7KB | 3.1KB | — |
| array/map-filter | 3.3KB | 3.3KB | — |
| array/reduce | 2.3KB | 2.8KB | — |
| array/indexOf | 1022B | 1.5KB | — |
| array/slice | 1.0KB | 1.5KB | — |
| array/reverse | 1.0KB | 1.5KB | — |
| array/forEach | 2.6KB | 3.1KB | — |
| array/find | 2.7KB | 3.2KB | 623B |
| dom/create-elements | 243B | — | — |
| dom/set-attributes | 510B | — | — |
| dom/read-attributes | 358B | — | — |
| dom/modify-text | 250B | — | — |
| mixed/csv-parse | 1.4KB | 2.9KB | — |
| mixed/text-search | 600B | 2.1KB | — |
| mixed/fibonacci | 157B | 1.1KB | 173B |
| mixed/matrix-multiply | 1.3KB | 1.8KB | 950B |
| mixed/sieve | 1.5KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1276.6ms | 1165.7ms | — |
| string/concat-long | 617.6ms | 986.0ms | — |
| string/indexOf | 573.9ms | 981.3ms | — |
| string/includes | 569.8ms | 995.4ms | — |
| string/split | 724.7ms | 947.4ms | — |
| string/replace | 547.4ms | 1061.9ms | — |
| string/case-convert | 557.2ms | 1097.1ms | — |
| string/substring | 534.2ms | 851.2ms | — |
| string/trim | 547.3ms | 987.1ms | — |
| string/startsWith-endsWith | 624.5ms | 935.3ms | — |
| array/push-pop | 755.0ms | 837.2ms | — |
| array/sort-i32 | 982.7ms | 975.5ms | — |
| array/map-filter | 940.3ms | 977.9ms | — |
| array/reduce | 867.3ms | 923.3ms | — |
| array/indexOf | 776.7ms | 853.3ms | — |
| array/slice | 757.2ms | 854.8ms | — |
| array/reverse | 756.4ms | 816.4ms | — |
| array/forEach | 884.1ms | 949.6ms | — |
| array/find | 905.7ms | 926.7ms | 814.7ms |
| dom/create-elements | 611.0ms | — | — |
| dom/set-attributes | 714.9ms | — | — |
| dom/read-attributes | 698.3ms | — | — |
| dom/modify-text | 686.1ms | — | — |
| mixed/csv-parse | 780.7ms | 1008.6ms | — |
| mixed/text-search | 710.4ms | 989.6ms | — |
| mixed/fibonacci | 674.7ms | 827.1ms | 691.6ms |
| mixed/matrix-multiply | 809.1ms | 902.7ms | 772.1ms |
| mixed/sieve | 802.4ms | 873.1ms | — |
