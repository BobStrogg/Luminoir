import { describe, it, expect } from 'vitest';
import { parseMIDI, GM_INSTRUMENTS } from '../../src/playback/midiParse.js';

/**
 * Build a minimal format-0 MIDI file: header + one track containing
 * a tempo meta event (120 BPM = 500000 µs/beat), a program change,
 * a note-on / note-off pair, and end-of-track.
 */
function buildTestMidi({ division = 480, noteTicks = 480, program = 40 } = {}) {
  const track = [
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // delta 0, tempo 500000
    0x00, 0xc0, program,                      // delta 0, program change ch 0
    0x00, 0x90, 60, 100,                      // delta 0, note-on C4 vel 100
  ];
  // note-off after `noteTicks` ticks — encode as varlen
  const vlq = [];
  let v = noteTicks;
  vlq.unshift(v & 0x7f);
  v >>= 7;
  while (v > 0) { vlq.unshift((v & 0x7f) | 0x80); v >>= 7; }
  track.push(...vlq, 0x80, 60, 64);           // note-off C4
  track.push(0x00, 0xff, 0x2f, 0x00);         // end of track

  const bytes = [
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, // MThd, len 6
    0x00, 0x00,                                     // format 0
    0x00, 0x01,                                     // 1 track
    (division >> 8) & 0xff, division & 0xff,
    0x4d, 0x54, 0x72, 0x6b,                          // MTrk
    (track.length >>> 24) & 0xff, (track.length >>> 16) & 0xff,
    (track.length >>> 8) & 0xff, track.length & 0xff,
    ...track,
  ];
  return new Uint8Array(bytes).buffer;
}

describe('parseMIDI', () => {
  it('parses a minimal format-0 file into one note event', () => {
    const { noteEvents, channelPrograms } = parseMIDI(buildTestMidi());
    expect(noteEvents).toHaveLength(1);
    const e = noteEvents[0];
    expect(e.midi).toBe(60);
    expect(e.channel).toBe(0);
    expect(e.velocity).toBe(100);
    expect(e.time).toBeCloseTo(0);
    // 480 ticks at 480 tpq, 120 BPM = 0.5 s.
    expect(e.duration).toBeCloseTo(0.5);
    expect(channelPrograms.get(0)).toBe(40);
  });

  it('returns empty results for non-MIDI data', () => {
    const { noteEvents, channelPrograms } = parseMIDI(new Uint8Array(16).buffer);
    expect(noteEvents).toEqual([]);
    expect(channelPrograms.size).toBe(0);
  });
});

describe('GM_INSTRUMENTS', () => {
  it('has 128 entries with the expected anchors', () => {
    expect(GM_INSTRUMENTS).toHaveLength(128);
    expect(GM_INSTRUMENTS[0]).toBe('acoustic_grand_piano');
    expect(GM_INSTRUMENTS[40]).toBe('violin');
    expect(GM_INSTRUMENTS[127]).toBe('gunshot');
  });
});
