---
id: 2828
title: Ship examples/ in the npm tarball
status: done
sprint: 69
priority: high
area: packaging
related: [389]
assignee: ttraenkler/agent-a8f0d6a619ca48044
completed: 2026-06-29
---

# Ship `examples/` on npm

## Problem

The `package.json` `files` allowlist was
`["dist/", "README.md", "LICENSE", "CHANGELOG.md"]` — the published npm tarball
shipped **no `examples/` directory at all**. The loopdive/js2#389 reporter could
not obtain the native-messaging host sources via `npm i @loopdive/js2` and had to
fall back to `bun install` straight from the GitHub repo.

The example native-messaging hosts (`examples/native-messaging/*.ts`), the WASI
example, and the edge-platform example are reference material users need; they
should ride along in the package.

## Fix

Add `"examples/"` to the `files` allowlist in the root `package.json` (the
published `@loopdive/js2` package). The proxy package
`packages/js2wasm/package.json` is a thin dependency-only proxy (it ships only
`index.js`/`cli.js`/`README`/`LICENSE` and depends on `@loopdive/js2`), so it
does **not** need the examples — they are added to the published package only.

The whole `examples/` tree is git-tracked source (~276 KB: `.ts`/`.js`/`.mjs`/
`.sh`/`.json`/`.wat`/`.wit`/`.md`), with no `node_modules` and no generated
`.wasm` artifacts (each example subdir has its own `.gitignore` keeping build
output out of git, hence out of the npm tarball too). A plain `"examples/"` glob
therefore ships source only.

## Verify

`npm pack --dry-run` now lists `examples/native-messaging/*.ts` (and the rest of
the `examples/` source tree). The tarball size increase is small (the examples
total ~276 KB of source). See `## Test Results`.
