/**
 * Pure rotation helpers — the exclude-history model that makes a DIFFERENT
 * variant land in different scenes (the arranger palette's variety), while
 * locked tracks never rotate.
 *
 * History is project-scoped (plugin_data key `history:<kind>`) and FIFO with
 * a hard cap; the effective exclude set for a pick is the union of that
 * history, the same-kind sample paths already used in the current scene, and
 * the current path being shuffled away from. Exhaustion (resolver returns
 * null) is handled by the CALLER: clear the kind's history and re-pick with
 * scene-local excludes only — the drum-panel precedent.
 */

export const HISTORY_CAP = 24;

/** Project-scoped plugin_data key for a kind's rotation history. */
export function historyKey(kind: string): string {
  return `history:${kind}`;
}

/** Narrow an unknown plugin_data value into a string[] history. */
export function asHistory(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((p): p is string => typeof p === 'string');
}

/** Union: history ∪ same-kind scene paths ∪ the path being replaced. */
export function buildExcludeSet(
  history: readonly string[],
  sceneSameKindPaths: ReadonlyArray<string | null | undefined>,
  currentPath?: string | null,
): Set<string> {
  const out = new Set<string>();
  for (const p of history) if (p) out.add(p);
  for (const p of sceneSameKindPaths) if (p) out.add(p);
  if (currentPath) out.add(currentPath);
  return out;
}

/** Append a pick to history (dedup-moves it to the end), FIFO-capped. */
export function recordHistory(
  history: readonly string[],
  path: string,
  cap: number = HISTORY_CAP,
): string[] {
  const next = history.filter((p) => p !== path);
  next.push(path);
  return next.length > cap ? next.slice(next.length - cap) : next;
}
