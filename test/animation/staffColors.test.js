import { describe, it, expect } from 'vitest';
import { assignStaffColorIndices } from '../../src/animation/staffColors.js';

describe('assignStaffColorIndices', () => {
  it('assigns indices in first-seen timeline order', () => {
    const timeline = [
      { staff: 3 }, { staff: 1 }, { staff: 3 }, { staff: 2 }, { staff: 1 },
    ];
    const m = assignStaffColorIndices(timeline);
    expect(m.get(3)).toBe(0);
    expect(m.get(1)).toBe(1);
    expect(m.get(2)).toBe(2);
    expect(m.size).toBe(3);
  });

  it('produces indices that cycle a palette correctly', () => {
    const palette = ['a', 'b'];
    const timeline = [{ staff: 1 }, { staff: 2 }, { staff: 3 }];
    const m = assignStaffColorIndices(timeline);
    expect(palette[m.get(1) % palette.length]).toBe('a');
    expect(palette[m.get(2) % palette.length]).toBe('b');
    expect(palette[m.get(3) % palette.length]).toBe('a');
  });

  it('handles an empty timeline', () => {
    expect(assignStaffColorIndices([]).size).toBe(0);
  });
});
