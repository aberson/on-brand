/**
 * Hand-verifiable NUMERIC ANCHORS for the contrast engine (review iteration 2,
 * measurement-validity): nothing here is fixture-relative — every expected
 * number is a published/textbook value, so a colorjs.io regression or an
 * accidental fg/bg orientation flip (the documented `bg.contrastAPCA(fg)`
 * receiver gotcha) fails these tests instead of silently inverting the gate.
 *
 * Anchors:
 *   - black-on-white WCAG = 21 (textbook maximum), grey #767676 on white =
 *     4.54:1 (just above AA), #777777 on white = 4.48:1 (just below AA);
 *   - APCA polarity: dark-text-on-light-bg is POSITIVE (~ +106.0 for black on
 *     white), light-text-on-dark-bg NEGATIVE (~ -107.9 for white on black),
 *     both pass via |Lc|;
 *   - round-then-compare regression: raw values inside the false-pass band
 *     (display rounds up to the threshold) must still FAIL the gate;
 *   - NaN (CSS Color 4 `none` components) and unparseable strings route to
 *     parseError, never a numeric verdict.
 */

import { describe, expect, it } from 'vitest';
import {
  APCA_STRICT_LC,
  WCAG_AA_NORMAL,
  evaluateContrast,
} from '../src/check/contrast.ts';

describe('evaluateContrast — WCAG numeric anchors', () => {
  it('black on white is the textbook 21:1 maximum', () => {
    const result = evaluateContrast('#000000', '#ffffff');
    expect(result.wcag).toBe(21);
    expect(result.wcagPass).toBe(true);
  });

  it('#767676 on #ffffff is 4.54:1 — just above the 4.5:1 AA floor (PASS)', () => {
    const result = evaluateContrast('#767676', '#ffffff');
    expect(result.wcag).toBeCloseTo(4.54, 2); // raw 4.5422…, display-rounded to 2dp
    expect(result.wcagPass).toBe(true);
  });

  it('#777777 on #ffffff is 4.48:1 — just below the AA floor (FAIL)', () => {
    const result = evaluateContrast('#777777', '#ffffff');
    expect(result.wcag).toBeCloseTo(4.48, 2); // raw 4.4781…
    expect(result.wcagPass).toBe(false);
  });

  it('WCAG is symmetric: swapping fg/bg gives the same ratio', () => {
    const a = evaluateContrast('#767676', '#ffffff');
    const b = evaluateContrast('#ffffff', '#767676');
    expect(a.wcag).toBe(b.wcag);
  });
});

describe('evaluateContrast — APCA polarity/orientation anchors', () => {
  it('black text on white background is POSITIVE ~ +106.0 Lc (orientation anchor)', () => {
    const result = evaluateContrast('#000000', '#ffffff');
    // An inverted call (fg.contrastAPCA(bg)) would flip this to ~ -107.9 —
    // a 213-point miss, far outside the tolerance.
    expect(result.apca).toBeCloseTo(106.0, 0);
    expect(result.apca!).toBeGreaterThan(0);
    expect(result.apcaPass).toBe(true);
  });

  it('white text on black background is NEGATIVE ~ -107.9 Lc, and |Lc| still passes', () => {
    const result = evaluateContrast('#ffffff', '#000000');
    expect(result.apca).toBeCloseTo(-107.9, 0);
    expect(result.apca!).toBeLessThan(0);
    expect(result.apcaPass).toBe(true); // abs handling: -107.9 clears the 60 floor
  });

  it('near-identical greys score |Lc| far below the strict floor (garbage anchor)', () => {
    const result = evaluateContrast('#808080', '#8a8a8a');
    expect(Math.abs(result.apca!)).toBeLessThan(APCA_STRICT_LC);
    expect(result.apcaPass).toBe(false);
  });
});

describe('evaluateContrast — round-then-compare regression (gate on RAW values)', () => {
  it('a raw WCAG ratio of 4.4975:1 displays as 4.50 but FAILS the hard gate', () => {
    // rgb(46.548% grey) on white: raw 4.49750… — inside [4.495, 4.5), the
    // band where rounding-before-comparing used to certify a genuine AA
    // violation as a PASS.
    const result = evaluateContrast('rgb(46.548% 46.548% 46.548%)', '#ffffff');
    expect(result.wcag).toBe(4.5); // the display value rounds UP to the threshold…
    expect(result.wcagPass).toBe(false); // …but the raw value gates, and fails
    expect(result.wcag! >= WCAG_AA_NORMAL).toBe(true); // the trap the old code fell into
  });

  it('a raw |Lc| of 59.97 displays as 60.0 but FAILS the strict threshold', () => {
    const result = evaluateContrast('rgb(55.804% 55.804% 55.804%)', '#ffffff');
    expect(result.apca).toBe(60); // display-rounded to 1dp
    expect(result.apcaPass).toBe(false); // raw 59.972… < 60
  });
});

describe('evaluateContrast — parse/compute error routing', () => {
  it('an unparseable foreground routes to parseError (no numeric verdict)', () => {
    const result = evaluateContrast('definitely-not-a-color', '#ffffff');
    expect(result.parseError).toContain('unparseable foreground color');
    expect(result.wcag).toBeUndefined();
    expect(result.apca).toBeUndefined();
    expect(result.wcagPass).toBe(false);
    expect(result.apcaPass).toBe(false);
  });

  it('an unparseable background routes to parseError', () => {
    const result = evaluateContrast('#000000', 'nope');
    expect(result.parseError).toContain('unparseable background color');
  });

  it('CSS Color 4 `none` components (NaN APCA) route to parseError, never NaN output', () => {
    // colorjs.io parses rgb(none none none) without throwing but APCA yields
    // NaN for it — must surface as a compute error, not "APCA Lc NaN".
    const result = evaluateContrast('rgb(none none none)', '#ffffff');
    expect(result.parseError).toContain('non-numeric contrast result');
    expect(result.wcag).toBeUndefined();
    expect(result.apca).toBeUndefined();
    expect(result.wcagPass).toBe(false);
    expect(result.apcaPass).toBe(false);
  });
});
