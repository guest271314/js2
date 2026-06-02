// Uses JSON.stringify which is on the allowlist (and tracked by #1470).
// Verifies that strict mode accepts allowlisted imports — JSON_stringify is
// tolerated during the dual-mode transition until #1470 retires it.
export function main(obj: object): string {
  return JSON.stringify(obj);
}
