/**
 * Resolve a validated inspiration trace against real token documents.
 *
 * Trace JSON deliberately does not duplicate implementation colors.  This
 * module is the only bridge from a reviewed mapping target to the current
 * light/dark token values, so a changed token can never leave prose claiming
 * an obsolete shipped hex.
 */

import {
  childEntries,
  isPlainObject,
  isToken,
  isTokenType,
  isUnsafeName,
  type TokenType,
  type TokensDocument,
} from '../schema/types.ts';
import {
  type InspirationDefaultDerivedTarget,
  type InspirationMapping,
  type InspirationTarget,
} from './contract.ts';
import type { LoadedInspirationAsset, LoadedInspirationTrace } from './load.ts';

export interface ResolvedInspirationTarget extends InspirationTarget {
  /** Current resolved light token value, canonical lowercase #rrggbb. */
  lightHex: string;
  /** Current resolved dark token value, or null when this brand has no dark mode. */
  darkHex: string | null;
}

export interface ResolvedInspirationMapping extends Omit<InspirationMapping, 'targets'> {
  targets: ResolvedInspirationTarget[];
}

export interface ResolvedDefaultDerivedTarget extends InspirationDefaultDerivedTarget {
  lightHex: string;
  darkHex: string | null;
}

export interface ResolvedInspirationTrace {
  projectDir: string;
  brandDir: string;
  tracePath: string;
  traceSha256: string;
  trace: LoadedInspirationTrace['trace'];
  asset: LoadedInspirationAsset;
  mappings: ResolvedInspirationMapping[];
  defaultDerivedColorTargets: ResolvedDefaultDerivedTarget[];
}

export interface InspirationResolveIssue {
  path: string;
  message: string;
}

export class InspirationResolveError extends Error {
  readonly issues: InspirationResolveIssue[];

  constructor(issues: readonly InspirationResolveIssue[]) {
    super(`inspiration token resolution failed:\n${issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n')}`);
    this.name = 'InspirationResolveError';
    this.issues = [...issues];
  }
}

/**
 * Resolve all mapping/default-derived targets. `dark` must be the fully merged
 * dark document (not the sparse modes.dark.json overlay); `loadBrandSources()`
 * provides exactly that as `darkDocument`.
 */
export function resolveInspirationTrace(
  loaded: LoadedInspirationTrace,
  light: TokensDocument,
  dark?: TokensDocument,
): ResolvedInspirationTrace {
  const lightTokens = tokenMap(light);
  const darkTokens = dark === undefined ? undefined : tokenMap(dark);
  const issues: InspirationResolveIssue[] = [];

  const resolveTarget = (
    target: InspirationTarget,
    issuePath: string,
    mapping: InspirationMapping,
  ): ResolvedInspirationTarget | undefined => {
    const lightHex = resolveTokenHex(lightTokens, target.token, issuePath, issues);
    const darkHex = darkTokens === undefined
      ? null
      : resolveTokenHex(darkTokens, target.token, issuePath, issues);
    if (lightHex === undefined || (darkTokens !== undefined && darkHex === undefined)) return undefined;

    if (target.relationship === 'sampled' && lightHex !== mapping.sample.hex) {
      issues.push({
        path: issuePath,
        message: `relationship "sampled" requires source ${mapping.sample.hex} to equal resolved light ${lightHex}`,
      });
    }
    if (target.relationship === 'adjusted-for-contrast' && lightHex === mapping.sample.hex) {
      issues.push({
        path: issuePath,
        message: 'relationship "adjusted-for-contrast" requires a light value different from the measured sample',
      });
    }
    // `derived` is intentionally unconstrained by equality. contract.ts already
    // requires a bounded non-empty rationale on every mapping.
    return { ...target, lightHex, darkHex: darkHex ?? null };
  };

  const mappings: ResolvedInspirationMapping[] = [];
  loaded.trace.mappings.forEach((mapping, mappingIndex) => {
    const targets: ResolvedInspirationTarget[] = [];
    mapping.targets.forEach((target, targetIndex) => {
      const resolved = resolveTarget(target, `mappings[${mappingIndex}].targets[${targetIndex}].token`, mapping);
      if (resolved !== undefined) targets.push(resolved);
    });
    mappings.push({ ...mapping, targets });
  });

  const defaultDerivedColorTargets: ResolvedDefaultDerivedTarget[] = [];
  loaded.trace.analysis.defaultDerivedColorTargets.forEach((target, index) => {
    const issuePath = `analysis.defaultDerivedColorTargets[${index}].token`;
    const lightHex = resolveTokenHex(lightTokens, target.token, issuePath, issues);
    const darkHex = darkTokens === undefined
      ? null
      : resolveTokenHex(darkTokens, target.token, issuePath, issues);
    if (lightHex !== undefined && (darkTokens === undefined || darkHex !== undefined)) {
      defaultDerivedColorTargets.push({ ...target, lightHex, darkHex: darkHex ?? null });
    }
  });

  if (issues.length > 0) throw new InspirationResolveError(issues);
  return {
    projectDir: loaded.projectDir,
    brandDir: loaded.brandDir,
    tracePath: loaded.tracePath,
    traceSha256: loaded.traceSha256,
    trace: loaded.trace,
    asset: loaded.asset,
    mappings,
    defaultDerivedColorTargets,
  };
}

interface ResolvedToken {
  type: TokenType;
  value: unknown;
  hex?: string;
}

/** Walk validated DTCG documents without importing compile.ts (avoids a build-cycle). */
function tokenMap(document: TokensDocument): Map<string, ResolvedToken> {
  const out = new Map<string, ResolvedToken>();
  const walk = (group: Record<string, unknown>, segments: string[], inherited: TokenType | undefined): void => {
    for (const [name, child] of childEntries(group)) {
      if (isUnsafeName(name) || !isPlainObject(child)) continue;
      const childSegments = [...segments, name];
      if (isToken(child)) {
        const type = isTokenType(child.$type) ? child.$type : inherited;
        if (type === undefined) continue;
        const value = child.$value;
        const hex = type === 'color' ? canonicalOpaqueHex(value) : undefined;
        out.set(childSegments.join('.'), { type, value, ...(hex === undefined ? {} : { hex }) });
      } else {
        const ownType = child['$type'];
        walk(child, childSegments, isTokenType(ownType) ? ownType : inherited);
      }
    }
  };
  const rootType = isTokenType(document.$type) ? document.$type : undefined;
  walk(document, [], rootType);

  return out;
}

function resolveTokenHex(
  tokens: ReadonlyMap<string, ResolvedToken>,
  tokenPath: string,
  issuePath: string,
  issues: InspirationResolveIssue[],
): string | undefined {
  const found = tokens.get(tokenPath);
  if (found === undefined) {
    issues.push({
      path: issuePath,
      message: `does not resolve to an existing token (${tokenPath})`,
    });
    return undefined;
  }
  if (found.type !== 'color') {
    issues.push({ path: issuePath, message: `must resolve to a color token (found ${found.type})` });
    return undefined;
  }
  if (found.hex === undefined) {
    issues.push({ path: issuePath, message: 'color target must resolve to an opaque #rrggbb value' });
    return undefined;
  }
  return found.hex;
}

/** Normalise supported DTCG hex values to the exact standalone rendering form. */
function canonicalOpaqueHex(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (/^#[0-9a-f]{6}$/.test(value)) return value;
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    const r = value[1]!;
    const g = value[2]!;
    const b = value[3]!;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return undefined;
}
