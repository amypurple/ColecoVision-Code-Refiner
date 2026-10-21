const ROUTINE_LABEL = /^\s*([A-Za-z_.$?][\w.$?]*)\s*:\s*(?:;.*)?$/;

const CATALOG = [
  {
    id: "FILVRM", labels: ["FILVRM", "FILVRM2"], service: "FILL_VRAM", vector: "$1F82",
    status: "PROVEN_CALLSITE", risk: "low",
    summary: "CVBasic's VRAM fill loop duplicates the OS7 FILL_VRAM service.",
    prerequisite: "At each call site, prove HL=VRAM destination, BC=count and A=value; move BC to DE and preserve caller-visible registers. Do not replace the helper globally.",
    signature: /call\s+SETWRT[\s\S]{0,500}out\s*\(VDP\)\s*,\s*a[\s\S]{0,300}djnz/i
  },
  {
    id: "LDIRVM", labels: ["LDIRVM", "LDIRVM3"], service: "WRITE_VRAM", vector: "$1FDF",
    status: "PROVEN_CALLSITE", risk: "low",
    summary: "CVBasic's RAM-to-VRAM transfer duplicates OS7 WRITE_VRAM.",
    prerequisite: "At each call site, prove the standard HL=RAM, DE=VRAM, BC=count inputs and liveness after the call. Use the Amy count-fix wrapper unless B=0. Do not replace the helper globally.",
    signature: /call\s+SETWRT[\s\S]{0,500}(?:outi|otir)/i
  },
  {
    id: "LDIRMV", labels: ["LDIRMV"], service: "READ_VRAM", vector: "$1FE2",
    status: "PROVEN_CALLSITE", risk: "low",
    summary: "CVBasic's VRAM-to-RAM loop duplicates OS7 READ_VRAM.",
    prerequisite: "At each call site, prove the standard HL=RAM, DE=VRAM, BC=count inputs and liveness after the call. Use the Amy count-fix wrapper unless B=0. Do not replace the helper globally.",
    signature: /call\s+SETRD[\s\S]{0,400}in\s+a\s*,\s*\(VDP\)[\s\S]{0,200}ld\s*\(de\)\s*,\s*a/i
  },
  {
    id: "WRTVDP", labels: ["WRTVDP"], service: "WRITE_REGISTER", vector: "$1FD9",
    status: "CONDITIONAL", risk: "medium",
    summary: "Direct VDP-register writes can use OS7 WRITE_REGISTER and keep OS7 shadows coherent.",
    prerequisite: "Translate CVBasic B=value/C=register to the OS7 ABI and prove interrupt policy and shadow state.",
    signature: /out\s*\(VDP\+1\)\s*,\s*a[\s\S]{0,100}or\s+\$80/i
  },
  {
    id: "SCREEN_ENABLE", labels: ["DISSCR", "ENASCR"], service: "WRITE_REGISTER", vector: "$1FD9",
    status: "CONDITIONAL", risk: "medium",
    summary: "CVBasic toggles display enable through its own register writer.",
    prerequisite: "OS7 R1 shadow must first match the active CVBasic VDP state.",
    signature: /ld\s+bc\s*,\s*\$(?:a2|e2)01[\s\S]{0,80}call\s+WRTVDP/i
  },
  {
    id: "CLS", labels: ["cls"], service: "FILL_VRAM", vector: "$1F82",
    status: "PROVEN_CALLSITE", risk: "low",
    summary: "CVBasic clears the name table with its private fill helper.",
    prerequisite: "Retain CVBasic cursor initialization, adapt BC count to OS7 DE, and choose the same blank tile ($20 in its text screen).",
    signature: /ld\s+hl\s*,\s*\$1800[\s\S]{0,120}ld\s+bc\s*,\s*\$0300[\s\S]{0,100}call\s+FILVRM/i
  },
  {
    id: "MODE_INIT", labels: ["mode_0", "mode_1", "mode_2", "vdp_generic_mode"], service: "MODE_1 / INIT_TABLE / WRITE_REGISTER", vector: "$1F85 et al.",
    status: "CONDITIONAL", risk: "high",
    summary: "CVBasic initializes VDP tables, fonts, sprites and screen state itself.",
    prerequisite: "Match the selected CVBasic mode exactly; OS7 MODE_1 alone is not equivalent to CVBasic MODE 0/1/2 setup.",
    signature: /vdp_generic_mode:[\s\S]{0,900}call\s+WRTVDP/i
  },
  {
    id: "SPRITE_UPDATE", labels: ["update_sprite"], service: "COPY_RAM_SPRITES / WR_SPR_NM_TBL", vector: "$1FC4",
    status: "CONDITIONAL", risk: "high",
    summary: "CVBasic maintains its own sprite RAM table and NMI upload pipeline.",
    prerequisite: "Adapt CVBasic sprite order, terminator and four-byte entry layout to the cartridge header tables expected by OS7.",
    signature: /ld\s*\(sprite_data\+3\)\s*,\s*a[\s\S]{0,350}ldi[\s\S]{0,80}ldi/i
  },
  {
    id: "CONTROLLERS", labels: ["nmi_handler"], service: "UPDATE_CONTROLLERS / READ_SPINNER", vector: "$1F76 / $1F79",
    status: "CONDITIONAL", risk: "high",
    summary: "CVBasic scans controllers in its NMI and translates keypad values to its own variables.",
    prerequisite: "Adapt OS7 controller-table format to joy1_data/joy2_data/key1_data/key2_data without changing NMI timing.",
    signature: /keypad_table:[\s\S]{0,1600}(?:joy1_data|key1_data)/i
  },
  {
    id: "RANDOM", labels: ["random"], service: "GET_RANDOM", vector: "$1FFD",
    status: "KEEP_DIRECT", risk: "semantic",
    summary: "Both generate pseudo-random values, but CVBasic exposes a 16-bit LFSR sequence while OS7 has a different state and result contract.",
    prerequisite: "Replace only when the program does not depend on CVBasic's sequence, width or saved lfsr state.",
    signature: /ld\s+hl\s*,\s*\(lfsr\)[\s\S]{0,500}ld\s*\(lfsr\)\s*,\s*hl/i
  },
  {
    id: "PSG", labels: ["sn76489_freq", "sn76489_vol", "sn76489_control"], service: "PLAY_SOUND_SLOT / PLAY_SOUNDS", vector: "$1FF1 / $1F61",
    status: "KEEP_DIRECT", risk: "semantic",
    summary: "CVBasic writes immediate SN76489 parameters; OS7 consumes sound-table records with a different scheduler.",
    prerequisite: "Convert data and timing to OS7 sound records; a call substitution is not equivalent.",
    signature: /sn76489_freq:[\s\S]{0,900}out\s*\(PSG\)\s*,\s*a/i
  },
  {
    id: "MUSIC", labels: ["music_init", "music_play", "music_generate"], service: "OS7 sound engine", vector: "$1FEE-$1FF4",
    status: "KEEP_DIRECT", risk: "semantic",
    summary: "CVBasic music has its own bytecode, state and per-frame generator.",
    prerequisite: "Requires an offline music-format conversion, not a routine replacement.",
    signature: /music_init:[\s\S]{0,3000}music_(?:play|generate):/i
  },
  {
    id: "TEXT", labels: ["print_string", "print_char", "define_char", "define_color"], service: "LOAD_ASCII / WRITE_VRAM", vector: "$1F7F / $1FDF",
    status: "CONDITIONAL", risk: "medium",
    summary: "CVBasic implements cursor-based text and character definition above primitive VRAM writes.",
    prerequisite: "Preserve cursor, character encoding, mode-dependent replicated pattern/color tables and PRINT semantics.",
    signature: /print_char:[\s\S]{0,300}call\s+WRTVRM/i
  }
];

function labelsIn(source) {
  const labels = new Set();
  for (const line of String(source).split(/\r?\n/)) {
    const label = line.match(ROUTINE_LABEL)?.[1];
    if (label) labels.add(label.toUpperCase());
  }
  return labels;
}

export function catalogCvbasicOs7Opportunities(source) {
  const text = String(source);
  const labels = labelsIn(text);
  return CATALOG.flatMap((entry) => {
    const matchedLabels = entry.labels.filter((label) => labels.has(label.toUpperCase()));
    const signatureMatched = entry.signature.test(text);
    if (!matchedLabels.length && !signatureMatched) return [];
    return [{
      id: entry.id,
      matchedLabels,
      signatureMatched,
      service: entry.service,
      vector: entry.vector,
      status: entry.status,
      risk: entry.risk,
      summary: entry.summary,
      prerequisite: entry.prerequisite
    }];
  });
}

export const CVBASIC_OS7_CATALOG = Object.freeze(CATALOG.map(({ signature, ...entry }) => Object.freeze(entry)));
