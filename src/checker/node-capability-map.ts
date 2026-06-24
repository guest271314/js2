// #2634 — @types/node → capability-map extraction (Phase 2 of #1772).
//
// The type surface of `@types/node` is thousands of members, but only the
// subset with a runtime **provider** (a `.wat` shim, an `edge.js` adapter, or a
// WASI mapping) is *linkable*. Without a capability gate a program type-checks
// against the full `@types/node` surface, then fails to **link** with an opaque
// error when it calls a member no provider satisfies.
//
// This module is the single source of truth for that gate. Each entry maps a
// `@types/node` member → its faithful (overloaded) declaration → the providers
// that can satisfy it at runtime. The checker (`buildNodeEnvDts`) consumes this
// to emit ONLY the runtime-satisfiable surface with faithful types, and codegen
// raises a precise "no provider" error for a member that is typed but
// unsatisfiable under the active target.
//
// Design goals:
//   1. **Faithful, not approximate** — the declaration text mirrors the real
//      `@types/node` signatures (verified against `node_modules/@types/node/
//      fs.d.ts`), including every overload and the precise `NodeJS.ArrayBufferView`
//      buffer type. The approximate single-signature hand-roll (#2631) is gone.
//   2. **Data, not code** — adding `node:process` / `node:os` members later is a
//      new entry in `NODE_CAPABILITY_MAP`, not a code change. The injector and
//      the deliberate-error path read the map generically.
//   3. **allowJs-safe overloads** — faithful overloads use bodiless
//      `export function` declarations. Those are illegal in a `.ts`/`.js`
//      (non-declaration) file (TS8017), but the surface is injected as a
//      `.d.ts`-typed synthetic source where overloads ARE legal; the user's
//      import site only *references* the names, so TS8017 never fires there.
//      See `buildNodeEnvDts` in `src/checker/index.ts`.

/**
 * A provider that can satisfy a member at link time. Informational today
 * (drives the deliberate-error message + future link wiring); the active set is
 * target-dependent (`providersFor`).
 */
export type NodeProvider =
  | "wasi-fd" // fd_read / fd_write via the node:fs shim (#2631 ABI) — no filesystem
  | "wasi-fs" // path_open / preopens — a real WASI filesystem (not standalone)
  | "js-host-fs" // the real `node:fs` under a JS host, gated behind `--allow-fs`
  | "edge-adapter"; // an `edge.js` host adapter (#1772 Phase 1)

/** The compilation target surface a capability decision depends on. */
export interface CapabilityTarget {
  /** `--target wasi` (standalone WASI: fd IO yes, filesystem no). */
  wasi: boolean;
  /** `--allow-fs` — JS-host filesystem access is permitted. */
  allowFs: boolean;
}

export interface NodeMemberCapability {
  /** The exported member name (e.g. `readSync`). */
  name: string;
  /**
   * Faithful `.d.ts` declaration body for this member — one or more bodiless
   * `export function` overloads, mirroring `@types/node`. Injected verbatim into
   * the synthetic `node:<mod>` declaration module. Types reference only globals
   * available in the checker's loaded lib surface plus the `__NodeFs*` aliases
   * emitted by the module's `supportDecls`.
   */
  decls: string;
  /**
   * Providers that can satisfy this member, as a function of the active target.
   * A member is *satisfiable* under a target iff `providersFor(target)` is
   * non-empty. Empty ⇒ deliberate "no provider" compile error.
   */
  providersFor: (target: CapabilityTarget) => NodeProvider[];
}

export interface NodeModuleCapability {
  /** The bare module specifier, e.g. `node:fs`. */
  module: string;
  /**
   * Shared declaration preamble (interfaces / type aliases) emitted ONCE before
   * the member decls when at least one member of this module is imported.
   */
  supportDecls: string;
  /** Capability entry per exported member. */
  members: Map<string, NodeMemberCapability>;
}

// ---------------------------------------------------------------------------
// node:fs
// ---------------------------------------------------------------------------

// Mirror of the `@types/node` buffer-view + encoding types the fs signatures
// reference. The checker does NOT load `@types/node` (it uses an in-memory lib
// host), so we re-declare the minimal `NodeJS.ArrayBufferView` union and
// `BufferEncoding` against the TypedArray/DataView globals the lib surface DOES
// provide. `NodeJS.ArrayBufferView = TypedArray | DataView` (verified against
// node_modules/@types/node/globals.typedarray.d.ts) — so `DataView`, `Uint8Array`,
// and every other TypedArray are accepted (closing fidelity gap #2: the old
// hand-roll narrowed the buffer to `Uint8Array`, wrongly rejecting `DataView`).
const NODE_FS_SUPPORT_DECLS = `  type __NodeFsArrayBufferView =
    | Int8Array | Uint8Array | Uint8ClampedArray
    | Int16Array | Uint16Array
    | Int32Array | Uint32Array
    | Float32Array | Float64Array
    | BigInt64Array | BigUint64Array
    | DataView;
  type __NodeFsReadPosition = number | bigint;
  type __NodeFsBufferEncoding =
    | "ascii" | "utf8" | "utf-8" | "utf16le" | "utf-16le"
    | "ucs2" | "ucs-2" | "base64" | "base64url"
    | "latin1" | "binary" | "hex";
  interface __NodeFsReadSyncOptions {
    offset?: number;
    length?: number;
    position?: __NodeFsReadPosition | null;
  }`;

// `readSync` — TWO faithful overloads (positional + options), mirroring
// `@types/node` fs.d.ts. Closes fidelity gap #1 (the old hand-roll collapsed
// both into one signature that also accepted nonsensical mixes).
const FS_READ_SYNC_DECLS = `  export function readSync(
    fd: number,
    buffer: __NodeFsArrayBufferView,
    offset: number,
    length: number,
    position: __NodeFsReadPosition | null,
  ): number;
  export function readSync(
    fd: number,
    buffer: __NodeFsArrayBufferView,
    opts?: __NodeFsReadSyncOptions,
  ): number;`;

// `writeSync` — a buffer overload AND a STRING overload, mirroring
// `@types/node`. Closes fidelity gap #1 (the old hand-roll had no string form).
const FS_WRITE_SYNC_DECLS = `  export function writeSync(
    fd: number,
    buffer: __NodeFsArrayBufferView,
    offset?: number | null,
    length?: number | null,
    position?: number | null,
  ): number;
  export function writeSync(
    fd: number,
    str: string,
    position?: number | null,
    encoding?: __NodeFsBufferEncoding | null,
  ): number;`;

/**
 * The anchor `node:fs` members. `readSync` / `writeSync` are fd-based and
 * linkable per the Phase-0 ABI (`docs/architecture/node-fs-abi.md`): under
 * `--target wasi` they lower to fd_read / fd_write through the `node:fs` shim,
 * and under a JS host the real `node:fs` provides them. The path-based family
 * (`readFileSync`, `openSync`, …) needs a real filesystem — satisfiable only
 * with `--allow-fs` (JS host) or a WASI filesystem, and a deliberate compile
 * error otherwise (standalone WASI has no `path_open` / preopens).
 */
const FS_MEMBERS: NodeMemberCapability[] = [
  {
    name: "readSync",
    decls: FS_READ_SYNC_DECLS,
    // fd-based: always linkable (wasi-fd shim, or the JS host's node:fs).
    providersFor: (t) => (t.wasi ? ["wasi-fd"] : ["js-host-fs"]),
  },
  {
    name: "writeSync",
    decls: FS_WRITE_SYNC_DECLS,
    providersFor: (t) => (t.wasi ? ["wasi-fd"] : ["js-host-fs"]),
  },
];

// Path-based fs members: typed in `@types/node`, but NOT satisfiable under
// standalone `--target wasi` (no filesystem). Satisfiable with `--allow-fs`
// (JS host) or a real WASI filesystem. Listed so the deliberate-error path can
// distinguish "typed-but-unsatisfiable here" from "unknown member". They are
// emitted as `any` in the surface (they still type-check) and the precise
// "no provider" error is raised at codegen for the active target (#2631).
export const FS_PATH_BASED_MEMBERS = [
  "readFileSync",
  "readFile",
  "writeFile",
  "appendFileSync",
  "appendFile",
  "openSync",
  "open",
  "unlinkSync",
  "unlink",
  "mkdirSync",
  "mkdir",
  "readdirSync",
  "readdir",
  "statSync",
  "stat",
  "existsSync",
] as const;

function buildFsCapability(): NodeModuleCapability {
  const members = new Map<string, NodeMemberCapability>();
  for (const m of FS_MEMBERS) members.set(m.name, m);
  for (const name of FS_PATH_BASED_MEMBERS) {
    members.set(name, {
      name,
      // Path-based members stay permissive `any` in the type surface (they
      // type-check), but carry no fd-based provider — codegen raises the precise
      // "no provider under --target wasi" error (#2631) when the target can't
      // satisfy them.
      decls: `  export const ${name}: any;`,
      providersFor: (t) => {
        const ps: NodeProvider[] = [];
        if (t.allowFs) ps.push("js-host-fs");
        // standalone WASI has no filesystem (no path_open / preopens) — no
        // `wasi-fs` provider exists yet, so path-based members are unsatisfiable
        // under `--target wasi` without `--allow-fs`.
        return ps;
      },
    });
  }
  return { module: "node:fs", supportDecls: NODE_FS_SUPPORT_DECLS, members };
}

// ---------------------------------------------------------------------------
// Registry — one entry per supported `node:<mod>`. Extend here (data) to add
// `node:process` / `node:os` members later, NOT in the checker code.
// ---------------------------------------------------------------------------

const NODE_CAPABILITY_MAP = new Map<string, NodeModuleCapability>([["node:fs", buildFsCapability()]]);

/** Look up the capability entry for a `node:<mod>` specifier, if mapped. */
export function getModuleCapability(module: string): NodeModuleCapability | undefined {
  return NODE_CAPABILITY_MAP.get(module);
}

/** Is `member` a known (mapped) member of `module`? */
export function isKnownMember(module: string, member: string): boolean {
  return NODE_CAPABILITY_MAP.get(module)?.members.has(member) ?? false;
}

/**
 * Is `member` of `module` satisfiable under `target`? `false` for a member that
 * is typed in `@types/node` but has no provider under the active target (the
 * deliberate-error case). Returns `undefined` for an unknown member (caller
 * decides — usually permissive).
 */
export function isMemberSatisfiable(module: string, member: string, target: CapabilityTarget): boolean | undefined {
  const cap = NODE_CAPABILITY_MAP.get(module)?.members.get(member);
  if (!cap) return undefined;
  return cap.providersFor(target).length > 0;
}

/**
 * Build the `.d.ts` body lines for a `node:<mod>` module, scoped to the
 * `imported` member names. Emits the module's support decls once, then a
 * faithful (overloaded) declaration per imported member that the map knows,
 * falling back to permissive `any` for members outside the map. Returns
 * `undefined` if the module is not in the capability map (caller falls back to
 * the permissive generic module shape).
 */
export function buildModuleDecls(module: string, imported: Iterable<string>): string[] | undefined {
  const cap = NODE_CAPABILITY_MAP.get(module);
  if (!cap) return undefined;
  const lines: string[] = [cap.supportDecls];
  for (const name of imported) {
    if (name === "") continue; // default / namespace handled by the caller
    const member = cap.members.get(name);
    if (member) lines.push(member.decls);
    else lines.push(`  export const ${name}: any;`); // unmapped member stays permissive
  }
  return lines;
}
