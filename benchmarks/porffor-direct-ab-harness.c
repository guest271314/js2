// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

#include <stdint.h>
#include <stdio.h>
#include <sys/resource.h>
#include <time.h>

#ifndef JS2_AB_ITERATIONS
#define JS2_AB_ITERATIONS 200000
#endif

void js2_ab_init(int argc, char **argv, void *stack_top);
double js2_ab_kernel(double seed);

static uint64_t js2_ab_process_cpu_ns(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &value) != 0) return UINT64_MAX;
  return (uint64_t)value.tv_sec * 1000000000ull + (uint64_t)value.tv_nsec;
}

static uint64_t js2_ab_peak_rss_bytes(void) {
  struct rusage usage;
  if (getrusage(RUSAGE_SELF, &usage) != 0) return UINT64_MAX;
#if defined(__APPLE__)
  return (uint64_t)usage.ru_maxrss;
#else
  return (uint64_t)usage.ru_maxrss * 1024ull;
#endif
}

int main(int argc, char **argv) {
  volatile int stack_anchor = 0;
  js2_ab_init(argc, argv, (void *)&stack_anchor);

  const double fixed0 = js2_ab_kernel(-7.0);
  const double fixed1 = js2_ab_kernel(0.0);
  const double fixed2 = js2_ab_kernel(4.0);
  const double fixed3 = js2_ab_kernel(31.0);

  volatile double checksum = 0.0;
  const uint64_t started = js2_ab_process_cpu_ns();
  if (started == UINT64_MAX) return 2;
  for (int index = 0; index < JS2_AB_ITERATIONS; index++) {
    const double seed = (double)((index * 17) % 257 - 128);
    checksum += js2_ab_kernel(seed);
  }
  const uint64_t finished = js2_ab_process_cpu_ns();
  const uint64_t peak_rss = js2_ab_peak_rss_bytes();
  if (finished == UINT64_MAX || peak_rss == UINT64_MAX) return 3;

  printf(
      "{\"iterations\":%d,\"runtimeCpuNs\":%llu,\"peakRssBytes\":%llu,"
      "\"fixedOutputs\":[%.17g,%.17g,%.17g,%.17g],\"checksumDecimal\":\"%.17g\"}\n",
      JS2_AB_ITERATIONS, (unsigned long long)(finished - started), (unsigned long long)peak_rss, fixed0, fixed1,
      fixed2, fixed3, checksum);
  return 0;
}
