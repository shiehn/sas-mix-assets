/**
 * Pure placement math for the MIDI asset family — deterministic, no LLM.
 *
 * A MIDI mix asset is an ordinary instrument track (user picks the sound —
 * rompler, synth, whatever) carrying one deterministically-written root
 * note:
 *
 *   midi hit   → the root, quarter note on the scene downbeat
 *   midi riser → the root held for the LAST BAR of the loop
 *   midi shot  → the root, quarter note at a user-chosen beat offset
 *
 * The root pitch is taken from the scene's FIRST BASS note when a bass-role
 * track with MIDI exists (the hit doubles the bass root verbatim, octave
 * included), else derived from the musical context (first chord's root,
 * falling back to the key tonic) in a low register.
 *
 * Theory tables are plugin-local by design — the SDK ships none (same
 * discipline as the pad/arp/ensemble plugins).
 */

import type { PluginChordTiming, PluginMidiNote } from '@signalsandsorcery/plugin-sdk';
import type { PlacementContext } from './placement';

const NOTE_TO_PC: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};

/** Bass-register anchor: pitches land in [36, 47] (C2..B2). */
const BASS_OCTAVE_BASE = 36;

/** Minimum audible/representable note duration in beats. */
const MIN_DURATION_BEATS = 0.25;

/** Root pitch class of a chord symbol ('F#m7' → 6); null when unparseable. */
export function chordRootPc(symbol: string): number | null {
  const m = /^([A-G](?:#|b)?)/.exec(symbol.trim());
  if (!m) return null;
  const pc = NOTE_TO_PC[m[1]];
  return pc === undefined ? null : pc;
}

/**
 * Fallback root when the scene has no bass to double: the root of the chord
 * sounding at the downbeat (earliest startQn), else the key tonic, else C —
 * always dropped into the bass octave.
 */
export function rootPitchFromContext(
  key: string,
  chordProgression: readonly PluginChordTiming[] | undefined,
): number {
  let pc: number | null = null;
  if (chordProgression && chordProgression.length > 0) {
    const first = [...chordProgression].sort((a, b) => a.startQn - b.startQn)[0];
    pc = chordRootPc(first.symbol);
  }
  if (pc === null) pc = NOTE_TO_PC[key?.trim() ?? ''] ?? null;
  return BASS_OCTAVE_BASE + (pc ?? 0);
}

/**
 * The "first bass" note of a clip: earliest startBeat, ties broken toward
 * the LOWEST pitch (the register a hit should double). Null for empty clips.
 */
export function firstBassPitch(notes: readonly PluginMidiNote[] | undefined): number | null {
  if (!notes || notes.length === 0) return null;
  let best: PluginMidiNote | null = null;
  for (const n of notes) {
    if (
      !best ||
      n.startBeat < best.startBeat ||
      (n.startBeat === best.startBeat && n.pitch < best.pitch)
    ) {
      best = n;
    }
  }
  return best ? best.pitch : null;
}

/** MIDI hit: the root, one quarter note on the scene downbeat. */
export function buildMidiHitNotes(pitch: number): PluginMidiNote[] {
  return [{ pitch, startBeat: 0, durationBeats: 1, velocity: 110, channel: 0 }];
}

/**
 * MIDI riser: the root held for the last bar of the loop. Scenes shorter
 * than one bar degenerate to the whole loop.
 */
export function buildMidiRiserNotes(
  ctx: PlacementContext,
  pitch: number,
  quarterNotesPerBar: number,
): PluginMidiNote[] {
  const barQn =
    Number.isFinite(quarterNotesPerBar) && quarterNotesPerBar > 0 ? quarterNotesPerBar : 4;
  const startBeat = Math.max(ctx.maxBeats - barQn, 0);
  return [
    {
      pitch,
      startBeat,
      durationBeats: Math.max(ctx.maxBeats - startBeat, MIN_DURATION_BEATS),
      velocity: 100,
      channel: 0,
    },
  ];
}

/** MIDI shot: the root, quarter note at a user-chosen offset (clamped). */
export function buildMidiShotNotes(ctx: PlacementContext, pitch: number, offsetBeats: number): PluginMidiNote[] {
  const maxStart = Math.max(ctx.maxBeats - MIN_DURATION_BEATS, 0);
  const clamped = Math.min(Math.max(Number.isFinite(offsetBeats) ? offsetBeats : 0, 0), maxStart);
  return [{ pitch, startBeat: clamped, durationBeats: 1, velocity: 100, channel: 0 }];
}
