// Emit-identity corpus (#3105): a linear-backend-safe program that exercises all
// four hash-table runtimes (string Map/Set + numeric Map/Set) so the
// open-addressing hash-probe scaffolds in src/codegen-linear/runtime.ts are
// present in the emitted binary. Without a linear-compilable corpus file the
// `linear` target in scripts/prove-emit-identity.mjs is vacuous (every
// website/playground example is DOM/Promise-oriented and fails under linear).
//
// Kept DOM-free / Promise-free / class-field-free so it also compiles under the
// gc, standalone, and wasi targets.

export function run(): number {
  const sm = new Map<string, number>();
  sm.set("alpha", 1);
  sm.set("beta", 2);
  sm.set("gamma", 3);
  sm.set("beta", 20); // update path
  let total = 0;
  if (sm.has("alpha")) total += sm.get("alpha");
  if (sm.has("beta")) total += sm.get("beta");
  total += sm.size;

  const ss = new Set<string>();
  ss.add("x");
  ss.add("y");
  ss.add("x"); // dup
  if (ss.has("x")) total += 1;
  total += ss.size;

  const nm = new Map<number, number>();
  nm.set(10, 100);
  nm.set(20, 200);
  nm.set(10, 111); // update path
  if (nm.has(20)) total += nm.get(20);
  total += nm.size;

  const ns = new Set<number>();
  ns.add(7);
  ns.add(8);
  ns.add(7); // dup
  if (ns.has(8)) total += 1;
  total += ns.size;

  return total;
}
