import { describe, it, expect } from 'vitest';
import { centerOf, buildMatchings, buildChordGroups } from '../../src/animation/chordGroups.js';

describe('centerOf', () => {
  it('averages note positions', () => {
    expect(centerOf([{ x: 0, y: 0 }, { x: 2, y: 4 }])).toEqual({ x: 1, y: 2 });
  });
});

describe('buildChordGroups', () => {
  it('clusters events within 1 ms and sorts notes by y', () => {
    const groups = buildChordGroups([
      { time: 1.0005, x: 0, y: 5, id: 'a' },
      { time: 1.0, x: 0, y: 1, id: 'b' },
      { time: 2.0, x: 0, y: 9, id: 'c' },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].notes.map((n) => n.id)).toEqual(['b', 'a']);
    expect(groups[1].notes.map((n) => n.id)).toEqual(['c']);
  });

  it('does not cluster events more than 1 ms apart', () => {
    const groups = buildChordGroups([
      { time: 1.0, x: 0, y: 0, id: 'a' },
      { time: 1.002, x: 0, y: 0, id: 'b' },
    ]);
    expect(groups).toHaveLength(2);
  });

  it('stamps group.center with the notes centroid', () => {
    const groups = buildChordGroups([
      { time: 0, x: 2, y: 2, id: 'a' },
      { time: 0, x: 4, y: 6, id: 'b' },
    ]);
    expect(groups[0].center).toEqual({ x: 3, y: 4 });
  });
});

describe('buildMatchings', () => {
  it('picks the nearest note and marks overflow as null', () => {
    const groups = [
      { time: 0, notes: [{ x: 0, y: 0 }, { x: 0, y: 10 }] },
      { time: 1, notes: [{ x: 0, y: 11 }] },
    ];
    buildMatchings(groups);
    // Ball 0 (y=0) is farther from the only next note (y=11) than ball 1
    // (y=10)?  Ball 0 is processed first and takes j=0; ball 1 gets null.
    expect(groups[0].toNext).toEqual([0, null]);
  });

  it('assigns nearest neighbours without duplicates', () => {
    const groups = [
      { time: 0, notes: [{ x: 0, y: 0 }, { x: 0, y: 10 }] },
      { time: 1, notes: [{ x: 0, y: 9 }, { x: 0, y: 1 }] },
    ];
    buildMatchings(groups);
    // y=0 → j=1 (y=1); y=10 → j=0 (y=9)
    expect(groups[0].toNext).toEqual([1, 0]);
  });
});
