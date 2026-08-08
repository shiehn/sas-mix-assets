/**
 * Root-pitch derivation for MIDI mix assets — the host-facing half.
 *
 * Preference order:
 *   1. The scene's FIRST BASS note — first role='bass' track with MIDI in
 *      `host.listSceneTracks()` scene order, read ownership-free via
 *      `host.readImportableTrackMidi()`, earliest note (ties → lowest).
 *      The MIDI hit doubles that root verbatim, octave included.
 *   2. Musical-context fallback: the downbeat chord's root, else the key
 *      tonic, dropped into the bass octave (see midi-placement.ts).
 *
 * Both host APIs are optional (older hosts) and both reads are best-effort:
 * any failure falls through to the context fallback. No LLM anywhere.
 */

import type { MusicalContext, PluginHost } from '@signalsandsorcery/plugin-sdk';
import { firstBassPitch, rootPitchFromContext } from './midi-placement';

export async function deriveRootPitch(host: PluginHost, mc: MusicalContext): Promise<number> {
  try {
    if (
      typeof host.listSceneTracks === 'function' &&
      typeof host.readImportableTrackMidi === 'function'
    ) {
      const tracks = (await host.listSceneTracks()) ?? [];
      const bass = tracks.find(
        (t) => t.hasMidi && t.role?.trim().toLowerCase() === 'bass',
      );
      if (bass) {
        const result = await host.readImportableTrackMidi(bass.dbId);
        const pitch = firstBassPitch(result.clips.flatMap((c) => c.notes));
        if (pitch !== null) return pitch;
      }
    }
  } catch (err) {
    console.warn('[MixAssets] bass root read failed, using context root:', err);
  }
  return rootPitchFromContext(mc.key, mc.chordProgression);
}
