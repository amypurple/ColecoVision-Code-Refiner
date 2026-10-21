import test from "node:test";
import assert from "node:assert/strict";
import { convertCvbasicMusicToTinyAsm } from "../src/convert-cvbasic-music.mjs";
import { buildCvbasicHybridMusicCandidate } from "../src/cvbasic-music-rom.mjs";
import { synthesizeCvbasicMusicMicroRuntime } from "../src/cvbasic-music-micro-runtime.mjs";
import { renderAssemblyDialect } from "../src/dialect-output.mjs";
import { assembleAmysCVAssembly } from "../vendor/amyscvassembly/compilerCore.js";
import { getOptimizationProfile } from "../vendor/studio-core/optimization.js";

const mixedMusic = `
unsupported:
DATA BYTE 5
MUSIC C4,E4,-,M4
MUSIC REPEAT

melody: DATA BYTE 6
MUSIC C4,E4,-,-
MUSIC S,S,-,-
MUSIC STOP
`;

test("rejects unsupported percussion without losing compatible tunes", () => {
  const result = convertCvbasicMusicToTinyAsm(mixedMusic, {
    prefix: "fixture",
    skipUnsupportedBlocks: true
  });

  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].name, "melody");
  assert.equal(result.rejectedBlocks.length, 1);
  assert.match(result.rejectedBlocks[0].reason, /M4/);
  assert.equal(result.firstSongLabel, "fixture_melody_song");
  assert.match(result.asm, /play song fixture_melody_song/);
  assert.doesNotMatch(result.asm, /fixture_unsupported_song/);
});

test("fails closed on unknown percussion in strict mode", () => {
  assert.throws(
    () => convertCvbasicMusicToTinyAsm(mixedMusic, { prefix: "fixture" }),
    /unsupported CVBasic percussion M4/
  );
});

test("returns no playable label when every block is rejected", () => {
  const result = convertCvbasicMusicToTinyAsm(`
drums:
DATA BYTE 4
MUSIC -,-,-,M4
MUSIC STOP
`, { prefix: "fixture", skipUnsupportedBlocks: true });

  assert.equal(result.blocks.length, 0);
  assert.equal(result.firstSongLabel, null);
  assert.match(result.asm, /play song <no compatible song>/);
});

test("emits Tiny Tone 1/2 with BIOS Tone 3 and M1/M2/M3 noise", () => {
  const result = convertCvbasicMusicToTinyAsm(`
hybrid: DATA BYTE 5
MUSIC G5#Y,C3#,C4,M1
MUSIC S,S,S,M2
MUSIC F5#,G3#,-,M3
MUSIC STOP
`, { prefix: "fixture", skipUnsupportedBlocks: true });

  assert.equal(result.rejectedBlocks.length, 0);
  assert.deepEqual(result.blocks[0].activeChannels, [1, 2, 3]);
  assert.deepEqual(result.blocks[0].percussion, ["M1", "M2", "M3"]);
  assert.match(result.asm, /SPECIAL-04 tiny stream on sndtiny_1/);
  assert.match(result.asm, /SPECIAL-04 tiny stream on sndtiny_2/);
  assert.match(result.asm, /BIOS standard Tone 3 stream/);
  assert.match(result.asm, /BIOS standard noise stream for M1, M2, M3/);
  assert.match(result.asm, /dw fixture_hybrid_noise,\$7049/);
});

test("loops synchronized BIOS percussion when CVBasic music repeats", () => {
  const result = convertCvbasicMusicToTinyAsm(`
looping: DATA BYTE 4
MUSIC C4,E4,-,M1
MUSIC REPEAT
`, { prefix: "fixture" });

  const noiseBlock = result.asm.match(/fixture_looping_noise:\n([\s\S]*?)\n\n/)[1];
  assert.match(noiseBlock, /\$18(?:\s*;[^\n]*)?$/m);
});

test("hybrid ROM integration advances OS7 sound and keeps Tiny state independent", () => {
  const basic = `
tune: DATA BYTE 5
MUSIC C4,E4,-,-
MUSIC D4,F4,-,-
MUSIC STOP
`;
  const assembly = `
music_init:
    ret
START:
    call music_init
    ld a,(music_mode)
    or a
    call nz,music_hardware
    ; Music is played with a 50hz clock.
.3:
    LD HL,cvb_TUNE
    CALL music_play
    LD HL,music_silence
    CALL music_play
cvb_TUNE:
    db 0
rom_end:
    org $7000
ram_start:
sprites:
    rb 128
frame:
    rb 2
music_tick: rb 1
music_mode: rb 1
music_start: rb 2
music_pointer: rb 2
music_playing: rb 1
ram_end:
`;
  const result = buildCvbasicHybridMusicCandidate(assembly, basic, { prefix: "fixture" });
  const update = result.assembly.indexOf("call $1FF4");
  const output = result.assembly.indexOf("call $1F61");

  assert.ok(update >= 0 && output > update, "SOUND_MAN must advance streams before PLAY_SOUNDS outputs them");
  assert.match(result.assembly, /CVB_OS7_SOUND_RAM:\s*rb \$53\s*\n\s*sprites:/i);
  assert.match(result.assembly, /CVB_TINY_SLOT_1:\s*rb 16\s*\nCVB_TINY_SLOT_2:\s*rb 16/i);
  assert.match(result.assembly, /ld de,CVB_TINY_SLOT_1/i);
  assert.doesNotMatch(result.assembly, /ld de,music_tick/i);
  assert.match(result.assembly, /ld b,4\s*\n\s*call \$1FEE/i);
});

test("synthesizes a closed two-choice BASIC player with the Amy/OS7 wrapper", () => {
  const basic = `
wait_key:
  PRINT AT 66,"Press button"
  IF CONT1.BUTTON THEN GOTO play_1
  IF CONT1.BUTTON2 THEN GOTO play_2
play_1:
  PRINT AT 66,"First tune"
  PRINT AT 130,"(fragment)"
  PLAY tune_1
play_2:
  PRINT AT 66,"Second tune"
  PRINT AT 130,"(fragment)"
  PLAY tune_2
tune_1: DATA BYTE 5
  MUSIC C4,E4
  MUSIC STOP
tune_2: DATA BYTE 5
  MUSIC D4,F4,-,M1
  MUSIC REPEAT
`;
  const result = synthesizeCvbasicMusicMicroRuntime(basic, { prefix: "fixture" });

  assert.equal(result.report.replacedCvbasicRuntime, true);
  assert.deepEqual(result.report.songs.map(song => song.indexes), [[5, 6], [7, 8, 9]]);
  assert.match(result.assembly, /call UPDATE_CONTROLLERS/);
  assert.match(result.assembly, /call PLAY_SOUNDS\s*\n\s*call UPDATE_SOUND_ADDR/);
  assert.doesNotMatch(result.assembly, /call AMY_TINY_SOUND_TICK/i);
  assert.match(result.assembly, /ld hl,fixture_snd_table\s*\n\s*ld b,4\s*\n\s*call SET_SOUND_TABLE/i);
  assert.doesNotMatch(result.assembly, /music_hardware|music_play:/i);
});

test("Amy/OS7 music synthesis fails closed on a different BASIC control shape", () => {
  assert.throws(
    () => synthesizeCvbasicMusicMicroRuntime("tune_1: MUSIC C4 MUSIC STOP"),
    /expected the two-button tune_1\/tune_2 menu/
  );
});

test("Amy/OS7 music wrapper remains byte-identical in TASM and GASM80 output", async () => {
  const basic = `
wait_key:
  PRINT AT 66,"Press button"
  IF CONT1.BUTTON THEN GOTO play_1
  IF CONT1.BUTTON2 THEN GOTO play_2
play_1:
  PRINT AT 66,"First tune"
  PRINT AT 130,"(fragment)"
  PLAY tune_1
play_2:
  PRINT AT 66,"Second tune"
  PRINT AT 130,"(fragment)"
  PLAY tune_2
tune_1: DATA BYTE 5
  MUSIC C4,E4
  MUSIC STOP
tune_2: DATA BYTE 5
  MUSIC D4,F4,-,M1
  MUSIC REPEAT
`;
  const native = synthesizeCvbasicMusicMicroRuntime(basic, { prefix: "fixture" }).assembly;
  const assemble = async (source, dialect) => {
    const result = await assembleAmysCVAssembly({ "main.asm": source }, "main.asm", {
      outputFilename: "music.rom",
      outputMode: "binary",
      targetPlatform: "raw",
      optimizerEnabled: false,
      gasm80Compatibility: dialect === "gasm80",
      tasmCompatibility: dialect === "tasm"
    });
    assert.equal(result.ok, true, result.log);
    return Buffer.from(result.binary);
  };
  const nativeBinary = await assemble(native, "native");
  for (const dialect of ["tasm", "gasm80"]) {
    const rendered = renderAssemblyDialect(native, dialect);
    assert.deepEqual(await assemble(rendered, dialect), nativeBinary, `${dialect} changed the generated ROM`);
  }
});

test("Amy/OS7 music wrapper accepts the exposed optimizer profiles", async () => {
  const basic = `
wait_key:
  PRINT AT 66,"Press button"
  IF CONT1.BUTTON THEN GOTO play_1
  IF CONT1.BUTTON2 THEN GOTO play_2
play_1:
  PRINT AT 66,"First tune"
  PRINT AT 130,"(fragment)"
  PLAY tune_1
play_2:
  PRINT AT 66,"Second tune"
  PRINT AT 130,"(fragment)"
  PLAY tune_2
tune_1: DATA BYTE 5
  MUSIC C4,E4
  MUSIC STOP
tune_2: DATA BYTE 5
  MUSIC D4,F4,-,M1
  MUSIC REPEAT
`;
  const source = synthesizeCvbasicMusicMicroRuntime(basic, { prefix: "fixture" }).assembly;
  for (const level of ["off", "balanced", "aggressive"]) {
    const profile = getOptimizationProfile(level, source);
    const result = await assembleAmysCVAssembly({ "main.asm": source }, "main.asm", {
      outputMode: "binary",
      targetPlatform: "raw",
      optimizerEnabled: profile.optimizerEnabled,
      optimizerConfig: profile.optimizerConfig
    });
    assert.equal(result.ok, true, `${level}: ${result.log}`);
  }
});
