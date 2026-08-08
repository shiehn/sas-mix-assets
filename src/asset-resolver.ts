/**
 * Asset resolver — picks a WAV for a given asset KIND from the configured
 * one-shot library. Forked from sas-drum-plugin/src/kit-resolver.ts (plugins
 * must not depend on each other at runtime), narrowed from "every folder is
 * a role" to a fixed kind→folders mapping over the drum pack's FX folders.
 * SDK-lifting the shared resolver so drum + mix-assets stop diverging is a
 * known later cleanup.
 *
 * Roots: `host.getSamplePackRoot('sas-drum-pack')` + every
 * `host.getUserSampleRoots?.('drums')` root — the same union the drum panel
 * scans, so user-imported impact/riser folders feed the pools automatically.
 * File listing happens once, lazily, via `host.listAudioFiles`, then is
 * cached; `reset()` forces a re-scan.
 */

import { scorePromptMatch, pickTopKWeighted } from '@signalsandsorcery/plugin-sdk';
import type { PluginHost } from '@signalsandsorcery/plugin-sdk';
import type { MixAssetKind } from './mix-asset-meta';

/**
 * Which library folders feed each kind's pool. All are real folders in the
 * distributed drum pack v3 (and legal user-import roles): see
 * DRUM_FOLDER_TO_INSTRUMENT in sas-app's instrument-classification.ts.
 */
export const KIND_FOLDERS: Record<MixAssetKind, readonly string[]> = {
  hit: ['impact', 'hit', 'sub-drop'],
  riser: ['riser', 'sweep'],
  shot: ['zap', 'texture', 'downlifter'],
};

/**
 * Tempo-stretched loop variants (`<base>_v<bpm>.wav`) have no place in a
 * native-pitch one-shot pool — same exclusion as the drum kit-resolver.
 */
const VARIANT_RE = /_v\d+\.wav$/iu;

export type SampleRootSource =
  | string
  | string[]
  | (() => Promise<string | string[] | null>);

export interface PickOptions {
  /** Rotation exclude set — paths to skip. */
  excludePaths?: ReadonlySet<string>;
  /** Free-text intent; biases toward sidecar-prompt matches when present. */
  query?: string;
}

export interface AssetResolverOptions {
  /** Injectable RNG in [0, 1) for deterministic tests (default Math.random). */
  rng?: () => number;
}

export interface AssetResolver {
  /**
   * Pick a WAV path for the kind (union pool over its folders). Returns null
   * when the filtered pool is empty — caller resets its rotation history and
   * retries — or when no library is installed.
   */
  pick(kind: MixAssetKind, options?: PickOptions): Promise<string | null>;
  /** Pool size per kind (0 = kind unavailable) — drives empty-library CTA. */
  getPoolSizes(): Promise<Record<MixAssetKind, number>>;
  /** Force a re-scan of the library on the next pick. */
  reset(): void;
}

export function createAssetResolver(
  host: PluginHost,
  root: SampleRootSource,
  options?: AssetResolverOptions,
): AssetResolver {
  const rng = options?.rng ?? Math.random;

  /** Lazily-populated map: folder name → list of absolute WAV paths. */
  let cache: Map<string, string[]> | null = null;
  let listingPromise: Promise<Map<string, string[]>> | null = null;

  /** WAV path → sidecar prompt ('' when missing); filled per kind on demand. */
  const promptCache = new Map<string, string>();
  const promptsLoadedKinds = new Set<MixAssetKind>();

  async function ensurePromptsForKind(kind: MixAssetKind, pool: readonly string[]): Promise<void> {
    if (promptsLoadedKinds.has(kind)) return;
    await Promise.all(
      pool.map(async (wavPath) => {
        if (promptCache.has(wavPath)) return;
        const sidecar = wavPath.replace(/\.wav$/iu, '.txt');
        try {
          const text = await host.readTextFile(sidecar);
          promptCache.set(wavPath, text ? text.trim() : '');
        } catch {
          promptCache.set(wavPath, '');
        }
      }),
    );
    promptsLoadedKinds.add(kind);
  }

  async function resolveRoots(): Promise<string[]> {
    const raw = typeof root === 'function' ? await root() : root;
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    const seen = new Set<string>();
    const roots: string[] = [];
    for (const r of list) {
      if (typeof r === 'string' && r.length > 0 && !seen.has(r)) {
        seen.add(r);
        roots.push(r);
      }
    }
    return roots;
  }

  /** The set of folders any kind cares about — everything else is skipped. */
  const wantedFolders = new Set<string>(Object.values(KIND_FOLDERS).flat());

  async function getCache(): Promise<Map<string, string[]>> {
    if (cache) return cache;
    if (listingPromise) return listingPromise;

    listingPromise = (async () => {
      try {
        const roots = await resolveRoots();
        if (roots.length === 0) {
          cache = new Map();
          return cache;
        }
        const byFolder = new Map<string, string[]>();
        // Scan every root independently and merge; a failing root is skipped.
        for (const rootPath of roots) {
          let paths: string[];
          try {
            paths = await host.listAudioFiles(rootPath, { extensions: ['.wav'], recursive: true });
          } catch (err: unknown) {
            console.warn(`[asset-resolver] Failed to list samples under ${rootPath}:`, err);
            continue;
          }
          for (const p of paths) {
            if (VARIANT_RE.test(p)) continue;
            const parts = p.split('/');
            const folder = parts[parts.length - 2] ?? '';
            if (!folder || !wantedFolders.has(folder)) continue;
            const existing = byFolder.get(folder);
            if (existing) {
              existing.push(p);
            } else {
              byFolder.set(folder, [p]);
            }
          }
        }
        cache = byFolder;
        return byFolder;
      } finally {
        // Always clear so a transient failure doesn't poison the resolver.
        listingPromise = null;
      }
    })();

    return listingPromise;
  }

  async function poolForKind(kind: MixAssetKind): Promise<string[]> {
    let byFolder: Map<string, string[]>;
    try {
      byFolder = await getCache();
    } catch (err: unknown) {
      console.warn('[asset-resolver] Failed to list samples:', err);
      return [];
    }
    const pool: string[] = [];
    for (const folder of KIND_FOLDERS[kind]) {
      const list = byFolder.get(folder);
      if (list) pool.push(...list);
    }
    return pool;
  }

  async function pick(kind: MixAssetKind, options?: PickOptions): Promise<string | null> {
    const { excludePaths, query } = options ?? {};

    const pool = await poolForKind(kind);
    if (pool.length === 0) return null;

    const filtered =
      excludePaths && excludePaths.size > 0 ? pool.filter((p) => !excludePaths.has(p)) : pool;
    if (filtered.length === 0) return null;

    // Semantic pick — any failure falls through to uniform random.
    const trimmedQuery = query?.trim();
    if (trimmedQuery) {
      try {
        await ensurePromptsForKind(kind, pool);
        const prompts = filtered.map((p) => promptCache.get(p) ?? '');
        const scores = scorePromptMatch(trimmedQuery, prompts);
        const maxScore = scores.reduce((m, s) => Math.max(m, s), 0);
        if (maxScore > 0) {
          const picked = pickTopKWeighted(
            filtered.map((p, i) => ({ item: p, score: scores[i], key: p })),
            { rng },
          );
          if (picked) return picked;
        }
      } catch (err) {
        console.warn('[asset-resolver] Semantic pick failed, using random:', err);
      }
    }

    const idx = Math.floor(rng() * filtered.length);
    return filtered[idx] ?? null;
  }

  async function getPoolSizes(): Promise<Record<MixAssetKind, number>> {
    const sizes = { hit: 0, riser: 0, shot: 0 } as Record<MixAssetKind, number>;
    for (const kind of Object.keys(KIND_FOLDERS) as MixAssetKind[]) {
      sizes[kind] = (await poolForKind(kind)).length;
    }
    return sizes;
  }

  return {
    pick,
    getPoolSizes,
    reset(): void {
      cache = null;
      listingPromise = null;
      promptCache.clear();
      promptsLoadedKinds.clear();
    },
  };
}
