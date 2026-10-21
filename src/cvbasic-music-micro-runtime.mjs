import { alexisLibrarySources } from "../vendor/studio-core/alexisLibrarySources.generated.js";
import { convertCvbasicMusicToTinyAsm } from "./convert-cvbasic-music.mjs";

function hex(value, width = 2) {
  return `$${Number(value).toString(16).toUpperCase().padStart(width, "0")}`;
}

function extractText(source, pattern, description) {
  const match = source.match(pattern);
  if (!match) throw new Error(`unsupported CVBasic music program: ${description}`);
  return match[1];
}

function stringBytes(text) {
  return [...String(text)].map(character => hex(character.charCodeAt(0) & 0x7f)).join(",");
}

function callsFor(indexes) {
  return indexes.map(index => `    ld b,${index}\n    call PLAY_SOUND_SLOT`).join("\n");
}

function recognizeMusicMenu(source) {
  if (!/IF\s+CONT1\.BUTTON\s+THEN\s+GOTO\s+play_1/i.test(source) ||
      !/IF\s+CONT1\.BUTTON2\s+THEN\s+GOTO\s+play_2/i.test(source) ||
      !/PLAY\s+tune_1/i.test(source) || !/PLAY\s+tune_2/i.test(source)) {
    throw new Error("unsupported CVBasic music program: expected the two-button tune_1/tune_2 menu");
  }
  return {
    prompt: extractText(source, /PRINT\s+AT\s+66\s*,\s*"([^"]+)"/i, "missing menu prompt"),
    title1: extractText(source, /play_1:[\s\S]*?PRINT\s+AT\s+66\s*,\s*"([^"]+)"/i, "missing first title"),
    title2: extractText(source, /play_2:[\s\S]*?PRINT\s+AT\s+66\s*,\s*"([^"]+)"/i, "missing second title"),
    subtitle: extractText(source, /PRINT\s+AT\s+130\s*,\s*"([^"]+)"/i, "missing subtitle")
  };
}

export function synthesizeCvbasicMusicMicroRuntime(basicSource, options = {}) {
  const menu = recognizeMusicMenu(basicSource);
  const tiny = convertCvbasicMusicToTinyAsm(basicSource, {
    prefix: options.prefix || "AmyCvbasicMusic",
    skipUnsupportedBlocks: false,
    primaryInstrument: options.primaryInstrument || [0x60, 0x00, 0x00],
    secondaryInstrument: options.secondaryInstrument || [0x50, 0x00, 0x00]
  });
  if (tiny.blocks.length !== 2) throw new Error(`unsupported CVBasic music program: expected 2 tunes, found ${tiny.blocks.length}`);

  let nextSoundIndex = 5;
  const songs = tiny.blocks.map(block => {
    const count = block.activeChannels.filter(channel => channel <= 3).length + (block.percussion.length ? 1 : 0);
    const indexes = Array.from({ length: count }, (_, offset) => nextSoundIndex + offset);
    nextSoundIndex += count;
    return { block, indexes };
  });
  const [song1, song2] = songs;
  const song1Frames = song1.block.rows * song1.block.tinyTempo + 1;
  const tinyRuntime = alexisLibrarySources["src/alexis_lib/coleco_tiny_sound.asm"]
    .replaceAll("AMY_TINYSOUND_SLOT_1", "TINY_SLOT_1")
    .replaceAll("AMY_TINYSOUND_SLOT_2", "TINY_SLOT_2")
    .replaceAll("AMY_FRAME_COUNTER", "FRAME_COUNTER");

  const assembly = `; Amy/OS7 micro-wrapper synthesized from a closed CVBasic music program.
MODE_1             equ $1F85
LOAD_ASCII         equ $1F7F
FILL_VRAM          equ $1F82
WRITE_VRAM         equ $1FDF
WRITE_REGISTER     equ $1FD9
TURN_OFF_SOUND     equ $1FD6
UPDATE_CONTROLLERS  equ $1F76
PLAY_SOUNDS        equ $1F61
UPDATE_SOUND_ADDR  equ $1FF4
SET_SOUND_TABLE    equ $1FEE
PLAY_SOUND_SLOT    equ $1FF1
VRAM_NAME          equ $1800
VRAM_COLOR         equ $2000
VRAM_SPR_ATTR      equ $1B00

JOY1               equ $7083
MUSIC_REMAIN       equ $708A
MUSIC_MODE         equ $708C
FRAME_COUNTER      equ $73BA
TINY_SLOT_1        equ $7114
TINY_SLOT_2        equ $7124

org $8000
db $55,$AA
dw 0,0,$7000,0
dw Start
db $C9,0,0,$C9,0,0,$C9,0,0,$C9,0,0,$C9,0,0,$C9,0,0,$C9,0,0
jp Nmi

Nmi:
    push af
    push bc
    push de
    push hl
    push ix
    push iy
    in a,($BF)
    call UPDATE_CONTROLLERS
    ld a,($73EE)
    and $40
    rlca
    ld d,a
    ld a,($73F0)
    and $40
    or d
    ld (JOY1),a
    call PLAY_SOUNDS
    call UPDATE_SOUND_ADDR
    ld hl,FRAME_COUNTER
    inc (hl)
    jr nz,NmiFrameDone
    inc hl
    inc (hl)
NmiFrameDone:
    ld a,(MUSIC_MODE)
    cp 1
    jr nz,NmiDone
    ld hl,(MUSIC_REMAIN)
    ld a,h
    or l
    jr z,NmiDone
    dec hl
    ld (MUSIC_REMAIN),hl
    ld a,h
    or l
    call z,StopMusic
NmiDone:
    pop iy
    pop ix
    pop hl
    pop de
    pop bc
    pop af
    ret

Start:
    di
    im 1
    call TURN_OFF_SOUND
    call MODE_1
    ld hl,$0000
LoadFontPage:
    ld ($73F8),hl
    push hl
    call LOAD_ASCII
    pop hl
    ld de,$0800
    add hl,de
    bit 4,h
    jr z,LoadFontPage
    xor a
    ld ($73F8),a
    ld ($73F9),a
    ld (MUSIC_MODE),a
    ld (FRAME_COUNTER),a
    ld (FRAME_COUNTER+1),a
    ld hl,${tiny.soundTableLabel}
    ld b,4
    call SET_SOUND_TABLE
    ld bc,$01E2
    call WRITE_REGISTER
    ei

ShowMenu:
    call StopMusic
    call ClearText
    ld hl,TextPrompt
    ld de,VRAM_NAME+66
    ld bc,TextPromptEnd-TextPrompt
    call WRITE_VRAM
    ld b,61
MenuDelay:
    halt
    djnz MenuDelay
WaitRelease:
    halt
    ld a,(JOY1)
    and $C0
    jr nz,WaitRelease
WaitChoice:
    halt
    ld a,(JOY1)
    bit 6,a
    jp nz,PlayOne
    bit 7,a
    jp z,WaitChoice

PlayTwo:
    call ClearText
    ld hl,TextTitle2
    ld de,VRAM_NAME+66
    ld bc,TextTitle2End-TextTitle2
    call WRITE_VRAM
    call PrintSubtitle
${callsFor(song2.indexes)}
    ld a,2
    ld (MUSIC_MODE),a
WaitTwo:
    halt
    ld a,(JOY1)
    bit 6,a
    jr z,WaitTwo
    jp ShowMenu

PlayOne:
    call ClearText
    ld hl,TextTitle1
    ld de,VRAM_NAME+66
    ld bc,TextTitle1End-TextTitle1
    call WRITE_VRAM
    call PrintSubtitle
${callsFor(song1.indexes)}
    ld hl,${hex(song1Frames, 4)}
    ld (MUSIC_REMAIN),hl
    ld a,1
    ld (MUSIC_MODE),a
WaitOne:
    halt
    ld a,(MUSIC_MODE)
    or a
    jr nz,WaitOne
    jp ShowMenu

PrintSubtitle:
    ld hl,TextSubtitle
    ld de,VRAM_NAME+130
    ld bc,TextSubtitleEnd-TextSubtitle
    jp WRITE_VRAM

ClearText:
    ld hl,VRAM_NAME
    ld de,$0300
    ld a,$20
    call FILL_VRAM
    ld hl,VRAM_COLOR
    ld de,$1800
    ld a,$F0
    call FILL_VRAM
    ld hl,VRAM_SPR_ATTR
    ld de,$0080
    ld a,$D1
    jp FILL_VRAM

StopMusic:
${callsFor([1, 2, 3, 4])}
    xor a
    ld (MUSIC_MODE),a
    ld (MUSIC_REMAIN),a
    ld (MUSIC_REMAIN+1),a
    ret

${tinyRuntime}

TextPrompt: db ${stringBytes(menu.prompt)}
TextPromptEnd:
TextTitle1: db ${stringBytes(menu.title1)}
TextTitle1End:
TextTitle2: db ${stringBytes(menu.title2)}
TextTitle2End:
TextSubtitle: db ${stringBytes(menu.subtitle)}
TextSubtitleEnd:

${tiny.asm}
ROM_END:
`;

  return {
    assembly,
    tiny,
    menu,
    report: {
      status: "AMY_OS7_MICRO_RUNTIME",
      replacedCvbasicRuntime: true,
      soundAreaCount: 4,
      song1Frames,
      songs: songs.map(song => ({ name: song.block.name, indexes: song.indexes }))
    }
  };
}
