import {
  buildMidiHitNotes,
  buildMidiRiserNotes,
  buildMidiShotNotes,
  chordRootPc,
  firstBassPitch,
  rootPitchFromContext,
} from '../midi-placement';
import type { PlacementContext } from '../placement';

/** 120 BPM, 4 bars of 4/4 → 16 beats, 8 s. */
const CTX: PlacementContext = { bpm: 120, clipEndSeconds: 8, maxBeats: 16 };

describe('chordRootPc', () => {
  it('parses plain, sharp, flat, and qualified symbols', () => {
    expect(chordRootPc('C')).toBe(0);
    expect(chordRootPc('F#m7')).toBe(6);
    expect(chordRootPc('Bbmaj7')).toBe(10);
    expect(chordRootPc('  Eb  ')).toBe(3);
  });

  it('returns null for garbage', () => {
    expect(chordRootPc('')).toBeNull();
    expect(chordRootPc('H7')).toBeNull();
  });
});

describe('rootPitchFromContext', () => {
  it('prefers the earliest chord root, in the bass octave', () => {
    const pitch = rootPitchFromContext('C', [
      { symbol: 'G7', startQn: 8, endQn: 16 },
      { symbol: 'Am', startQn: 0, endQn: 8 },
    ]);
    expect(pitch).toBe(36 + 9); // A
  });

  it('falls back to the key tonic when the progression is empty/unparseable', () => {
    expect(rootPitchFromContext('F#', [])).toBe(36 + 6);
    expect(rootPitchFromContext('Eb', [{ symbol: '???', startQn: 0, endQn: 4 }])).toBe(36 + 3);
  });

  it('falls back to C for an unknown key', () => {
    expect(rootPitchFromContext('X', undefined)).toBe(36);
  });
});

describe('firstBassPitch', () => {
  it('returns the earliest note, ties broken toward the lowest pitch', () => {
    expect(
      firstBassPitch([
        { pitch: 48, startBeat: 0, durationBeats: 1, velocity: 100, channel: 0 },
        { pitch: 36, startBeat: 0, durationBeats: 1, velocity: 100, channel: 0 },
        { pitch: 31, startBeat: 2, durationBeats: 1, velocity: 100, channel: 0 },
      ]),
    ).toBe(36);
  });

  it('returns null for empty or missing clips', () => {
    expect(firstBassPitch([])).toBeNull();
    expect(firstBassPitch(undefined)).toBeNull();
  });
});

describe('buildMidiHitNotes', () => {
  it('is one quarter-note root on the downbeat', () => {
    expect(buildMidiHitNotes(43)).toEqual([
      { pitch: 43, startBeat: 0, durationBeats: 1, velocity: 110, channel: 0 },
    ]);
  });
});

describe('buildMidiRiserNotes', () => {
  it('holds the root for the last bar of the loop', () => {
    expect(buildMidiRiserNotes(CTX, 40, 4)).toEqual([
      { pitch: 40, startBeat: 12, durationBeats: 4, velocity: 100, channel: 0 },
    ]);
  });

  it('handles fractional bars (7/8 → 3.5 qn)', () => {
    const ctx: PlacementContext = { bpm: 120, clipEndSeconds: 7, maxBeats: 14 };
    expect(buildMidiRiserNotes(ctx, 38, 3.5)[0]).toMatchObject({
      startBeat: 10.5,
      durationBeats: 3.5,
    });
  });

  it('degenerates to the whole loop when the scene is shorter than a bar', () => {
    const ctx: PlacementContext = { bpm: 120, clipEndSeconds: 1, maxBeats: 2 };
    expect(buildMidiRiserNotes(ctx, 38, 4)[0]).toMatchObject({ startBeat: 0, durationBeats: 2 });
  });

  it('guards a bad bar length by assuming 4/4', () => {
    expect(buildMidiRiserNotes(CTX, 38, NaN)[0]).toMatchObject({ startBeat: 12, durationBeats: 4 });
  });
});

describe('buildMidiShotNotes', () => {
  it('places the root at the requested offset', () => {
    expect(buildMidiShotNotes(CTX, 45, 6.5)[0]).toMatchObject({ pitch: 45, startBeat: 6.5 });
  });

  it('clamps into the loop', () => {
    expect(buildMidiShotNotes(CTX, 45, 99)[0].startBeat).toBe(15.75);
    expect(buildMidiShotNotes(CTX, 45, -3)[0].startBeat).toBe(0);
    expect(buildMidiShotNotes(CTX, 45, NaN)[0].startBeat).toBe(0);
  });
});
