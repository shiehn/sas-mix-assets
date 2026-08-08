import {
  HISTORY_CAP,
  asHistory,
  buildExcludeSet,
  historyKey,
  recordHistory,
} from '../rotation';

describe('historyKey', () => {
  it('namespaces per kind', () => {
    expect(historyKey('hit')).toBe('history:hit');
    expect(historyKey('riser')).toBe('history:riser');
  });
});

describe('asHistory', () => {
  it('narrows arrays to their string entries and rejects garbage', () => {
    expect(asHistory(['a', 'b'])).toEqual(['a', 'b']);
    expect(asHistory(['a', 3, null, 'b'])).toEqual(['a', 'b']);
    expect(asHistory('nope')).toEqual([]);
    expect(asHistory(undefined)).toEqual([]);
    expect(asHistory({ 0: 'a' })).toEqual([]);
  });
});

describe('buildExcludeSet', () => {
  it('unions history, same-kind scene paths, and the current path', () => {
    const set = buildExcludeSet(['h1', 'h2'], ['s1', null, undefined, 'h2'], 'cur');
    expect(set).toEqual(new Set(['h1', 'h2', 's1', 'cur']));
  });

  it('handles empty inputs', () => {
    expect(buildExcludeSet([], [])).toEqual(new Set());
    expect(buildExcludeSet([], [], null)).toEqual(new Set());
  });
});

describe('recordHistory', () => {
  it('appends and dedup-moves an existing path to the end', () => {
    expect(recordHistory(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
    expect(recordHistory(['a', 'b', 'c'], 'a')).toEqual(['b', 'c', 'a']);
  });

  it('caps FIFO at HISTORY_CAP, dropping the oldest', () => {
    const full = Array.from({ length: HISTORY_CAP }, (_, i) => `p${i}`);
    const next = recordHistory(full, 'new');
    expect(next).toHaveLength(HISTORY_CAP);
    expect(next[0]).toBe('p1');
    expect(next[next.length - 1]).toBe('new');
  });
});
