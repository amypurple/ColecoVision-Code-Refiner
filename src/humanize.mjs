import { evaluateExpression } from "./expression.mjs";

const EQUATE = /^\s*([A-Za-z_.$?][\w.$?]*)\s*:?[ \t]+\.?equ\s+([^;]+)/i;
const LOAD_BYTE = /^\s*ld\s+([bc])\s*,\s*([^;]+?)(?:\s*;\s*(.*))?$/i;
const LOAD_PAIR = /^(\s*ld\s+bc\s*,\s*)([^;]+?)(\s*(?:;.*)?)$/i;
const OS7_VECTORS = new Map([
  [0x1f82, "FILL_VRAM"], [0x1f85, "MODE_1"], [0x1fc1, "INIT_SPR_ORDER"],
  [0x1fc4, "WR_SPR_NM_TBL"], [0x1fd6, "TURN_OFF_SOUND"],
  [0x1fd9, "WRITE_REGISTER"], [0x1fdf, "WRITE_VRAM"], [0x1fe2, "READ_VRAM"],
  [0x1ffa, "PUTOBJ"]
]);

function collectLiteralStyle(source) {
  const byValue = new Map();
  for (const match of String(source).matchAll(/\$([0-9a-f]+)/gi)) {
    const digits = match[1];
    const value = Number.parseInt(digits, 16);
    const rendered = `$${value.toString(16).toUpperCase().padStart(digits.length, "0")}`;
    const previous = byValue.get(value);
    if (!previous || rendered.length < previous.length) byValue.set(value, rendered);
  }
  return byValue;
}

function collectEquateStyle(source) {
  const styles = new Map();
  for (const line of String(source).split(/\r?\n/)) {
    const match = line.match(EQUATE);
    if (match) styles.set(match[1].toUpperCase(), match[2].trim());
  }
  return styles;
}

function restoreHumanNumberStyle(line, literalStyle, equateStyle, symbols) {
  const semicolon = line.indexOf(";");
  const code = semicolon >= 0 ? line.slice(0, semicolon) : line;
  const comment = semicolon >= 0 ? line.slice(semicolon) : "";
  let restored = code;
  const equate = restored.match(/^\s*([A-Za-z_.$?][\w.$?]*)\s+equ\s+[^;]+$/i);
  if (equate && equateStyle.has(equate[1].toUpperCase())) {
    restored = `${equate[1]} equ ${equateStyle.get(equate[1].toUpperCase())}`;
  }
  for (const [name, value] of symbols) {
    if (!/(?:^|_)PORT$/.test(name)) continue;
    const decimal = String(value);
    restored = restored.replace(new RegExp(`(\\(\\s*)${decimal}(\\s*\\))`, "g"), `$1${name}$2`);
  }
  restored = restored.replace(/(?<![\w.$])\d+(?![\w])/g, (token) => {
    const value = Number(token);
    return literalStyle.get(value) ?? token;
  });
  if (/^\s*(?:org|dw)\b/i.test(restored)) {
    restored = restored.replace(/\$([0-9a-f]{1,4})\b/gi, (_, digits) => `$${digits.toUpperCase().padStart(4, "0")}`);
  }
  const call = restored.match(/^(\s*call\s+)\$([0-9a-f]+)(\s*)$/i);
  if (call) {
    const value = Number.parseInt(call[2], 16);
    const service = OS7_VECTORS.get(value);
    if (service) return `${call[1]}$${call[2].toUpperCase().padStart(4, "0")}${call[3]} ; OS7 ${service}`;
  }
  return restored + comment;
}

function parseSymbols(source) {
  const symbols = new Map();
  for (const line of String(source).split(/\r?\n/)) {
    const match = line.match(EQUATE);
    if (!match) continue;
    try {
      symbols.set(match[1].toUpperCase(), evaluateExpression(match[2], symbols));
    } catch {
      // Forward/address expressions are irrelevant to byte-pair provenance.
    }
  }
  return symbols;
}

function describeByte(register, expression, value, comment, nextInstruction) {
  const symbol = expression.trim();
  const upper = symbol.toUpperCase();
  const details = [];
  if (comment?.trim()) details.push(comment.trim().replace(/[.;]+$/, ""));
  if (register === "B" && /^(OTIR|OTDR|INIR|INDR)\b/i.test(nextInstruction)) {
    if (!new RegExp(`\\b${value}\\s*bytes?\\b`, "i").test(comment ?? "")) details.push(`${value} bytes`);
    details.push("block-transfer byte count");
  }
  if (register === "C" && /^(OTIR|OTDR|INIR|INDR)\b/i.test(nextInstruction)) details.push("I/O port");
  if (register === "B" && /^DJNZ\b/i.test(nextInstruction)) details.push("loop counter");
  if (/CTRL_PORT|VDP.*CTRL|CONTROL_PORT/.test(upper)) details.push("VDP control port");
  if (/DATA_PORT|VDP.*DATA/.test(upper)) details.push("VDP data port");
  return `${register}=${symbol}${details.length ? ` (${[...new Set(details)].join("; ")})` : ""}`;
}

function collectPairs(source, symbols) {
  const lines = String(source).replace(/\r\n?/g, "\n").split("\n");
  const pairs = [];
  for (let index = 0; index < lines.length; index += 1) {
    const first = lines[index].match(LOAD_BYTE);
    if (!first) continue;
    let secondIndex = index + 1;
    while (secondIndex < lines.length && /^\s*(?:;.*)?$/.test(lines[secondIndex])) secondIndex += 1;
    const second = lines[secondIndex]?.match(LOAD_BYTE);
    if (!second || first[1].toUpperCase() === second[1].toUpperCase()) continue;
    const byRegister = new Map([[first[1].toUpperCase(), first], [second[1].toUpperCase(), second]]);
    try {
      const b = evaluateExpression(byRegister.get("B")[2].trim(), symbols) & 0xff;
      const c = evaluateExpression(byRegister.get("C")[2].trim(), symbols) & 0xff;
      let nextIndex = secondIndex + 1;
      while (nextIndex < lines.length && /^\s*(?:;.*|[A-Za-z_.$?][\w.$?]*:\s*)?$/.test(lines[nextIndex])) nextIndex += 1;
      const nextInstruction = lines[nextIndex]?.trim() ?? "";
      pairs.push({
        value: (b << 8) | c,
        b: describeByte("B", byRegister.get("B")[2], b, byRegister.get("B")[3], nextInstruction),
        c: describeByte("C", byRegister.get("C")[2], c, byRegister.get("C")[3], nextInstruction),
        sourceLines: [index + 1, secondIndex + 1]
      });
      index = secondIndex;
    } catch {
      // A pair is annotated only when both bytes are statically proven.
    }
  }
  return pairs;
}

export function annotateOptimizedAssembly(originalSource, optimizedSource) {
  const symbols = parseSymbols(originalSource);
  const literalStyle = collectLiteralStyle(originalSource);
  const equateStyle = collectEquateStyle(originalSource);
  const pairs = collectPairs(originalSource, symbols);
  const pending = [...pairs];
  const annotations = [];
  const lines = String(optimizedSource).replace(/\r\n?/g, "\n").split("\n").map((line) => restoreHumanNumberStyle(line, literalStyle, equateStyle, symbols));
  const output = lines.map((line, index) => {
    const match = line.match(LOAD_PAIR);
    if (!match) return line;
    let value;
    try {
      value = evaluateExpression(match[2].trim(), symbols) & 0xffff;
    } catch {
      return line;
    }
    const pairIndex = pending.findIndex((candidate) => candidate.value === value);
    if (pairIndex < 0) return line;
    const pair = pending.splice(pairIndex, 1)[0];
    const note = `packed from separate byte roles: ${pair.b}; ${pair.c}. Split into LD B / LD C when that is clearer to edit.`;
    annotations.push({ line: index + 1, value, sourceLines: pair.sourceLines, b: pair.b, c: pair.c });
    return `${match[1]}$${value.toString(16).toUpperCase().padStart(4, "0")} ; ${note}`;
  });
  return { text: `${output.join("\n").replace(/\n+$/, "")}\n`, annotations };
}
