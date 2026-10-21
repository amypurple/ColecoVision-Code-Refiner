import { evaluateExpression } from "./expression.mjs";

const EQUATE = /^\s*([A-Za-z_.$?][\w.$?]*)\s*:?[ \t]+\.?equ\s+([^;]+)/i;
const SIGNIFICANT = (line) => !/^\s*(?:;.*)?$/.test(line);

function symbolsFrom(source) {
  const symbols = new Map();
  for (const line of String(source).split(/\r?\n/)) {
    const match = line.match(EQUATE);
    if (!match) continue;
    try { symbols.set(match[1].toUpperCase(), evaluateExpression(match[2], symbols)); } catch { /* forward expression */ }
  }
  return symbols;
}

function expression(line, pattern) {
  return line.match(pattern)?.[1]?.trim() ?? null;
}

function nextSignificant(lines, from) {
  let index = from;
  while (index < lines.length && !SIGNIFICANT(lines[index])) index += 1;
  return index;
}

function hex(value, width) {
  return `$${value.toString(16).toUpperCase().padStart(width, "0")}`;
}

function codeOnly(line) {
  return line.split(";", 1)[0].trim();
}

function labelName(line) {
  return codeOnly(line).match(/^([A-Za-z_.$?][\w.$?]*)\s*:\s*$/)?.[1] ?? null;
}

function instruction(line, pattern) {
  return codeOnly(line).match(pattern);
}

function collectSignificant(lines, start, count) {
  const indexes = [];
  let cursor = start;
  while (cursor < lines.length && indexes.length < count) {
    cursor = nextSignificant(lines, cursor);
    if (cursor >= lines.length) break;
    indexes.push(cursor++);
  }
  return indexes.length === count ? indexes : null;
}

function uniqueGeneratedPrefix(source) {
  let suffix = "";
  let index = 1;
  while (new RegExp(`\\b__REFINER_OS7_OBJECT${suffix}\\b`, "i").test(source)) suffix = `_${index++}`;
  return `__REFINER_OS7${suffix}`;
}

function findHeaderWorkspace(lines, symbols) {
  const orgIndex = lines.findIndex((line) => {
    const value = instruction(line, /^\.?org\s+(.+)$/i)?.[1];
    if (!value) return false;
    try { return evaluateExpression(value, symbols) === 0x8000; } catch { return false; }
  });
  if (orgIndex < 0) return null;
  const indexes = collectSignificant(lines, orgIndex + 1, 6);
  if (!indexes) return null;
  const values = indexes.map((index) => instruction(lines[index], /^\.?dw\s+([^,]+)$/i)?.[1] ?? null);
  if (values.some((value) => value === null)) return null;
  try {
    const signature = evaluateExpression(values[0], symbols) & 0xffff;
    const workspace = evaluateExpression(values[3], symbols) & 0xffff;
    if (![0x55aa, 0xaa55].includes(signature)) return null;
    return { index: indexes[3], value: workspace };
  } catch { return null; }
}

function findStaticPutobjRewrite(lines, symbols) {
  const source = lines.join("\n");
  const vdpShadowReady = /\bcall\s+(?:\$1f85|mode_1|amy_set_[a-z0-9_]*graphics[a-z0-9_]*)\b|\bld\s*\(\s*(?:\$73c3|vdp0shad|vdp_mode_word)\s*\)\s*,/i.test(source);
  const labels = new Map();
  lines.forEach((line, index) => {
    const name = labelName(line);
    if (name) labels.set(name.toUpperCase(), index);
  });

  for (const [routineUpper, routineLabelIndex] of labels) {
    const body = collectSignificant(lines, routineLabelIndex + 1, 8);
    if (!body) continue;
    const bodyLines = body.map((index) => lines[index]);
    if (!instruction(bodyLines[0], /^out\s*\(\s*(?:ctrl_port|\$00?bf|00?bfh)\s*\)\s*,\s*a$/i)) continue;
    const highExpr = instruction(bodyLines[1], /^ld\s+a\s*,\s*(.+)$/i)?.[1];
    const maskExpr = instruction(bodyLines[2], /^or\s+(.+)$/i)?.[1];
    if (!highExpr || !maskExpr || !instruction(bodyLines[3], /^out\s*\(\s*(?:ctrl_port|\$00?bf|00?bfh)\s*\)\s*,\s*a$/i)) continue;
    const widthExpr = instruction(bodyLines[4], /^ld\s+b\s*,\s*(.+)$/i)?.[1];
    const portExpr = instruction(bodyLines[5], /^ld\s+c\s*,\s*(.+)$/i)?.[1];
    if (!widthExpr || !portExpr || !instruction(bodyLines[6], /^otir$/i) || !instruction(bodyLines[7], /^ret$/i)) continue;

    let high;
    let width;
    let mask;
    let port;
    try {
      high = evaluateExpression(highExpr, symbols) & 0xff;
      width = evaluateExpression(widthExpr, symbols) & 0xff;
      mask = evaluateExpression(maskExpr, symbols) & 0xff;
      port = evaluateExpression(portExpr, symbols) & 0xff;
    } catch { continue; }
    if ((high & 0xc0) !== 0 || mask !== 0x40 || port !== 0xbe || width === 0 || width > 32) continue;

    const routineReference = new RegExp(`\\b(?:call|jp)\\s+${routineUpper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    const callIndexes = lines.map((line, index) => routineReference.test(codeOnly(line)) ? index : -1).filter((index) => index >= 0);
    if (callIndexes.length < 2 || callIndexes.length > 24) continue;

    const firstCall = callIndexes[0];
    const prelude = [];
    let cursor = firstCall - 1;
    while (cursor >= 0 && !SIGNIFICANT(lines[cursor])) cursor -= 1;
    const sourceLoadIndex = cursor;
    const sourceLabel = instruction(lines[sourceLoadIndex] ?? "", /^ld\s+hl\s*,\s*([A-Za-z_.$?][\w.$?]*)$/i)?.[1];
    cursor -= 1;
    while (cursor >= 0 && !SIGNIFICANT(lines[cursor])) cursor -= 1;
    const firstLowIndex = cursor;
    const firstLowExpr = instruction(lines[firstLowIndex] ?? "", /^ld\s+a\s*,\s*(.+)$/i)?.[1];
    if (!sourceLabel || !firstLowExpr) continue;
    prelude.push(firstLowIndex, sourceLoadIndex, firstCall);

    const lows = [];
    try { lows.push(evaluateExpression(firstLowExpr, symbols) & 0xff); } catch { continue; }
    let previous = firstCall;
    let validCalls = true;
    for (const callIndex of callIndexes.slice(1)) {
      cursor = callIndex - 1;
      while (cursor > previous && !SIGNIFICANT(lines[cursor])) cursor -= 1;
      const lowExpr = instruction(lines[cursor] ?? "", /^ld\s+a\s*,\s*(.+)$/i)?.[1];
      if (!lowExpr) { validCalls = false; break; }
      const significantBetween = lines.slice(previous + 1, callIndex).filter(SIGNIFICANT);
      if (significantBetween.length !== 1) { validCalls = false; break; }
      try { lows.push(evaluateExpression(lowExpr, symbols) & 0xff); } catch { validCalls = false; break; }
      prelude.push(cursor, callIndex);
      previous = callIndex;
    }
    if (!validCalls) continue;
    if (!lows.every((low, row) => low === ((lows[0] + row * 32) & 0xff))) continue;
    const startAddress = (high << 8) | lows[0];
    const nameOffset = startAddress - 0x1800;
    if (nameOffset < 0 || nameOffset >= 0x300 || nameOffset % 32 + width > 32) continue;

    const sourceLabelIndex = labels.get(sourceLabel.toUpperCase());
    if (sourceLabelIndex === undefined) continue;
    const sourceReferences = new RegExp(`\\b${sourceLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    const externalReferences = lines.filter((line, index) => index !== sourceLabelIndex && sourceReferences.test(codeOnly(line)));
    if (externalReferences.length !== 1) continue;

    const dataIndexes = [];
    const dataValues = [];
    cursor = sourceLabelIndex + 1;
    while (cursor < lines.length && dataValues.length < width * callIndexes.length) {
      if (!SIGNIFICANT(lines[cursor])) { cursor += 1; continue; }
      if (labelName(lines[cursor])) break;
      const data = instruction(lines[cursor], /^\.?db\s+(.+)$/i)?.[1];
      if (!data) break;
      const values = data.split(",").map((value) => value.trim()).filter(Boolean);
      try { dataValues.push(...values.map((value) => evaluateExpression(value, symbols) & 0xff)); } catch { break; }
      dataIndexes.push(cursor++);
    }
    if (dataValues.length !== width * callIndexes.length) continue;

    const workspace = findHeaderWorkspace(lines, symbols);
    if (!workspace) continue;
    const prefix = uniqueGeneratedPrefix(source);
    const x = (nameOffset % 32) * 8;
    const y = Math.floor(nameOffset / 32) * 8;
    return {
      prefix,
      routine: routineUpper,
      routineIndexes: [routineLabelIndex, ...body],
      callIndexes: prelude,
      callStart: firstLowIndex,
      callEnd: callIndexes.at(-1),
      sourceLabelIndex,
      width,
      height: callIndexes.length,
      x,
      y,
      address: startAddress,
      workspace,
      vdpShadowReady,
      generatedCall: [
        `  ld ix,${prefix}_OBJECT`,
        "  ld b,0",
        "  call $1FFA ; OS7 PUTOBJ, static type-0 no-save object"
      ],
      generatedRecords: [
        `${prefix}_OBJECT: dw ${prefix}_GRAPHICS,${prefix}_STATUS,$8000`,
        `${prefix}_GRAPHICS: db 0,0`,
        "  dw 0",
        "  db 0",
        `  dw ${prefix}_FRAME`,
        `${prefix}_STATUS: db 0`,
        `  dw ${x},${y}`,
        "  db 0",
        `${prefix}_FRAME: db ${width},${callIndexes.length}`
      ]
    };
  }
  return null;
}

function matchFixedVramWrite(lines, start, symbols) {
  // HL already names the RAM source. The following VDP control-port sequence
  // selects one fixed write address, then OTIR sends a proven byte-sized block.
  const firstIndex = nextSignificant(lines, start);
  const localSource = expression(lines[firstIndex] ?? "", /^\s*ld\s+hl\s*,\s*([^;]+)/i);
  const instructionCount = localSource ? 9 : 8;
  const indexes = [];
  let cursor = start;
  for (let count = 0; count < instructionCount; count += 1) {
    cursor = nextSignificant(lines, cursor);
    if (cursor >= lines.length) return null;
    indexes.push(cursor);
    cursor += 1;
  }
  const selected = indexes.map((index) => lines[index]);
  const offset = localSource ? 1 : 0;
  const source = localSource ?? "HL input";
  const lowExpr = expression(selected[offset], /^\s*ld\s+a\s*,\s*([^;]+)/i);
  if (!lowExpr || !/^\s*out\s*\(\s*(?:ctrl_port|\$00?bf|00?bfh)\s*\)\s*,\s*a\b/i.test(selected[offset + 1])) return null;
  const highExpr = expression(selected[offset + 2], /^\s*ld\s+a\s*,\s*([^;]+)/i);
  const writeMask = expression(selected[offset + 3], /^\s*or\s+([^;]+)/i);
  if (!highExpr || !writeMask || !/^\s*out\s*\(\s*(?:ctrl_port|\$00?bf|00?bfh)\s*\)\s*,\s*a\b/i.test(selected[offset + 4])) return null;
  const countExpr = expression(selected[offset + 5], /^\s*ld\s+b\s*,\s*([^;]+)/i);
  const portExpr = expression(selected[offset + 6], /^\s*ld\s+c\s*,\s*([^;]+)/i);
  if (!countExpr || !portExpr || !/^\s*otir\b/i.test(selected[offset + 7])) return null;
  try {
    const low = evaluateExpression(lowExpr, symbols) & 0xff;
    const rawHigh = evaluateExpression(highExpr, symbols) & 0xff;
    const high = rawHigh & 0x3f;
    const mask = evaluateExpression(writeMask, symbols) & 0xff;
    const count = evaluateExpression(countExpr, symbols) & 0xff;
    const port = evaluateExpression(portExpr, symbols) & 0xff;
    if ((rawHigh & 0xc0) !== 0 || mask !== 0x40 || port !== 0xbe || count === 0) return null;
    return { indexes, source, localSource: Boolean(localSource), address: (high << 8) | low, count, estimatedBytesSaved: 7 };
  } catch {
    return null;
  }
}

function matchFixedVramRead(lines, start, symbols) {
  // A complete TMS9918 read-address setup followed by INIR has the same
  // source/destination/count contract as OS7 READ_VRAM.
  const firstIndex = nextSignificant(lines, start);
  const localDestination = expression(lines[firstIndex] ?? "", /^\s*ld\s+hl\s*,\s*([^;]+)/i);
  const instructionCount = localDestination ? 8 : 7;
  const indexes = [];
  let cursor = start;
  for (let count = 0; count < instructionCount; count += 1) {
    cursor = nextSignificant(lines, cursor);
    if (cursor >= lines.length) return null;
    indexes.push(cursor);
    cursor += 1;
  }
  const selected = indexes.map((index) => lines[index]);
  const offset = localDestination ? 1 : 0;
  const destination = localDestination ?? "HL input";
  const lowExpr = expression(selected[offset], /^\s*ld\s+a\s*,\s*([^;]+)/i);
  if (!lowExpr || !/^\s*out\s*\(\s*(?:ctrl_port|\$00?bf|00?bfh)\s*\)\s*,\s*a\b/i.test(selected[offset + 1])) return null;
  const highExpr = expression(selected[offset + 2], /^\s*ld\s+a\s*,\s*([^;]+)/i);
  if (!highExpr || !/^\s*out\s*\(\s*(?:ctrl_port|\$00?bf|00?bfh)\s*\)\s*,\s*a\b/i.test(selected[offset + 3])) return null;
  const countExpr = expression(selected[offset + 4], /^\s*ld\s+b\s*,\s*([^;]+)/i);
  const portExpr = expression(selected[offset + 5], /^\s*ld\s+c\s*,\s*([^;]+)/i);
  if (!countExpr || !portExpr || !/^\s*inir\b/i.test(selected[offset + 6])) return null;
  try {
    const low = evaluateExpression(lowExpr, symbols) & 0xff;
    const rawHigh = evaluateExpression(highExpr, symbols) & 0xff;
    const high = rawHigh & 0x3f;
    const count = evaluateExpression(countExpr, symbols) & 0xff;
    const port = evaluateExpression(portExpr, symbols) & 0xff;
    if ((rawHigh & 0xc0) !== 0 || port !== 0xbe || count === 0) return null;
    return { indexes, destination, localDestination: Boolean(localDestination), address: (high << 8) | low, count, estimatedBytesSaved: 5 };
  } catch {
    return null;
  }
}

export function adaptAssemblyToOs7(source) {
  const text = String(source).replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const symbols = symbolsFrom(text);
  const putobjCandidate = findStaticPutobjRewrite(lines, symbols);
  const putobj = putobjCandidate?.vdpShadowReady ? putobjCandidate : null;
  const removed = new Set(putobj?.routineIndexes ?? []);
  const replacedCalls = new Set(putobj?.callIndexes ?? []);
  const output = [];
  const transformations = [];
  for (let index = 0; index < lines.length;) {
    if (putobj && index === putobj.callStart) {
      output.push(...putobj.generatedCall);
      transformations.push({
        kind: "STATIC_NAME_RECTANGLE_TO_PUTOBJ",
        sourceLine: putobj.callStart + 1,
        endLine: putobj.callEnd + 1,
        sourceRoutine: putobj.routine,
        destination: putobj.address,
        width: putobj.width,
        height: putobj.height,
        estimatedBytesSaved: 3,
        workBuffer: putobj.workspace.value || 0x7000,
        reservedRam: putobj.workspace.value ? null : "$7000-$7003",
        contract: "OS7 type-0 static object; ROM status; OLD_SCREEN bit 15 set (no save/restore); valid header work buffer required"
      });
      index += 1;
      continue;
    }
    if (removed.has(index) || replacedCalls.has(index)) {
      index += 1;
      continue;
    }
    if (putobj?.workspace.value === 0 && index === putobj.workspace.index) {
      const indent = lines[index].match(/^\s*/)[0];
      output.push(`${indent}dw $7000 ; OS7 PUTOBJ work buffer, reserves $7000-$7003`);
      index += 1;
      continue;
    }
    if (putobj && index === putobj.sourceLabelIndex) output.push(...putobj.generatedRecords);
    const write = matchFixedVramWrite(lines, index, symbols);
    const read = write ? null : matchFixedVramRead(lines, index, symbols);
    const match = write ?? read;
    if (!match || match.indexes[0] !== index) {
      output.push(lines[index]);
      index += 1;
      continue;
    }
    const indent = lines[index].match(/^\s*/)[0];
    if (write && match.localSource) output.push(`${indent}ld hl,${match.source}`);
    if (read && match.localDestination) output.push(`${indent}ld hl,${match.destination}`);
    output.push(`${indent}ld de,${hex(match.address, 4)} ; fixed VRAM ${write ? "destination" : "source"}`);
    output.push(`${indent}ld bc,${hex(match.count, 4)} ; ${match.count} bytes, proven byte-sized transfer`);
    output.push(`${indent}call ${write ? "$1FDF ; OS7 WRITE_VRAM" : "$1FE2 ; OS7 READ_VRAM"}`);
    transformations.push({
      kind: write ? "FIXED_VRAM_WRITE_TO_OS7" : "FIXED_VRAM_READ_TO_OS7",
      sourceLine: index + 1,
      endLine: match.indexes.at(-1) + 1,
      source: write ? match.source : match.address,
      destination: write ? match.address : match.destination,
      byteCount: match.count,
      estimatedBytesSaved: match.estimatedBytesSaved,
      contract: `${write ? "WRITE_VRAM" : "READ_VRAM"} byte-sized count; C may be nonzero because B is zero`
    });
    index = match.indexes.at(-1) + 1;
  }
  return {
    text: `${output.join("\n").replace(/\n+$/, "")}\n`,
    transformations,
    opportunities: putobjCandidate && !putobjCandidate.vdpShadowReady ? [{
      kind: "STATIC_NAME_RECTANGLE_TO_PUTOBJ",
      status: "BLOCKED_UNSYNCED_VDP_SHADOW",
      sourceLine: putobjCandidate.callStart + 1,
      sourceRoutine: putobjCandidate.routine,
      destination: putobjCandidate.address,
      width: putobjCandidate.width,
      height: putobjCandidate.height,
      localBytesSavedWhenOs7Ready: 3,
      reason: "PUTOBJ reads OS7 VDP shadows, but this source configures the VDP directly. Synchronizing VDP0_SHADOW would erase the local size gain, so direct SET_LINES is retained."
    }] : []
  };
}
