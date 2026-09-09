# monet-mismatch-anchor — provenance & mismatch rationale

**Brand-fidelity benchmark, Step 4 (issue #33).** This preset is a hand-authored
**negative** vision-judge mood anchor. It is never extracted from a live site,
never used as a general-purpose UI preset, and never included in the fidelity
rollup — its only job is to give the Step 9 vision judge a pairing it is
*forced* to fail, alongside the real `monet-water-lily` preset that it must
*pass* against the same reference.

## Stated reference painting

**Claude Monet, "Water Lilies" (*Nymphéas*) series** (c. 1897–1926) — the same
painting family the real `monet-water-lily` preset (in this same `templates/presets/`
directory) is faithfully grounded in: muted, cool-green pond tones, soft blues,
gentle pink/lavender lily accents, a contemplative, atmospheric mood.

## Why the palette is deliberately unrelated

`monet-mismatch-anchor` claims the same reference but instead uses a **harsh
neon/cyber palette** — electric magenta accent (`#dd06b2`), acid-green /
electric-cyan / radioactive-yellow / laser-red / ultraviolet categorical chart
colors, and a flat, warmth-free neutral scale (`hueNeutral` saturation 0 — the
only preset in this set with a perfectly desaturated gray, since every real
Monet-grounded preset here carries a warm or cool tint even in its neutrals).
None of this shares a hue family, saturation register, or mood with the real
series' soft pond greens/blues/pinks. It reads as a tech dashboard, not an
impressionist pond painting.

## Measured color distance (quantitative, not just descriptive)

CIEDE2000 `deltaE` (via `colorjs.io`, the same color-science library the
production WCAG/APCA contrast gate uses — plan §2 stack) between
`monet-water-lily`'s and `monet-mismatch-anchor`'s tokens at every entry of
`KEY_SWATCHES` in `test/preset.monet.test.ts` (11 dot-paths — the table below
lists all 11, in the same order the test does, so the two never drift apart).
As a rule of thumb, `deltaE2000 > ~10` is clearly perceptible to any human
observer; `> 25` reads as a stark, obvious mismatch.

| token | water-lily | mismatch-anchor | deltaE2000 |
|---|---|---|---|
| `color.semantic.accent` | `#3ea590` | `#dd06b2` | **47.3** |
| `color.diagram.spine-accent` | `#3ea590` | `#dd06b2` | **47.3** |
| `color.primitive.brand.9` | `#3ea590` | `#dd06b2` | **47.3** |
| `color.chart.categorical.1` | `#2d7668` | `#f910ca` | **42.0** |
| `color.chart.categorical.2` | `#3f84a6` | `#25c705` | **50.5** |
| `color.chart.categorical.3` | `#d69ab3` | `#06bbe0` | **56.1** |
| `color.chart.categorical.4` | `#ac97c4` | `#ffd400` | **52.8** |
| `color.chart.categorical.5` | `#75a385` | `#f20d0d` | **54.7** |
| `color.chart.categorical.6` | `#36777d` | `#8c25f4` | **29.3** |
| `color.chart.categorical.7` | `#77804d` | `#0bcb6b` | **26.4** |
| `color.chart.categorical.8` | `#b4747e` | `#f4258c` | **16.0** |

The first 3 rows repeat one value pair (`color.semantic.accent`,
`color.diagram.spine-accent`, and `color.primitive.brand.9` all derive from
the same underlying "accent" choice in both presets' token trees) — kept as 3
separate rows, not collapsed into 1, because that is what the test actually
iterates and averages over.

**Average across all 11 rows: 42.71.** Minimum single row: 16.02
(`color.chart.categorical.8`) — still 1.6x the "stark mismatch" floor. Both
numbers are ~4x and ~1.6x the "clearly perceptible" threshold respectively.
`test/preset.monet.test.ts` asserts this computationally over the identical
11-entry `KEY_SWATCHES` list (average `deltaE2000 >= 35`, every individual
swatch `>= 15`) so a future edit that accidentally "fixes" this preset toward
the real palette — defeating its purpose as a negative anchor — fails CI
rather than silently degrading the Step 9 judge calibration. The same file
also guards that the 3 REAL monet presets (parasol / san-giorgio / water-lily)
stay pairwise distinguishable from EACH OTHER, via the same deltaE mechanism.

## One deliberate exception: WCAG AA still holds

Every declared text/bg pairing in `monet-mismatch-anchor` still passes the
WCAG 2 AA contrast gate (verified via `onbrand check`, both light and dark —
see the Step 4 dev report). The mismatch is entirely **aesthetic** (wrong mood,
wrong hue family, wrong painting-fidelity), not an accessibility bug — the
vision judge must fail this pairing on "does this look like the reference
painting", not be able to fail it (or excuse it) on an unrelated contrast
defect. Conflating the two would invalidate the anchor as a measurement
instrument (see `dev/.claude/rules/measurement-validity.md` — calibrate with a
clean, unconfounded known-bad input).
