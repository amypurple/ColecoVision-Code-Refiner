const DIRECTIVE = /^(\s*)\.?(org|db|dw|byte|word|end)(\b.*)$/i;
const LABELED_DIRECTIVE = /^(\s*)([A-Za-z_.$?][\w.$?]*)\s*:?\s+\.?(db|dw|byte|word)(\b.*)$/i;
const EQUATE = /^(\s*)([A-Za-z_.$?][\w.$?]*)\s*:?[ \t]+\.?equ\s+([^;]+?)(\s*(?:;.*)?)$/i;

function tasmLabel(scope, localName) {
  const cleanScope = String(scope || "ROOT").replace(/[^A-Za-z0-9_]/g, "_");
  const cleanLocal = String(localName).replace(/[^A-Za-z0-9_]/g, "_");
  return `L_${cleanScope}_${cleanLocal}`.slice(0, 32);
}

function normalizeTasmLocalLabels(lines) {
  let scope = "ROOT";
  return lines.map((line) => {
    const global = line.match(/^([A-Za-z_?][\w.$?]*):/);
    if (global && !/^L_/i.test(global[1])) scope = global[1];
    return line
      .replace(/\b([A-Za-z_?][\w$?]*)\.([0-9]+)\b/g,
        (_, owner, local) => tasmLabel(owner, local))
      .replace(/(^|[^A-Za-z0-9_.$?])\.([0-9]+)(?=$|[^A-Za-z0-9_.$?])/g,
        (_, prefix, local) => `${prefix}${tasmLabel(scope, local)}`);
  });
}

function shortSymbolHash(value) {
  let hash = 0x811C9DC5;
  for (const character of value.toUpperCase()) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).toUpperCase().padStart(8, "0");
}

function normalizeTasmSymbolLengths(lines) {
  const aliases = new Map();
  for (const line of lines) {
    const definition = line.match(/^\s*([A-Za-z_?][\w.$?]{31,})(?=\s*:)/);
    if (!definition) continue;
    const original = definition[1];
    const key = original.toUpperCase();
    if (!aliases.has(key)) aliases.set(key, `${original.slice(0, 22)}_${shortSymbolHash(original)}`);
  }
  if (!aliases.size) return lines;
  return lines.map((line) => {
    const semicolon = line.indexOf(";");
    const code = semicolon < 0 ? line : line.slice(0, semicolon);
    const comment = semicolon < 0 ? "" : line.slice(semicolon);
    const rendered = code.replace(/[A-Za-z_?][\w.$?]*/g, token => aliases.get(token.toUpperCase()) || token);
    return `${rendered}${comment}`;
  });
}

function indentTasmInstructions(lines) {
  return lines.map(line => {
    if (!/^[A-Za-z_?]/.test(line)) return line;
    if (/^[A-Za-z_?][\w.$?]*\s*:/.test(line)) return line;
    return `    ${line}`;
  });
}

function renderTasmNumericLiterals(lines) {
  return lines.map((line) => {
    const semicolon = line.indexOf(";");
    const code = semicolon < 0 ? line : line.slice(0, semicolon);
    const comment = semicolon < 0 ? "" : line.slice(semicolon);
    if (/^\s*(?:im|bit|set|res)\b/i.test(code)) return line;
    const rendered = code.replace(/(?<![A-Za-z0-9_.$])([0-9]+)(?![A-Za-z0-9_.$])/g, (token, digits) => {
      const value = Number.parseInt(digits, 10);
      if (!Number.isFinite(value) || value > 0xFFFF) return token;
      const width = value <= 0xFF ? 2 : 4;
      return `$${value.toString(16).toUpperCase().padStart(width, "0")}`;
    });
    return `${rendered}${comment}`;
  });
}

function renderTasmStorage(lines) {
  const output = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const separateLabel = line.match(/^\s*([A-Za-z_?][\w.$?]*):\s*(?:;.*)?$/);
    const nextReserve = lines[index + 1]?.match(/^\s*rb\s+([^;]+?)(\s*(?:;.*)?)$/i);
    if (separateLabel && nextReserve) {
      output.push(`${separateLabel[1]}:`);
      output.push(`    .ORG $+${nextReserve[1].trim()}${nextReserve[2] || ""}`);
      index += 1;
      continue;
    }
    const inlineReserve = line.match(/^\s*([A-Za-z_?][\w.$?]*)\s+rb\s+([^;]+?)(\s*(?:;.*)?)$/i);
    if (inlineReserve) {
      output.push(`${inlineReserve[1]}:`);
      output.push(`    .ORG $+${inlineReserve[2].trim()}${inlineReserve[3] || ""}`);
      continue;
    }
    const align = line.match(/^\s*align\s+(\$[0-9a-f]+|[0-9]+)\s*(?:;.*)?$/i);
    if (align) {
      const boundary = align[1].startsWith("$")
        ? Number.parseInt(align[1].slice(1), 16)
        : Number.parseInt(align[1], 10);
      if (boundary > 0 && (boundary & (boundary - 1)) === 0 && boundary <= 0x8000) {
        const lowMask = boundary - 1;
        const highMask = 0xFFFF ^ lowMask;
        output.push(`    .FILL ((($ + $${lowMask.toString(16).toUpperCase()}) & $${highMask.toString(16).toUpperCase()})-$),$FF`);
        continue;
      }
    }
    output.push(line.replace(/^\s*ex\s+af\s*,\s*af\s*(;.*)?$/i, (_, comment = "") => `    EX AF,AF'${comment ? ` ${comment}` : ""}`));
  }
  return output;
}

function humanEquateExpression(name, expression) {
  const value = expression.trim();
  if (!/(?:^|_)PORT$/i.test(name)) return value;
  return value.replace(/^\$00([0-9a-f]{2})$/i, (_, byte) => `$${byte.toUpperCase()}`);
}

export function renderAssemblyDialect(source, dialect) {
  if (!new Set(["native", "gasm80", "tasm"]).has(dialect)) throw new Error(`unsupported output dialect: ${dialect}`);
  const lines = String(source).replace(/\r\n?/g, "\n").split("\n");
  const tasmSymbols = new Map();
  let output = lines.map((line) => {
    const equate = line.match(EQUATE);
    if (equate) {
      let expression = humanEquateExpression(equate[2], equate[3]);
      if (dialect === "tasm") {
        try {
          const value = evaluateExpression(expression, tasmSymbols);
          tasmSymbols.set(equate[2].toUpperCase(), value);
          const operators = expression.match(/(?:<<|>>|[+*/%&|^-])/g) ?? [];
          if (operators.length > 1) {
            const width = value >= 0 && value <= 0xFF ? 2 : 4;
            const literal = `$${(value & 0xFFFF).toString(16).toUpperCase().padStart(width, "0")}`;
            expression = `${literal} ; TASM folded from ${expression}`;
          }
        } catch {
          // Forward-address expressions remain symbolic and are handled by TASM.
        }
      }
      if (dialect === "tasm") return `${equate[1]}${equate[2]}: .EQU ${expression}${equate[4]}`;
      if (dialect === "gasm80") return `${equate[1]}${equate[2]}: equ ${expression}${equate[4]}`;
      return `${equate[1]}${equate[2]} equ ${expression}${equate[4]}`;
    }
    const labeled = line.match(LABELED_DIRECTIVE);
    if (labeled) {
      const name = labeled[3].toLowerCase();
      const separator = dialect === "native" ? " " : ": ";
      return `${labeled[1]}${labeled[2]}${separator}${dialect === "tasm" ? `.${name.toUpperCase()}` : name}${labeled[4]}`;
    }
    const directive = line.match(DIRECTIVE);
    if (!directive) return line;
    const name = directive[2].toLowerCase();
    if (dialect === "tasm") return `${directive[1]}.${name.toUpperCase()}${directive[3]}`;
    return `${directive[1]}${name}${directive[3]}`;
  });
  if (dialect === "tasm") {
    output = indentTasmInstructions(normalizeTasmSymbolLengths(renderTasmNumericLiterals(renderTasmStorage(normalizeTasmLocalLabels(output)))));
    output.unshift("; Assemble with Telemark TASM: tasm -80 -b -fFF source.asm output.rom");
    if (!output.some((line) => /^\s*\.END(?:\s|$)/i.test(line))) output.push("    .END");
  }
  if (dialect === "gasm80") {
    output = output.map((line) => line
      .replace(/^\s*ex\s+af\s*,\s*af\s*(;.*)?$/i,
        (_, comment = "") => `    ex af,af'${comment ? ` ${comment}` : ""}`)
      .replace(/^(\s*)([A-Za-z_.$?][\w.$?]*)\s+((?:rb|rw)\b.*)$/i, "$1$2: $3"));
  }
  return `${output.join("\n").replace(/\n+$/, "")}\n`;
}
import { evaluateExpression } from "./expression.mjs";

