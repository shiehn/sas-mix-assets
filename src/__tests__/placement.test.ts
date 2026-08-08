import {
  buildClip,
  buildHitNotes,
  buildRiserNotes,
  buildShotNotes,
  maxShotOffsetBeats,
  type PlacementContext,
} from '../placement';

/** 8 bars of 4/4 at 120 BPM: 32 beats, 16 seconds. */
const CTX_44: PlacementContext = { bpm: 120, clipEndSeconds: 16, maxBeats: 32 };

/** 4 bars of 6/8 at 90 BPM: 6/8 bar = 3 quarter-notes → 12 qn = 8 seconds. */
const CTX_68: PlacementContext = { bpm: 90, clipEndSeconds: 8, maxBeats: 12 };

describe('buildHitNotes', () => {
  it('places one pitch-60 note on the downbeat', () => {
    const notes = buildHitNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ pitch: 60, startBeat: 0, channel: 0 });
    expect(notes[0].velocity).toBeGreaterThan(0);
  });
});

describe('buildRiserNotes', () => {
  it('end-aligns: 3.5 s sample in a 16 s scene starts at 12.5 s = beat 25', () => {
    const { notes, truncated } = buildRiserNotes(CTX_44, 3.5);
    expect(truncated).toBe(false);
    expect(notes).toHaveLength(1);
    expect(notes[0].startBeat).toBeCloseTo(25, 10);
    expect(notes[0].startBeat + notes[0].durationBeats).toBeCloseTo(32, 10);
  });

  it('supports fractional beats (2.7 s sample → startBeat 26.6)', () => {
    const { notes } = buildRiserNotes(CTX_44, 2.7);
    expect(notes[0].startBeat).toBeCloseTo(((16 - 2.7) * 120) / 60, 10);
  });

  it('end-aligns under a non-4/4 meter (6/8 scene)', () => {
    const { notes, truncated } = buildRiserNotes(CTX_68, 2);
    expect(truncated).toBe(false);
    // startSec = 8 - 2 = 6 s → 6 * 90/60 = 9 beats of the 12-beat loop.
    expect(notes[0].startBeat).toBeCloseTo(9, 10);
  });

  it('clamps to beat 0 with truncated=true when the sample exceeds the scene', () => {
    const { notes, truncated } = buildRiserNotes(CTX_44, 20);
    expect(truncated).toBe(true);
    expect(notes[0].startBeat).toBe(0);
  });

  it('treats unknown duration (0/NaN) as start-at-0 without the truncated flag', () => {
    for (const dur of [0, NaN, -1]) {
      const { notes, truncated } = buildRiserNotes(CTX_44, dur);
      expect(notes[0].startBeat).toBe(0);
      expect(truncated).toBe(false);
    }
  });
});

describe('buildShotNotes', () => {
  it('places the note at the requested offset', () => {
    const notes = buildShotNotes(CTX_44, 8.5);
    expect(notes[0].startBeat).toBe(8.5);
  });

  it('clamps the offset into the loop', () => {
    expect(buildShotNotes(CTX_44, -3)[0].startBeat).toBe(0);
    expect(buildShotNotes(CTX_44, 99)[0].startBeat).toBe(maxShotOffsetBeats(CTX_44));
    expect(buildShotNotes(CTX_44, NaN)[0].startBeat).toBe(0);
  });
});

describe('buildClip', () => {
  it('wraps notes in a scene-length clip at the scene tempo', () => {
    const notes = buildHitNotes();
    const clip = buildClip(CTX_44, notes);
    expect(clip).toEqual({ startTime: 0, endTime: 16, tempo: 120, notes });
  });
});
