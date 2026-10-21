import { alexisLibrarySources } from "../vendor/studio-core/alexisLibrarySources.generated.js";
import { convertCvbasicMusicToTinyAsm } from "./convert-cvbasic-music.mjs";
import { refineAssembly } from "./refiner.mjs";

function replaceExactly(source, pattern, replacement, description) {
  const matches = source.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)) || [];
  if (matches.length !== 1) throw new Error(`${description}: expected one structural match, found ${matches.length}`);
  return source.replace(pattern, replacement);
}

function callsFor(indexes) {
  return indexes.map(index => `    ld b,${index}\n    call $1FF1`).join("\n");
}

export function buildCvbasicHybridMusicCandidate(generatedAssembly, basicSource, options = {}) {
  const tiny = convertCvbasicMusicToTinyAsm(basicSource, {
    prefix: options.prefix || "CVBHybridMusic",
    skipUnsupportedBlocks: false,
    ...(options.primaryInstrument ? { primaryInstrument: options.primaryInstrument } : {}),
    ...(options.secondaryInstrument ? { secondaryInstrument: options.secondaryInstrument } : {})
  });
  if (tiny.blocks.length < 1) throw new Error("no convertible CVBasic music block");

  let source = refineAssembly(generatedAssembly).text;
  source = replaceExactly(source,
    /^(ram_start:\s*\r?\n\s*)(sprites:\s*)$/im,
    "$1CVB_OS7_SOUND_RAM: rb $53\n$2",
    "CVBasic sprite buffer relocation after OS7 sound RAM");
  const labels = new Map(tiny.blocks.map(block => [block.name.toUpperCase(), block]));
  let nextSoundIndex = 5;
  const starts = new Map();
  for (const block of tiny.blocks) {
    const count = block.activeChannels.filter(channel => channel <= 3).length + (block.percussion.length ? 1 : 0);
    const indexes = Array.from({ length: count }, (_, offset) => nextSoundIndex + offset);
    nextSoundIndex += count;
    starts.set(block.name.toUpperCase(), { block, indexes });
  }

  source = replaceExactly(source,
    /\s*ld a,\(music_mode\)\s*\n\s*or a\s*\n\s*call nz,music_hardware\s*/i,
    "\n\tcall $1FF4\n\tcall $1F61\n\tcall CVB_TINY_TICK\n",
    "CVBasic NMI hardware music hook");
  source = replaceExactly(source,
    /\s*;\s*Music is played with a 50hz clock\.[\s\S]*?^\.3:\s*$/im,
    "",
    "CVBasic NMI music generator hook");
  source = replaceExactly(source,
    /^music_init:[\s\S]*?(?=^START:)/im,
    "__CVB_TINY_RUNTIME__\n\n",
    "CVBasic music runtime");
  source = replaceExactly(source, /^\s*call music_init\s*$/im, "\tcall CVB_TINY_INIT", "CVBasic music startup");
  source = source.replace(/^\s*LD A,(?:3|5)\s*\n\s*LD \(music_mode\),A\s*$/gim, "");

  for (const [name, item] of starts) {
    const label = `cvb_${name}`;
    source = replaceExactly(source,
      new RegExp(`\\s*LD HL,${label}\\s*\\n\\s*CALL music_play\\s*`, "i"),
      `\n\tcall CVB_TINY_START_${name}\n`,
      `PLAY ${item.block.name}`);
  }
  source = replaceExactly(source,
    /\s*LD HL,music_silence\s*\n\s*CALL music_play\s*/i,
    "\n\tcall CVB_TINY_STOP\n",
    "PLAY OFF");

  const firstDataLabel = `cvb_${tiny.blocks[0].name.toUpperCase()}`;
  source = replaceExactly(source,
    new RegExp(`^${firstDataLabel}:[\\s\\S]*?(?=^rom_end:)`, "im"),
    `${tiny.asm}\n`,
    "compiled CVBasic music data");

  const tinyRuntime = alexisLibrarySources["src/alexis_lib/coleco_tiny_sound.asm"]
    .replaceAll("AMY_TINYSOUND_SLOT_1", "CVB_TINY_SLOT_1")
    .replaceAll("AMY_TINYSOUND_SLOT_2", "CVB_TINY_SLOT_2")
    .replaceAll("AMY_FRAME_COUNTER", "frame");
  const helpers = [
    "CVB_TINY_INIT:",
    `    ld hl,${tiny.soundTableLabel}`,
    "    ld b,4",
    "    call $1FEE",
    "    xor a",
    "    ld (music_playing),a",
    "    ld (music_pointer),a",
    "    ld (music_pointer+1),a",
    "    ret",
    "",
    "CVB_TINY_TICK:",
    "    ld hl,(music_pointer)",
    "    ld a,h",
    "    or l",
    "    ret z",
    "    dec hl",
    "    ld (music_pointer),hl",
    "    ld a,h",
    "    or l",
    "    ret nz",
    "    ld (music_playing),a",
    "    ret",
    "",
    "CVB_TINY_STOP:",
    callsFor([1, 2, 3, 4]),
    "    xor a",
    "    ld (music_playing),a",
    "    ld (music_pointer),a",
    "    ld (music_pointer+1),a",
    "    ret",
    ""
  ];
  for (const [name, item] of starts) {
    const frames = item.block.terminator === "stop" ? item.block.rows * item.block.tinyTempo + 1 : 0;
    helpers.push(`CVB_TINY_START_${name}:`, callsFor(item.indexes));
    helpers.push(`    ld hl,$${frames.toString(16).toUpperCase().padStart(4, "0")}`);
    helpers.push("    ld (music_pointer),hl", "    ld a,1", "    ld (music_playing),a", "    ret", "");
  }
  source = source.replace("__CVB_TINY_RUNTIME__", `${helpers.join("\n")}\n${tinyRuntime}`);
  source = replaceExactly(source,
    /^ram_end:\s*$/im,
    "CVB_TINY_SLOT_1: rb 16\nCVB_TINY_SLOT_2: rb 16\nram_end:",
    "Tiny Sound RAM reservation");

  return {
    assembly: source,
    tiny,
    report: {
      status: "ASSEMBLY_CANDIDATE",
      spriteBufferRelocatedAfterOs7SoundRam: true,
      replacedSongs: [...starts.keys()],
      soundAreaCount: 4
    }
  };
}
