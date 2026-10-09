import { applyPatch, parsePatch, reversePatch } from 'diff';
/** Reconstruct the pre-change text only when the recorded patch matches exactly. */
export function reconstructBefore(current: string, patch: string): string | undefined {
  try {
    const parsed = parsePatch(patch);
    if (parsed.length !== 1 || !parsed[0].hunks.length) return undefined;
    const before = applyPatch(current, reversePatch(parsed[0]), { fuzzFactor: 0 });
    if (before === false) return undefined;
    return applyPatch(before, parsed[0], { fuzzFactor: 0 }) === current ? before : undefined;
  } catch { return undefined; }
}
