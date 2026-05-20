// Pure arithmetic kernel — should compile under strict `--no-host-imports`
// without requesting any `env` host imports.
export function compute(a: number, b: number): number {
  return a * b + (a - b) * (a + b);
}

export function main(): number {
  return compute(7, 3);
}
