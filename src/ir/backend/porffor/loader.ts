// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { execFileSync } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PORFFOR_IR_COMMIT,
  PorfforCompatibilityError,
  assertPorfforCommit,
  assertPorfforIrCompatibility,
  assertPorfforRendererInput,
  porfforRendererOutputText,
  type PorfforIrModule,
  type PorfforRenderer,
  type PorfforRendererInput,
  type PorfforRendererOutput,
} from "./compat.js";

export interface LoadOptionalPorfforOptions {
  /** Porffor checkout root. Defaults to this repository's optional vendor/Porffor path. */
  readonly root?: string;
}

export interface LoadedPorffor {
  readonly root: string;
  readonly commit: typeof PORFFOR_IR_COMMIT;
  readonly ir: PorfforIrModule;
  /** Validate JS2's record before invoking the unstable upstream renderer. */
  render(input: PorfforRendererInput): PorfforRendererOutput;
}

export class PorfforUnavailableError extends Error {
  constructor(
    readonly root: string,
    options?: ErrorOptions,
  ) {
    super(
      `Optional Porffor backend is unavailable at ${JSON.stringify(root)}.\n` +
        `Initialize vendor/Porffor at commit ${PORFFOR_IR_COMMIT}, or pass LoadOptionalPorfforOptions.root to a compatible checkout. ` +
        "Core JS2 builds do not require Porffor.",
      options,
    );
    this.name = "PorfforUnavailableError";
  }
}

const DEFAULT_PORFFOR_ROOT = fileURLToPath(new URL("../../../../vendor/Porffor/", import.meta.url));

/**
 * Load Porffor only when an adapter tool explicitly requests it.
 *
 * There is deliberately no static import from vendor/Porffor: an absent
 * submodule remains invisible to normal JS2 build, typecheck, and test paths.
 */
export async function loadOptionalPorffor(options: LoadOptionalPorfforOptions = {}): Promise<LoadedPorffor> {
  const root = resolve(options.root ?? DEFAULT_PORFFOR_ROOT);
  const irPath = join(root, "compiler", "ir.js");
  const rendererPath = join(root, "compiler", "render.js");

  try {
    await Promise.all([access(irPath), access(rendererPath)]);
  } catch (cause) {
    throw new PorfforUnavailableError(root, { cause });
  }

  const commit = readPorfforCommit(root);
  assertPorfforCommit(commit);

  let irNamespace: unknown;
  let rendererNamespace: unknown;
  try {
    [irNamespace, rendererNamespace] = await Promise.all([
      import(pathToFileURL(irPath).href),
      import(pathToFileURL(rendererPath).href),
    ]);
  } catch (cause) {
    throw new PorfforCompatibilityError(
      `failed to dynamically import compiler/ir.js and compiler/render.js from ${JSON.stringify(root)}: ${errorMessage(cause)}`,
      commit,
      { cause },
    );
  }

  assertPorfforIrCompatibility(irNamespace, commit);
  const rendererRecord = requireModuleNamespace(rendererNamespace, commit);
  if (typeof rendererRecord.default !== "function") {
    throw new PorfforCompatibilityError("compiler/render.js must have a default renderer function", commit);
  }
  const renderer = rendererRecord.default as PorfforRenderer;
  if (renderer.length !== 1) {
    throw new PorfforCompatibilityError(
      `renderer function arity expected 1 module record, received ${renderer.length}`,
      commit,
    );
  }

  return {
    root,
    commit: PORFFOR_IR_COMMIT,
    ir: irNamespace,
    render(input) {
      assertPorfforRendererInput(input, commit);
      let output: PorfforRendererOutput;
      try {
        output = renderer(input);
      } catch (cause) {
        throw new PorfforCompatibilityError(
          `renderer rejected the frozen ${PORFFOR_IR_COMMIT} module-record shape: ${errorMessage(cause)}`,
          commit,
          { cause },
        );
      }
      porfforRendererOutputText(output);
      return output;
    },
  };
}

function readPorfforCommit(root: string): string {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (cause) {
    throw new PorfforUnavailableError(root, { cause });
  }
}

function requireModuleNamespace(value: unknown, actualCommit: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PorfforCompatibilityError("compiler/render.js did not load as an ES module namespace", actualCommit);
  }
  return value as Readonly<Record<string, unknown>>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
