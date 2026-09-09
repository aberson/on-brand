# Step 3 verification: Tailwind v4 theme variable namespaces

**Date:** 2026-07-16 (build Step 3)
**Source:** https://tailwindcss.com/docs/theme (fetched 2026-07-16). Plan §12 requires external-tool
specifics to be verified from the tool's own docs before an emitter relies on them; this note is
that record for `src/build/emitters/tailwind.ts` (theme.tw.css). We map ONLY namespaces from this
verified table — no invented namespaces.

## Verified namespace table (tailwindcss.com/docs/theme, "Theme variable namespaces")

| Namespace | Utilities |
|---|---|
| `--color-*` | color utilities (`bg-red-500`, `text-sky-300`, ...) |
| `--font-*` | font family utilities (`font-sans`) |
| `--text-*` | font size utilities (`text-xl`) |
| `--font-weight-*` | font weight utilities (`font-bold`) |
| `--tracking-*` | letter spacing utilities (`tracking-wide`) |
| `--leading-*` | line height utilities (`leading-tight`) |
| `--tab-size-*` | tab size utilities |
| `--breakpoint-*` | responsive breakpoint variants (`sm:*`) |
| `--container-*` | container query variants + size utilities (`max-w-md`) |
| `--spacing-*` | spacing/sizing utilities (`px-4`, `max-h-16`, ...) |
| `--radius-*` | border radius utilities (`rounded-sm`) |
| `--shadow-*` | box shadow utilities (`shadow-md`) |
| `--inset-shadow-*` | inset box shadow utilities |
| `--drop-shadow-*` | drop shadow filter utilities |
| `--blur-*` | blur filter utilities |
| `--perspective-*` | perspective utilities |
| `--aspect-*` | aspect ratio utilities |
| `--ease-*` | transition timing function utilities (`ease-out`) |
| `--animate-*` | animation utilities (`animate-spin`) |

(The docs table also lists a `--zoom-*` row per the fetch; on-brand maps nothing to it either way.)

## What on-brand maps (the emitter's table, mirrored in tailwind.ts)

| Token category | Namespace | Example |
|---|---|---|
| `color.*` | `--color-*` | `color.semantic.bg` -> `--color-semantic-bg` |
| `font.*` | `--font-*` | `font.sans` -> `--font-sans` |
| `type.size.*`, `type.scale.*` | `--text-*` | `type.scale.step-1` -> `--text-step-1` |
| `type.weight.*` | `--font-weight-*` | `type.weight.bold` -> `--font-weight-bold` |
| `type.line-height.*` | `--leading-*` | `type.line-height.tight` -> `--leading-tight` |
| `space.*` | `--spacing-*` | `space.4` -> `--spacing-4` |
| `radius.*` | `--radius-*` | `radius.md` -> `--radius-md` |
| `shadow.*` | `--shadow-*` | `shadow.elevation-2` -> `--shadow-elevation-2` |
| `motion.easing.*` | `--ease-*` | `motion.easing.standard` -> `--ease-standard` |

**Deliberately unmapped:** `motion.duration.*` — the verified table has NO duration namespace
(durations appear only as the special `--default-transition-duration`-style defaults, not a
utility-driving `--duration-*` namespace on this table). Unmapped tokens are listed in a comment
inside the emitted theme.tw.css and remain available via tokens.css. If a later Tailwind release
documents a duration namespace, extend the mapping then.

## Dark-mode decision (recorded)

The docs require theme variables to be declared **top-level** — "Theme variables need to be
defined at the top level of the stylesheet", not nested under selectors or media queries — and the
theme docs offer **no native dark variant for `@theme`** (dark mode is a separate mechanism).
Tailwind emits theme variables as regular custom properties (on `:root`, inside `@layer theme`)
and compiles utilities to `var()` references, so theme.tw.css:

1. puts LIGHT values in the `@theme` block;
2. re-declares the mapped custom properties with DARK values in companion **unlayered** blocks
   after it — `@media (prefers-color-scheme: dark) { :root { ... } }` then `[data-theme="dark"]`
   (same order and opt-in-wins semantics as tokens.css). Unlayered declarations beat `@layer
   theme`, so the dark values win at runtime and utilities flip.

Consequence, stated in the emitted header: the block must stay plain `@theme`. The docs' `@theme
inline` option inlines the **value** into generated utilities instead of the `var()` reference —
that would bake light values in and break the runtime dark flip. (`@theme static` only forces all
variables to be emitted; it is orthogonal and unused here.)
