import { compressBytes, decompressBytes } from "../vendor/studio-core/compression.js";

function parseNumber(value) {
  const text = String(value).trim();
  if (/^\$[0-9a-f]+$/i.test(text)) return Number.parseInt(text.slice(1), 16);
  if (/^0x[0-9a-f]+$/i.test(text)) return Number.parseInt(text.slice(2), 16);
  if (/^\d+$/.test(text)) return Number.parseInt(text, 10);
  throw new Error(`Pletter to ZX0 needs a constant length, not ${value}`);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dbBytes(text) {
  const bytes = [];
  for (const match of text.matchAll(/^\s*DB\s+([^;\r\n]+)/gim)) {
    for (const token of match[1].split(",")) bytes.push(parseNumber(token));
  }
  return Uint8Array.from(bytes);
}

function renderDb(bytes) {
  const lines = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const values = [...bytes.slice(offset, offset + 16)].map((value) => `$${value.toString(16).padStart(2, "0")}`);
    lines.push(`\tDB ${values.join(",")}`);
  }
  return lines.join("\n");
}

export async function replacePletterWithZx0(basicSource, assemblySource, zx0Decoder) {
  const declarations = [...String(basicSource).matchAll(/^\s*DEFINE\s+VRAM\s+PLETTER\s+([^,]+),\s*([^,]+),\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/gim)];
  const unsupported = [...String(basicSource).matchAll(/^\s*DEFINE\s+(CHAR|COLOR|SPRITE)\s+PLETTER\b.*$/gim)];
  if (unsupported.length) {
    throw new Error("Pletter to ZX0 currently refuses CHAR/COLOR/SPRITE wrappers because they compute VRAM destinations inside CVBasic's Pletter ABI");
  }
  if (!declarations.length) return { source: assemblySource, changed: false, summary: "no DEFINE VRAM PLETTER assets", assets: [] };

  let source = String(assemblySource);
  const assets = [];
  for (const declaration of declarations) {
    const [, destinationText, lengthText, label] = declaration;
    const expectedLength = parseNumber(lengthText);
    const asmLabel = `cvb_${label.toUpperCase()}`;
    const callPattern = new RegExp(`(^\\s*;\\s*DEFINE\\s+VRAM\\s+PLETTER[^\\r\\n]*${escapeRegExp(label)}\\s*$[\\s\\S]{0,400}?^\\s*)CALL\\s+unpack\\b`, "mi");
    if (!callPattern.test(source)) throw new Error(`cannot prove the Pletter call site for ${label}`);
    source = source.replace(callPattern, `$1LD A,(mode)
PUSH AF
OR 1
LD (mode),A
CALL zx0_decompress
POP AF
LD (mode),A`);

    const blockPattern = new RegExp(`(^${escapeRegExp(asmLabel)}:\\s*\\r?\\n)([\\s\\S]*?)(?=^[A-Za-z_.$?@][A-Za-z0-9_.$?@]*:\\s*(?:;.*)?$)`, "mi");
    const block = source.match(blockPattern);
    if (!block) throw new Error(`cannot isolate Pletter data block ${asmLabel}`);
    const packed = dbBytes(block[2]);
    if (!packed.length) throw new Error(`Pletter data block ${asmLabel} contains no bytes`);
    const raw = await decompressBytes("pletter", packed);
    if (raw.length !== expectedLength) throw new Error(`${asmLabel} expands to ${raw.length} bytes; declaration requires ${expectedLength}`);
    const zx0 = await compressBytes("zx0", raw);
    const verified = await (await import("../vendor/studio-core/compression.js")).decompressBytes("zx0", zx0);
    if (verified.length !== raw.length || verified.some((value, index) => value !== raw[index])) throw new Error(`ZX0 round-trip failed for ${asmLabel}`);
    source = source.replace(blockPattern, (_match, heading) => `${heading}\t; Refiner: ${packed.length}-byte Pletter -> ${zx0.length}-byte ZX0 (${raw.length} raw bytes)\n${renderDb(zx0)}\n`);

    assets.push({ label, destination: parseNumber(destinationText), rawBytes: raw.length, pletterBytes: packed.length, zx0Bytes: zx0.length, savedPayloadBytes: packed.length - zx0.length });
  }

  if (!/^rom_end:/mi.test(source)) throw new Error("cannot place the ZX0 decoder before rom_end");
  if (!/^CVBASIC_COMPRESSION:\s*equ\s+1\s*$/mi.test(source)) throw new Error("cannot disable the now-unused CVBasic Pletter runtime");
  source = source.replace(/^CVBASIC_COMPRESSION:\s*equ\s+1\s*$/mi, "CVBASIC_COMPRESSION:\tequ 0\t; Refiner: all Pletter calls replaced by ZX0");
  source = source.replace(/^rom_end:/mi, `${zx0Decoder.trim()}\n\nrom_end:`);
  return {
    source,
    changed: true,
    assets,
    summary: `${assets.length} Pletter asset${assets.length === 1 ? "" : "s"} converted to ZX0 (${assets.reduce((sum, item) => sum + item.savedPayloadBytes, 0)} payload bytes saved before decoder replacement)`
  };
}
