/**
 * Unit tests for the SHARED identifier guards in src/build/emitters/naming.ts
 * (hoisted there in Step 6 — previously a components.ts local that
 * src/preview had re-declared).
 *
 * Two jobs:
 *   1. Pin the predicate behavior AT THE SHARED SITE — including the
 *      empty-string case, the exact inversion this predicate once shipped
 *      (caught in the Step 4 review) and the reason the guard must never be
 *      re-declared per consumer.
 *   2. IDENTITY assertions (`toBe`, not equality) that every re-export is the
 *      same function object — the code-quality rule for de-duplicated
 *      constants: a future re-duplication (a consumer growing its own copy
 *      again) fails HERE, in CI, not in a drift incident.
 */

import { describe, expect, it } from 'vitest';
import { isIdentCharCode, isSafeClassSuffix } from '../src/build/emitters/naming.ts';
import { isSafeClassSuffix as fromComponents } from '../src/build/emitters/components.ts';
import {
  isIdentCharCode as identFromPreview,
  isSafeClassSuffix as fromPreview,
} from '../src/preview/dist-parse.ts';

describe('shared guard identity (one source of truth — re-duplication fails here)', () => {
  it('components.ts and src/preview re-export the SAME function object', () => {
    expect(fromComponents).toBe(isSafeClassSuffix);
    expect(fromPreview).toBe(isSafeClassSuffix);
    expect(identFromPreview).toBe(isIdentCharCode);
  });
});

describe('isSafeClassSuffix (the shared site)', () => {
  it('rejects the empty string (the review-caught inversion)', () => {
    expect(isSafeClassSuffix('')).toBe(false);
  });

  it('rejects names with characters outside [A-Za-z0-9_-]', () => {
    for (const name of ['odd name', 'quote"y', 'semi;colon', 'brace)paren', 'tab\tname', 'unié', 'dot.ted']) {
      expect(isSafeClassSuffix(name), JSON.stringify(name)).toBe(false);
    }
  });

  it('accepts ordinary suffix names', () => {
    for (const name of ['success', 'warning', 'a', 'A-Z_09', 'neutral-2', 'color-chart-categorical-1']) {
      expect(isSafeClassSuffix(name), name).toBe(true);
    }
  });
});

describe('isIdentCharCode boundary codes', () => {
  it('accepts exactly [A-Za-z0-9_-] and rejects the neighbors of each range', () => {
    const accepted = ['0', '9', 'A', 'Z', 'a', 'z', '-', '_'];
    for (const ch of accepted) {
      expect(isIdentCharCode(ch.charCodeAt(0)), ch).toBe(true);
    }
    // the characters immediately OUTSIDE each accepted range, plus common breakers
    const rejected = ['/', ':', '@', '[', '`', '{', '.', ' ', '"', "'", '(', ')', ','];
    for (const ch of rejected) {
      expect(isIdentCharCode(ch.charCodeAt(0)), JSON.stringify(ch)).toBe(false);
    }
    expect(isIdentCharCode(0x00)).toBe(false); // control
    expect(isIdentCharCode(0x7f)).toBe(false); // DEL
    expect(isIdentCharCode(0xe9)).toBe(false); // é — non-ASCII rejected
  });
});
