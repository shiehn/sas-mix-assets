/**
 * Pure MIDI-placement math for the three asset kinds. No I/O, no host —
 * fully jest-covered. The panel feeds it the meter geometry it already gets
 * from the SDK meter helpers (panelClipEndSeconds / panelMaxBeats).
 *
 * All notes are pitch 60 (the single-sound sampler's keyNote — same rule as
 * the drum plugin) on channel 0. The sampler is openEnded for role 'fx', so
 * note DURATION is cosmetic: every sample rings to its natural end. That is
 * exactly right for hits/shots, and for risers it means end-alignment is
 * achieved purely by the START position: startSec = loopEnd − sampleSec.
 */

import type { MidiClipData, PluginMidiNote } from '@signalsandsorcery/plugin-sdk';

export interface PlacementContext {
  /** Scene tempo (quarter notes per minute). */
  bpm: number;
  /** Scene loop length in seconds (panelClipEndSeconds). */
  clipEndSeconds: number;
  /** Scene loop length in quarter-note beats (panelMaxBeats). */
  maxBeats: number;
}

/** Minimum audible/representable note duration in beats. */
const MIN_DURATION_BEATS = 0.25;

export interface RiserPlacement {
  notes: PluginMidiNote[];
  /** Sample longer than the scene: placed at 0, end NOT aligned. */
  truncated: boolean;
}

/** Hit: one note on the scene downbeat. */
export function buildHitNotes(): PluginMidiNote[] {
  return [{ pitch: 60, startBeat: 0, durationBeats: 1, velocity: 110, channel: 0 }];
}

/**
 * Riser: one note positioned so the SAMPLE's natural end lands exactly on
 * the loop boundary. Fractional startBeat is intentional (sub-16th
 * alignment); the engine preserves micro-timing verbatim.
 */
export function buildRiserNotes(
  ctx: PlacementContext,
  sampleDurationSeconds: number,
): RiserPlacement {
  const safeDuration =
    Number.isFinite(sampleDurationSeconds) && sampleDurationSeconds > 0
      ? sampleDurationSeconds
      : 0;
  const startSec = ctx.clipEndSeconds - safeDuration;
  if (safeDuration === 0 || startSec < 0) {
    // Unknown duration or sample longer than the scene — start at 0 and warn.
    return {
      notes: [
        {
          pitch: 60,
          startBeat: 0,
          durationBeats: Math.max(ctx.maxBeats, MIN_DURATION_BEATS),
          velocity: 100,
          channel: 0,
        },
      ],
      truncated: safeDuration > 0,
    };
  }
  const startBeat = (startSec * ctx.bpm) / 60;
  return {
    notes: [
      {
        pitch: 60,
        startBeat,
        durationBeats: Math.max(ctx.maxBeats - startBeat, MIN_DURATION_BEATS),
        velocity: 100,
        channel: 0,
      },
    ],
    truncated: false,
  };
}

/** Shot: one note at a user-chosen beat offset (clamped into the loop). */
export function buildShotNotes(ctx: PlacementContext, offsetBeats: number): PluginMidiNote[] {
  const maxStart = Math.max(ctx.maxBeats - MIN_DURATION_BEATS, 0);
  const clamped = Math.min(Math.max(Number.isFinite(offsetBeats) ? offsetBeats : 0, 0), maxStart);
  return [{ pitch: 60, startBeat: clamped, durationBeats: 1, velocity: 100, channel: 0 }];
}

/** Wrap notes in the standard scene-length clip. */
export function buildClip(ctx: PlacementContext, notes: PluginMidiNote[]): MidiClipData {
  return {
    startTime: 0,
    endTime: ctx.clipEndSeconds,
    tempo: ctx.bpm,
    notes,
  };
}

/** Max value the shot offset stepper should allow. */
export function maxShotOffsetBeats(ctx: PlacementContext): number {
  return Math.max(ctx.maxBeats - MIN_DURATION_BEATS, 0);
}
