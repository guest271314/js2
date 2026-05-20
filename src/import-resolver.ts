// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts, forEachChild } from "./ts-api.js";

interface ClassUsageInfo {
  constructorArgCounts: number[];
  properties: Set<string>;
  methods: Map<string, number>; // method name → max arg count
}

interface NestedNamespaceInfo {
  properties: Set<string>;
  methods: Map<string, number>; // method name → max arg count
}

/** Recognized Node.js builtin module specifiers (#1044). */
export const NODE_BUILTIN_MODULES = new Set([
  "http",
  "https",
  "http2",
  "url",
  "querystring",
  "stream",
  "stream/web",
  "events",
  "buffer",
  "zlib",
  "util",
  "path",
  "process",
  "net",
  "tls",
  "fs",
  "crypto",
  "os",
  "child_process",
  "assert",
  "dns",
  "dgram",
  "cluster",
  "readline",
  "string_decoder",
  "timers",
  "tty",
  "vm",
  "worker_threads",
  "perf_hooks",
  "async_hooks",
  "diagnostics_channel",
  "console",
]);

/** Returns true if `spec` is a recognized Node.js builtin (with or without `node:` prefix). */
export function isNodeBuiltin(spec: string): boolean {
  return NODE_BUILTIN_MODULES.has(spec.replace(/^node:/, ""));
}

/** Normalizes a module specifier by stripping the `node:` prefix if present. */
export function normalizeNodeBuiltin(spec: string): string {
  return spec.replace(/^node:/, "");
}

/** Info about a Node builtin import discovered during preprocessing. */
export interface NodeBuiltinImport {
  /** The local binding name (e.g., `http` from `import http from 'node:http'`). */
  localName: string;
  /** The normalized module name (e.g., `http`). */
  moduleName: string;
  /** Named bindings imported (e.g., `['createServer', 'get']` from `import { createServer, get } from 'http'`). */
  namedBindings?: string[];
}

/** Result of `preprocessImports`. */
export interface PreprocessResult {
  /** The transformed source code with import stubs. */
  source: string;
  /** Node builtin modules detected during preprocessing. */
  nodeBuiltins: NodeBuiltinImport[];
}

/**
 * Pre-process source code to replace import statements with auto-generated
 * declare blocks based on usage analysis.
 *
 * Handles:
 * - `import * as X from "mod"` → `declare namespace X { ... }`
 * - `import X from "mod"` → `declare const X: any;`
 * - `import { a, b } from "mod"` → `declare function a(...): any;` or `declare const a: any;`
 */
/**
 * #1501 — Timer host-import shim.
 *
 * Bare identifiers `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval`
 * are global functions on the JS host but unbound from compiled Wasm — the
 * `declared_global` resolver returns a getter, not a callable, so user
 * `setTimeout(cb, 100)` calls silently no-op (in the best case) or pass a
 * WasmGC closure to `globalThis.setTimeout`, which the host coerces to
 * `"[object Object]"` and the timer never fires.
 *
 * The shim below replaces those identifiers with `function` declarations
 * that delegate to `__timer_set_timeout` / `__timer_clear_interval` host
 * imports. Those names are classified by `compiler/import-manifest.ts` into
 * the `timer_set` / `timer_clear` `ImportIntent` variants, and
 * `runtime.resolveImport` binds them to `globalThis.{set,clear}{Timeout,
 * Interval}` (with the same `_wrapWasmClosure` callback-bridging
 * machinery future-proofed for #1382).
 *
 * Scope: this is the "doesn't crash" passthrough path requested by the
 * tech lead while #1382 (Wasm closure → JS-callable bridge) is in flight.
 * `clearTimeout` / `clearInterval` already work end-to-end (the handle is
 * an externref that round-trips); `setTimeout` / `setInterval` callbacks
 * will fire fully once #1382 lands.
 */
const TIMER_SHIM_FNS = ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] as const;

function detectTimerCallSites(sf: ts.SourceFile): Set<string> {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if ((TIMER_SHIM_FNS as readonly string[]).includes(name)) {
        found.add(name);
      }
    }
    forEachChild(node, visit);
  };
  for (const stmt of sf.statements) {
    forEachChild(stmt, visit);
  }
  return found;
}

function buildTimerShim(used: Set<string>, definedNames: Set<string>): string {
  if (used.size === 0) return "";
  const lines: string[] = [];
  const hostFor: Record<string, string> = {
    setTimeout: "__timer_set_timeout",
    setInterval: "__timer_set_interval",
    clearTimeout: "__timer_clear_timeout",
    clearInterval: "__timer_clear_interval",
  };
  // declares + wrapper functions. Skip any name that the user has already
  // defined to avoid shadowing user functions.
  for (const name of TIMER_SHIM_FNS) {
    if (!used.has(name) || definedNames.has(name)) continue;
    const hostName = hostFor[name]!;
    if (name === "clearTimeout" || name === "clearInterval") {
      lines.push(`declare function ${hostName}(h: any): void;`);
      lines.push(`function ${name}(h: any): void { ${hostName}(h); }`);
    } else {
      lines.push(`declare function ${hostName}(cb: any, ms: any): any;`);
      lines.push(`function ${name}(cb: any, ms: any): any { return ${hostName}(cb, ms); }`);
    }
  }
  if (lines.length === 0) return "";
  return `// #1501 timer host-import shim (auto-injected)\n${lines.join("\n")}\n`;
}

export function preprocessImports(source: string): PreprocessResult {
  const sf = ts.createSourceFile("__preprocess__.ts", source, ts.ScriptTarget.Latest, true);

  // #1501 — detect bare-identifier calls to timer globals BEFORE the early
  // return for source-without-imports, so a file that uses `setTimeout`
  // without any `import` statements still gets the shim. (The
  // `definedNames` reachable at this point includes the same scan used
  // below for the existing import resolution path.)
  const timerCalls = detectTimerCallSites(sf);

  // Step 1: Find all imports
  const nsImports = new Map<string, { start: number; end: number; moduleSpec: string }>();
  const otherImports: {
    start: number;
    end: number;
    defaultName?: string;
    namedBindings?: string[];
    moduleSpec: string;
  }[] = [];
  const nodeBuiltins: NodeBuiltinImport[] = [];

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;

    // Import attributes (TS 5.3+ / TS7) — `import x from "m" with { type: "json" }`.
    // We don't yet resolve JSON imports at compile time (tracked as a
    // follow-up to #1288 — JSON imports COULD be inlined statically by reading
    // the JSON file at compile time, but that's out of scope for the shim).
    // Per #1288: emit a one-line note and continue; do NOT throw. The TS7
    // native-preview parser surfaces this shape unconditionally, and TS5 has
    // supported the syntax since 5.3.
    const attrs = (stmt as ts.ImportDeclaration & { attributes?: { elements?: readonly unknown[] } }).attributes;
    if (attrs && Array.isArray(attrs.elements) && attrs.elements.length > 0) {
      const spec = ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : "<unknown>";
      console.warn(
        `[js2wasm] Import attributes on \`${spec}\` are accepted but not yet acted on (#1288); ` +
          `the import is processed as if no attributes were present. JSON inlining tracked as a follow-up.`,
      );
    }

    const moduleSpec = ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : "";
    const clause = stmt.importClause;
    if (!clause) {
      // Side-effect import: `import "mod"` — just remove
      otherImports.push({ start: stmt.getStart(sf), end: stmt.end, moduleSpec });
      continue;
    }

    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      // import * as X from "mod"
      const name = clause.namedBindings.name.text;
      nsImports.set(name, { start: stmt.getStart(sf), end: stmt.end, moduleSpec });
      if (isNodeBuiltin(moduleSpec)) {
        nodeBuiltins.push({ localName: name, moduleName: normalizeNodeBuiltin(moduleSpec) });
      }
      continue;
    }

    // Default and/or named imports
    const defaultName = clause.name?.text;
    const namedBindings: string[] = [];
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        namedBindings.push(el.name.text);
      }
    }
    otherImports.push({
      start: stmt.getStart(sf),
      end: stmt.end,
      defaultName,
      namedBindings: namedBindings.length > 0 ? namedBindings : undefined,
      moduleSpec,
    });
    if (isNodeBuiltin(moduleSpec)) {
      nodeBuiltins.push({
        localName: defaultName || namedBindings[0] || normalizeNodeBuiltin(moduleSpec),
        moduleName: normalizeNodeBuiltin(moduleSpec),
        namedBindings: namedBindings.length > 0 ? namedBindings : undefined,
      });
    }
  }

  // #1501 — Build the timer shim if the source uses any timer call site.
  // The shim is prepended to the (possibly otherwise-unchanged) source.
  // We compute `definedNames` before the early-return so the shim can
  // skip any timer name the user has already defined locally.
  const definedNames = new Set<string>();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      definedNames.add(stmt.name.text);
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          definedNames.add(decl.name.text);
        }
      }
    }
    if (ts.isClassDeclaration(stmt) && stmt.name) {
      definedNames.add(stmt.name.text);
    }
  }
  const timerShim = buildTimerShim(timerCalls, definedNames);

  if (nsImports.size === 0 && otherImports.length === 0) {
    return { source: timerShim ? timerShim + source : source, nodeBuiltins };
  }

  // Step 2: Analyze usage for namespace imports
  const namespaces = new Map<string, Map<string, ClassUsageInfo>>();
  const nestedNs = new Map<string, Map<string, NestedNamespaceInfo>>();
  for (const ns of nsImports.keys()) {
    namespaces.set(ns, new Map());
    nestedNs.set(ns, new Map());
  }

  // Track typed variables: varName → { ns, className }
  const typedVars = new Map<string, { ns: string; className: string }>();

  // Track which named/default imports are called as functions
  const calledAsFunction = new Set<string>();
  const maxCallArgs = new Map<string, number>();

  function getOrCreateClass(ns: string, className: string): ClassUsageInfo {
    const classes = namespaces.get(ns)!;
    if (!classes.has(className)) {
      classes.set(className, {
        constructorArgCounts: [],
        properties: new Set(),
        methods: new Map(),
      });
    }
    return classes.get(className)!;
  }

  function getOrCreateNestedNs(ns: string, subNs: string): NestedNamespaceInfo {
    const map = nestedNs.get(ns)!;
    if (!map.has(subNs)) {
      map.set(subNs, { properties: new Set(), methods: new Map() });
    }
    return map.get(subNs)!;
  }

  function tryResolveQualifiedName(typeRef: ts.TypeReferenceNode): { ns: string; className: string } | null {
    if (ts.isQualifiedName(typeRef.typeName)) {
      if (ts.isIdentifier(typeRef.typeName.left) && nsImports.has(typeRef.typeName.left.text)) {
        return {
          ns: typeRef.typeName.left.text,
          className: typeRef.typeName.right.text,
        };
      }
    }
    return null;
  }

  function visit(node: ts.Node) {
    // new X.Y(args...)
    if (ts.isNewExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (ts.isIdentifier(node.expression.expression) && nsImports.has(node.expression.expression.text)) {
        const ns = node.expression.expression.text;
        const cls = getOrCreateClass(ns, node.expression.name.text);
        cls.constructorArgCounts.push(node.arguments?.length ?? 0);
      }
    }

    // X.Y.method() — nested namespace access (e.g., THREE.MathUtils.lerp())
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression)
    ) {
      const outer = node.expression.expression;
      if (ts.isIdentifier(outer.expression) && nsImports.has(outer.expression.text)) {
        const ns = outer.expression.text;
        const subNsName = outer.name.text;
        const methodName = node.expression.name.text;
        const info = getOrCreateNestedNs(ns, subNsName);
        const existing = info.methods.get(methodName) ?? 0;
        info.methods.set(methodName, Math.max(existing, node.arguments.length));
      }
    }

    // X.Y.prop (nested namespace property access, not a call)
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      nsImports.has(node.expression.expression.text) &&
      !(node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      const ns = node.expression.expression.text;
      const subNsName = node.expression.name.text;
      // Only if not already treated as a class
      const classes = namespaces.get(ns)!;
      if (!classes.has(subNsName)) {
        const info = getOrCreateNestedNs(ns, subNsName);
        info.properties.add(node.name.text);
      }
    }

    // Parameter with type X.Y
    if (ts.isParameter(node) && node.type && ts.isTypeReferenceNode(node.type)) {
      const info = tryResolveQualifiedName(node.type);
      if (info && ts.isIdentifier(node.name)) {
        getOrCreateClass(info.ns, info.className);
        typedVars.set(node.name.text, info);
      }
    }

    // Variable declaration with type X.Y
    if (ts.isVariableDeclaration(node) && node.type && ts.isTypeReferenceNode(node.type)) {
      const info = tryResolveQualifiedName(node.type);
      if (info && ts.isIdentifier(node.name)) {
        getOrCreateClass(info.ns, info.className);
        typedVars.set(node.name.text, info);
      }
    }

    // Return type X.Y on function declarations
    if (ts.isFunctionDeclaration(node) && node.type && ts.isTypeReferenceNode(node.type)) {
      const info = tryResolveQualifiedName(node.type);
      if (info) {
        getOrCreateClass(info.ns, info.className);
      }
    }

    // Property access on typed variable: varName.prop or varName.method()
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const varInfo = typedVars.get(node.expression.text);
      if (varInfo) {
        const cls = getOrCreateClass(varInfo.ns, varInfo.className);
        const memberName = node.name.text;

        if (node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node) {
          // Method call
          const existing = cls.methods.get(memberName) ?? 0;
          cls.methods.set(memberName, Math.max(existing, node.parent.arguments.length));
        } else {
          // Property access (read or write)
          cls.properties.add(memberName);
        }
      }
    }

    // Track calls to named/default imported identifiers: func(args...)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      calledAsFunction.add(name);
      const existing = maxCallArgs.get(name) ?? 0;
      maxCallArgs.set(name, Math.max(existing, node.arguments.length));
    }

    forEachChild(node, visit);
  }

  visit(sf);

  // Step 3: Generate replacements
  const replacements: { start: number; end: number; text: string }[] = [];

  // Namespace imports → declare namespace
  for (const [nsName, { start, end }] of nsImports) {
    const classes = namespaces.get(nsName)!;
    const nested = nestedNs.get(nsName)!;

    if (classes.size === 0 && nested.size === 0) {
      replacements.push({
        start,
        end,
        text: `/* import ${nsName}: no usage detected */`,
      });
      continue;
    }

    let declare = `declare namespace ${nsName} {\n`;

    // Classes
    for (const [className, usage] of classes) {
      declare += `  class ${className} {\n`;

      const maxCtorArgs = Math.max(0, ...usage.constructorArgCounts);
      if (maxCtorArgs > 0) {
        const params = Array.from({ length: maxCtorArgs }, (_, i) => `a${i}: any`).join(", ");
        declare += `    constructor(${params});\n`;
      } else {
        declare += `    constructor(...args: any[]);\n`;
      }

      for (const prop of usage.properties) {
        declare += `    ${prop}: any;\n`;
      }

      for (const [method, argCount] of usage.methods) {
        const params = Array.from({ length: argCount }, (_, i) => `a${i}: any`).join(", ");
        declare += `    ${method}(${params}): any;\n`;
      }

      declare += `  }\n`;
    }

    // Nested namespaces (e.g., THREE.MathUtils)
    for (const [subNsName, info] of nested) {
      // Skip if already registered as a class
      if (classes.has(subNsName)) continue;

      declare += `  namespace ${subNsName} {\n`;
      for (const prop of info.properties) {
        declare += `    const ${prop}: any;\n`;
      }
      for (const [method, argCount] of info.methods) {
        const params = Array.from({ length: argCount }, (_, i) => `a${i}: any`).join(", ");
        declare += `    function ${method}(${params}): any;\n`;
      }
      declare += `  }\n`;
    }

    declare += `}`;
    replacements.push({ start, end, text: declare });
  }

  // Default and named imports → declare stubs
  for (const imp of otherImports) {
    const lines: string[] = [];

    if (imp.defaultName && !definedNames.has(imp.defaultName)) {
      if (calledAsFunction.has(imp.defaultName)) {
        const argCount = maxCallArgs.get(imp.defaultName) ?? 0;
        const params = Array.from({ length: argCount }, (_, i) => `a${i}: any`).join(", ");
        lines.push(`declare function ${imp.defaultName}(${params}): any;`);
      } else {
        lines.push(`declare const ${imp.defaultName}: any;`);
      }
    }

    if (imp.namedBindings) {
      for (const name of imp.namedBindings) {
        // Skip if the name is already defined as a function/variable/class in source
        if (definedNames.has(name)) continue;

        if (calledAsFunction.has(name)) {
          const argCount = maxCallArgs.get(name) ?? 0;
          const params = Array.from({ length: argCount }, (_, i) => `a${i}: any`).join(", ");
          lines.push(`declare function ${name}(${params}): any;`);
        } else {
          lines.push(`declare const ${name}: any;`);
        }
      }
    }

    replacements.push({
      start: imp.start,
      end: imp.end,
      text: lines.length > 0 ? lines.join("\n") : `/* side-effect import removed */`,
    });
  }

  // Apply replacements in reverse order to preserve positions
  let result = source;
  replacements.sort((a, b) => b.start - a.start);
  for (const r of replacements) {
    result = result.substring(0, r.start) + r.text + result.substring(r.end);
  }

  return { source: timerShim ? timerShim + result : result, nodeBuiltins };
}
