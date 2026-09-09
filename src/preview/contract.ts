/** Exact dist inputs consumed by the preview renderer and provenance recorder. */
export const PREVIEW_TOKENS_CSS_INPUT = 'tokens.css';
export const PREVIEW_COMPONENTS_CSS_INPUT = 'components.css';
export const PREVIEW_DIAGRAM_PALETTE_INPUT = 'diagram-palette.json';
export const REQUIRED_PREVIEW_INPUTS = [
  PREVIEW_TOKENS_CSS_INPUT,
  PREVIEW_COMPONENTS_CSS_INPUT,
  PREVIEW_DIAGRAM_PALETTE_INPUT,
] as const;

export const SPECIMEN_VIEW_OUTPUT = 'specimen.html';
/** Shared synchronous-I/O ceiling for exact specimen inspection. */
export const SPECIMEN_VIEW_MAX_BYTES = 8_000_000;
/** v1 outputSources label binding recorded provenance to exact specimen bytes. */
export const SPECIMEN_CONTENT_SOURCE_LABEL = 'specimen-html';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLowerSha256(value: string): boolean {
  if (value.length !== 64) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102))) return false;
  }
  return true;
}

/** Read one exact v1 digest row without accepting an ambiguous extension. */
export function recordedOutputContentDigest(
  manifest: unknown,
  relPath: string,
  label: string,
): string | undefined {
  if (!isPlainObject(manifest)) return undefined;
  const allSources = manifest['outputSources'];
  if (!isPlainObject(allSources)) return undefined;
  const rows = allSources[relPath];
  if (!Array.isArray(rows) || rows.length !== 1) return undefined;
  const row = rows[0];
  if (!isPlainObject(row)) return undefined;
  const keys = Object.keys(row).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== 'kind' ||
    keys[1] !== 'label' ||
    keys[2] !== 'sha256' ||
    keys[3] !== 'sourcePath'
  ) {
    return undefined;
  }
  const sha256 = row['sha256'];
  return row['label'] === label && row['sourcePath'] === null && row['kind'] === 'digest' &&
      typeof sha256 === 'string' && isLowerSha256(sha256)
    ? sha256
    : undefined;
}

export function recordedSpecimenContentDigest(manifest: unknown): string | undefined {
  return recordedOutputContentDigest(
    manifest,
    SPECIMEN_VIEW_OUTPUT,
    SPECIMEN_CONTENT_SOURCE_LABEL,
  );
}
