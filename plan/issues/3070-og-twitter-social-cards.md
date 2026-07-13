---
id: 3070
title: "Add Open Graph + Twitter Card meta tags and a social-preview image to the landing page"
status: done
assignee: ttraenkler/agent-a675d0c61c8025856
sprint: 71
created: 2026-07-06
updated: 2026-07-13
completed: 2026-07-06
priority: medium
horizon: s
feasibility: easy
reasoning_effort: low
task_type: chore
area: website
language_feature: n/a
goal: developer-experience
---

# #3070 — OG + Twitter Card meta tags and a social-preview image

## Problem

`website/index.html` (the js2wasm landing page, served at
`https://js2.loopdive.com`) had only a `<title>` and a
`<meta name="description">` in its `<head>` — zero `og:*`/`twitter:*` tags.
Sharing `https://js2.loopdive.com` on X/Twitter, Slack, LinkedIn, Discord, etc.
rendered a bare link with no thumbnail, no title card, no description —
hurting click-through and making shared links look unfinished/untrustworthy.

## Acceptance criteria

- The landing page (`website/index.html`) `<head>` carries a complete
  Open Graph + Twitter Card tag set: `og:type`, `og:site_name`, `og:url`,
  `og:title`, `og:description`, `og:image` (+ width/height/alt),
  `twitter:card` (`summary_large_image`), `twitter:title`,
  `twitter:description`, `twitter:image`.
- All `og:url` / `og:image` / `twitter:image` values are **absolute URLs**
  rooted at the canonical production host `https://js2.loopdive.com` — not
  relative to the page's dynamic `<base href>` (the page injects
  `/js2wasm/` on `loopdive.github.io`, `/` elsewhere; OG/Twitter crawlers do
  not execute that script, so relative URLs would resolve incorrectly on the
  GitHub Pages host).
- A branded 1200×630 social-preview image ships at `website/public/og-image.png`
  so it deploys to `https://js2.loopdive.com/og-image.png` (see "Build/deploy
  wiring" below for why `website/public` lands at the site root).
- Other public-facing pages that already carry their own `<title>` +
  `<meta name="description">` (`website/blog/index.html`,
  `website/getting-started/index.html`) get matching page-specific OG/Twitter
  tags reusing the same `og-image.png`, since blog posts and the getting-started
  guide are plausible share targets too.

## Design / implementation notes

**Image**: composed as an SVG (dark `--bg: #060a14` background matching the
site's real gradient wash, the existing `js2logo-squaring-the-circle-white.svg`
mark, "js2wasm" wordmark in Inter ExtraBold, the tagline
"AOT JavaScript/TypeScript → WebAssembly GC", a "No embedded JS engine" pill,
and a small "by Loopdive" mark using the existing `loopdive-logo-white.svg`
paths) and rasterized to a flattened (alpha-free) 1200×630 PNG via
`@resvg/resvg-js` (Rust-based SVG renderer, no system `rsvg-convert`/Chromium
dependency needed) with real Inter TTFs loaded for correct text shaping —
no system fonts have Inter installed (only DejaVu), and ImageMagick's `convert`
lacks a working SVG-text-to-raster path in this container (`unable to read
font 'helvetica'`), so a plain `convert -density … file.svg file.png` was not
viable. The generation was a one-off `.tmp/` script (per repo convention for
ad-hoc build tooling — not committed; only the final PNG asset is committed).

**Build/deploy wiring verified**: `pnpm run build:playground` (Vite, `root:
website/`, `appType: "mpa"`, `publicDir: website/public`) builds the landing
page as one of the MPA HTML entries and copies `website/public/*` to the
`dist/playground` root. `scripts/build-pages.js` then does
`copyDirectory(PLAYGROUND_DIST, PAGES_DIST)` as the **first** step ("Start from
the Vite multi-page build, which now includes the landing page at / and the
playground at /playground/") — so `website/public/og-image.png` lands at
`dist/pages/og-image.png`, i.e. `https://js2.loopdive.com/og-image.png` at the
site root. Confirmed no path remap needed.

**Pages intentionally NOT touched**: `website/playground/index.html` and
`website/dashboard/index.html` are tool/app pages (no existing `<meta
name="description">`. i.e. not previously treated as marketing/share
surfaces) — left out of scope to keep this a tight, `horizon: s` slice. A
follow-up can add them later if desired.

## Test Results

- `identify website/public/og-image.png` → `PNG 1200x630 1200x630+0+0 8-bit
sRGB`, ~73KB, alpha channel flattened (`Type: TrueColor`, not
  `TrueColorAlpha`) for broadest crawler compatibility.
- Visual review of the rendered PNG: logo, wordmark, tagline, pill, and
  Loopdive byline all render correctly against the dark background; the
  puzzle-piece cutout in the logo's top edge is the mark's intentional design
  (not a rendering artifact).
- Manually verified all three edited files (`website/index.html`,
  `website/blog/index.html`, `website/getting-started/index.html`) contain
  well-formed `og:*`/`twitter:*` tags with absolute `https://js2.loopdive.com/…`
  URLs.
