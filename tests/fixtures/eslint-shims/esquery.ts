// #2693 host-delegate shim for `esquery` (native compile blocked, #2700). eslint
// touches only esquery.parse + esquery.matches (lib/linter/esquery.js); both
// delegate to the real Node esquery. Parse being host-delegated too means the
// nodes/selectors are host objects, so host esquery operates on them natively.
declare function __host_esquery_parse(selector: string): unknown;
declare function __host_esquery_matches(node: unknown, selector: unknown, ancestry: unknown, options: unknown): boolean;

export function parse(selector: string): unknown {
  return __host_esquery_parse(selector);
}
export function matches(node: unknown, selector: unknown, ancestry: unknown, options: unknown): boolean {
  return __host_esquery_matches(node, selector, ancestry, options);
}
