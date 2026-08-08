import type { PluginHost } from '@signalsandsorcery/plugin-sdk';
import { KIND_FOLDERS, createAssetResolver } from '../asset-resolver';

function hostWithFiles(filesByRoot: Record<string, string[]>): PluginHost {
  return {
    listAudioFiles: jest.fn(async (root: string) => {
      const files = filesByRoot[root];
      if (!files) throw new Error(`no such root: ${root}`);
      return files;
    }),
    readTextFile: jest.fn(async () => {
      throw new Error('no sidecars in this test');
    }),
  } as unknown as PluginHost;
}

const PACK = '/packs/drums';

describe('createAssetResolver', () => {
  it('pools only the kind folders and ignores everything else', async () => {
    const host = hostWithFiles({
      [PACK]: [
        `${PACK}/impact/a.wav`,
        `${PACK}/hit/b.wav`,
        `${PACK}/sub-drop/c.wav`,
        `${PACK}/riser/r.wav`,
        `${PACK}/sweep/s.wav`,
        `${PACK}/zap/z.wav`,
        `${PACK}/kick/k.wav`,
        `${PACK}/snare/n.wav`,
      ],
    });
    const resolver = createAssetResolver(host, PACK, { rng: () => 0 });
    const sizes = await resolver.getPoolSizes();
    expect(sizes).toEqual({ hit: 3, riser: 2, shot: 1 });
    expect(await resolver.pick('hit')).toBe(`${PACK}/impact/a.wav`);
  });

  it('merges multiple roots into one pool (user packs union)', async () => {
    const USER = '/user/drums/mypack';
    const host = hostWithFiles({
      [PACK]: [`${PACK}/riser/r1.wav`],
      [USER]: [`${USER}/riser/r2.wav`],
    });
    const resolver = createAssetResolver(host, [PACK, USER]);
    const sizes = await resolver.getPoolSizes();
    expect(sizes.riser).toBe(2);
  });

  it('skips a failing root but keeps the others', async () => {
    const host = hostWithFiles({ [PACK]: [`${PACK}/impact/a.wav`] });
    const resolver = createAssetResolver(host, [PACK, '/missing/root']);
    const sizes = await resolver.getPoolSizes();
    expect(sizes.hit).toBe(1);
  });

  it('excludes _vNNN tempo-variant files from the pool', async () => {
    const host = hostWithFiles({
      [PACK]: [`${PACK}/sub-drop/base.wav`, `${PACK}/sub-drop/base_v129.wav`],
    });
    const resolver = createAssetResolver(host, PACK);
    const sizes = await resolver.getPoolSizes();
    expect(sizes.hit).toBe(1);
  });

  it('respects excludePaths and returns null on an exhausted pool', async () => {
    const host = hostWithFiles({
      [PACK]: [`${PACK}/zap/z1.wav`, `${PACK}/zap/z2.wav`],
    });
    const resolver = createAssetResolver(host, PACK, { rng: () => 0 });
    const first = await resolver.pick('shot');
    expect(first).toBe(`${PACK}/zap/z1.wav`);
    const second = await resolver.pick('shot', { excludePaths: new Set([first!]) });
    expect(second).toBe(`${PACK}/zap/z2.wav`);
    const third = await resolver.pick('shot', { excludePaths: new Set([first!, second!]) });
    expect(third).toBeNull();
  });

  it('returns null cleanly when no library is installed', async () => {
    const host = hostWithFiles({});
    const resolver = createAssetResolver(host, () => Promise.resolve(null));
    expect(await resolver.pick('hit')).toBeNull();
    expect(await resolver.getPoolSizes()).toEqual({ hit: 0, riser: 0, shot: 0 });
  });

  it('every KIND_FOLDERS folder is a known drum-pack FX folder', () => {
    const legal = new Set([
      'impact', 'hit', 'sub-drop', 'riser', 'sweep', 'zap', 'texture', 'downlifter',
    ]);
    for (const folders of Object.values(KIND_FOLDERS)) {
      for (const f of folders) expect(legal.has(f)).toBe(true);
    }
  });
});
