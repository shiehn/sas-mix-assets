/**
 * Mix-asset track metadata — the persisted contract between this panel and
 * the rest of the platform.
 *
 * One scene-scoped plugin_data key PER MEMBER TRACK:
 *
 *   key:   `track:<tracks.id dbId>:mixAsset`
 *   value: MixAssetMeta (JSON)
 *
 * This rides the SDK group-meta seam (parseTrackGroups / resolveTrackGroups
 * with `metaKey: 'mixAsset'`), with groupId == kind — three fixed groups
 * (hits / risers / shots). The shape is READ MAIN-SIDE by the arranger push
 * service (without the plugin running) to tag frozen stems with their
 * `asset_kind`, so changes here must stay tolerant-parseable and versioned.
 */

import type { GroupParseSpec } from '@signalsandsorcery/plugin-sdk';

/** The three asset kinds. Also the fixed group ids. */
export type MixAssetKind = 'hit' | 'riser' | 'shot';

export const MIX_ASSET_KINDS: readonly MixAssetKind[] = ['hit', 'riser', 'shot'];

/** Scene-data key suffix: `track:<dbId>:mixAsset`. */
export const MIX_ASSET_META_KEY = 'mixAsset';

export interface MixAssetMeta {
  /** Evolution seam — bump on breaking shape changes. */
  version: 1;
  /** Asset kind; doubles as the track-group id. */
  kind: MixAssetKind;
  /** Stable slot order within the kind's group (creation order). */
  slotIndex: number;
  /** Absolute path of the loaded sample; null = "shuffle to assign". */
  samplePath: string | null;
  /** Display basename of the sample (kept even if the file goes missing). */
  sampleName: string | null;
  /** True = pinned: exempt from every auto-shuffle / rotation path. */
  locked: boolean;
  /** Where the sample came from. */
  source: 'library' | 'import';
  /** Shots only: note start in quarter-note beats from the scene start. */
  offsetBeats?: number;
  /** Cached duration probe (host.getAudioFileInfo); absent = unknown. */
  sampleDurationSeconds?: number;
  /** Riser only: sample was longer than the scene → placed at 0, end NOT aligned. */
  truncated?: boolean;
  /** Scene the meta was written for — differs after scene duplication
   *  (plugin_data is copied verbatim), which is how repair detects clones. */
  appliedInSceneId: string;
}

/** Defensive narrow — returns null for anything that isn't a usable meta. */
export function asMixAssetMeta(val: unknown): MixAssetMeta | null {
  if (typeof val !== 'object' || val === null) return null;
  const m = val as Record<string, unknown>;
  if (m.version !== 1) return null;
  if (m.kind !== 'hit' && m.kind !== 'riser' && m.kind !== 'shot') return null;
  if (typeof m.slotIndex !== 'number' || !Number.isFinite(m.slotIndex)) return null;
  if (m.samplePath !== null && typeof m.samplePath !== 'string') return null;
  if (m.sampleName !== null && typeof m.sampleName !== 'string') return null;
  if (typeof m.locked !== 'boolean') return null;
  if (m.source !== 'library' && m.source !== 'import') return null;
  if (typeof m.appliedInSceneId !== 'string') return null;
  return m as unknown as MixAssetMeta;
}

/** Group-parse spec for the SDK's parseTrackGroups. */
export const MIX_ASSET_GROUP_SPEC: GroupParseSpec<MixAssetMeta> = {
  metaKey: MIX_ASSET_META_KEY,
  asMeta: asMixAssetMeta,
  groupIdOf: (meta) => meta.kind,
  sortMembers: (a, b) => a.meta.slotIndex - b.meta.slotIndex,
};

export const KIND_LABELS: Record<MixAssetKind, string> = {
  hit: 'Hits',
  riser: 'Risers',
  shot: 'Shots',
};

/** Track display-name prefix per kind ("Hit 1", "Riser 2", …). Load-bearing
 *  for duplication repair: orphaned clones are re-matched by this prefix. */
export const KIND_TRACK_PREFIX: Record<MixAssetKind, string> = {
  hit: 'Hit',
  riser: 'Riser',
  shot: 'Shot',
};

/** Parse a kind back out of a track display name ("Riser 2" → 'riser'). */
export function kindFromTrackName(name: string): MixAssetKind | null {
  const m = /^(Hit|Riser|Shot)\s+\d+$/u.exec(name.trim());
  if (!m) return null;
  return m[1].toLowerCase() as MixAssetKind;
}

// ---------------------------------------------------------------------------
// Scene-duplication repair
// ---------------------------------------------------------------------------
//
// Scene duplication copies scene plugin_data VERBATIM: the copied keys still
// name the SOURCE scene's track dbIds, while the cloned tracks got fresh
// dbIds. On load the panel therefore sees (a) metas whose dbId resolves no
// live plugin track ("stale") and (b) owned tracks named like ours with no
// meta ("orphans"). Repair pairs them positionally per kind.

export interface RepairPairing {
  /** Stale meta key's dbId (to delete) → orphan track dbId (to rewrite under). */
  staleDbId: string;
  orphanDbId: string;
  meta: MixAssetMeta;
  /** Unlocked members auto-rotate to a fresh sample; locked keep theirs. */
  rotate: boolean;
}

export interface RepairPlan {
  pairings: RepairPairing[];
  /** Orphans with no stale meta to pair — recreate a blank meta for these. */
  unpairedOrphans: Array<{ dbId: string; kind: MixAssetKind }>;
  /** Stale metas with no orphan to pair — delete their keys outright. */
  unpairedStaleDbIds: string[];
}

/**
 * Pure pairing: stale metas ↔ orphan tracks, per kind, in slotIndex /
 * given order. Both lists must belong to the CURRENT scene's live state.
 */
export function planDuplicationRepair(
  staleMetas: ReadonlyArray<{ dbId: string; meta: MixAssetMeta }>,
  orphanTracks: ReadonlyArray<{ dbId: string; name: string }>,
): RepairPlan {
  const pairings: RepairPairing[] = [];
  const unpairedOrphans: Array<{ dbId: string; kind: MixAssetKind }> = [];
  const unpairedStaleDbIds: string[] = [];

  for (const kind of MIX_ASSET_KINDS) {
    const stale = staleMetas
      .filter((s) => s.meta.kind === kind)
      .sort((a, b) => a.meta.slotIndex - b.meta.slotIndex);
    const orphans = orphanTracks.filter((o) => kindFromTrackName(o.name) === kind);

    const n = Math.min(stale.length, orphans.length);
    for (let i = 0; i < n; i++) {
      pairings.push({
        staleDbId: stale[i].dbId,
        orphanDbId: orphans[i].dbId,
        meta: stale[i].meta,
        rotate: !stale[i].meta.locked,
      });
    }
    for (let i = n; i < orphans.length; i++) {
      unpairedOrphans.push({ dbId: orphans[i].dbId, kind });
    }
    for (let i = n; i < stale.length; i++) {
      unpairedStaleDbIds.push(stale[i].dbId);
    }
  }

  return { pairings, unpairedOrphans, unpairedStaleDbIds };
}
