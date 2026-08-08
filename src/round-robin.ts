/**
 * Round-robin "one asset per kind" — pure logic.
 *
 * Every member of a kind — MIDI and audio TOGETHER (a MIDI hit and a sample
 * hit are alternatives, never simultaneous) — forms one rotation pool. At
 * any time exactly ONE member per kind is ACTIVE (audible); the rest are
 * engine-muted. The pointer advances one step on every transport play, so
 * successive playthroughs cycle through the pool.
 *
 * Persistence: one scene-scoped plugin_data key (`roundRobin`) holding
 * { kind → active dbId }. Engine mutes are deliberately NOT persisted to the
 * DB `tracks.muted` column — the arranger push reads that column to drop
 * muted layers, and every variant must keep reaching the cloud palette (the
 * arranger brain already guarantees one-per-kind placement). The panel
 * re-enforces mutes from this key on every load instead.
 */

import { MIX_ASSET_KINDS, type MixAssetKind } from './mix-asset-meta';

/** Scene-scoped plugin_data key for the active-member map. */
export const ROUND_ROBIN_KEY = 'roundRobin';

/** kind → dbId of the member that plays this rotation. */
export type ActiveByKind = Partial<Record<MixAssetKind, string>>;

export interface RoundRobinMember {
  dbId: string;
  kind: MixAssetKind;
}

/** Defensive narrow of a persisted plugin_data value. */
export function asActiveByKind(val: unknown): ActiveByKind {
  if (typeof val !== 'object' || val === null) return {};
  const out: ActiveByKind = {};
  const rec = val as Record<string, unknown>;
  for (const kind of MIX_ASSET_KINDS) {
    if (typeof rec[kind] === 'string') out[kind] = rec[kind] as string;
  }
  return out;
}

function pool(ordered: readonly RoundRobinMember[], kind: MixAssetKind): string[] {
  return ordered.filter((m) => m.kind === kind).map((m) => m.dbId);
}

/**
 * Ensure every kind that has members points at a LIVE member (stale dbIds —
 * scene duplication, deletions — reset to the first in display order), and
 * kinds without members carry no entry.
 */
export function normalizeActive(
  stored: ActiveByKind,
  ordered: readonly RoundRobinMember[],
): { active: ActiveByKind; changed: boolean } {
  const active: ActiveByKind = {};
  let changed = false;
  for (const kind of MIX_ASSET_KINDS) {
    const dbIds = pool(ordered, kind);
    const current = stored[kind];
    if (dbIds.length === 0) {
      if (current !== undefined) changed = true;
      continue;
    }
    if (current && dbIds.includes(current)) {
      active[kind] = current;
    } else {
      active[kind] = dbIds[0];
      changed = true;
    }
  }
  return { active, changed };
}

/** Advance every kind with ≥ 2 members one step around its pool. */
export function advanceActive(
  current: ActiveByKind,
  ordered: readonly RoundRobinMember[],
): ActiveByKind {
  const next: ActiveByKind = {};
  for (const kind of MIX_ASSET_KINDS) {
    const dbIds = pool(ordered, kind);
    if (dbIds.length === 0) continue;
    const idx = current[kind] ? dbIds.indexOf(current[kind] as string) : -1;
    next[kind] = dbIds[(idx + 1) % dbIds.length];
  }
  return next;
}

/**
 * dbId → should-be-muted. A member is muted exactly when its kind has an
 * active member and it isn't this one; sole members always play.
 */
export function mutePlan(
  active: ActiveByKind,
  ordered: readonly RoundRobinMember[],
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const m of ordered) {
    const a = active[m.kind];
    out[m.dbId] = a !== undefined && a !== m.dbId;
  }
  return out;
}

export function sameActive(a: ActiveByKind, b: ActiveByKind): boolean {
  return MIX_ASSET_KINDS.every((kind) => a[kind] === b[kind]);
}
