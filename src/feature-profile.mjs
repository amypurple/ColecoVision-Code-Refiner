const FEATURES = [
  ["vblankNmi", ["NMI_HANDLER", "WAIT"], "Frame synchronization and CVBasic NMI state"],
  ["controllers", ["KEYPAD_TABLE", "JOYSEL", "KEYSEL"], "Controller/keypad scanning"],
  ["text", ["PRINT_STRING", "PRINT_CHAR", "PRINT_NUMBER"], "Cursor-based text output"],
  ["sprites", ["DEFINE_SPRITE", "UPDATE_SPRITE", "SPRITES"], "Sprite definitions or SAT updates"],
  ["vramTransfer", ["LDIRVM", "LDIRMV", "FILVRM", "WRTVRM", "RDVRM"], "VRAM transfer helpers"],
  ["arithmetic16", ["_MUL16", "_DIV16", "_DIV16S", "_MOD16", "_SGN16"], "16-bit arithmetic helpers"],
  ["random", ["RANDOM"], "CVBasic LFSR sequence"],
  ["music", ["MUSIC_INIT", "MUSIC_PLAY", "MUSIC_GENERATE"], "CVBasic music bytecode player"],
  ["sound", ["SN76489_FREQ", "SN76489_VOL", "SN76489_CONTROL"], "Immediate PSG control"],
  ["compression", ["PLETTER_UNPACK", "ZX0_UNPACK", "BITBUSTER_UNPACK"], "Compressed asset decoder"]
];

export function buildCvbasicFeatureProfile(reachability, source = "") {
  const reachable = new Set((reachability?.reachable ?? []).map((name) => name.toUpperCase()));
  const match = String(source).match(/;\s*CVBasic program start\.[\s\S]*?(?=;\s*CVBasic epilogue)/i);
  const program = match?.[0] ?? String(source);
  const programUses = (symbols) => symbols.filter((symbol) => new RegExp(`\\b${symbol}\\b`, "i").test(program));
  const features = FEATURES.map(([id, symbols, description]) => {
    let evidence = programUses(symbols);
    if (id === "vblankNmi" && /\b(?:halt|db\s+\$76|call\s+wait)\b/i.test(program)) evidence = ["WAIT/HALT"];
    if (id === "controllers") evidence = programUses(["JOY1_DATA", "JOY2_DATA", "KEY1_DATA", "KEY2_DATA", "SPINNER_DATA"]);
    if (id === "sprites") evidence = programUses(["DEFINE_SPRITE", "UPDATE_SPRITE", "SPRITE_DATA", "SPRITES"]);
    if (!match && !evidence.length) evidence = symbols.filter((symbol) => reachable.has(symbol));
    return { id, required: evidence.length > 0, evidence, description };
  });
  return {
    required: features.filter((feature) => feature.required),
    omitted: features.filter((feature) => !feature.required),
    synthesisPolicy: "Generate only required ColecoVision services; preserve CVBasic-visible RAM and semantics at the boundary."
  };
}
