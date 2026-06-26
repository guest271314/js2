// #2693 host-delegate shim for `espree`. Compiled in place of the real parser so
// compileProject(linter.js) does NOT pull the full espree/acorn source into the
// wasm. Each entry delegates to an env host import that calls the REAL Node
// espree (node:path #1791 host-route pattern). The JS language calls
// parser.parse / parser.parseForESLint / tokenize; eslint also reads
// espree.latestEcmaVersion.
declare function __host_espree_parse(code: string, options: unknown): unknown;
declare function __host_espree_parseForESLint(code: string, options: unknown): unknown;
declare function __host_espree_tokenize(code: string, options: unknown): unknown;

export function parse(code: string, options: unknown): unknown {
  return __host_espree_parse(code, options);
}
export function parseForESLint(code: string, options: unknown): unknown {
  return __host_espree_parseForESLint(code, options);
}
export function tokenize(code: string, options: unknown): unknown {
  return __host_espree_tokenize(code, options);
}
export const latestEcmaVersion: number = 2025;
export const version: string = "11.2.0-shim";
