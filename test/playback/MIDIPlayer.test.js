import { beforeEach, describe, expect, it, vi } from 'vitest';

const { created } = vi.hoisted(() => ({ created: [] }));

vi.mock('smplr', () => ({
  Soundfont: class FakeSoundfont {
    constructor(_ctx, opts) {
      this.instrument = opts.instrument;
      this.load = new Promise((resolve) => {
        this.resolveLoad = resolve;
      });
      this.start = () => () => {};
      this.stop = () => {};
      created.push(this);
    }
  },
}));

import { MIDIPlayer, instrumentProgramKey } from '../../src/playback/MIDIPlayer.js';

function midiBase64({ division = 480, noteTicks = 480, program = 40 } = {}) {
  const track = [
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
    0x00, 0xc0, program,
    0x00, 0x90, 60, 100,
  ];
  const vlq = [];
  let v = noteTicks;
  vlq.unshift(v & 0x7f);
  v >>= 7;
  while (v > 0) { vlq.unshift((v & 0x7f) | 0x80); v >>= 7; }
  track.push(...vlq, 0x80, 60, 64);
  track.push(0x00, 0xff, 0x2f, 0x00);

  const bytes = [
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06,
    0x00, 0x00,
    0x00, 0x01,
    (division >> 8) & 0xff, division & 0xff,
    0x4d, 0x54, 0x72, 0x6b,
    (track.length >>> 24) & 0xff, (track.length >>> 16) & 0xff,
    (track.length >>> 8) & 0xff, track.length & 0xff,
    ...track,
  ];
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function tick() {
  return new Promise((resolve) => { setImmediate(resolve); });
}

function fakePlayer() {
  const player = new MIDIPlayer();
  player._ctx = {
    state: 'running',
    currentTime: 0,
    sampleRate: 44100,
    destination: {},
    resume: () => Promise.resolve(),
    addEventListener() {},
    removeEventListener() {},
  };
  player._primed = true;
  player._audioUnlockElement = { play: () => Promise.resolve() };
  player._masterGain = { gain: { value: 1 } };
  player._channelPrograms = new Map([[0, 40]]);
  player._scheduleNotes = () => { player._scheduled = true; };
  return player;
}

describe('instrumentProgramKey', () => {
  it('sorts unique programs and treats an empty map as piano', () => {
    expect(instrumentProgramKey(new Map([[1, 40], [0, 0]]))).toBe('0,40');
    expect(instrumentProgramKey(new Map([[0, 40], [1, 40]]))).toBe('40');
    expect(instrumentProgramKey(new Map())).toBe('0');
    expect(instrumentProgramKey(null)).toBe('0');
  });
});

describe('loadMIDI instrument readiness', () => {
  it('drops readiness when the program set changes, including on iOS', async () => {
    const player = new MIDIPlayer();
    player._needsUserGestureForAudio = () => true;
    player._instrumentsReady = Promise.resolve();

    await player.loadMIDI(midiBase64({ program: 40 }));
    expect(player._instrumentsReady).toBeNull();
    expect(player._instrumentProgramKey).toBe('40');

    const kept = Promise.resolve();
    player._instrumentsReady = kept;
    await player.loadMIDI(midiBase64({ program: 40 }));
    expect(player._instrumentsReady).toBe(kept);

    await player.loadMIDI(midiBase64({ program: 0 }));
    expect(player._instrumentsReady).toBeNull();
    expect(player._instrumentProgramKey).toBe('0');
  });

  it('drops readiness on a program change when preload cannot start', async () => {
    const player = new MIDIPlayer();
    player._needsUserGestureForAudio = () => false;
    player._preloadInstruments = () => null;
    player._instrumentsReady = Promise.resolve('stale');

    await player.loadMIDI(midiBase64({ program: 40 }));
    expect(player._instrumentsReady).toBeNull();

    const kept = Promise.resolve('same');
    player._instrumentsReady = kept;
    await player.loadMIDI(midiBase64({ program: 40 }));
    expect(player._instrumentsReady).toBe(kept);
  });

  it('keeps the original preload promise after the 8s overlay timeout', async () => {
    vi.useFakeTimers();
    try {
      const player = new MIDIPlayer();
      player._needsUserGestureForAudio = () => false;
      let resolvePreload;
      const preload = new Promise((resolve) => { resolvePreload = resolve; });
      player._preloadInstruments = () => preload;

      const done = player.loadMIDI(midiBase64({ program: 40 }));
      await vi.advanceTimersByTimeAsync(8000);
      expect(player._instrumentsReady).toBe(preload);

      resolvePreload();
      await done;
      expect(player._instrumentsReady).toBe(preload);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a failed preload without clobbering a newer score', async () => {
    const player = new MIDIPlayer();
    player._needsUserGestureForAudio = () => false;
    let rejectFirst;
    const first = new Promise((_, reject) => { rejectFirst = reject; });
    const second = Promise.resolve();
    let calls = 0;
    player._preloadInstruments = () => (calls++ === 0 ? first : second);

    const firstLoad = player.loadMIDI(midiBase64({ program: 40 }));
    const secondLoad = player.loadMIDI(midiBase64({ program: 0 }));
    await secondLoad;
    expect(player._instrumentsReady).toBe(second);

    rejectFirst(new Error('audio context not running'));
    await firstLoad;
    expect(player._instrumentsReady).toBe(second);
  });
});

describe('in-flight soundfont loads', () => {
  beforeEach(() => { created.length = 0; });

  it('awaits inst.load already stored on the instrument', async () => {
    const player = fakePlayer();
    const first = player._loadInstruments();
    await tick();
    expect(created).toHaveLength(1);
    expect(player._instruments.has('violin')).toBe(true);

    let settled = false;
    const second = player._loadInstruments().then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);
    expect(created).toHaveLength(1);

    created[0].resolveLoad();
    await first;
    await second;
    expect(settled).toBe(true);
    expect(player._instrumentLoads.size).toBe(0);
  });

  it('play waits when readiness was cleared but sample decode is still pending', async () => {
    const player = fakePlayer();
    const first = player._loadInstruments();
    player._instrumentsReady = null;

    const playing = player.play();
    await tick();
    expect(player._isPlaying).toBe(false);
    expect(player._scheduled).toBeUndefined();
    expect(created).toHaveLength(1);

    created[0].resolveLoad();
    await first;
    await playing;
    expect(player._isPlaying).toBe(true);
    expect(player._scheduled).toBe(true);
  });
});
