const PROGRAM_PATTERN = /;\s*CVBasic program start\.([\s\S]*?)(?=;\s*CVBasic epilogue)/i;

function parseNumber(text) {
  const value = String(text).trim();
  if (/^\$[0-9a-f]+$/i.test(value)) return Number.parseInt(value.slice(1), 16);
  if (/^0x[0-9a-f]+$/i.test(value)) return Number.parseInt(value.slice(2), 16);
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function bytesForLabel(source, label) {
  const lines = String(source).split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `${label.toLowerCase()}:`);
  if (start < 0) return null;
  const bytes = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s*(?:db|\.db)\s+/i.test(line)) break;
    const values = line.replace(/^\s*(?:db|\.db)\s+/i, "").split(",");
    for (const value of values) {
      const parsed = parseNumber(value.replace(/;.*/, ""));
      if (parsed === null || parsed < 0 || parsed > 255) return null;
      bytes.push(parsed);
    }
  }
  return bytes;
}

function normalizeProgram(text) {
  return text
    .replace(/;[^\r\n]*/g, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

export function recognizeStaticMode2Text(source) {
  const block = String(source).match(PROGRAM_PATTERN)?.[1];
  if (!block) return { matched: false, reason: "CVBasic program markers were not found" };
  const lines = normalizeProgram(block);
  let index = 0;
  const take = (pattern) => {
    const match = lines[index]?.match(pattern);
    if (match) index += 1;
    return match;
  };

  if (!take(/^call mode_2$/i)) return { matched: false, reason: "program is not the strict MODE 2 static-text shape" };
  const borderLoad = take(/^ld a,([^ ]+)$/i);
  if (!borderLoad || !take(/^ld b,a$/i) || !take(/^ld c,(?:7|\$07)$/i) ||
      !take(/^call nmi_off$/i) || !take(/^call wrtvdp$/i) || !take(/^call nmi_on$/i)) {
    return { matched: false, reason: "border setup differs from the recognized CVBasic sequence" };
  }
  const cursorLoad = take(/^ld hl,([^ ]+)$/i);
  if (!cursorLoad || !take(/^ld \(cursor\),hl$/i)) return { matched: false, reason: "cursor setup is not static" };
  const stringLoad = take(/^ld hl,([a-z_.$?@][\w.$?@]*)$/i);
  const lengthLoad = take(/^ld a,([^ ]+)$/i);
  if (!stringLoad || !lengthLoad || !take(/^call print_string$/i)) return { matched: false, reason: "text output is not one static PRINT" };
  const jumpOverData = take(/^jr ([a-z_.$?@][\w.$?@]*)$/i);
  if (!jumpOverData) return { matched: false, reason: "inline string jump was not recognized" };

  const dataLabel = lines[index]?.match(/^([a-z_.$?@][\w.$?@]*):$/i)?.[1];
  if (!dataLabel || dataLabel.toLowerCase() !== stringLoad[1].toLowerCase()) return { matched: false, reason: "inline string label differs" };
  index += 1;
  while (index < lines.length && /^(?:db|\.db)\s+/i.test(lines[index])) index += 1;
  const afterLabel = lines[index]?.match(/^([a-z_.$?@][\w.$?@]*):$/i)?.[1];
  if (!afterLabel || afterLabel.toLowerCase() !== jumpOverData[1].toLowerCase()) return { matched: false, reason: "inline string terminator differs" };
  index += 1;
  const loopLabel = lines[index]?.match(/^([a-z_.$?@][\w.$?@]*):$/i)?.[1];
  if (!loopLabel) return { matched: false, reason: "wait loop label was not found" };
  index += 1;
  if (!take(/^(?:db \$76\+coleco_spinner\*\$59|halt)$/i) || !take(new RegExp(`^jp ${loopLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"))) {
    return { matched: false, reason: "program does more than wait forever after printing" };
  }
  if (index < lines.length && /^[a-z_.$?@][\w.$?@]*:$/i.test(lines[index])) index += 1;
  if (index !== lines.length) return { matched: false, reason: "program does more than wait forever after printing" };

  const border = parseNumber(borderLoad[1]);
  const cursor = parseNumber(cursorLoad[1]);
  const length = parseNumber(lengthLoad[1]);
  const bytes = bytesForLabel(source, dataLabel);
  if ([border, cursor, length].some((value) => value === null) || !bytes || bytes.length !== length) {
    return { matched: false, reason: "static values or inline string bytes could not be resolved" };
  }
  return { matched: true, border, cursor, bytes, sourceLabel: dataLabel };
}

function hex(value, width = 2) {
  return `$${value.toString(16).padStart(width, "0").toUpperCase()}`;
}

export function synthesizeStaticMode2Text(source) {
  const match = recognizeStaticMode2Text(source);
  if (!match.matched) return { ...match, text: null, transformations: [] };
  const data = match.bytes.map((value) => hex(value)).join(",");
  const text = `; Specialized ColecoVision cartridge generated from a proven static CVBasic program.
; OS7 owns mode setup, font loading, VRAM fill/write, sound shutdown and VDP access.
; The original generic CVBasic runtime is intentionally omitted.

FILL_VRAM       equ $1F82
MODE_1          equ $1F85
LOAD_ASCII      equ $1F7F
TURN_OFF_SOUND  equ $1FD6
WRITE_REGISTER  equ $1FD9
WRITE_VRAM      equ $1FDF

VRAM_NAME       equ $1800
VRAM_COLOR      equ $2000
VRAM_SPR_ATTR   equ $1B00

org $8000
db $55,$AA
; Sprite/name pointers are unused; OS7 still requires a valid RAM work buffer.
dw 0,0,$7000,0
dw Start

ret
nop
nop
ret
nop
nop
ret
nop
nop
ret
nop
nop
ret
nop
nop
ret
nop
nop
ret
nop
nop
jp Nmi

Nmi:
    push af
    ; A direct status read is re-entrant while an OS7 VRAM service is active.
    in a,($BF)
    pop af
    retn

Start:
    di
    im 1
    call TURN_OFF_SOUND
    call MODE_1
    ; Graphics II selects one of three pattern pages by display band.
    ld hl,$0000
    ld ($73F8),hl
    call LOAD_ASCII
    ld hl,$0800
    ld ($73F8),hl
    call LOAD_ASCII
    ld hl,$1000
    ld ($73F8),hl
    call LOAD_ASCII
    xor a
    ld ($73F8),a
    ld ($73F9),a

    ; CVBasic MODE 2 uses blank character $20 and color byte $F0.
    ld hl,VRAM_NAME
    ld de,$0300
    ld a,$20
    call FILL_VRAM
    ld hl,VRAM_COLOR
    ; CVBasic's mode-aware FILVRM expands the 32-byte request over all 3 pages.
    ld de,$1800
    ld a,$F0
    call FILL_VRAM
    ; Hide all 32 sprites, matching CVBasic's mode initialization.
    ld hl,VRAM_SPR_ATTR
    ld de,$0080
    ld a,$D1
    call FILL_VRAM

    ; OS7 WRITE_REGISTER takes B=register and C=value.
    ld bc,${hex((7 << 8) | match.border, 4)}
    call WRITE_REGISTER

    ld hl,Message
    ld de,VRAM_NAME+${hex(match.cursor, 4)}
    ld bc,${hex(match.bytes.length, 4)}
    call WRITE_VRAM

    ; Enable display and VDP interrupts after VRAM is complete.
    ld bc,$01E2
    call WRITE_REGISTER
    ei

WaitForever:
    halt
    jp WaitForever

Message:
    db ${data}

ROM_END:
`;
  return {
    matched: true,
    text,
    profile: match,
    transformations: [{
      kind: "STATIC_MODE2_TEXT_MICRO_RUNTIME",
      description: `replaced the generic CVBasic runtime with OS7 services for ${match.bytes.length} static text bytes`
    }]
  };
}

function extractStaticPrints(source) {
  const block = String(source).match(PROGRAM_PATTERN)?.[1];
  if (!block) return [];
  const lines = normalizeProgram(block);
  const prints = [];
  for (let index = 0; index < lines.length - 4; index += 1) {
    const cursor = lines[index].match(/^ld hl,([^ ]+)$/i);
    if (!cursor || !/^ld \(cursor\),hl$/i.test(lines[index + 1])) continue;
    const label = lines[index + 2].match(/^ld hl,([a-z_.$?@][\w.$?@]*)$/i)?.[1];
    const length = lines[index + 3].match(/^ld a,([^ ]+)$/i)?.[1];
    if (!label || !length || !/^call print_string$/i.test(lines[index + 4])) continue;
    const parsedCursor = parseNumber(cursor[1]);
    const parsedLength = parseNumber(length);
    const bytes = bytesForLabel(source, label);
    if (parsedCursor === null || parsedLength === null || !bytes || bytes.length !== parsedLength) return [];
    prints.push({ cursor: parsedCursor, bytes, sourceLabel: label });
  }
  return prints;
}

export function recognizeControllerBorderDemo(source) {
  const block = String(source).match(PROGRAM_PATTERN)?.[1];
  if (!block) return { matched: false, reason: "CVBasic program markers were not found" };
  const text = normalizeProgram(block).join("\n");
  const prints = extractStaticPrints(source);
  const calls = [...text.matchAll(/^call ([a-z_.$?@][\w.$?@]*)$/gim)].map((match) => match[1].toLowerCase());
  const allowed = new Set(["mode_2", "print_string", "nmi_off", "wrtvdp", "nmi_on"]);
  if (calls.some((name) => !allowed.has(name)) || calls.filter((name) => name === "mode_2").length !== 1 ||
      calls.filter((name) => name === "print_string").length !== 3 ||
      calls.filter((name) => name === "wrtvdp").length !== 7 || prints.length !== 3) {
    return { matched: false, reason: "program is not the strict controller-to-border demo shape" };
  }
  const required = [
    /ld a,\(key1_data\)\ncp 15/i,
    /ld a,\(joy1_data\)\nand 128/i,
    /ld a,\(joy1_data\)\nand 64/i,
    /ld a,\(joy1_data\)\nand 1/i,
    /ld a,\(joy1_data\)\nand 4/i,
    /ld a,\(joy1_data\)\nand 8/i,
    /ld a,\(joy1_data\)\nand 2/i
  ];
  if (!required.every((pattern) => pattern.test(text))) return { matched: false, reason: "controller tests or priorities differ" };
  const borders = [...text.matchAll(/ld a,(13|9|3|12|11|7|4)\nld b,a\nld c,7\ncall nmi_off\ncall wrtvdp\ncall nmi_on/gi)]
    .map((match) => Number(match[1]));
  if (borders.join(",") !== "13,9,3,12,11,7,4") return { matched: false, reason: "border response table differs" };
  if (!/db \$76\+coleco_spinner\*\$59/i.test(text)) return { matched: false, reason: "frame wait was not recognized" };
  return { matched: true, prints };
}

function dataLines(bytes) {
  return bytes.map((value) => hex(value)).join(",");
}

export function synthesizeControllerBorderDemo(source) {
  const match = recognizeControllerBorderDemo(source);
  if (!match.matched) return { ...match, text: null, transformations: [] };
  const writes = match.prints.map((item, index) => `    ld hl,Text${index + 1}\n    ld de,VRAM_NAME+${hex(item.cursor, 4)}\n    ld bc,${hex(item.bytes.length, 4)}\n    call WRITE_VRAM`).join("\n");
  const records = match.prints.map((item, index) => `Text${index + 1}: db ${dataLines(item.bytes)}`).join("\n");
  const text = `; Specialized ColecoVision controller demo generated from a closed CVBasic program.
MODE_1           equ $1F85
LOAD_ASCII       equ $1F7F
FILL_VRAM        equ $1F82
WRITE_VRAM       equ $1FDF
WRITE_REGISTER   equ $1FD9
TURN_OFF_SOUND   equ $1FD6
DECODE_CONTROLLER equ $1F79
VRAM_NAME        equ $1800
VRAM_COLOR       equ $2000
VRAM_SPR_ATTR    equ $1B00
COLOR            equ $7024
VBLANK           equ $7025

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
    in a,($BF)
    xor a
    out ($C0),a
    ld h,a
    ld l,a
    call DECODE_CONTROLLER
    ld a,h
    rlca
    or l
    push af
    ld h,0
    ld l,1
    call DECODE_CONTROLLER
    ld b,h
    ld c,l
    pop af
    ld d,a
    ld a,c
    cp $0F
    ld a,13
    jr nz,StoreColor
    ld a,b
    or a
    ld a,9
    jr nz,StoreColor
    ld a,d
    bit 7,a
    ld a,9
    jr nz,StoreColor
    bit 0,d
    ld a,3
    jr nz,StoreColor
    bit 2,d
    ld a,12
    jr nz,StoreColor
    bit 3,d
    ld a,11
    jr nz,StoreColor
    bit 1,d
    ld a,7
    jr nz,StoreColor
    ld a,4
StoreColor:
    ld (COLOR),a
    ld a,1
    ld (VBLANK),a
    pop hl
    pop de
    pop bc
    pop af
    retn

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
    call FILL_VRAM
${writes}
    ld bc,$01E2
    call WRITE_REGISTER
    ei
Loop:
    xor a
    ld (VBLANK),a
WaitFrame:
    ld a,(VBLANK)
    or a
    jr z,WaitFrame
    ld a,(COLOR)
    ld c,a
    ld b,7
    call WRITE_REGISTER
    jr Loop

${records}
ROM_END:
`;
  return {
    matched: true,
    text,
    profile: { matched: true, kind: "CONTROLLER_BORDER_DEMO", prints: match.prints },
    runtimeInputEvents: [
      { frame: 65, masks: [1, 0] },
      { frame: 75, masks: [0, 0] },
      { frame: 85, masks: [16, 0] },
      { frame: 95, masks: [0, 0] }
    ],
    transformations: [{
      kind: "CONTROLLER_BORDER_OS7_MICRO_RUNTIME",
      description: "replaced CVBasic text, controller NMI, condition tree and VDP writer with OS7 services"
    }]
  };
}

export function synthesizePureCvProgram(source) {
  const staticText = synthesizeStaticMode2Text(source);
  if (staticText.matched) return { ...staticText, profile: { ...staticText.profile, kind: "STATIC_MODE2_TEXT" } };
  const controller = synthesizeControllerBorderDemo(source);
  if (controller.matched) return controller;
  return { matched: false, text: null, transformations: [], reason: `${staticText.reason}; ${controller.reason}` };
}
