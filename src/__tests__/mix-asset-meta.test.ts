import { parseTrackGroups } from '@signalsandsorcery/plugin-sdk';
import {
  MIX_ASSET_GROUP_SPEC,
  asMixAssetMeta,
  kindFromTrackName,
  planDuplicationRepair,
  type MixAssetMeta,
} from '../mix-asset-meta';

function meta(overrides: Partial<MixAssetMeta> = {}): MixAssetMeta {
  return {
    version: 1,
    kind: 'hit',
    slotIndex: 0,
    samplePath: '/packs/impact/a.wav',
    sampleName: 'a.wav',
    locked: false,
    source: 'library',
    appliedInSceneId: 'scene-1',
    ...overrides,
  };
}

describe('asMixAssetMeta', () => {
  it('accepts a well-formed meta', () => {
    expect(asMixAssetMeta(meta())).not.toBeNull();
    expect(asMixAssetMeta(meta({ samplePath: null, sampleName: null }))).not.toBeNull();
  });

  it('rejects garbage and wrong shapes', () => {
    expect(asMixAssetMeta(null)).toBeNull();
    expect(asMixAssetMeta('x')).toBeNull();
    expect(asMixAssetMeta({})).toBeNull();
    expect(asMixAssetMeta(meta({ kind: 'boom' as never }))).toBeNull();
    expect(asMixAssetMeta({ ...meta(), version: 2 })).toBeNull();
    expect(asMixAssetMeta({ ...meta(), locked: 'yes' })).toBeNull();
    expect(asMixAssetMeta({ ...meta(), source: 'web' })).toBeNull();
  });
});

describe('parseTrackGroups round-trip with the mixAsset spec', () => {
  it('assembles per-kind groups ordered by slotIndex and skips bad values', () => {
    const sceneData: Record<string, unknown> = {
      'track:db-b:mixAsset': meta({ kind: 'hit', slotIndex: 1 }),
      'track:db-a:mixAsset': meta({ kind: 'hit', slotIndex: 0 }),
      'track:db-r:mixAsset': meta({ kind: 'riser', slotIndex: 0 }),
      'track:db-x:mixAsset': { junk: true },
      'track:db-a:samplePath': '/packs/impact/a.wav',
      unrelated: 42,
    };
    const groups = parseTrackGroups(sceneData, MIX_ASSET_GROUP_SPEC);
    const byId = new Map(groups.map((g) => [g.groupId, g]));
    expect(byId.get('hit')?.members.map((m) => m.dbId)).toEqual(['db-a', 'db-b']);
    expect(byId.get('riser')?.members.map((m) => m.dbId)).toEqual(['db-r']);
    expect(byId.has('shot')).toBe(false);
  });
});

describe('kindFromTrackName', () => {
  it('parses the canonical names', () => {
    expect(kindFromTrackName('Hit 1')).toBe('hit');
    expect(kindFromTrackName('Riser 12')).toBe('riser');
    expect(kindFromTrackName(' Shot 3 ')).toBe('shot');
  });
  it('rejects everything else', () => {
    expect(kindFromTrackName('Hit')).toBeNull();
    expect(kindFromTrackName('Kick 1')).toBeNull();
    expect(kindFromTrackName('hit 1')).toBeNull();
    expect(kindFromTrackName('Hit one')).toBeNull();
  });
});

describe('planDuplicationRepair', () => {
  it('pairs stale metas with orphans per kind in slot order', () => {
    const plan = planDuplicationRepair(
      [
        { dbId: 'old-h2', meta: meta({ kind: 'hit', slotIndex: 1, locked: true }) },
        { dbId: 'old-h1', meta: meta({ kind: 'hit', slotIndex: 0 }) },
        { dbId: 'old-r1', meta: meta({ kind: 'riser', slotIndex: 0 }) },
      ],
      [
        { dbId: 'new-h1', name: 'Hit 1' },
        { dbId: 'new-h2', name: 'Hit 2' },
        { dbId: 'new-r1', name: 'Riser 1' },
      ],
    );
    expect(plan.pairings).toHaveLength(3);
    const byStale = new Map(plan.pairings.map((p) => [p.staleDbId, p]));
    expect(byStale.get('old-h1')?.orphanDbId).toBe('new-h1');
    expect(byStale.get('old-h2')?.orphanDbId).toBe('new-h2');
    expect(byStale.get('old-r1')?.orphanDbId).toBe('new-r1');
    expect(plan.unpairedOrphans).toHaveLength(0);
    expect(plan.unpairedStaleDbIds).toHaveLength(0);
  });

  it('locked members keep their sample (rotate=false); unlocked rotate', () => {
    const plan = planDuplicationRepair(
      [
        { dbId: 'old-locked', meta: meta({ slotIndex: 0, locked: true }) },
        { dbId: 'old-free', meta: meta({ slotIndex: 1, locked: false }) },
      ],
      [
        { dbId: 'new-1', name: 'Hit 1' },
        { dbId: 'new-2', name: 'Hit 2' },
      ],
    );
    expect(plan.pairings.find((p) => p.staleDbId === 'old-locked')?.rotate).toBe(false);
    expect(plan.pairings.find((p) => p.staleDbId === 'old-free')?.rotate).toBe(true);
  });

  it('reports unpaired orphans (recreate blank) and unpaired stale (delete)', () => {
    const plan = planDuplicationRepair(
      [
        { dbId: 'old-1', meta: meta({ slotIndex: 0 }) },
        { dbId: 'old-2', meta: meta({ slotIndex: 1 }) },
      ],
      [{ dbId: 'new-1', name: 'Hit 1' }],
    );
    expect(plan.pairings).toHaveLength(1);
    expect(plan.unpairedStaleDbIds).toEqual(['old-2']);

    const plan2 = planDuplicationRepair(
      [],
      [{ dbId: 'new-s1', name: 'Shot 1' }],
    );
    expect(plan2.pairings).toHaveLength(0);
    expect(plan2.unpairedOrphans).toEqual([{ dbId: 'new-s1', kind: 'shot' }]);
  });

  it('never pairs across kinds', () => {
    const plan = planDuplicationRepair(
      [{ dbId: 'old-r', meta: meta({ kind: 'riser', slotIndex: 0 }) }],
      [{ dbId: 'new-h', name: 'Hit 1' }],
    );
    expect(plan.pairings).toHaveLength(0);
    expect(plan.unpairedStaleDbIds).toEqual(['old-r']);
    expect(plan.unpairedOrphans).toEqual([{ dbId: 'new-h', kind: 'hit' }]);
  });
});
