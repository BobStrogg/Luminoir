/**
 * Minimal Standard MIDI File parser (format 0/1) plus the GM
 * instrument-name table.  Extracted from `MIDIPlayer` so the binary
 * decoding can be unit-tested without an AudioContext.
 */

/**
 * Read the 14-byte header chunk.  Returns
 * `{ numTracks, ticksPerBeat, pos }` (pos = first track offset) or
 * null when the file is unusable.
 */
function readHeader(view) {
  // Header chunk
  const headerTag = view.getUint32(0);
  if (headerTag !== 0x4d546864) return null; // "MThd"
  const headerLen = view.getUint32(4);
  const numTracks = view.getUint16(10);
  const division = view.getUint16(12);

  const ticksPerBeat = division & 0x7fff;
  if (ticksPerBeat === 0) return null;
  return { numTracks, ticksPerBeat, pos: 8 + headerLen };
}

/**
 * First pass: extract the global tempo map from all tracks.
 * Returns `[{ tick, microsecondsPerBeat }]`, sorted by tick, with a
 * 120 BPM default unshifted when needed.
 */
function scanTempoMap(view, startPos, numTracks) {
  const tempoMap = [];
  let scanPos = startPos;
  for (let t = 0; t < numTracks; t++) {
    if (scanPos + 8 > view.byteLength) break;
    const tag = view.getUint32(scanPos);
    scanPos += 4;
    if (tag !== 0x4d54726b) break; // "MTrk"
    const trackLen = view.getUint32(scanPos);
    scanPos += 4;
    const trackEnd = scanPos + trackLen;

    let scanTick = 0;
    let scanRunning = 0;
    while (scanPos < trackEnd) {
      let delta = 0;
      let b;
      do {
        b = view.getUint8(scanPos++);
        delta = (delta << 7) | (b & 0x7f);
      } while (b & 0x80);
      scanTick += delta;

      let status = view.getUint8(scanPos);
      if (status & 0x80) {
        scanRunning = status;
        scanPos++;
      } else {
        status = scanRunning;
      }

      const type = status & 0xf0;
      if (type === 0x90 || type === 0x80 || type === 0xa0 || type === 0xb0 || type === 0xe0) {
        scanPos += 2;
      } else if (type === 0xc0 || type === 0xd0) {
        scanPos += 1;
      } else if (status === 0xff) {
        const metaType = view.getUint8(scanPos++);
        let metaLen = 0;
        do {
          b = view.getUint8(scanPos++);
          metaLen = (metaLen << 7) | (b & 0x7f);
        } while (b & 0x80);
        if (metaType === 0x51 && metaLen === 3) {
          const uspb =
            (view.getUint8(scanPos) << 16) |
            (view.getUint8(scanPos + 1) << 8) |
            view.getUint8(scanPos + 2);
          tempoMap.push({ tick: scanTick, microsecondsPerBeat: uspb });
        }
        scanPos += metaLen;
      } else if (status === 0xf0 || status === 0xf7) {
        let sysLen = 0;
        do {
          b = view.getUint8(scanPos++);
          sysLen = (sysLen << 7) | (b & 0x7f);
        } while (b & 0x80);
        scanPos += sysLen;
      } else {
        break;
      }
    }
    scanPos = trackEnd;
  }

  tempoMap.sort((a, b) => a.tick - b.tick);
  if (tempoMap.length === 0 || tempoMap[0].tick > 0) {
    tempoMap.unshift({ tick: 0, microsecondsPerBeat: 500000 }); // 120 BPM default
  }
  return tempoMap;
}

/**
 * Convert a MIDI tick to seconds under the given tempo map.
 * Returns a `tick → seconds` closure.
 */
function tempoMapToSeconds(tempoMap, ticksPerBeat) {
  return (tick) => {
    let seconds = 0;
    let prevTick = 0;
    let tickToSec = tempoMap[0].microsecondsPerBeat / 1e6 / ticksPerBeat;
    for (const entry of tempoMap) {
      if (entry.tick >= tick) break;
      if (entry.tick > prevTick) {
        seconds += (entry.tick - prevTick) * tickToSec;
      }
      prevTick = entry.tick;
      tickToSec = entry.microsecondsPerBeat / 1e6 / ticksPerBeat;
    }
    seconds += (tick - prevTick) * tickToSec;
    return seconds;
  };
}

/**
 * Second pass, single track: extract note events + program changes
 * into `allEvents` / `channelPrograms`.  `pos` is mutated on the
 * shared cursor object so the caller can continue with the next
 * track.
 */
function readTrack(view, cursor, tickToSeconds, allEvents, channelPrograms) {
  const trackTag = view.getUint32(cursor.pos);
  cursor.pos += 4;
  if (trackTag !== 0x4d54726b) return false; // "MTrk"
  const trackLen = view.getUint32(cursor.pos);
  cursor.pos += 4;
  const trackEnd = cursor.pos + trackLen;

  const readVarLen = () => {
    let value = 0;
    let byte;
    do {
      byte = view.getUint8(cursor.pos++);
      value = (value << 7) | (byte & 0x7f);
    } while (byte & 0x80);
    return value;
  };

  let tick = 0;
  let runningStatus = 0;
  const pending = new Map();

  while (cursor.pos < trackEnd) {
    const delta = readVarLen();
    tick += delta;
    const timeInSeconds = tickToSeconds(tick);

    let status = view.getUint8(cursor.pos);
    if (status & 0x80) {
      runningStatus = status;
      cursor.pos++;
    } else {
      status = runningStatus;
    }

    const type = status & 0xf0;
    const channel = status & 0x0f;

    if (type === 0x90) {
      // Note On
      const note = view.getUint8(cursor.pos++);
      const vel = view.getUint8(cursor.pos++);
      if (vel > 0) {
        pending.set(note + channel * 128, { time: timeInSeconds, velocity: vel });
      } else {
        const on = pending.get(note + channel * 128);
        if (on) {
          allEvents.push({
            midi: note,
            time: on.time,
            duration: Math.max(0.05, timeInSeconds - on.time),
            velocity: on.velocity,
            channel,
          });
          pending.delete(note + channel * 128);
        }
      }
    } else if (type === 0x80) {
      // Note Off
      const note = view.getUint8(cursor.pos++);
      cursor.pos++; // velocity (unused)
      const on = pending.get(note + channel * 128);
      if (on) {
        allEvents.push({
          midi: note,
          time: on.time,
          duration: Math.max(0.05, timeInSeconds - on.time),
          velocity: on.velocity,
          channel,
        });
        pending.delete(note + channel * 128);
      }
    } else if (type === 0xc0) {
      // Program Change — capture channel → instrument mapping
      const program = view.getUint8(cursor.pos++);
      channelPrograms.set(channel, program);
    } else if (type === 0xd0) {
      cursor.pos += 1; // channel pressure — one data byte
    } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) {
      cursor.pos += 2; // two data bytes
    } else if (status === 0xff) {
      // Meta event
      const _metaType = view.getUint8(cursor.pos++);
      const metaLen = readVarLen();
      cursor.pos += metaLen;
    } else if (status === 0xf0 || status === 0xf7) {
      // SysEx
      const sysLen = readVarLen();
      cursor.pos += sysLen;
    } else {
      break;
    }
  }

  cursor.pos = trackEnd;
  return true;
}

/**
 * Parse a MIDI ArrayBuffer into note events and program changes.
 * Handles format 0 and format 1 (merges all tracks).
 * For format 1, extracts the tempo map from track 0 first and applies it
 * to all tracks so that timing is consistent across the entire file.
 * @returns {{ noteEvents: Array<MIDINoteEvent>, channelPrograms: Map<number, number> }}
 */
export function parseMIDI(buffer) {
  const view = new DataView(buffer);

  const header = readHeader(view);
  if (!header) return { noteEvents: [], channelPrograms: new Map() };
  const { numTracks, ticksPerBeat } = header;

  // --- First pass: extract global tempo map from all tracks ---
  const tempoMap = scanTempoMap(view, header.pos, numTracks);
  const tickToSeconds = tempoMapToSeconds(tempoMap, ticksPerBeat);

  // --- Second pass: extract note events + program changes ---
  const allEvents = [];
  const channelPrograms = new Map();
  const cursor = { pos: header.pos };

  for (let t = 0; t < numTracks; t++) {
    if (!readTrack(view, cursor, tickToSeconds, allEvents, channelPrograms)) break;
  }

  allEvents.sort((a, b) => a.time - b.time);
  return { noteEvents: allEvents, channelPrograms };
}

/* ------------------------------------------------------------------ */
/*  General MIDI instrument name table                                 */
/* ------------------------------------------------------------------ */

/** @type {string[]} 128 GM instrument names matching MIDI.js SoundFont naming */
export const GM_INSTRUMENTS = [
  // Piano (0–7)
  'acoustic_grand_piano', 'bright_acoustic_piano', 'electric_grand_piano',
  'honkytonk_piano', 'electric_piano_1', 'electric_piano_2', 'harpsichord', 'clavinet',
  // Chromatic Percussion (8–15)
  'celesta', 'glockenspiel', 'music_box', 'vibraphone',
  'marimba', 'xylophone', 'tubular_bells', 'dulcimer',
  // Organ (16–23)
  'drawbar_organ', 'percussive_organ', 'rock_organ', 'church_organ',
  'reed_organ', 'accordion', 'harmonica', 'tango_accordion',
  // Guitar (24–31)
  'acoustic_guitar_nylon', 'acoustic_guitar_steel', 'electric_guitar_jazz',
  'electric_guitar_clean', 'electric_guitar_muted', 'overdriven_guitar',
  'distortion_guitar', 'guitar_harmonics',
  // Bass (32–39)
  'acoustic_bass', 'electric_bass_finger', 'electric_bass_pick', 'fretless_bass',
  'slap_bass_1', 'slap_bass_2', 'synth_bass_1', 'synth_bass_2',
  // Strings (40–47)
  'violin', 'viola', 'cello', 'contrabass',
  'tremolo_strings', 'pizzicato_strings', 'orchestral_harp', 'timpani',
  // Ensemble (48–55)
  'string_ensemble_1', 'string_ensemble_2', 'synth_strings_1', 'synth_strings_2',
  'choir_aahs', 'voice_oohs', 'synth_choir', 'orchestra_hit',
  // Brass (56–63)
  'trumpet', 'trombone', 'tuba', 'muted_trumpet',
  'french_horn', 'brass_section', 'synth_brass_1', 'synth_brass_2',
  // Reed (64–71)
  'soprano_sax', 'alto_sax', 'tenor_sax', 'baritone_sax',
  'oboe', 'english_horn', 'bassoon', 'clarinet',
  // Pipe (72–79)
  'piccolo', 'flute', 'recorder', 'pan_flute',
  'blown_bottle', 'shakuhachi', 'whistle', 'ocarina',
  // Synth Lead (80–87)
  'lead_1_square', 'lead_2_sawtooth', 'lead_3_calliope', 'lead_4_chiff',
  'lead_5_charang', 'lead_6_voice', 'lead_7_fifths', 'lead_8_bass_lead',
  // Synth Pad (88–95)
  'pad_1_new_age', 'pad_2_warm', 'pad_3_polysynth', 'pad_4_choir',
  'pad_5_bowed', 'pad_6_metallic', 'pad_7_halo', 'pad_8_sweep',
  // Synth Effects (96–103)
  'fx_1_rain', 'fx_2_soundtrack', 'fx_3_crystal', 'fx_4_atmosphere',
  'fx_5_brightness', 'fx_6_goblins', 'fx_7_echoes', 'fx_8_scifi',
  // Ethnic (104–111)
  'sitar', 'banjo', 'shamisen', 'koto',
  'kalimba', 'bagpipe', 'fiddle', 'shanai',
  // Percussive (112–119)
  'tinkle_bell', 'agogo', 'steel_drums', 'woodblock',
  'taiko_drum', 'melodic_tom', 'synth_drum', 'reverse_cymbal',
  // Sound Effects (120–127)
  'guitar_fret_noise', 'breath_noise', 'seashore', 'bird_tweet',
  'telephone_ring', 'helicopter', 'applause', 'gunshot',
];
