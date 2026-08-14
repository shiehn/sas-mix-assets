import { basename } from '../paths';

describe('basename', () => {
  it('extracts the last segment of a posix path', () => {
    expect(basename('/Users/steve/Music/kick.wav')).toBe('kick.wav');
  });

  it('extracts the last segment of a Windows path (the import-flow regression)', () => {
    // host.showOpenDialog returns native paths; splitting on '/' alone made
    // the whole backslash path the "basename" and importFile then built an
    // NTFS-invalid destination filename (drive colon + backslashes).
    expect(basename('C:\\Users\\steve\\Music\\kick.wav')).toBe('kick.wav');
  });

  it('handles mixed separators and bare filenames', () => {
    expect(basename('C:\\Users\\steve/Music/kick.wav')).toBe('kick.wav');
    expect(basename('kick.wav')).toBe('kick.wav');
  });
});
