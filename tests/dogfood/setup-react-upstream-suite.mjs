import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadReactUpstreamSuitePin() {
  return JSON.parse(readFileSync(join(HERE, "react-upstream-suite-pin.json"), "utf-8"));
}

// React's published tarball omits its Jest tests. Acquire only the exact
// source tag that supplies the selected public-API vectors, then verify HEAD
// before any test is attributed to upstream React.
export function setupReactUpstreamSuite({ force = false } = {}) {
  const pin = loadReactUpstreamSuitePin();
  const root = join(HERE, ".react-upstream-suite");

  if (force && existsSync(root)) rmSync(root, { recursive: true, force: true });
  if (!existsSync(join(root, ".git"))) {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    execFileSync("git", ["clone", "--depth", "1", "--branch", pin.tag, pin.repo, root], { stdio: "pipe" });
  }

  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  if (commit !== pin.commit) {
    throw new Error(
      `[dogfood] React upstream-suite checkout integrity mismatch.\n` +
        `  expected ${pin.commit} (tag ${pin.tag})\n` +
        `  got      ${commit}`,
    );
  }

  const testPaths = pin.testFiles.map((file) => join(root, file));
  for (const file of testPaths) {
    if (!existsSync(file)) throw new Error(`[dogfood] React source pin is missing expected test file ${file}`);
  }
  return { root, pin, testPaths };
}
