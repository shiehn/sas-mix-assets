/**
 * @signalsandsorcery/mix-assets — plugin entry.
 *
 * Mix Assets panel: a per-project palette of one-shot mix assets in three
 * fixed kinds (hits / risers / shots) across TWO families:
 *
 * - MIDI (top section): instrument tracks (Surge XT default, user-swappable
 *   to any rompler/synth) carrying one DETERMINISTIC root note — hit on the
 *   downbeat, riser held across the last bar, shot at a chosen offset. No
 *   LLM: the pitch doubles the scene's first bass note (else key/chord root).
 *
 * - Audio samples (bottom section): the sampler one-shots — hits (impacts on
 *   the scene downbeat), risers (end-aligned to the loop boundary), and
 *   shots (misc FX one-shots incl. user-imported audio).
 *
 * Sounds rotate per scene for arrangement variety (samples for audio rows,
 * Surge presets for MIDI rows); a per-track lock pins the current sound. At
 * arranger push these tracks freeze like any other layer (VST FX baked in)
 * and their stems are tagged with the asset kind read from this plugin's
 * scene data.
 */

import type { ComponentType } from 'react';
import type {
  GeneratorPlugin,
  PluginHost,
  PluginUIProps,
  PluginSettingsSchema,
} from '@signalsandsorcery/plugin-sdk';
import { MixAssetsPanel } from './MixAssetsPanel';
import manifest from './plugin.json';

export const MIX_ASSETS_PLUGIN_ID = '@signalsandsorcery/mix-assets';

class MixAssetsPlugin implements GeneratorPlugin {
  readonly id = MIX_ASSETS_PLUGIN_ID;
  readonly displayName = 'Mix Assets';
  readonly version = '1.1.0';
  readonly description =
    'One-shot mix assets in two families — MIDI root-note hits/risers/shots on instrument tracks (pick any synth/rompler sound) and audio sample one-shots — with per-scene rotation and a lock to pin a sound';
  readonly generatorType = 'midi' as const;
  readonly minHostVersion = '2.65.0';

  private host: PluginHost | null = null;

  async activate(host: PluginHost): Promise<void> {
    this.host = host;
    console.log('[MixAssetsPlugin] activated');
  }

  async deactivate(): Promise<void> {
    this.host = null;
  }

  getUIComponent(): ComponentType<PluginUIProps> {
    return MixAssetsPanel;
  }

  getSettingsSchema(): PluginSettingsSchema | null {
    return null;
  }
}

export default MixAssetsPlugin;
export { MixAssetsPlugin, MixAssetsPanel };
export {
  MIX_ASSET_META_KEY,
  MIX_ASSET_KINDS,
  MIX_ASSET_MEDIUMS,
  MIX_ASSET_GROUP_SPEC,
  asMixAssetMeta,
  assetFromTrackName,
  kindFromTrackName,
  mediumOf,
  planDuplicationRepair,
  trackPrefixFor,
  type MixAssetKind,
  type MixAssetMedium,
  type MixAssetMeta,
} from './src/mix-asset-meta';
export { KIND_FOLDERS, createAssetResolver } from './src/asset-resolver';
export {
  LONG_PATTERN_MIN_BARS,
  buildClip,
  buildHitNotes,
  buildRiserNotes,
  buildShotNotes,
  hitStartBeats,
  maxShotOffsetBeats,
  type PlacementContext,
} from './src/placement';
export {
  ROUND_ROBIN_KEY,
  advanceActive,
  asActiveByKind,
  mutePlan,
  normalizeActive,
  sameActive,
  type ActiveByKind,
  type RoundRobinMember,
} from './src/round-robin';
export {
  buildMidiHitNotes,
  buildMidiRiserNotes,
  buildMidiShotNotes,
  chordRootPc,
  firstBassPitch,
  rootPitchFromContext,
} from './src/midi-placement';
export { deriveRootPitch } from './src/root-pitch';
export const mixAssetsManifest = manifest;
