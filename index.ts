/**
 * @signalsandsorcery/mix-assets — plugin entry.
 *
 * Mix Assets panel: a per-project palette of one-shot mix assets in three
 * fixed track groups — hits (impacts on the scene downbeat), risers
 * (one-shots end-aligned to the loop boundary), and shots (misc FX
 * one-shots incl. user-imported audio). Samples rotate per scene for
 * arrangement variety; a per-track lock pins the current sound. At arranger
 * push these tracks freeze like any other layer (VST FX baked in) and their
 * stems are tagged with the asset kind read from this plugin's scene data.
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
  readonly version = '1.0.0';
  readonly description =
    'One-shot mix assets: hits (downbeat impacts), risers (end-aligned builds), and shots (misc FX one-shots) with per-scene rotation and a lock to pin a sound';
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
  MIX_ASSET_GROUP_SPEC,
  asMixAssetMeta,
  kindFromTrackName,
  planDuplicationRepair,
  type MixAssetKind,
  type MixAssetMeta,
} from './src/mix-asset-meta';
export { KIND_FOLDERS, createAssetResolver } from './src/asset-resolver';
export {
  buildClip,
  buildHitNotes,
  buildRiserNotes,
  buildShotNotes,
  maxShotOffsetBeats,
  type PlacementContext,
} from './src/placement';
export const mixAssetsManifest = manifest;
