const GLOBAL_LABEL = /^([A-Za-z_?$][\w?$]*)\s*:\s*(?:;.*)?$/i;
const TOKEN = /\b([A-Za-z_?$][\w?$]*)\b/g;
const TERMINATOR = /^\s*(?:ret(?:[ \t]+[a-z]+)?|reti|retn|jp\s+(?![a-z]+\s*,)|jr\s+(?![a-z]+\s*,))\b/i;
const INSTRUCTION = /^\s*(?:adc|add|and|bit|call|ccf|cp|cpd|cpdr|cpi|cpir|cpl|daa|dec|di|djnz|ei|ex|exx|halt|im|in|inc|ind|indr|ini|inir|jp|jr|ld|ldd|lddr|ldi|ldir|neg|nop|or|otdr|otir|out|outd|outi|pop|push|res|ret|reti|retn|rl|rla|rlc|rlca|rld|rr|rra|rrc|rrca|rrd|rst|sbc|scf|set|sla|sll|sra|srl|sub|xor)\b/i;
const DIRECTIVE = /^\s*(?:db|dw|dd|byte|word|rb|ds|org|align|equ)\b/i;
const ROOT_NAMES = new Set(["START", "NMI_HANDLER", "ROM_START", "ROM_END"]);
const CVBASIC_RUNTIME_ROUTINES = new Set([
  "WRTVDP", "SETWRT", "SETRD", "WRTVRM", "RDVRM", "FILVRM", "LDIRMV", "LDIRVM", "LDIRVM3", "FILVRM2",
  "DISSCR", "ENASCR", "CPYBLK", "CLS", "PRINT_STRING", "PRINT_NUMBER", "PRINT_CHAR", "DEFINE_CHAR", "DEFINE_COLOR",
  "DEFINE_SPRITE", "UPDATE_SPRITE", "_MUL16", "_MOD16S", "_DIV16S", "_ABS16", "_NEG16", "_DIV16", "_MOD16", "_SGN16",
  "RANDOM", "SN76489_FREQ", "SN76489_VOL", "SN76489_CONTROL", "AY3_REG", "AY3_FREQ", "AY3_VOL", "AY3_CONTROL",
  "MODE_0", "MODE_1", "MODE_2", "WAIT", "MUSIC_INIT", "MUSIC_PLAY", "MUSIC_GENERATE", "TURN_OFF_FM"
]);

function codeOnly(line) { return line.split(";", 1)[0].trim(); }

function references(text, known) {
  const found = new Set();
  for (const match of text.matchAll(TOKEN)) {
    const name = match[1].toUpperCase();
    if (known.has(name)) found.add(name);
  }
  return found;
}

export function analyzeReachability(source) {
  const lines = String(source).replace(/\r\n?/g, "\n").split("\n");
  const starts = [];
  lines.forEach((line, index) => {
    const name = line.match(GLOBAL_LABEL)?.[1];
    if (name) starts.push({ name, upper: name.toUpperCase(), start: index });
  });
  const known = new Set(starts.map((block) => block.upper));
  const firstStart = starts[0]?.start ?? lines.length;
  const headerReferences = references(lines.slice(0, firstStart).join("\n"), known);
  const blocks = starts.map((block, index) => {
    const end = starts[index + 1]?.start ?? lines.length;
    const bodyLines = lines.slice(block.start + 1, end);
    const body = bodyLines.join("\n");
    const meaningful = bodyLines.map(codeOnly).filter(Boolean);
    const instructions = meaningful.filter((line) => INSTRUCTION.test(line));
    const directives = meaningful.filter((line) => DIRECTIVE.test(line));
    const edges = references(body, known);
    edges.delete(block.upper);
    return {
      ...block, end, line: block.start + 1, lineCount: end - block.start,
      edges: [...edges], instructionCount: instructions.length,
      directiveCount: directives.length,
      terminal: instructions.length > 0 && TERMINATOR.test(instructions.at(-1)),
      codeOnly: instructions.length > 0 && directives.length === 0
    };
  });
  const byName = new Map(blocks.map((block) => [block.upper, block]));
  const roots = new Set([...headerReferences, ...[...ROOT_NAMES].filter((name) => known.has(name))]);
  const reachable = new Set();
  const queue = [...roots];
  while (queue.length) {
    const name = queue.pop();
    if (reachable.has(name)) continue;
    reachable.add(name);
    for (const edge of byName.get(name)?.edges ?? []) if (!reachable.has(edge)) queue.push(edge);
  }
  const removableBlocks = blocks.filter((block, index) => {
    if (reachable.has(block.upper) || !block.codeOnly || !block.terminal) return false;
    if (index === 0) return true;
    return blocks[index - 1].terminal;
  });
  const removable = removableBlocks.map((block) => ({ name: block.name, line: block.line, lineCount: block.lineCount, reason: "unreachable isolated code block" }));
  return {
    roots: [...roots].sort(), reachable: [...reachable].sort(), reachableCount: reachable.size, blockCount: blocks.length,
    unreachableCount: blocks.length - reachable.size,
    removable,
    guarded: blocks.filter((block) => !reachable.has(block.upper) && !removable.some((item) => item.name.toUpperCase() === block.upper)).map((block) => ({
      name: block.name, line: block.line,
      reason: !block.codeOnly ? "contains data or mixed code" : !block.terminal ? "fall-through or non-terminal block" : "preceding block may fall through"
    }))
  };
}

export function pruneUnreachableCvbasicRuntime(source) {
  const text = String(source).replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const analysis = analyzeReachability(text);
  let approved = analysis.removable.filter((item) => CVBASIC_RUNTIME_ROUTINES.has(item.name.toUpperCase()));
  // Remove a closed group of dead runtime routines together. References from
  // active code, data, or an unapproved block still reject the entire chain.
  while (approved.length) {
    const hidden = new Set();
    for (const item of approved) {
      const start = item.line - 1;
      for (let index = start; index < start + item.lineCount; index += 1) hidden.add(index);
    }
    const outside = lines.filter((_, index) => !hidden.has(index)).join("\n");
    const next = approved.filter((item) => {
      const escaped = item.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return !new RegExp(`\\b${escaped}\\b`, "i").test(outside);
    });
    if (next.length === approved.length) break;
    approved = next;
  }
  const remove = new Set();
  for (const item of approved) {
    const start = item.line - 1;
    for (let index = start; index < start + item.lineCount; index += 1) remove.add(index);
  }
  const output = lines.filter((_, index) => !remove.has(index));
  return {
    text: `${output.join("\n").replace(/\n+$/, "")}\n`,
    transformations: approved.map((item) => ({ kind: "REMOVE_UNREACHABLE_CVBASIC_RUNTIME", routine: item.name, sourceLine: item.line, sourceLineCount: item.lineCount }))
  };
}
