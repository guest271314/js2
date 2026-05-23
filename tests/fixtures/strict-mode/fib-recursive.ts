// Fibonacci — recursion + arithmetic, no host calls.
export function fib(n: number): number {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}

export function main(): number {
  return fib(10);
}
