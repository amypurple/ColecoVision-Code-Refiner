#!/usr/bin/env node

const TINY_NOTE_PERIODS = [
  0x03ff, 0x03f8, 0x03db, 0x03bf, 0x03a4, 0x0389, 0x036f, 0x0356,
  0x033e, 0x0327, 0x0310, 0x02f9, 0x02e3, 0x02ce, 0x02ba, 0x02a6,
  0x0293, 0x0280, 0x026e, 0x025c, 0x024b, 0x023a, 0x022a, 0x021a,
  0x020b, 0x01fc, 0x01ed, 0x01df, 0x01d1, 0x01c4, 0x01b7, 0x01ab,
  0x019f, 0x0193, 0x0187, 0x017c, 0x0171, 0x0167, 0x015d, 0x0153,
  0x0149, 0x0140, 0x0137, 0x012e, 0x0125, 0x011d, 0x0115, 0x010d,
  0x0105, 0x00fe, 0x00f6, 0x00ef, 0x00e8, 0x00e2, 0x00db, 0x00d5,
  0x00cf, 0x00c9, 0x00c3, 0x00be, 0x00b8, 0x00b3, 0x00ae, 0x00a9,
  0x00a4, 0x00a0, 0x009b, 0x0097, 0x0092, 0x008e, 0x008a, 0x0086,
  0x0082, 0x007f, 0x007b, 0x0077, 0x0074, 0x0071, 0x006d, 0x006a,
  0x0067, 0x0064, 0x0061, 0x005f, 0x005c, 0x0059, 0x0056, 0x0054,
  0x0052, 0x0050, 0x004d, 0x004b, 0x0049, 0x0047, 0x0045, 0x0043,
  0x0041, 0x003f, 0x003d, 0x003b, 0x0039, 0x0038, 0x0036, 0x0035,
  0x0033, 0x0032, 0x0030, 0x002f, 0x002d, 0x002c, 0x002b, 0x002a
];

const CVBASIC_SN_NOTE_PERIODS = [
  0,
  // CVBasic Z80 music_notes_table values for the 3.58 MHz SN76489 target.
  1710, 1614, 1524, 1438, 1357, 1281, 1209, 1141, 1077, 1017, 960, 906,
  855, 807, 762, 719, 679, 641, 605, 571, 539, 508, 480, 453,
  428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226,
  214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113,
  107, 101, 95, 90, 85, 80, 76, 71, 67, 64, 60, 57,
  53, 50, 48
];

const NOTE_BASE = new Map([
  ["C", 0],
  ["D", 2],
  ["E", 4],
  ["F", 5],
  ["G", 7],
  ["A", 9],
  ["B", 11]
]);

const DEFAULT_OPTIONS = {
  prefix: "cvbmusic",
  primaryInstrument: [0x60, 0x19, 0x22],
  secondaryInstrument: [0x50, 0x13, 0x33],
  sourceFrameRate: 50,
  targetFrameRate: 60,
  tempoScale: null,
  noteCodeOffset: 3,
  baseSoundArea: 0x702b,
  soundAreaStride: 10
};

function stripComment(line) {
  const quote = line.indexOf("'");
  return quote >= 0 ? line.slice(0, quote) : line;
}

function normalizeLabel(name) {
  return String(name || "")
    .trim()
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/^([^A-Za-z_])/, "_$1");
}

function formatHexByte(value) {
  return `$${(value & 0xff).toString(16).toUpperCase().padStart(2, "0")}`;
}

function formatDb(values, comment = "") {
  const rendered = values.map((value) => {
    if (typeof value === "string") return value;
    return formatHexByte(value);
  }).join(",");
  return `    db ${rendered}${comment ? ` ; ${comment}` : ""}`;
}

function formatDw(value, comment = "") {
  const rendered = typeof value === "number"
    ? `$${(value & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`
    : value;
  return `    dw ${rendered}${comment ? ` ; ${comment}` : ""}`;
}

function formatSigned(value) {
  const number = Number(value) || 0;
  return number >= 0 ? `+${number}` : `${number}`;
}

function formatScale(value) {
  const fixed = Number(value).toFixed(2);
  return fixed.replace(/\.?0+$/, "");
}

export function parseCvbasicMusic(sourceText) {
  const lines = String(sourceText || "").split(/\r?\n/);
  const blocks = [];
  let current = null;

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    let line = stripComment(lines[lineNumber]).trim();
    if (!line) continue;

    const labelMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (labelMatch) {
      if (current) blocks.push(current);
      current = {
        name: labelMatch[1],
        tempo: null,
        rows: [],
        terminator: null,
        lineNumber: lineNumber + 1
      };
      line = labelMatch[2].trim();
      if (!line) continue;
    }

    if (!current) continue;

    const tempoMatch = line.match(/^DATA\s+BYTE\s+([0-9]+)\s*$/i);
    if (tempoMatch && current.rows.length === 0 && current.tempo === null) {
      current.tempo = Number.parseInt(tempoMatch[1], 10);
      continue;
    }

    const musicMatch = line.match(/^MUSIC\s+(.+)$/i);
    if (!musicMatch) continue;

    const payload = musicMatch[1].trim();
    if (/^REPEAT$/i.test(payload)) {
      current.terminator = "repeat";
      blocks.push(current);
      current = null;
      continue;
    }
    if (/^STOP$/i.test(payload)) {
      current.terminator = "stop";
      blocks.push(current);
      current = null;
      continue;
    }

    const channels = payload.split(",").map((part) => part.trim().toUpperCase());
    if (channels.length < 1 || channels.length > 4) {
      throw new Error(`Invalid MUSIC row at line ${lineNumber + 1}: ${line}`);
    }
    current.rows.push({ channels, lineNumber: lineNumber + 1 });
  }

  if (current) blocks.push(current);
  return blocks.filter((block) => block.tempo !== null && block.rows.length > 0);
}

export function noteToPeriod(noteToken) {
  const index = noteToCvbasicIndex(noteToken);
  const period = CVBASIC_SN_NOTE_PERIODS[index];
  if (!period) throw new Error(`Unsupported CVBasic note range: ${noteToken}`);
  return period;
}

function noteToCvbasicIndex(noteToken) {
  const normalized = String(noteToken || "").trim().toUpperCase().replace(/[WXY]$/, "");
  const match = normalized.match(/^([A-G])([0-9])([#S]?)$/);
  if (!match) throw new Error(`Unsupported note token: ${noteToken}`);
  const [, letter, octaveText, accidental] = match;
  const octave = Number.parseInt(octaveText, 10);
  if (octave < 2 || octave > 7) throw new Error(`Unsupported CVBasic note octave: ${noteToken}`);
  const semitone = NOTE_BASE.get(letter) + (accidental ? 1 : 0);
  if (octave === 7 && semitone > 2) throw new Error(`Unsupported CVBasic note range: ${noteToken}`);
  return 1 + ((octave - 2) * 12) + semitone;
}

function convertTempo(tempo, opts) {
  const scaled = Math.round(Number(tempo) * getTempoScale(opts));
  return Math.max(1, Math.min(0x3f, scaled));
}

function getTempoScale(opts) {
  if (opts.tempoScale !== null && opts.tempoScale !== undefined) {
    return Number(opts.tempoScale) || 1;
  }
  return (Number(opts.targetFrameRate) || 60) / (Number(opts.sourceFrameRate) || 60);
}

export function noteToTinyCode(noteToken, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const period = noteToPeriod(noteToken);
  let bestCode = 0x04;
  let bestIndex = tinyCodeToNoteIndex(bestCode);
  let bestDiff = Number.POSITIVE_INFINITY;
  for (let code = 0x04; code <= 0x3c; code += 1) {
    const index = tinyCodeToNoteIndex(code);
    const diff = Math.abs(TINY_NOTE_PERIODS[index] - period);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestCode = code;
      bestIndex = index;
    }
  }
  bestCode = Math.max(0x04, Math.min(0x3c, bestCode + Number(opts.noteCodeOffset || 0)));
  bestIndex = tinyCodeToNoteIndex(bestCode);
  return {
    code: bestCode,
    index: bestIndex,
    period,
    tinyPeriod: TINY_NOTE_PERIODS[bestIndex]
  };
}

export function tinyCodeToNoteIndex(code) {
  const normalized = Number(code) & 0x3f;
  return (((normalized - 1) & 0x3f) * 2) + 1;
}

function activeChannelIndexes(block) {
  const active = new Set();
  for (const row of block.rows) {
    row.channels.forEach((token, index) => {
      if (token && token !== "-" && token !== "S") active.add(index);
    });
  }
  return [...active].sort((a, b) => a - b);
}

function tonalChannelIndexes(block) {
  return activeChannelIndexes(block).filter(index => index < 3);
}

function percussionTokens(block) {
  return [...new Set(block.rows.map(row => row.channels[3] || "-")
    .filter(token => token !== "-" && token !== "S"))].sort();
}

function channelToTinyStream(block, channelIndex, opts) {
  const bytes = [];
  const noteMap = [];
  let lastState = "rest";
  for (const row of block.rows) {
    const token = row.channels[channelIndex] || "-";
    if (token === "S") {
      bytes.push(0x00);
      continue;
    }
    if (token === "-") {
      bytes.push(0x01);
      lastState = "rest";
      continue;
    }
    const note = noteToTinyCode(token, opts);
    bytes.push(note.code);
    lastState = "note";
    noteMap.push({ token, ...note });
  }
  let loopCompression = null;
  if (block.terminator === "repeat") {
    const repeatedPhrase = findSmallestRepeatedPhrase(bytes);
    if (repeatedPhrase && repeatedPhrase.length < bytes.length) {
      loopCompression = {
        originalLength: bytes.length,
        phraseLength: repeatedPhrase.length,
        repeats: bytes.length / repeatedPhrase.length
      };
      bytes.length = 0;
      bytes.push(...repeatedPhrase);
    }
    bytes.push(0xff);
  } else {
    if (lastState !== "rest") bytes.push(0x01);
    // The song table owns one-shot duration and then triggers a silence stream.
    // Keep one safe no-op byte for the boundary tick; the old 32-byte tail was
    // defensive padding and made short stop tracks look much larger than needed.
    bytes.push(0x00);
  }
  return { bytes, noteMap, loopCompression };
}

function chunkBytes(bytes, width = 16) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += width) {
    chunks.push(bytes.slice(offset, offset + width));
  }
  return chunks;
}

function findSmallestRepeatedPhrase(bytes) {
  if (!Array.isArray(bytes) || bytes.length < 4) return null;
  for (let length = 2; length <= Math.floor(bytes.length / 2); length += 1) {
    if (bytes.length % length !== 0) continue;
    let matches = true;
    for (let index = length; index < bytes.length; index += 1) {
      if (bytes[index] !== bytes[index % length]) {
        matches = false;
        break;
      }
    }
    if (matches) return bytes.slice(0, length);
  }
  return null;
}

function appendRest(bytes, channel, length) {
  let remaining = length;
  while (remaining > 0) {
    const chunk = Math.min(31, remaining);
    bytes.push((channel << 6) | 0x20 | chunk);
    remaining -= chunk;
  }
}

function appendSimpleCommand(bytes, channel, period, attenuation, length) {
  let remaining = length;
  while (remaining > 0) {
    const chunk = Math.min(256, remaining);
    bytes.push(channel << 6, period & 0xff, ((attenuation & 15) << 4) | ((period >> 8) & 3), chunk & 0xff);
    remaining -= chunk;
  }
}

function appendNoiseCommand(bytes, noise, attenuation, length) {
  let remaining = length;
  while (remaining > 0) {
    const chunk = Math.min(256, remaining);
    bytes.push(0x00, 0x00, ((attenuation & 15) << 4) | (noise & 7), chunk & 0xff);
    remaining -= chunk;
  }
}

function channel3ToBiosStream(block, opts) {
  const bytes = [];
  const rowFrames = convertTempo(block.tempo, opts);
  let currentPeriod = null;
  for (const row of block.rows) {
    const token = row.channels[2] || "-";
    if (token === "-") currentPeriod = null;
    else if (token !== "S") currentPeriod = noteToPeriod(token);
    if (currentPeriod) appendSimpleCommand(bytes, 3, currentPeriod, 4, rowFrames);
    else appendRest(bytes, 3, rowFrames);
  }
  bytes.push(block.terminator === "repeat" ? 0xd8 : 0xd0);
  return bytes;
}

function percussionToBiosStream(block, opts) {
  const bytes = [];
  const rowFrames = convertTempo(block.tempo, opts);
  for (const row of block.rows) {
    const token = row.channels[3] || "-";
    const active = Array(rowFrames).fill(false);
    if (token === "M1") {
      for (let frame = 0; frame < Math.min(3, rowFrames); frame += 1) active[frame] = true;
    } else if (token === "M2") {
      if (rowFrames) active[0] = true;
    } else if (token === "M3") {
      const midpoint = Math.floor((rowFrames & 0x3e) / 2);
      for (let frame = 0; frame < rowFrames; frame += 1) {
        active[frame] = frame < 2 || (frame >= midpoint && frame < midpoint + 2);
      }
    }
    for (let offset = 0; offset < active.length;) {
      const enabled = active[offset];
      let end = offset + 1;
      while (end < active.length && active[end] === enabled) end += 1;
      if (enabled) appendNoiseCommand(bytes, 4, 5, end - offset);
      else appendRest(bytes, 0, end - offset);
      offset = end;
    }
  }
  bytes.push(block.terminator === "repeat" ? 0x18 : 0x10);
  return bytes;
}

export function convertCvbasicMusicToTinyAsm(sourceText, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const prefix = normalizeLabel(opts.prefix);
  const blocks = parseCvbasicMusic(sourceText);
  if (!blocks.length) throw new Error("No CVBasic MUSIC blocks found.");

  const lines = [
    "; Generated by tools/convert-cvbasic-music.mjs",
    "; Format: hybrid Amy/lib4ksa sound table: Tiny Tone 1/2 plus BIOS Tone 3/noise.",
    "; Music streams intentionally use the lowest sound areas first.",
    "; On ColecoVision those areas are lowest priority, leaving higher areas for SFX.",
    "; Use from Amy with:",
    `;   set sound table ${prefix}_snd_table areas 4`,
    ";   play song __CVBASIC_TINY_FIRST_SONG__",
    ""
  ];
  const soundTableEntries = [
    { label: `${prefix}_silence_ch1`, area: opts.baseSoundArea, soundIndex: 1 },
    { label: `${prefix}_silence_ch2`, area: opts.baseSoundArea + opts.soundAreaStride, soundIndex: 2 },
    { label: `${prefix}_silence_ch3`, area: opts.baseSoundArea + opts.soundAreaStride * 2, soundIndex: 3 },
    { label: `${prefix}_silence_noise`, area: opts.baseSoundArea + opts.soundAreaStride * 3, soundIndex: 4 }
  ];
  const summaries = [];
  const rejectedBlocks = [];
  let soundIndex = 5;

  for (const block of blocks) {
    const blockName = normalizeLabel(block.name);
    const active = tonalChannelIndexes(block);
    const percussion = percussionTokens(block);
    const unsupportedPercussion = percussion.filter(token => !/^M[123]$/.test(token));
    if (unsupportedPercussion.length) {
      const reason = `${block.name} uses unsupported CVBasic percussion ${unsupportedPercussion.join(", ")}; expected M1, M2, or M3.`;
      if (opts.skipUnsupportedBlocks) {
        rejectedBlocks.push({ name: block.name, lineNumber: block.lineNumber, reason, percussion: unsupportedPercussion });
        continue;
      }
      throw new Error(reason);
    }
    const tinyChannels = active.filter(index => index < 2);
    const blockSoundIndexes = [];
    const blockSilenceIndexes = [];
    const blockNoteCount = new Map();

    for (let localChannel = 0; localChannel < tinyChannels.length; localChannel += 1) {
      const sourceChannel = tinyChannels[localChannel];
      const label = `${prefix}_${blockName}_ch${sourceChannel + 1}`;
      const handler = localChannel === 0 ? "sndtiny_1" : "sndtiny_2";
      const instrument = localChannel === 0 ? opts.primaryInstrument : opts.secondaryInstrument;
      const area = opts.baseSoundArea + localChannel * opts.soundAreaStride;
      const { bytes, noteMap, loopCompression } = channelToTinyStream(block, sourceChannel, opts);
      const tinyTempo = convertTempo(block.tempo, opts);
      const tempoComment = opts.tempoScale === null || opts.tempoScale === undefined
        ? `tempo, CVBasic ${block.tempo} ${opts.sourceFrameRate}Hz->${opts.targetFrameRate}Hz x ${formatScale(getTempoScale(opts))}; note offset ${formatSigned(opts.noteCodeOffset)}`
        : `tempo, CVBasic ${block.tempo} x ${formatScale(getTempoScale(opts))}; note offset ${formatSigned(opts.noteCodeOffset)}`;

      lines.push(`${label}:`);
      lines.push(formatDb([localChannel === 0 ? 0x44 : 0x84], `SPECIAL-04 tiny stream on ${handler}`));
      lines.push(formatDw(handler));
      lines.push(formatDb([tinyTempo], tempoComment));
      lines.push(formatDb([0x02, ...instrument], "instrument"));
      if (loopCompression) {
        lines.push(`    ; loop phrase compressed: ${loopCompression.originalLength} row bytes -> ${loopCompression.phraseLength} row bytes, repeats ${loopCompression.repeats}x`);
      }
      for (const chunk of chunkBytes(bytes)) lines.push(formatDb(chunk));
      lines.push("");

      soundTableEntries.push({ label, area, soundIndex });
      blockSoundIndexes.push(soundIndex);
      blockSilenceIndexes.push(sourceChannel + 1);
      soundIndex += 1;
      for (const note of noteMap) {
        blockNoteCount.set(note.token, (blockNoteCount.get(note.token) || 0) + 1);
      }
    }

    if (active.includes(2)) {
      const label = `${prefix}_${blockName}_ch3`;
      const bytes = channel3ToBiosStream(block, opts);
      lines.push(`${label}:`);
      lines.push("    ; BIOS standard Tone 3 stream");
      for (const chunk of chunkBytes(bytes)) lines.push(formatDb(chunk));
      lines.push("");
      soundTableEntries.push({ label, area: opts.baseSoundArea + opts.soundAreaStride * 2, soundIndex });
      blockSoundIndexes.push(soundIndex++);
      blockSilenceIndexes.push(3);
    }

    if (percussion.length) {
      const label = `${prefix}_${blockName}_noise`;
      const bytes = percussionToBiosStream(block, opts);
      lines.push(`${label}:`);
      lines.push(`    ; BIOS standard noise stream for ${percussion.join(", ")}`);
      for (const chunk of chunkBytes(bytes)) lines.push(formatDb(chunk));
      lines.push("");
      soundTableEntries.push({ label, area: opts.baseSoundArea + opts.soundAreaStride * 3, soundIndex });
      blockSoundIndexes.push(soundIndex++);
      blockSilenceIndexes.push(4);
    }

    const songLabel = `${prefix}_${blockName}_song`;
    lines.push(`${songLabel}:`);
    if (blockSoundIndexes.length) {
      const encodedFirst = ((blockSoundIndexes.length - 1) << 6) | blockSoundIndexes[0];
      const duration = block.terminator === "stop" ? Math.max(1, block.rows.length * convertTempo(block.tempo, opts) + 1) : 1;
      lines.push(formatDw(duration, block.terminator === "stop" ? "one-shot duration before silence" : "trigger tiny looping streams once"));
      lines.push(formatDb([encodedFirst, ...blockSoundIndexes.slice(1)], blockSoundIndexes.map((index) => `sound ${index}`).join(", ")));
      if (block.terminator === "repeat") {
        lines.push(formatDw(0, "song table end; tiny streams loop internally"));
      } else {
        const silenceIndexes = blockSilenceIndexes.length ? blockSilenceIndexes : [1];
        const encodedSilenceFirst = ((silenceIndexes.length - 1) << 6) | silenceIndexes[0];
        lines.push(formatDw(1, "force music areas silent"));
        lines.push(formatDb([encodedSilenceFirst, ...silenceIndexes.slice(1)], silenceIndexes.map((index) => `sound ${index}`).join(", ")));
        lines.push(formatDw(0, "song table end"));
      }
    } else {
      lines.push(formatDw(0, "empty song"));
    }
    lines.push("");

    summaries.push({
      name: block.name,
      tempo: block.tempo,
      tinyTempo: convertTempo(block.tempo, opts),
      rows: block.rows.length,
      terminator: block.terminator || "none",
      activeChannels: active.map((index) => index + 1),
      percussion,
      soundIndexes: blockSoundIndexes,
      noteCounts: Object.fromEntries([...blockNoteCount.entries()].sort())
    });
  }

  lines.push(`${prefix}_silence_ch1:`);
  lines.push(formatDb([0x44], "SPECIAL-04 tiny silence"));
  lines.push(formatDw("sndtiny_1"));
  lines.push(formatDb([1], "tempo"));
  lines.push(formatDb([0x01, 0xff], "silence then loop"));
  lines.push("");
  lines.push(`${prefix}_silence_ch2:`);
  lines.push(formatDb([0x84], "SPECIAL-04 tiny silence"));
  lines.push(formatDw("sndtiny_2"));
  lines.push(formatDb([1], "tempo"));
  lines.push(formatDb([0x01, 0xff], "silence then loop"));
  lines.push("");
  lines.push(`${prefix}_silence_ch3:`);
  lines.push(formatDb([0x23, 0xd0], "three-frame Tone 3 rest, then end"));
  lines.push("");
  lines.push(`${prefix}_silence_noise:`);
  lines.push(formatDb([0x23, 0x10], "three-frame noise rest, then end"));
  lines.push("");

  lines.push(`${prefix}_snd_table:`);
  for (const entry of soundTableEntries) {
    const priorityNote = entry.area === opts.baseSoundArea
      ? "lowest-priority area"
      : entry.area === opts.baseSoundArea + opts.soundAreaStride
        ? "next-lowest-priority area"
        : "";
    const suffix = priorityNote ? `, ${priorityNote}` : "";
    lines.push(`    dw ${entry.label},$${entry.area.toString(16).toUpperCase().padStart(4, "0")} ; = ${entry.soundIndex}${suffix}`);
  }
  lines.push("");

  const firstSongLabel = summaries.length
    ? `${prefix}_${normalizeLabel(summaries[0].name)}_song`
    : null;
  const rendered = lines.join("\n").replace("__CVBASIC_TINY_FIRST_SONG__", firstSongLabel || "<no compatible song>");
  return {
    asm: `${rendered}\n`,
    blocks: summaries,
    soundCount: soundTableEntries.length,
    firstSongLabel,
    soundTableLabel: `${prefix}_snd_table`,
    rejectedBlocks
  };
}

function parseArgs(argv) {
  const args = { input: null, output: null, report: null, prefix: null, summary: false, skipUnsupported: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input" || arg === "-i") args.input = argv[++i];
    else if (arg === "--output" || arg === "-o") args.output = argv[++i];
    else if (arg === "--report") args.report = argv[++i];
    else if (arg === "--prefix") args.prefix = argv[++i];
    else if (arg === "--summary") args.summary = true;
    else if (arg === "--skip-unsupported") args.skipUnsupported = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (!args.input) args.input = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return [
    "Usage: node tools/convert-cvbasic-music.mjs --input game.bas --output music.asm --prefix GameMusic [--skip-unsupported] [--report report.json]",
    "",
    "Parses CVBasic DATA BYTE + MUSIC rows and emits Amy-compatible SPECIAL-04 tiny sound ASM.",
    "Uses Tiny Sound for Tone 1/2 and synchronized BIOS streams for Tone 3 plus M1/M2/M3 percussion."
  ].join("\n");
}

async function main() {
  const [{ default: fs }, { default: path }] = await Promise.all([
    import("node:fs/promises"),
    import("node:path")
  ]);
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    console.log(usage());
    return;
  }
  const sourceText = await fs.readFile(args.input, "utf8");
  const result = convertCvbasicMusicToTinyAsm(sourceText, {
    prefix: args.prefix || path.basename(args.input, path.extname(args.input)),
    skipUnsupportedBlocks: args.skipUnsupported
  });
  if (args.output) {
    await fs.mkdir(path.dirname(path.resolve(args.output)), { recursive: true });
    await fs.writeFile(args.output, result.asm, "utf8");
  } else {
    process.stdout.write(result.asm);
  }
  const report = {
    status: result.rejectedBlocks.length ? "PARTIAL_APPROXIMATE" : "APPROXIMATE",
    soundTable: result.soundTableLabel,
    firstSong: result.firstSongLabel,
    soundCount: result.soundCount,
    blocks: result.blocks,
    rejectedBlocks: result.rejectedBlocks,
    approximations: [
      "Notes are mapped to the nearest Tiny Sound period.",
      "Tempo rows are rescaled from CVBasic's 50 Hz convention to 60 Hz.",
      "Tone 1/2 use compact Tiny envelopes; Tone 3 and M1/M2/M3 use synchronized BIOS streams.",
      "Audible equivalence remains unproven until PSG-write traces are compared."
    ]
  };
  if (args.report) {
    await fs.mkdir(path.dirname(path.resolve(args.report)), { recursive: true });
    await fs.writeFile(args.report, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (args.summary) {
    console.error(JSON.stringify(report, null, 2));
  }
}

const isCli = typeof process !== "undefined" && process.argv?.[1]
  ? await Promise.all([import("node:path"), import("node:url")]).then(([pathModule, urlModule]) =>
      pathModule.default.resolve(process.argv[1]) === urlModule.fileURLToPath(import.meta.url))
  : false;
if (isCli) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
