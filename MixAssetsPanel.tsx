/**
 * MixAssetsPanel — the Mix Assets panel.
 *
 * TWO FAMILIES, one divider between them:
 *
 * MIDI (top) — Hits / Risers / Shots as ordinary instrument tracks (Surge XT
 * by default; the user swaps in a rompler / any synth via the 🎹 drawer)
 * carrying one DETERMINISTIC root note — no LLM anywhere:
 *
 *   midi hit   → the root (doubling the scene's first bass note when one
 *                exists, else key/chord root in the bass octave), a quarter
 *                note on the scene downbeat
 *   midi riser → the root held across the LAST BAR of the loop
 *   midi shot  → the root, quarter note at a user-chosen beat offset
 *
 * The 🎲 on a MIDI row rotates the Surge preset through the same
 * exclude-history model the audio rows use for samples.
 *
 * Audio samples (bottom) — the original one-shot sampler rows:
 *
 *   hit   → note on the scene downbeat (openEnded sampler rings out)
 *   riser → note positioned so the sample's natural END lands exactly on
 *           the loop boundary (start = loopEnd − sampleDuration)
 *   shot  → note at a user-chosen beat offset
 *
 * Sounds ROTATE (exclude-history pick per kind, per family) so different
 * scenes carry different variants — that variety is the arranger's placement
 * palette. The per-row Lock pins a sound against every rotation path so it
 * repeats verbatim while the user auditions FX presets on the track.
 *
 * ROUND ROBIN (playback): only ONE member per kind is audible at a time —
 * MIDI and audio of the same kind share the pool (a MIDI hit and a sample
 * hit never stack). The active member advances one step on every transport
 * stop and is enforced with ENGINE-only mutes; the DB muted column is left
 * alone so the arranger push still receives every variant (the cloud brain
 * already places at most one asset of a kind at a time).
 *
 * LONG PATTERNS: scenes of 16+ bars place hits on the downbeat AND the loop
 * midpoint (the second phrase's downbeat), for both families.
 *
 * Persistence contract (read main-side by the arranger push service):
 * one scene-scoped plugin_data key per member — `track:<dbId>:mixAsset`
 * (see src/mix-asset-meta.ts). Scene duplication copies these keys verbatim
 * with the SOURCE dbIds; the load path repairs that (pair stale metas with
 * orphaned clones per kind AND family, keep locked sounds, rotate unlocked
 * ones — samples for audio rows, Surge presets for MIDI rows).
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
  tryParseTimeSignature,
  useAnySolo,
  usePanelBus,
} from '@signalsandsorcery/plugin-sdk';
import {
  KIND_LABELS,
  MIX_ASSET_GROUP_SPEC,
  MIX_ASSET_KINDS,
  MIX_ASSET_MEDIUMS,
  MIX_ASSET_META_KEY,
  kindFromTrackName,
  mediumOf,
  planDuplicationRepair,
  trackPrefixFor,
  type MixAssetKind,
  type MixAssetMedium,
  type MixAssetMeta,
} from './src/mix-asset-meta';
import { parseTrackGroups } from '@signalsandsorcery/plugin-sdk';
import {
  buildClip,
  buildHitNotes,
  buildRiserNotes,
  buildShotNotes,
  hitStartBeats,
  maxShotOffsetBeats,
  type PlacementContext,
} from './src/placement';
import {
  buildMidiHitNotes,
  buildMidiRiserNotes,
  buildMidiShotNotes,
  rootPitchFromContext,
} from './src/midi-placement';
import { deriveRootPitch } from './src/root-pitch';
import { basename } from './src/paths';
import {
  ROUND_ROBIN_KEY,
  advanceActive,
  asActiveByKind,
  mutePlan,
  normalizeActive,
  sameActive,
  type ActiveByKind,
  type RoundRobinMember,
} from './src/round-robin';
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

/** Semantic bias for the MIDI rows' Surge preset rotation, per kind. */
const MIDI_PRESET_DESCRIPTION: Record<MixAssetKind, string> = {
  hit: 'impact hit one-shot stab',
  riser: 'riser build-up sweep',
  shot: 'fx one-shot zap accent',
};

const FAMILY_LABELS: Record<MixAssetMedium, string> = {
  midi: 'MIDI',
  audio: 'Audio Samples',
};

/** shufflePreset pool exhausted → wrap the deck (SDK cycle convention). */
function isPresetPoolExhausted(err: unknown): boolean {
  return /no presets available/iu.test(err instanceof Error ? err.message : String(err));
}

/** shufflePreset refused: a non-Surge instrument is loaded on the track. */
function isPresetIncompatible(err: unknown): boolean {
  return /preset shuffle applies/iu.test(err instanceof Error ? err.message : String(err));
}

function metaKeyFor(dbId: string): string {
  return `track:${dbId}:${MIX_ASSET_META_KEY}`;
}

function placementContext(mc: MusicalContext): PlacementContext {
  return {
    bpm: mc.bpm,
    clipEndSeconds: panelClipEndSeconds(mc),
    maxBeats: panelMaxBeats(mc),
  };
}

/** Stable member order: family (MIDI section first), then kind, then slot. */
function memberOrder(a: MemberState, b: MemberState): number {
  const am = mediumOf(a.meta);
  const bm = mediumOf(b.meta);
  if (am !== bm) return MIX_ASSET_MEDIUMS.indexOf(am) - MIX_ASSET_MEDIUMS.indexOf(bm);
  if (a.meta.kind !== b.meta.kind) {
    return MIX_ASSET_KINDS.indexOf(a.meta.kind) - MIX_ASSET_KINDS.indexOf(b.meta.kind);
  }
  return a.meta.slotIndex - b.meta.slotIndex;
}

/** The round-robin view of a member list (kind pool spans BOTH families). */
function asRoundRobinMembers(memberList: readonly MemberState[]): RoundRobinMember[] {
  return memberList.map((m) => ({ dbId: m.handle.dbId, kind: m.meta.kind }));
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
  const [soundOpenDbId, setSoundOpenDbId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [addMenuKind, setAddMenuKind] = useState<MixAssetKind | null>(null);
  /** Round robin: which member of each kind plays this rotation. */
  const [active, setActive] = useState<ActiveByKind>({});
  const activeRef = useRef<ActiveByKind>({});
  activeRef.current = active;

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
  // Rotation history (project-scoped, per kind; MIDI presets use the
  // parallel `midi:<kind>` deck so sample and preset rotations never mix)
  // ---------------------------------------------------------------------
  const getHistory = useCallback(
    async (kindKey: string): Promise<string[]> => {
      try {
        return asHistory(await host.getProjectData(historyKey(kindKey)));
      } catch {
        return [];
      }
    },
    [host],
  );

  const pushHistory = useCallback(
    async (kindKey: string, soundName: string): Promise<void> => {
      const next = recordHistory(await getHistory(kindKey), soundName);
      host.setProjectData(historyKey(kindKey), next).catch(() => {});
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
      if (mediumOf(meta) === 'midi') {
        const pitch = meta.rootPitch ?? rootPitchFromContext(context.key, context.chordProgression);
        let midiNotes;
        if (meta.kind === 'hit') {
          midiNotes = buildMidiHitNotes(pitch, hitStartBeats(context.bars, ctx.maxBeats));
        } else if (meta.kind === 'riser') {
          const qnPerBar = tryParseTimeSignature(context.timeSignature)?.quarterNotesPerBar ?? 4;
          midiNotes = buildMidiRiserNotes(ctx, pitch, qnPerBar);
        } else {
          midiNotes = buildMidiShotNotes(ctx, pitch, meta.offsetBeats ?? 0);
        }
        await host.writeMidiClip(handle.id, buildClip(ctx, midiNotes));
        return false; // MIDI placements are never end-alignment-truncated
      }
      let truncated = false;
      let notes;
      if (meta.kind === 'hit') {
        notes = buildHitNotes(hitStartBeats(context.bars, ctx.maxBeats));
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
  // MIDI rows: Surge preset rotation — the 🎲 for the MIDI family. Same
  // exclude-history cycle as samples (history ∪ scene same-kind ∪ current;
  // wipe the deck on exhaustion). Throws INCOMPATIBLE-flavored errors
  // through to the caller when a custom instrument is loaded.
  // ---------------------------------------------------------------------
  const shuffleMidiPreset = useCallback(
    async (
      handle: PluginTrackHandle,
      meta: MixAssetMeta,
      currentMembers: MemberState[],
    ): Promise<string | null> => {
      const kindKey = `midi:${meta.kind}`;
      const sceneSameKind = currentMembers
        .filter(
          (m) =>
            m.meta.kind === meta.kind &&
            mediumOf(m.meta) === 'midi' &&
            m.handle.dbId !== handle.dbId,
        )
        .map((m) => m.meta.sampleName);
      const options = { description: MIDI_PRESET_DESCRIPTION[meta.kind] };
      const history = await getHistory(kindKey);
      let result;
      try {
        result = await host.shufflePreset(
          handle.id,
          Array.from(buildExcludeSet(history, sceneSameKind, meta.sampleName)),
          options,
        );
      } catch (err: unknown) {
        if (!isPresetPoolExhausted(err)) throw err;
        // Deck exhausted — clear the kind's preset history and retry with
        // scene-local excludes only (sample-rotation precedent).
        host.setProjectData(historyKey(kindKey), []).catch(() => {});
        result = await host.shufflePreset(
          handle.id,
          Array.from(buildExcludeSet([], sceneSameKind, meta.sampleName)),
          options,
        );
      }
      await pushHistory(kindKey, result.presetName);
      return result.presetName;
    },
    [host, getHistory, pushHistory],
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
  // Round robin: only ONE member per kind is audible; MIDI and audio of the
  // same kind share the pool. Enforced via ENGINE-only mutes (never the DB
  // muted column — the arranger push must keep seeing every variant) and
  // advanced one step on every transport STOP, so the next playthrough
  // starts with the next asset already in place.
  // ---------------------------------------------------------------------
  const applyRoundRobin = useCallback(
    (activeMap: ActiveByKind, memberList: readonly MemberState[]): void => {
      const plan = mutePlan(activeMap, asRoundRobinMembers(memberList));
      setMuted((prev) => ({ ...prev, ...plan }));
      for (const m of memberList) {
        host
          .setTrackMute(m.handle.id, plan[m.handle.dbId] ?? false)
          .catch((err: unknown) => console.warn('[MixAssets] round-robin mute failed:', err));
      }
    },
    [host],
  );

  const setActiveAndEnforce = useCallback(
    (next: ActiveByKind, memberList: readonly MemberState[], sceneId: string): void => {
      activeRef.current = next;
      setActive(next);
      host
        .setSceneData(sceneId, ROUND_ROBIN_KEY, next)
        .catch((err: unknown) => console.warn('[MixAssets] round-robin persist failed:', err));
      applyRoundRobin(next, memberList);
    },
    [host, applyRoundRobin],
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
          const liveMembers = flat
            .filter((m) => byDbId.has(m.dbId))
            .map((m) => ({ handle: byDbId.get(m.dbId)!, meta: m.meta }));
          if (pairing.rotate && mediumOf(nextMeta) === 'audio' && nextMeta.samplePath) {
            // Unlocked clone → rotate to a fresh variant (this is where
            // duplicated scenes pick up palette variety).
            const picked = await pickWithRotation(
              nextMeta.kind,
              nextMeta.samplePath,
              context,
              liveMembers,
            );
            if (picked) {
              nextMeta = await applySample(handle, nextMeta, picked, context, activeSceneId);
            } else {
              await host.setSceneData(activeSceneId, metaKeyFor(handle.dbId), nextMeta);
            }
          } else if (pairing.rotate && mediumOf(nextMeta) === 'midi') {
            // Unlocked MIDI clone → rotate to a fresh Surge preset; a custom
            // instrument or empty pool keeps the cloned sound (the clip's
            // notes were duplicated correctly — no rewrite needed).
            try {
              const presetName = await shuffleMidiPreset(handle, nextMeta, liveMembers);
              if (presetName) nextMeta = { ...nextMeta, sampleName: presetName };
            } catch {
              /* keep the cloned sound */
            }
            await host.setSceneData(activeSceneId, metaKeyFor(handle.dbId), nextMeta);
          } else {
            // Locked (or sound-less) clone → keep the copied sound verbatim.
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
            ...(orphan.medium === 'midi' ? { medium: 'midi' as const } : {}),
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
      next.sort(memberOrder);
      setMembers(next);
      setLoadError(null);

      // Round robin: restore the active map (repairing stale dbIds from
      // duplication/deletion) and enforce the one-per-kind mutes.
      const stored = asActiveByKind(sceneData[ROUND_ROBIN_KEY]);
      const { active: normalized, changed } = normalizeActive(stored, asRoundRobinMembers(next));
      activeRef.current = normalized;
      setActive(normalized);
      if (changed) {
        host
          .setSceneData(activeSceneId, ROUND_ROBIN_KEY, normalized)
          .catch((err: unknown) => console.warn('[MixAssets] round-robin persist failed:', err));
      }
      applyRoundRobin(normalized, next);

      const sizes = await resolver.getPoolSizes();
      setPoolEmpty(sizes.hit + sizes.riser + sizes.shot === 0);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[MixAssetsPanel] reload failed:', err);
      setLoadError(message);
    }
  }, [host, activeSceneId, resolver, pickWithRotation, applySample, shuffleMidiPreset, applyRoundRobin]);

  useEffect(() => {
    setMembers([]);
    setMuted({});
    setFxOpenDbId(null);
    setSoundOpenDbId(null);
    setAddMenuKind(null);
    setActive({});
    activeRef.current = {};
    void reload();
  }, [reload]);

  // Agent parity: re-read after agent mutations touching this scene.
  useEffect(() => {
    if (typeof host.onAfterAgentMutation !== 'function') return;
    const unsubscribe = host.onAfterAgentMutation(() => void reload());
    return unsubscribe;
  }, [host, reload]);

  // Round robin advance: one step per transport STOP (not play — flipping
  // mutes just after the downbeat would chop the ringing hit), so the next
  // playthrough starts with the next asset already enforced.
  useEffect(() => {
    if (!activeSceneId || typeof host.onTransportEvent !== 'function') return;
    const unsubscribe = host.onTransportEvent((event) => {
      if (event.type !== 'stop') return;
      const memberList = membersRef.current;
      const next = advanceActive(activeRef.current, asRoundRobinMembers(memberList));
      if (sameActive(next, activeRef.current)) return;
      setActiveAndEnforce(next, memberList, activeSceneId);
    });
    return unsubscribe;
  }, [host, activeSceneId, setActiveAndEnforce]);

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
        // MIDI placements always rewrite (the riser's last bar moves with
        // the meter); audio rows only when they actually carry a sample.
        if (mediumOf(m.meta) === 'audio' && !m.meta.samplePath) continue;
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
      if (mediumOf(member.meta) === 'midi') {
        void withBusy(member.handle.dbId, async () => {
          try {
            const presetName = await shuffleMidiPreset(
              member.handle,
              member.meta,
              membersRef.current,
            );
            if (!presetName) return;
            const nextMeta: MixAssetMeta = {
              ...member.meta,
              sampleName: presetName,
              appliedInSceneId: activeSceneId,
            };
            await host.setSceneData(activeSceneId, metaKeyFor(member.handle.dbId), nextMeta);
            updateMember(member.handle.dbId, nextMeta);
          } catch (err: unknown) {
            if (isPresetIncompatible(err)) {
              host.showToast(
                'warning',
                'Mix Assets',
                'This row has a custom instrument — its patches are changed in the instrument\'s own editor (🎹), not by shuffle.',
              );
              return;
            }
            throw err;
          }
        });
        return;
      }
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
    [mc, activeSceneId, withBusy, pickWithRotation, shuffleMidiPreset, applySample, updateMember, host],
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
          `Delete "${member.handle.name}"? The track and its sound assignment are removed from this scene.`,
        );
        if (!ok) return;
        await withBusy(member.handle.dbId, async () => {
          await host.deleteTrack(member.handle.id);
          await host.deleteSceneData(activeSceneId, metaKeyFor(member.handle.dbId));
          setMembers((prev) => prev.filter((m) => m.handle.dbId !== member.handle.dbId));
          // If the deleted member held the active slot, hand it to the next.
          const remaining = membersRef.current.filter(
            (m) => m.handle.dbId !== member.handle.dbId,
          );
          const { active: nextActive, changed } = normalizeActive(
            activeRef.current,
            asRoundRobinMembers(remaining),
          );
          if (changed) setActiveAndEnforce(nextActive, remaining, activeSceneId);
        });
      })();
    },
    [host, activeSceneId, withBusy, setActiveAndEnforce],
  );

  /** MIDI rows: a new instrument was loaded — remember its display name. */
  const handleInstrumentChanged = useCallback(
    (member: MemberState, name: string): void => {
      if (!activeSceneId) return;
      const nextMeta: MixAssetMeta = { ...member.meta, sampleName: name };
      updateMember(member.handle.dbId, nextMeta);
      host
        .setSceneData(activeSceneId, metaKeyFor(member.handle.dbId), nextMeta)
        .catch((err: unknown) => console.warn('[MixAssets] instrument persist failed:', err));
    },
    [activeSceneId, host, updateMember],
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
          const kindCount = current.filter(
            (m) => m.meta.kind === kind && mediumOf(m.meta) === 'audio',
          ).length;
          const slotIndex = current.reduce((max, m) => Math.max(max, m.meta.slotIndex), -1) + 1;
          const handle = await host.createTrack({
            name: `${trackPrefixFor(kind, 'audio')} ${kindCount + 1}`,
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
          setMembers((prev) => [...prev, { handle, meta }].sort(memberOrder));
          // The freshly added asset takes the active slot so it's audible now.
          setActiveAndEnforce(
            { ...activeRef.current, [kind]: handle.dbId },
            [...membersRef.current, { handle, meta }],
            activeSceneId,
          );
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          host.showToast('error', 'Mix Assets', message);
        }
      })();
    },
    [mc, activeSceneId, host, pickWithRotation, applySample, setActiveAndEnforce],
  );

  /**
   * Add a MIDI asset: an ordinary instrument track (Surge XT by default —
   * the user swaps in their preferred rompler/synth via 🎹) with ONE
   * deterministic root note. No LLM: the pitch doubles the scene's first
   * bass note, falling back to the key/chord root in the bass octave.
   */
  const addMidiAsset = useCallback(
    (kind: MixAssetKind): void => {
      if (!mc || !activeSceneId) return;
      void (async () => {
        try {
          const current = membersRef.current;
          const kindCount = current.filter(
            (m) => m.meta.kind === kind && mediumOf(m.meta) === 'midi',
          ).length;
          const slotIndex = current.reduce((max, m) => Math.max(max, m.meta.slotIndex), -1) + 1;
          const handle = await host.createTrack({
            name: `${trackPrefixFor(kind, 'midi')} ${kindCount + 1}`,
            role: 'fx',
            loadSynth: true,
            synthName: 'Surge XT',
          });
          // setTrackRole (unlike createTrack's role option) also stamps the
          // layer family — 'fx' keeps these neutral in transitions, matching
          // the audio rows.
          await host.setTrackRole(handle.id, 'fx').catch(() => {});

          const rootPitch = await deriveRootPitch(host, mc);
          let meta: MixAssetMeta = {
            version: 1,
            kind,
            medium: 'midi',
            slotIndex,
            samplePath: null,
            sampleName: null,
            locked: false,
            source: 'library',
            rootPitch,
            ...(kind === 'shot' ? { offsetBeats: 0 } : {}),
            appliedInSceneId: activeSceneId,
          };
          await host.setSceneData(activeSceneId, metaKeyFor(handle.dbId), meta);
          await writePlacement(handle, meta, mc);

          // Parity with the audio add: land on a rotated preset, not the
          // naked default patch. Failure is fine — default Surge it is.
          try {
            const presetName = await shuffleMidiPreset(handle, meta, current);
            if (presetName) {
              meta = { ...meta, sampleName: presetName };
              await host.setSceneData(activeSceneId, metaKeyFor(handle.dbId), meta);
            }
          } catch {
            /* keep the default patch */
          }

          setMembers((prev) => [...prev, { handle, meta }].sort(memberOrder));
          // The freshly added asset takes the active slot so it's audible now.
          setActiveAndEnforce(
            { ...activeRef.current, [kind]: handle.dbId },
            [...membersRef.current, { handle, meta }],
            activeSceneId,
          );
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          host.showToast('error', 'Mix Assets', message);
        }
      })();
    },
    [mc, activeSceneId, host, writePlacement, shuffleMidiPreset, setActiveAndEnforce],
  );

  const handleShuffleAll = useCallback(
    (kind: MixAssetKind, medium: MixAssetMedium): void => {
      for (const member of membersRef.current) {
        if (
          member.meta.kind === kind &&
          mediumOf(member.meta) === medium &&
          !member.meta.locked
        ) {
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

  const renderKindSection = (kind: MixAssetKind, medium: MixAssetMedium): React.ReactElement => {
    const kindMembers = members.filter(
      (m) => m.meta.kind === kind && mediumOf(m.meta) === medium,
    );
    const sectionTestId =
      medium === 'midi' ? `mix-assets-section-midi-${kind}` : `mix-assets-section-${kind}`;
    const singular = KIND_LABELS[kind].toLowerCase().replace(/s$/u, '');
    return (
      <div key={`${medium}-${kind}`} style={styles.section} data-testid={sectionTestId}>
        <div style={styles.sectionHeader}>
          <span style={styles.sectionTitle}>{KIND_LABELS[kind]}</span>
          <span style={styles.sectionCount}>{kindMembers.length}</span>
          <span style={styles.sectionSpacer} />
          {kindMembers.some((m) => !m.meta.locked) && (
            <button
              type="button"
              style={styles.iconButton}
              title={`Shuffle every unlocked ${KIND_LABELS[kind].toLowerCase()} row`}
              onClick={() => handleShuffleAll(kind, medium)}
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
            active={active[member.meta.kind] === member.handle.dbId}
            muted={Boolean(muted[member.handle.dbId])}
            busy={Boolean(busy[member.handle.dbId])}
            previewing={previewingDbId === member.handle.dbId}
            fxOpen={fxOpenDbId === member.handle.dbId}
            soundOpen={soundOpenDbId === member.handle.dbId}
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
            onSoundToggle={
              medium === 'midi'
                ? () =>
                    setSoundOpenDbId((prev) =>
                      prev === member.handle.dbId ? null : member.handle.dbId,
                    )
                : undefined
            }
            onInstrumentChanged={
              medium === 'midi' ? (name) => handleInstrumentChanged(member, name) : undefined
            }
          />
        ))}

        {medium === 'midi' ? (
          <button
            type="button"
            style={styles.addButton}
            data-testid={`mix-assets-add-midi-${kind}`}
            onClick={() => addMidiAsset(kind)}
          >
            + Add MIDI {singular}
          </button>
        ) : addMenuKind === kind ? (
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
            + Add {singular}
          </button>
        )}
      </div>
    );
  };

  return (
    <div style={styles.panel} data-testid="mix-assets-panel">
      {loadError && <div style={styles.errorBar}>{loadError}</div>}

      <div style={styles.familyHeader} data-testid="mix-assets-family-midi">
        {FAMILY_LABELS.midi}
      </div>
      {MIX_ASSET_KINDS.map((kind) => renderKindSection(kind, 'midi'))}

      <hr style={styles.familyDivider} data-testid="mix-assets-family-divider" />

      <div style={styles.familyHeader} data-testid="mix-assets-family-audio">
        {FAMILY_LABELS.audio}
      </div>
      {poolEmpty && (
        <div style={styles.cta}>
          No one-shot library found. Download the drum sample pack (its impact / riser / sweep /
          zap folders feed this panel) or import your own samples per track.
        </div>
      )}
      {MIX_ASSET_KINDS.map((kind) => renderKindSection(kind, 'audio'))}

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
