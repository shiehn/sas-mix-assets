import {
  advanceActive,
  asActiveByKind,
  mutePlan,
  normalizeActive,
  sameActive,
  type RoundRobinMember,
} from '../round-robin';

/** Display order: MIDI members first, then audio — one pooled cycle per kind. */
const MEMBERS: RoundRobinMember[] = [
  { dbId: 'midi-hit-1', kind: 'hit' },
  { dbId: 'audio-hit-1', kind: 'hit' },
  { dbId: 'audio-hit-2', kind: 'hit' },
  { dbId: 'riser-1', kind: 'riser' },
];

describe('asActiveByKind', () => {
  it('narrows valid maps and drops junk', () => {
    expect(asActiveByKind({ hit: 'a', riser: 42, junk: 'x' })).toEqual({ hit: 'a' });
    expect(asActiveByKind(null)).toEqual({});
    expect(asActiveByKind('nope')).toEqual({});
  });
});

describe('normalizeActive', () => {
  it('keeps live pointers and defaults missing kinds to the first member', () => {
    const { active, changed } = normalizeActive({ hit: 'audio-hit-1' }, MEMBERS);
    expect(active).toEqual({ hit: 'audio-hit-1', riser: 'riser-1' });
    expect(changed).toBe(true); // riser entry was added
  });

  it('repairs stale dbIds (scene duplication / deletion)', () => {
    const { active } = normalizeActive({ hit: 'deleted', riser: 'riser-1' }, MEMBERS);
    expect(active.hit).toBe('midi-hit-1');
  });

  it('drops entries for kinds with no members and reports no change when clean', () => {
    const first = normalizeActive({ hit: 'midi-hit-1', riser: 'riser-1', shot: 'gone' }, MEMBERS);
    expect(first.active.shot).toBeUndefined();
    expect(first.changed).toBe(true);
    const second = normalizeActive(first.active, MEMBERS);
    expect(second.changed).toBe(false);
  });
});

describe('advanceActive', () => {
  it('cycles through the pooled kind — MIDI and audio members alternate in one wheel', () => {
    let active = normalizeActive({}, MEMBERS).active; // hit → midi-hit-1
    active = advanceActive(active, MEMBERS);
    expect(active.hit).toBe('audio-hit-1');
    active = advanceActive(active, MEMBERS);
    expect(active.hit).toBe('audio-hit-2');
    active = advanceActive(active, MEMBERS);
    expect(active.hit).toBe('midi-hit-1'); // wrapped
  });

  it('is a no-op for single-member kinds', () => {
    const active = advanceActive({ riser: 'riser-1' }, MEMBERS);
    expect(active.riser).toBe('riser-1');
  });

  it('recovers from a stale pointer by starting at the first member', () => {
    const active = advanceActive({ hit: 'deleted' }, MEMBERS);
    expect(active.hit).toBe('midi-hit-1');
  });
});

describe('mutePlan', () => {
  it('mutes every same-kind member except the active one, across families', () => {
    const plan = mutePlan({ hit: 'audio-hit-1', riser: 'riser-1' }, MEMBERS);
    expect(plan).toEqual({
      'midi-hit-1': true,
      'audio-hit-1': false,
      'audio-hit-2': true,
      'riser-1': false,
    });
  });

  it('leaves members unmuted when their kind has no active pointer', () => {
    const plan = mutePlan({}, MEMBERS);
    expect(Object.values(plan).every((v) => v === false)).toBe(true);
  });
});

describe('sameActive', () => {
  it('compares per-kind pointers', () => {
    expect(sameActive({ hit: 'a' }, { hit: 'a' })).toBe(true);
    expect(sameActive({ hit: 'a' }, { hit: 'b' })).toBe(false);
    expect(sameActive({}, { hit: 'a' })).toBe(false);
  });
});
