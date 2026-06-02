// FizzBuzz in pure arithmetic — no string concat in the print path, so it
// fits the dual-mode constraint while exercising loop / branch codegen.
// Used by `tests/host-import-allowlist-gate.test.ts` (#1524) to verify a
// non-trivial program still compiles under `--no-host-imports`.
export function fizzbuzz(n: number): number {
  // Returns an integer signature of the run:
  //   +1 for a "FizzBuzz" tick, +2 for "Fizz", +3 for "Buzz", +0 for the
  //   number itself. Used as a smoke-test exit code (not the literal output).
  let sig = 0;
  for (let i = 1; i <= n; i++) {
    if (i % 15 === 0) {
      sig = sig + 1;
    } else if (i % 3 === 0) {
      sig = sig + 2;
    } else if (i % 5 === 0) {
      sig = sig + 3;
    }
  }
  return sig;
}

export function main(): number {
  return fizzbuzz(30);
}
