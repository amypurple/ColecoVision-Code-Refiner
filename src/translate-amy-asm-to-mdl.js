import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function printUsage() {
  console.log(`Usage:
  node --experimental-default-type=module tools/translate-amy-asm-to-mdl.js --in <input.asm> --out <output.asm> [--target mdl|copt]

Notes:
  - This is a one-way translator for feeding Amy/TASM-style ASM into MDL.
  - The same translator is also used to prepare ASM for text-filter oracles such
    as z88dk copt before MDL assembles their output.
  - It is intentionally conservative and only rewrites syntax we have observed in
    generated Amy assembler.
  - Main current rewrite: $FFFF-style hex -> #FFFF outside comments and strings.`);
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--in":
        options.input = argv[++i];
        break;
      case "--out":
        options.output = argv[++i];
        break;
      case "--target":
        options.target = argv[++i];
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function splitComment(line) {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== "\\") {
      inString = !inString;
      continue;
    }
    if (ch === ";" && !inString) {
      return {
        code: line.slice(0, i),
        comment: line.slice(i)
      };
    }
  }
  return { code: line, comment: "" };
}

export function translateCodeSegment(code) {
  let out = code;

  // MDL does not need explicit CPU selection here, and some included music
  // sources emit a bare "cpu z80" directive that MDL treats poorly.
  if (/^\s*cpu\s+z80\s*$/i.test(out)) {
    return "";
  }

  // Normalize dotted TASM directives used by imported ColecoVision sources.
  out = out.replace(/^(\s*)\.(db|dw|dd|ds|org|end)\b/i, "$1$2");
  out = out.replace(/^(\s*)([A-Za-z_.$?][\w.$?]*)\s*:\s*\.equ\b/i, "$1$2 equ");
  out = out.replace(/^(\s*)([A-Za-z_.$?][\w.$?]*)\s+\.equ\b/i, "$1$2 equ");

  // Amy/TASM-style hex literals: $1234 -> #1234
  // Keep this conservative by only rewriting obvious numeric tokens.
  out = out.replace(/\$([0-9A-Fa-f]+)/g, (_match, digits) => `#${digits.replace(/^0+(?=[0-9A-Fa-f])/, "").toUpperCase()}`);

  // Normalize C-style hex bytes from imported asm/music assets.
  out = out.replace(/\b0x([0-9A-Fa-f]+)\b/g, (_match, digits) => `#${digits.replace(/^0+(?=[0-9A-Fa-f])/, "").toUpperCase()}`);

  // GASM80's TIMES count DB fill is MDL's DS count,fill.
  out = out.replace(/^(\s*)times\s+(.+?)\s+db\s+([^,\s]+)\s*$/i, "$1ds $2,$3");

  return out;
}

function simpleValue(expression, constants) {
  const value = String(expression || "").trim();
  if (/^\$[0-9A-F]+$/i.test(value)) return Number.parseInt(value.slice(1), 16);
  if (/^\d+$/.test(value)) return Number(value);
  return constants.get(value.toUpperCase()) ?? null;
}

export function normalizeMdlVirtualReservations(text) {
  const lines = String(text).split(/\r?\n/);
  const output = [];
  const constants = new Map();
  let section = null;

  for (const line of lines) {
    const { code } = splitComment(line);
    const equate = code.match(/^\s*([A-Za-z_?$][\w.$?]*)\s*:?[ \t]+\.?equ\s+([^;]+)$/i);
    if (equate) {
      const value = simpleValue(equate[2], constants);
      if (value !== null) constants.set(equate[1].toUpperCase(), value);
    }
    const org = code.match(/^\s*\.?org\s+(.+?)\s*$/i);
    if (org) {
      const address = simpleValue(org[1], constants);
      section = address === null ? null : { address, orgIndex: output.length, labels: [], virtual: false };
      output.push(line);
      continue;
    }
    const labeledReserve = code.match(/^\s*([A-Za-z_?$][\w.$?]*)\s*:?[ \t]+(rb|rw)\s+(.+?)\s*$/i);
    if (section && labeledReserve) {
      const count = simpleValue(labeledReserve[3], constants);
      if (count === null) throw new Error(`cannot resolve virtual reservation: ${line.trim()}`);
      if (!section.virtual) {
        section.virtual = true;
        output[section.orgIndex] = "";
        for (const entry of section.labels) {
          output[entry.index] = `${entry.name} EQU $${entry.address.toString(16).toUpperCase()}`;
        }
      }
      output.push(`${labeledReserve[1]} EQU $${section.address.toString(16).toUpperCase()}`);
      section.address += count * (labeledReserve[2].toLowerCase() === "rw" ? 2 : 1);
      continue;
    }
    const label = code.match(/^\s*([A-Za-z_?$][\w.$?]*)\s*:\s*$/);
    if (section && label) {
      if (section.virtual) output.push(`${label[1]} EQU $${section.address.toString(16).toUpperCase()}`);
      else {
        section.labels.push({ index: output.length, name: label[1], address: section.address });
        output.push(line);
      }
      continue;
    }
    const reserve = code.match(/^\s*(rb|rw)\s+(.+?)\s*$/i);
    if (section && reserve) {
      const count = simpleValue(reserve[2], constants);
      if (count === null) throw new Error(`cannot resolve virtual reservation: ${line.trim()}`);
      if (!section.virtual) {
        section.virtual = true;
        output[section.orgIndex] = "";
        for (const entry of section.labels) {
          output[entry.index] = `${entry.name} EQU $${entry.address.toString(16).toUpperCase()}`;
        }
      }
      section.address += count * (reserve[1].toLowerCase() === "rw" ? 2 : 1);
      output.push("");
      continue;
    }
    if (section && code.trim() && !/^\s*;/.test(line)) section = null;
    output.push(line);
  }
  return output.join("\n");
}

async function resolveIncbinPath(specifier, inputPath, { projectRoot = null } = {}) {
  const candidate = String(specifier || "").trim();
  if (!candidate) return null;
  if (projectRoot && candidate.replace(/\\/g, "/").startsWith("@project/")) {
    return path.resolve(projectRoot, candidate.replace(/\\/g, "/").slice("@project/".length));
  }
  if (path.isAbsolute(candidate)) return candidate;
  const nearInput = path.resolve(path.dirname(inputPath), candidate);
  try {
    await fs.access(nearInput);
    return nearInput;
  } catch {}
  const fromCwd = path.resolve(candidate);
  try {
    await fs.access(fromCwd);
    return fromCwd;
  } catch {}
  return nearInput;
}

function formatDbLines(bytes, indent = "") {
  const lines = [];
  const chunkSize = 16;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.slice(offset, offset + chunkSize);
    const payload = Array.from(chunk, (byte) => `#${byte.toString(16).toUpperCase().padStart(2, "0")}`).join(",");
    lines.push(`${indent}db ${payload}`);
  }
  if (!lines.length) {
    lines.push(`${indent}db`);
  }
  return lines;
}

export async function translateAmyAsm(text, inputPath, { projectRoot = null, target = "mdl" } = {}) {
  if (!["mdl", "copt"].includes(target)) {
    throw new Error(`Unsupported translation target: ${target}`);
  }
  if (target === "mdl") text = normalizeMdlVirtualReservations(text);
  const translatedLines = [];
  let localScope = "ROOT";
  for (const line of text.split(/\r?\n/)) {
    let { code, comment } = splitComment(line);
    // Resolve quoted asset paths before MDL local-label normalization. Dots in
    // paths such as warrior.color.zx0 are filenames, not parent.local symbols.
    const incbinMatch = code.match(/^(\s*)incbin\s+"([^"]+)"\s*$/i);
    if (incbinMatch) {
      const indent = incbinMatch[1] || "";
      const assetPath = await resolveIncbinPath(incbinMatch[2], inputPath, { projectRoot });
      const assetBytes = await fs.readFile(assetPath);
      translatedLines.push(`${indent}; inlined from incbin "${incbinMatch[2]}"${comment ? ` ${comment.trim()}` : ""}`);
      translatedLines.push(...formatDbLines(assetBytes, indent));
      continue;
    }
    if (target === "mdl") {
      const globalLabel = code.match(/^\s*([A-Za-z_?$][\w.$?]*)\s*:/);
      if (globalLabel) localScope = globalLabel[1].replace(/[^A-Za-z0-9_?]/g, "_");
      const localName = (name) => `__CVR_${localScope}_${name}`;
      const localDefinition = code.match(/^(\s*)\.([A-Za-z0-9_?]+)\s*:/);
      if (localDefinition) {
        code = code.replace(/^(\s*)\.([A-Za-z0-9_?]+)\s*:/, (_all, indent, name) => `${indent}${localName(name)}:`);
      }
      if (!/^\s*\.(?:db|dw|dd|ds|org|equ|end)\b/i.test(code)) {
        code = code.replace(/\b([A-Za-z_?$][\w$?]*)\.([A-Za-z0-9_?]+)\b/g,
          (_all, parent, name) => `__CVR_${parent.replace(/[^A-Za-z0-9_?]/g, "_")}_${name}`);
        code = code.replace(/(^|[^A-Za-z0-9_?$])\.([A-Za-z0-9_?]+)\b/g,
          (_all, prefix, name) => `${prefix}${localName(name)}`);
      }
    }
    if (target === "mdl" && /^\s*\.?end\s*$/i.test(code)) {
      translatedLines.push("");
      continue;
    }
    // MDL's SDCC parser can treat a trailing semicolon comment as part of a
    // numeric CALL expression. The original source remains the provenance
    // artifact, so omit inline comments only from MDL's candidate input.
    translatedLines.push(`${translateCodeSegment(code)}${target === "mdl" ? "" : comment}`);
  }
  return translatedLines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.input || !options.output) {
    printUsage();
    process.exit(options.help ? 0 : 1);
  }

  const inputPath = path.resolve(options.input);
  const outputPath = path.resolve(options.output);
  const inputStem = path.basename(inputPath)
    .replace(/(?:\.expanded|\.builtin|\.mdl-input)?\.(asm|z80|s)$/i, "")
    .replace(/\.builtin$/i, "");
  const candidateProjectRoot = path.resolve(path.dirname(inputPath), "..", "project-files", inputStem);
  const projectRoot = await fs.access(candidateProjectRoot).then(() => candidateProjectRoot).catch(() => null);
  const text = await fs.readFile(inputPath, "utf8");
  const translated = await translateAmyAsm(text, inputPath, { projectRoot, target: options.target || "mdl" });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, translated, "utf8");

  console.log(`Translated ${inputPath} -> ${outputPath}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(String(error?.stack || error));
    process.exit(1);
  });
}
