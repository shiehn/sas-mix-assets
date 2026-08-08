import type { MusicalContext, PluginHost } from '@signalsandsorcery/plugin-sdk';
import { deriveRootPitch } from '../root-pitch';

const MC: MusicalContext = {
  key: 'A',
  mode: 'minor',
  bpm: 120,
  bars: 4,
  genre: null,
  timeSignature: '4/4',
  chordProgression: [],
  contractPrompt: null,
};

function hostWith(overrides: Partial<PluginHost>): PluginHost {
  return overrides as PluginHost;
}

const note = (pitch: number, startBeat: number) => ({
  pitch,
  startBeat,
  durationBeats: 1,
  velocity: 100,
  channel: 0,
});

describe('deriveRootPitch', () => {
  it('doubles the scene\'s first bass note, octave included', async () => {
    const host = hostWith({
      listSceneTracks: async () => [
        { dbId: 'drums-1', name: 'Drums', role: 'drums', hasMidi: true },
        { dbId: 'bass-1', name: 'Bassline', role: 'bass', hasMidi: true },
        { dbId: 'bass-2', name: 'Sub', role: 'bass', hasMidi: true },
      ],
      readImportableTrackMidi: async (dbId: string) => {
        expect(dbId).toBe('bass-1'); // first bass in scene order wins
        return {
          clips: [
            { startTime: 0, endTime: 8, notes: [note(43, 2), note(31, 0), note(38, 0)] },
          ],
        };
      },
    });
    // earliest startBeat 0, tie broken toward the lowest pitch → 31
    await expect(deriveRootPitch(host, MC)).resolves.toBe(31);
  });

  it('skips bass tracks without MIDI and falls back to the context root', async () => {
    const host = hostWith({
      listSceneTracks: async () => [
        { dbId: 'bass-1', name: 'Bassline', role: 'bass', hasMidi: false },
      ],
      readImportableTrackMidi: async () => {
        throw new Error('should not be called');
      },
    });
    await expect(deriveRootPitch(host, MC)).resolves.toBe(36 + 9); // A in the bass octave
  });

  it('falls back when the bass clip is empty', async () => {
    const host = hostWith({
      listSceneTracks: async () => [
        { dbId: 'bass-1', name: 'Bassline', role: 'bass', hasMidi: true },
      ],
      readImportableTrackMidi: async () => ({ clips: [] }),
    });
    await expect(deriveRootPitch(host, MC)).resolves.toBe(36 + 9);
  });

  it('survives hosts without the optional APIs', async () => {
    await expect(deriveRootPitch(hostWith({}), MC)).resolves.toBe(36 + 9);
  });

  it('survives a throwing host read', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const host = hostWith({
      listSceneTracks: async () => {
        throw new Error('boom');
      },
      readImportableTrackMidi: async () => ({ clips: [] }),
    });
    await expect(deriveRootPitch(host, MC)).resolves.toBe(36 + 9);
    warn.mockRestore();
  });

  it('prefers the downbeat chord root over the key when a progression exists', async () => {
    const mc: MusicalContext = {
      ...MC,
      chordProgression: [{ symbol: 'F', startQn: 0, endQn: 16 }],
    };
    await expect(deriveRootPitch(hostWith({}), mc)).resolves.toBe(36 + 5); // F
  });
});
