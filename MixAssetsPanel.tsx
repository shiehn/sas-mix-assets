/**
 * MixAssetsPanel — the Mix Assets panel.
 *
 * Three fixed track groups (Hits / Risers / Shots), each member an ordinary
 * fx-role track carrying the engine's single-sound sampler + one
 * deterministically-placed MIDI note:
 *
 *   hit   → note on the scene downbeat (openEnded sampler rings out)
 *   riser → note positioned so the sample's natural END lands exactly on
 *           the loop boundary (start = loopEnd − sampleDuration)
 *   shot  → note at a user-chosen beat offset
 *
 * Samples ROTATE (exclude-history pick per kind) so different scenes carry
 * different variants — that variety is the arranger's placement palette.
 * The per-row Lock pins a sample against every rotation path so it repeats
 * verbatim while the user auditions FX presets on the track.
 *
 * Persistence contract (read main-side by the arranger push service):
 * one scene-scoped plugin_data key per member — `track:<dbId>:mixAsset`
 * (see src/mix-asset-meta.ts). Scene duplication copies these keys verbatim
 * with the SOURCE dbIds; the load path repairs that (pair stale metas with
 * orphaned clones, keep locked samples, rotate unlocked ones).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  MusicalContext,
  PluginHost,
  PluginTrackHandle,
  PluginUIProps,
} from '@signalsandsorcery/plugin-sdk';
import {
  PanelMasterStrip,
  panelClipEndSeconds,
  panelMaxBeats,
  useAnySolo,
  usePanelBus,
} from '@signalsandsorcery/plugin-sdk';
import {
  KIND_LABELS,
  KIND_TRACK_PREFIX,
  MIX_ASSET_GROUP_SPEC,
  MIX_ASSET_KINDS,
  MIX_ASSET_META_KEY,
  kindFromTrackName,
  planDuplicationRepair,
  type MixAssetKind,
  type MixAssetMeta,
} from './src/mix-asset-meta';
import { parseTrackGroups } from '@signalsandsorcery/plugin-sdk';
import {
  buildClip,
  buildHitNotes,
  buildRiserNotes,
  buildShotNotes,
  maxShotOffsetBeats,
  type PlacementContext,
} from './src/placement';
import { asHistory, buildExcludeSet, historyKey, recordHistory } from './src/rotation';
import { createAssetResolver, type AssetResolver } from './src/asset-resolver';
import { AssetRow } from './src/ui/AssetRow';
import { styles } from './src/ui/styles';

interface MemberState {
  handle: PluginTrackHandle;
  meta: MixAssetMeta;
}

const DURATION_CACHE_KEY = 'durationCache';
const DURATION_CACHE_CAP = 200;
/** Riser pick attempts before settling for a too-long sample. */
const RISER_PICK_ATTEMPTS = 5;

function metaKeyFor(dbId: string): string {
  return `track:${dbId}:${MIX_ASSET_META_KEY}`;
}

function basename(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] ?? p;
}

function placementContext(mc: MusicalContext): PlacementContext {
  return {
    bpm: mc.bpm,
    clipEndSeconds: panelClipEndSeconds(mc),
    maxBeats: panelMaxBeats(mc),
  };
}

export function MixAssetsPanel(props: PluginUIProps): React.ReactElement {
  const { host, activeSceneId } = props;

  const [mc, setMc] = useState<MusicalContext | null>(null);
  const [members, setMembers] = useState<MemberState[]>([]);
  const [poolEmpty, setPoolEmpty] = useState<boolean>(false);
  const [muted, setMuted] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [previewingDbId, setPreviewingDbId] = useState<string | null>(null);
  const [fxOpenDbId, setFxOpenDbId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [addMenuKind, setAddMenuKind] = useState<MixAssetKind | null>(null);

  const panelBus = usePanelBus(host, activeSceneId);
  const anySolo = useAnySolo(host);

  const resolver: AssetResolver = useMemo(
    () =>
      createAssetResolver(host, async () => {
        const roots: string[] = [];
        try {
          const packRoot = await host.getSamplePackRoot('sas-drum-pack');
          if (packRoot) roots.push(packRoot);
        } catch {
          /* pack not installed */
        }
        try {
          const userRoots = (await host.getUserSampleRoots?.('drums')) ?? [];
          roots.push(...userRoots);
        } catch {
          /* older host */
        }
        return roots;
      }),
    [host],
  );

  // ---------------------------------------------------------------------
  // Duration probe (host.getAudioFileInfo) with a project-scoped cache —
  // one audio-tool spawn per NEW path, ever.
  // ---------------------------------------------------------------------
  const durationCacheRef = useRef<Record<string, number> | null>(null);

  const probeDuration = useCallback(
    async (samplePath: string): Promise<number | null> => {
      if (typeof host.getAudioFileInfo !== 'function') return null;
      if (!durationCacheRef.current) {
        try {
          durationCacheRef.current =
            (await host.getProjectData<Record<string, number>>(DURATION_CACHE_KEY)) ?? {};
        } catch {
          durationCacheRef.current = {};
        }
      }
      const cache = durationCacheRef.current;
      const cached = cache[samplePath];
      if (typeof cached === 'number' && Number.isFinite(cached)) return cached;
      try {
        const info = await host.getAudioFileInfo(samplePath);
        cache[samplePath] = info.durationSeconds;
        const keys = Object.keys(cache);
        if (keys.length > DURATION_CACHE_CAP) delete cache[keys[0]];
        host.setProjectData(DURATION_CACHE_KEY, cache).catch(() => {});
        return info.durationSeconds;
      } catch (err) {
        console.warn('[MixAssets] duration probe failed:', err);
        return null;
      }
    },
    [host],
  );

  // ---------------------------------------------------------------------
  // Rotation history (project-scoped, per kind)
  // ---------------------------------------------------------------------
  const getHistory = useCallback(
    async (kind: MixAssetKind): Promise<string[]> => {
      try {
        return asHistory(await host.getProjectData(historyKey(kind)));
      } catch {
        return [];
      }
    },
    [host],
  );

  const pushHistory = useCallback(
    async (kind: MixAssetKind, samplePath: string): Promise<void> => {
      const next = recordHistory(await getHistory(kind), samplePath);
      host.setProjectData(historyKey(kind), next).catch(() => {});
    },
    [host, getHistory],
  );

  // ---------------------------------------------------------------------
  // Placement
  // ---------------------------------------------------------------------
  const writePlacement = useCallback(
    async (
      handle: PluginTrackHandle,
      meta: MixAssetMeta,
      context: MusicalContext,
    ): Promise<boolean> => {
      const ctx = placementContext(context);
      let truncated = false;
      let notes;
      if (meta.kind === 'hit') {
        notes = buildHitNotes();
      } else if (meta.kind === 'riser') {
        const placement = buildRiserNotes(ctx, meta.sampleDurationSeconds ?? 0);
        notes = placement.notes;
        truncated = placement.truncated;
      } else {
        notes = buildShotNotes(ctx, meta.offsetBeats ?? 0);
      }
      await host.writeMidiClip(handle.id, buildClip(ctx, notes));
      return truncated;
    },
    [host],
  );

  // ---------------------------------------------------------------------
  // Apply a sample to a member: sampler + meta + MIDI + history.
  // ---------------------------------------------------------------------
  const applySample = useCallback(
    async (
      handle: PluginTrackHandle,
      meta: MixAssetMeta,
      samplePath: string,
      context: MusicalContext,
      sceneId: string,
    ): Promise<MixAssetMeta> => {
      const duration = await probeDuration(samplePath);
      await host.setTrackDrumKit(handle.id, { samplePath });
      let nextMeta: MixAssetMeta = {
        ...meta,
        samplePath,
        sampleName: basename(samplePath),
        sampleDurationSeconds: duration ?? undefined,
        truncated: false,
        appliedInSceneId: sceneId,
      };
      const truncated = await writePlacement(handle, nextMeta, context);
      nextMeta = { ...nextMeta, truncated };
      await host.setSceneData(sceneId, metaKeyFor(handle.dbId), nextMeta);
      await pushHistory(meta.kind, samplePath);
      return nextMeta;
    },
    [host, probeDuration, writePlacement, pushHistory],
  );

  // ---------------------------------------------------------------------
  // Pick a sample for a kind (riser: prefer one that fits the scene).
  // ---------------------------------------------------------------------
  const pickSample = useCallback(
    async (
      kind: MixAssetKind,
      exclude: Set<string>,
      context: MusicalContext,
    ): Promise<string | null> => {
      const clipEnd = panelClipEndSeconds(context);
      const attempts = kind === 'riser' ? RISER_PICK_ATTEMPTS : 1;
      const tried = new Set(exclude);
      let fallback: string | null = null;
      for (let i = 0; i < attempts; i++) {
        const path = await resolver.pick(kind, { excludePaths: tried });
        if (!path) break;
        if (kind !== 'riser') return path;
        const duration = await probeDuration(path);
        if (duration === null || duration <= clipEnd) return path;
        fallback = fallback ?? path;
        tried.add(path);
      }
      return fallback;
    },
    [resolver, probeDuration],
  );

  /** Full rotation pick: history ∪ scene same-kind ∪ current; reset on exhaustion. */
  const pickWithRotation = useCallback(
    async (
      kind: MixAssetKind,
      currentPath: string | null,
      context: MusicalContext,
      currentMembers: MemberState[],
    ): Promise<string | null> => {
      const sceneSameKind = currentMembers
        .filter((m) => m.meta.kind === kind)
        .map((m) => m.meta.samplePath);
      const history = await getHistory(kind);
      let picked = await pickSample(
        kind,
        buildExcludeSet(history, sceneSameKind, currentPath),
        context,
      );
      if (!picked) {
        // Pool exhausted — clear the kind's history and retry with
        // scene-local excludes only (drum-panel precedent).
        host.setProjectData(historyKey(kind), []).catch(() => {});
        picked = await pickSample(kind, buildExcludeSet([], sceneSameKind, currentPath), context);
      }
      return picked;
    },
    [getHistory, pickSample, host],
  );

  // ---------------------------------------------------------------------
  // Load: tracks + scene data → repair duplication → re-arm samplers.
  // ---------------------------------------------------------------------
  const membersRef = useRef<MemberState[]>([]);
  membersRef.current = members;

  const reload = useCallback(async (): Promise<void> => {
    if (!activeSceneId) {
      setMembers([]);
      setMc(null);
      return;
    }
    try {
      const context = await host.getMusicalContext();
      setMc(context);

      try {
        await host.adoptSceneTracks();
      } catch {
        /* nothing to adopt */
      }
      const handles = await host.getPluginTracks();
      const byDbId = new Map(handles.map((h) => [h.dbId, h]));
      let sceneData = await host.getAllSceneData(activeSceneId);
      let groups = parseTrackGroups(sceneData, MIX_ASSET_GROUP_SPEC);
      let flat = groups.flatMap((g) => g.members);

      // --- Scene-duplication repair ---------------------------------
      const staleMetas = flat.filter((m) => !byDbId.has(m.dbId));
      const metaDbIds = new Set(flat.map((m) => m.dbId));
      const orphanTracks = handles.filter(
        (h) => !metaDbIds.has(h.dbId) && kindFromTrackName(h.name) !== null,
      );
      if (staleMetas.length > 0 || orphanTracks.length > 0) {
        const plan = planDuplicationRepair(
          staleMetas.map((m) => ({ dbId: m.dbId, meta: m.meta })),
          orphanTracks.map((h) => ({ dbId: h.dbId, name: h.name })),
        );
        for (const pairing of plan.pairings) {
          const handle = byDbId.get(pairing.orphanDbId);
          if (!handle) continue;
          let nextMeta: MixAssetMeta = { ...pairing.meta, appliedInSceneId: activeSceneId };
          if (pairing.rotate && nextMeta.samplePath) {
            // Unlocked clone → rotate to a fresh variant (this is where
            // duplicated scenes pick up palette variety).
            const picked = await pickWithRotation(
              nextMeta.kind,
              nextMeta.samplePath,
              context,
              flat
                .filter((m) => byDbId.has(m.dbId))
                .map((m) => ({ handle: byDbId.get(m.dbId)!, meta: m.meta })),
            );
            if (picked) {
              nextMeta = await applySample(handle, nextMeta, picked, context, activeSceneId);
            } else {
              await host.setSceneData(activeSceneId, metaKeyFor(handle.dbId), nextMeta);
            }
          } else {
            // Locked (or sample-less) clone → keep the copied sample verbatim.
            await host.setSceneData(activeSceneId, metaKeyFor(handle.dbId), nextMeta);
          }
          await host.deleteSceneData(activeSceneId, metaKeyFor(pairing.staleDbId));
        }
        for (const staleDbId of plan.unpairedStaleDbIds) {
          await host.deleteSceneData(activeSceneId, metaKeyFor(staleDbId));
        }
        let slotBase = flat.reduce((max, m) => Math.max(max, m.meta.slotIndex), -1) + 1;
        for (const orphan of plan.unpairedOrphans) {
          const blank: MixAssetMeta = {
            version: 1,
            kind: orphan.kind,
            slotIndex: slotBase++,
            samplePath: null,
            sampleName: null,
            locked: false,
            source: 'library',
            appliedInSceneId: activeSceneId,
          };
          await host.setSceneData(activeSceneId, metaKeyFor(orphan.dbId), blank);
        }
        sceneData = await host.getAllSceneData(activeSceneId);
        groups = parseTrackGroups(sceneData, MIX_ASSET_GROUP_SPEC);
        flat = groups.flatMap((g) => g.members);
      }

      const next: MemberState[] = [];
      for (const m of flat) {
        const handle = byDbId.get(m.dbId);
        if (!handle) continue;
        next.push({ handle, meta: m.meta });
        // Re-arm the sampler from the persisted sample (restore semantics:
        // never counts as a sound edit, never un-freezes).
        if (m.meta.samplePath) {
          host
            .setTrackDrumKit(handle.id, { samplePath: m.meta.samplePath, restore: true })
            .catch((err: unknown) => console.warn('[MixAssets] sampler re-arm failed:', err));
        }
      }
      next.sort((a, b) =>
        a.meta.kind === b.meta.kind
          ? a.meta.slotIndex - b.meta.slotIndex
          : MIX_ASSET_KINDS.indexOf(a.meta.kind) - MIX_ASSET_KINDS.indexOf(b.meta.kind),
      );
      setMembers(next);
      setLoadError(null);

      const sizes = await resolver.getPoolSizes();
      setPoolEmpty(sizes.hit + sizes.riser + sizes.shot === 0);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[MixAssetsPanel] reload failed:', err);
      setLoadError(message);
    }
  }, [host, activeSceneId, resolver, pickWithRotation, applySample]);

  useEffect(() => {
    setMembers([]);
    setMuted({});
    setFxOpenDbId(null);
    setAddMenuKind(null);
    void reload();
  }, [reload]);

  // Agent parity: re-read after agent mutations touching this scene.
  useEffect(() => {
    if (typeof host.onAfterAgentMutation !== 'function') return;
    const unsubscribe = host.onAfterAgentMutation(() => void reload());
    return unsubscribe;
  }, [host, reload]);

  // Riser placement depends on bpm/bars/meter — rewrite when they change.
  const placementKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!mc || !activeSceneId) return;
    const key = `${activeSceneId}|${mc.bpm}|${mc.bars}|${mc.timeSignature}`;
    if (placementKeyRef.current === key) return;
    const isFirstForScene = !placementKeyRef.current?.startsWith(`${activeSceneId}|`);
    placementKeyRef.current = key;
    if (isFirstForScene) return; // initial load — clips already correct
    void (async () => {
      for (const m of membersRef.current) {
        if (!m.meta.samplePath) continue;
        try {
          const truncated = await writePlacement(m.handle, m.meta, mc);
          if (truncated !== Boolean(m.meta.truncated)) {
            const nextMeta = { ...m.meta, truncated };
            await host.setSceneData(activeSceneId, metaKeyFor(m.handle.dbId), nextMeta);
            setMembers((prev) =>
              prev.map((p) => (p.handle.dbId === m.handle.dbId ? { ...p, meta: nextMeta } : p)),
            );
          }
        } catch (err) {
          console.warn('[MixAssets] re-placement failed:', err);
        }
      }
    })();
  }, [mc, activeSceneId, host, writePlacement]);

  // ---------------------------------------------------------------------
  // Row actions
  // ---------------------------------------------------------------------
  const updateMember = useCallback((dbId: string, meta: MixAssetMeta): void => {
    setMembers((prev) => prev.map((m) => (m.handle.dbId === dbId ? { ...m, meta } : m)));
  }, []);

  const withBusy = useCallback(
    async (dbId: string, fn: () => Promise<void>): Promise<void> => {
      setBusy((prev) => ({ ...prev, [dbId]: true }));
      try {
        await fn();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        host.showToast('error', 'Mix Assets', message);
      } finally {
        setBusy((prev) => {
          const { [dbId]: _done, ...rest } = prev;
          return rest;
        });
      }
    },
    [host],
  );

  const handleShuffle = useCallback(
    (member: MemberState): void => {
      if (!mc || !activeSceneId || member.meta.locked) return;
      void withBusy(member.handle.dbId, async () => {
        const picked = await pickWithRotation(
          member.meta.kind,
          member.meta.samplePath,
          mc,
          membersRef.current,
        );
        if (!picked) {
          host.showToast(
            'warning',
            'Mix Assets',
            'No samples available for this kind — download the drum pack or import a sample folder.',
          );
          return;
        }
        const nextMeta = await applySample(member.handle, member.meta, picked, mc, activeSceneId);
        updateMember(member.handle.dbId, nextMeta);
      });
    },
    [mc, activeSceneId, withBusy, pickWithRotation, applySample, updateMember, host],
  );

  const handleLockToggle = useCallback(
    (member: MemberState): void => {
      if (!activeSceneId) return;
      const nextMeta = { ...member.meta, locked: !member.meta.locked };
      updateMember(member.handle.dbId, nextMeta);
      host
        .setSceneData(activeSceneId, metaKeyFor(member.handle.dbId), nextMeta)
        .catch((err: unknown) => console.warn('[MixAssets] lock persist failed:', err));
    },
    [activeSceneId, host, updateMember],
  );

  const handleMuteToggle = useCallback(
    (member: MemberState): void => {
      const next = !muted[member.handle.dbId];
      setMuted((prev) => ({ ...prev, [member.handle.dbId]: next }));
      host.setTrackMute(member.handle.id, next).catch((err: unknown) => {
        console.warn('[MixAssets] mute failed:', err);
        setMuted((prev) => ({ ...prev, [member.handle.dbId]: !next }));
      });
    },
    [host, muted],
  );

  const handlePreviewToggle = useCallback(
    (member: MemberState): void => {
      if (!member.meta.samplePath) return;
      if (previewingDbId === member.handle.dbId) {
        setPreviewingDbId(null);
        void host.stopPreview();
      } else {
        setPreviewingDbId(member.handle.dbId);
        host.previewSample(member.meta.samplePath).catch((err: unknown) => {
          console.warn('[MixAssets] preview failed:', err);
          setPreviewingDbId(null);
        });
      }
    },
    [host, previewingDbId],
  );

  const handleDelete = useCallback(
    (member: MemberState): void => {
      if (!activeSceneId) return;
      void (async () => {
        const ok = await host.confirmAction(
          'Delete asset track',
          `Delete "${member.handle.name}"? The track and its sample assignment are removed from this scene.`,
        );
        if (!ok) return;
        await withBusy(member.handle.dbId, async () => {
          await host.deleteTrack(member.handle.id);
          await host.deleteSceneData(activeSceneId, metaKeyFor(member.handle.dbId));
          setMembers((prev) => prev.filter((m) => m.handle.dbId !== member.handle.dbId));
        });
      })();
    },
    [host, activeSceneId, withBusy],
  );

  const handleOffsetChange = useCallback(
    (member: MemberState, beats: number): void => {
      if (!mc || !activeSceneId) return;
      const clamped = Math.min(
        Math.max(Number.isFinite(beats) ? beats : 0, 0),
        maxShotOffsetBeats(placementContext(mc)),
      );
      const nextMeta = { ...member.meta, offsetBeats: clamped };
      updateMember(member.handle.dbId, nextMeta);
      void withBusy(member.handle.dbId, async () => {
        await writePlacement(member.handle, nextMeta, mc);
        await host.setSceneData(activeSceneId, metaKeyFor(member.handle.dbId), nextMeta);
      });
    },
    [mc, activeSceneId, updateMember, withBusy, writePlacement, host],
  );

  // ---------------------------------------------------------------------
  // Add flows
  // ---------------------------------------------------------------------
  const addAsset = useCallback(
    (kind: MixAssetKind, source: 'library' | 'import'): void => {
      setAddMenuKind(null);
      if (!mc || !activeSceneId) return;
      void (async () => {
        try {
          let importedPath: string | null = null;
          if (source === 'import') {
            const chosen = await host.showOpenDialog({
              title: 'Import a one-shot sample',
              filters: [{ name: 'Audio', extensions: ['wav', 'aif', 'aiff', 'flac'] }],
            });
            if (!chosen || chosen.length === 0) return;
            const src = chosen[0];
            importedPath = await host.importFile(src, `${Date.now()}-${basename(src)}`);
          }

          const current = membersRef.current;
          const kindCount = current.filter((m) => m.meta.kind === kind).length;
          const slotIndex = current.reduce((max, m) => Math.max(max, m.meta.slotIndex), -1) + 1;
          const handle = await host.createTrack({
            name: `${KIND_TRACK_PREFIX[kind]} ${kindCount + 1}`,
            role: 'fx',
          });

          let meta: MixAssetMeta = {
            version: 1,
            kind,
            slotIndex,
            samplePath: null,
            sampleName: null,
            locked: false,
            source,
            ...(kind === 'shot' ? { offsetBeats: 0 } : {}),
            appliedInSceneId: activeSceneId,
          };
          await host.setSceneData(activeSceneId, metaKeyFor(handle.dbId), meta);

          const samplePath =
            importedPath ?? (await pickWithRotation(kind, null, mc, current));
          if (samplePath) {
            meta = await applySample(handle, meta, samplePath, mc, activeSceneId);
          } else if (source === 'library') {
            host.showToast(
              'warning',
              'Mix Assets',
              'No samples available for this kind yet — download the drum pack or import one.',
            );
          }
          setMembers((prev) =>
            [...prev, { handle, meta }].sort((a, b) =>
              a.meta.kind === b.meta.kind
                ? a.meta.slotIndex - b.meta.slotIndex
                : MIX_ASSET_KINDS.indexOf(a.meta.kind) - MIX_ASSET_KINDS.indexOf(b.meta.kind),
            ),
          );
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          host.showToast('error', 'Mix Assets', message);
        }
      })();
    },
    [mc, activeSceneId, host, pickWithRotation, applySample],
  );

  const handleShuffleAll = useCallback(
    (kind: MixAssetKind): void => {
      for (const member of membersRef.current) {
        if (member.meta.kind === kind && !member.meta.locked) {
          handleShuffle(member);
        }
      }
    },
    [handleShuffle],
  );

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------
  if (!activeSceneId) {
    return (
      <div style={styles.panel} data-testid="mix-assets-panel">
        <div style={styles.emptyState}>Select a scene to add mix assets.</div>
      </div>
    );
  }

  const maxOffset = mc ? maxShotOffsetBeats(placementContext(mc)) : 0;

  return (
    <div style={styles.panel} data-testid="mix-assets-panel">
      {loadError && <div style={styles.errorBar}>{loadError}</div>}
      {poolEmpty && (
        <div style={styles.cta}>
          No one-shot library found. Download the drum sample pack (its impact / riser / sweep /
          zap folders feed this panel) or import your own samples per track.
        </div>
      )}

      {MIX_ASSET_KINDS.map((kind) => {
        const kindMembers = members.filter((m) => m.meta.kind === kind);
        return (
          <div key={kind} style={styles.section} data-testid={`mix-assets-section-${kind}`}>
            <div style={styles.sectionHeader}>
              <span style={styles.sectionTitle}>{KIND_LABELS[kind]}</span>
              <span style={styles.sectionCount}>{kindMembers.length}</span>
              <span style={styles.sectionSpacer} />
              {kindMembers.some((m) => !m.meta.locked) && (
                <button
                  type="button"
                  style={styles.iconButton}
                  title={`Shuffle every unlocked ${KIND_LABELS[kind].toLowerCase()} row`}
                  onClick={() => handleShuffleAll(kind)}
                >
                  🎲 all
                </button>
              )}
            </div>

            {kindMembers.map((member) => (
              <AssetRow
                key={member.handle.dbId}
                host={host}
                trackId={member.handle.id}
                trackName={member.handle.name}
                meta={member.meta}
                muted={Boolean(muted[member.handle.dbId])}
                busy={Boolean(busy[member.handle.dbId])}
                previewing={previewingDbId === member.handle.dbId}
                fxOpen={fxOpenDbId === member.handle.dbId}
                maxOffsetBeats={maxOffset}
                onPreviewToggle={() => handlePreviewToggle(member)}
                onShuffle={() => handleShuffle(member)}
                onLockToggle={() => handleLockToggle(member)}
                onMuteToggle={() => handleMuteToggle(member)}
                onFxToggle={() =>
                  setFxOpenDbId((prev) => (prev === member.handle.dbId ? null : member.handle.dbId))
                }
                onDelete={() => handleDelete(member)}
                onOffsetChange={
                  kind === 'shot' ? (beats) => handleOffsetChange(member, beats) : undefined
                }
              />
            ))}

            {addMenuKind === kind ? (
              <div style={styles.addMenu}>
                <button
                  type="button"
                  style={styles.addMenuItem}
                  onClick={() => addAsset(kind, 'library')}
                >
                  From library
                </button>
                <button
                  type="button"
                  style={styles.addMenuItem}
                  onClick={() => addAsset(kind, 'import')}
                >
                  Import audio…
                </button>
                <button
                  type="button"
                  style={{ ...styles.addMenuItem, opacity: 0.6, flex: 0 }}
                  onClick={() => setAddMenuKind(null)}
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                type="button"
                style={styles.addButton}
                data-testid={`mix-assets-add-${kind}`}
                onClick={() => setAddMenuKind(kind)}
              >
                + Add {KIND_LABELS[kind].toLowerCase().replace(/s$/u, '')}
              </button>
            )}
          </div>
        );
      })}

      {panelBus.supported && panelBus.bus && (
        <PanelMasterStrip
          bus={panelBus.bus}
          levels={panelBus.levels}
          availableFx={panelBus.availableFx}
          fxLoading={panelBus.fxLoading}
          soloedOut={anySolo && !panelBus.bus.soloed}
          fxPickerOpen={panelBus.fxPickerOpen}
          onToggleFxPicker={panelBus.setFxPickerOpen}
          onRefreshFx={panelBus.refreshFx}
          onVolumeChange={panelBus.onVolumeChange}
          onMuteToggle={panelBus.onMuteToggle}
          onSoloToggle={panelBus.onSoloToggle}
          onAddFx={panelBus.onAddFx}
          onRemoveFx={panelBus.onRemoveFx}
          onToggleFxEnabled={panelBus.onToggleFxEnabled}
          onShowFxEditor={panelBus.onShowFxEditor}
          onMoveFx={panelBus.fxReorderSupported ? panelBus.onMoveFx : undefined}
        />
      )}
    </div>
  );
}
