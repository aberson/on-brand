# README visuals

The `brand-workflow-{light,dark}.svg` and `image-workflow-{light,dark}.svg`
diagrams are hand-authored SVGs using the rounded panels, monospace labels,
blue connecting arrows, and light/dark palette of the
[skill-mesh diagrams](https://github.com/aberson/skill-mesh/tree/main/_shared).
The README selects the appropriate variant with a `<picture>` element.
Edit these SVGs directly; the screenshot command does not regenerate them.

## Screenshots

Captured with Playwright Chromium from the real on-brand HTML views. No page
markup, styles, or displayed values are changed for the screenshots.

| File | Source |
|---|---|
| `inspiration.png` | The released `examples/inspiration/water-lilies/brand/dist/inspiration-to-implementation.html`, light mode, 1440 × 1000 viewport. |
| `specimen-light.png` | The released Water Lilies `specimen.html`, light mode, 1100 × 990 viewport. |
| `specimen-dark.png` | The same specimen after clicking its theme toggle. |
| `gallery.png` | The CLI gallery for temporary `house-docs` and `default` preset projects plus a fresh Water Lilies image proposal. The capture frames the navigation and first two complete detail cards, excluding the machine-specific root header. |

The artwork is Claude Monet's *Water Lilies* (1906), Art Institute of Chicago,
CC0 Public Domain Designation. The exact source image, attribution, and operator
review are recorded in the example's [PROVENANCE.md](../../../examples/inspiration/water-lilies/PROVENANCE.md).

Regenerate from the repository root after installing dependencies and Chromium:

```powershell
node scripts/capture-readme.mjs
```

The script opens the released example read-only. Demo brands are created below
an ignored `.observatory/readme-capture-*` directory and removed at the end.
The gallery proposal name includes the capture date. Fonts and rasterization
can vary by environment; captures are documentation, not visual regression baselines.
