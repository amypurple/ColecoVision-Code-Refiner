import { evaluateExpression } from "./expression.mjs";
import { ROUTINE_ABI } from "../vendor/studio-core/compiler/routineAbi.js";
import { catalogCvbasicOs7Opportunities } from "./os7-catalog.mjs";
import { analyzeReachability } from "./reachability.mjs";
import { buildCvbasicFeatureProfile } from "./feature-profile.mjs";

const CONDITIONAL = /^\s*(if|ifdef|ifndef|else|endif)\b(?:\s+(.*?))?\s*(?:;.*)?$/i;
const EQUATE = /^\s*([A-Za-z_.$?][\w.$?]*)\s*:\s*\.?equ\s+([^;]+)|^\s*([A-Za-z_.$?][\w.$?]*)\s+\.?equ\s+([^;]+)/i;
const LABEL = /^\s*([A-Za-z_.$?][\w.$?]*)\s*:/;
const CONTROL = /^\s*(call|jp|jr|djnz)\s+(.+?)(?:\s*;.*)?$/i;
const DIRECT_VDP = /^\s*(in|out)\s*[\s(].*(?:\$be|\$bf|00beh?|00bfh?|data_port|ctrl_port)/i;
const INTERRUPT_CONTROL = /^\s*(di|ei|im\s+[012])\b/i;
const BLOCK_IO = /^\s*(inir|indr|otir|otdr)\b/i;
const TIMING_LOOP = /^\s*(djnz|halt)\b/i;
const OS7_CALLS = new Map([
  ["$07E8", "PX_TO_PTRN_POS"],
  ["$080B", "PUT_FRAME"],
  ["$0898", "GET_BKGRND"],
  ["$08C0", "CALC_OFFSET"],
  ["$1F61", "PLAY_SOUNDS"],
  ["$1F70", "ROTATE_90"],
  ["$1F76", "UPDATE_CONTROLLERS"],
  ["$1F7F", "LOAD_ASCII"],
  ["$1F82", "FILL_VRAM"],
  ["$1F85", "MODE_1"],
  ["$1F88", "UPDATE_SPINNER"],
  ["$1FB8", "INIT_TABLE"],
  ["$1FBB", "GET_VRAM"],
  ["$1FBE", "PUT_VRAM"],
  ["$1FC1", "INIT_SPR_ORDER"],
  ["$1FC4", "WR_SPR_NM_TBL"],
  ["$1FD6", "TURN_OFF_SOUND"],
  ["$1FD9", "WRITE_REGISTER"],
  ["$1FDC", "READ_REGISTER"],
  ["$1FDF", "WRITE_VRAM"],
  ["$1FE2", "READ_VRAM"],
  ["$1FEE", "SET_SOUND_TABLE"],
  ["$1FF1", "PLAY_SOUND_SLOT"],
  ["$1FF4", "UPDATE_SOUND_ADDR"],
  ["$1FFD", "GET_RANDOM"]
]);

const OS7_SYMBOL_ALIASES = new Map([
  ["GET_VRAM", "READ_VRAM"],
  ["PUT_VRAM", "WRITE_VRAM"],
  ["MODE_1", "MODE_1"]
]);

function parseTarget(operand) {
  const parts = operand.split(",").map((part) => part.trim());
  return parts.at(-1)?.match(/^([A-Za-z_.$?][\w.$?]*|\$[0-9a-f]+|[0-9a-f]+h)$/i)?.[1] ?? null;
}

function normalizeAddress(target) {
  if (/^\$[0-9a-f]+$/i.test(target)) return `$${target.slice(1).toUpperCase().padStart(4, "0")}`;
  if (/^[0-9a-f]+h$/i.test(target)) return `$${target.slice(0, -1).toUpperCase().padStart(4, "0")}`;
  return null;
}

function contractFor(target) {
  const upper = target.toUpperCase();
  const address = normalizeAddress(upper);
  const service = address ? OS7_CALLS.get(address) : (OS7_SYMBOL_ALIASES.get(upper) ?? upper);
  const abi = ROUTINE_ABI[service];
  if (!abi) return null;
  return { service, address, ...abi };
}

function buildOs7Guide(lines, directVdpAccesses, os7Calls) {
  const source = lines.join("\n");
  const suggestions = [];
  if (directVdpAccesses.length && os7Calls.length === 0) {
    suggestions.push({
      priority: "high",
      code: "ESTABLISH_OS7_STARTUP",
      title: "Establish known OS7 machine state",
      reason: "The program drives the VDP directly but makes no recognized OS7 initialization call. Emulator startup state is not a real-hardware contract.",
      snippet: "call $1F85 ; MODE_1\ncall $1FD6 ; TURN_OFF_SOUND\nld hl,0\nld de,$4000\nxor a\ncall $1F82 ; FILL_VRAM"
    });
  }
  if (/^\s*\.?(?:dw|word)\s+(?:\$?0+)(?:\s*;[^\n]*)?$/gim.test(source)) {
    suggestions.push({
      priority: "high",
      code: "REVIEW_CARTRIDGE_HEADER_POINTERS",
      title: "Replace placeholder cartridge-header pointers",
      reason: "Zero sprite/controller pointers prevent several OS7 services from having valid working tables. Allocate only the services the program actually uses.",
      snippet: ".dw SpriteAttributes ; header +2 when OS7 sprite output is used\n.dw SpriteOrder      ; header +4 when INIT_SPR_ORDER is used\n.dw 0                ; workspace only when required\n.dw ControllerState  ; header +8 when OS7 controller state is used"
    });
  }
  if (/\bld\s+c\s*,\s*(?:ctrl_port|\$00?bf|00?bfh)\b[\s\S]{0,180}\botir\b/i.test(source)) {
    suggestions.push({
      priority: "medium",
      code: "VDP_REGISTER_STREAM",
      title: "Review direct VDP register stream",
      reason: "OTIR to the control port is compact, but bypasses OS7 VDP shadows. WRITE_REGISTER is clearer and keeps R0/R1 shadows coherent; retain the stream only when its size/speed advantage is deliberate.",
      snippet: "ld b,registerNumber\nld c,registerValue\ncall $1FD9 ; WRITE_REGISTER"
    });
  }
  if (/\bld\s+c\s*,\s*(?:data_port|\$00?be|00?beh)\b[\s\S]{0,80}\botir\b/i.test(source)) {
    suggestions.push({
      priority: "medium",
      code: "DIRECT_VRAM_TRANSFER",
      title: "Name or wrap direct VRAM transfers",
      reason: "Direct OTIR is valid and often smaller for a byte-sized transfer, but WRITE_VRAM documents RAM source, VRAM destination and count. Use Amy's count-fix wrapper when C may be nonzero.",
      snippet: "ld hl,source\nld de,vramDestination\nld bc,byteCount\ncall $1FDF ; raw WRITE_VRAM only when count semantics are proven\n; or call AMY_COPY_BYTES_TO_VRAM"
    });
  }
  if (/^\s*\.?(?:dw|word)\s+(?:start|main|entry)[^\n]*$/im.test(source) && !/^\s*\.?(?:dw|word)\s+0\s*,\s*0/im.test(source)) {
    suggestions.push({
      priority: "low",
      code: "RESERVED_HEADER_WORDS",
      title: "Review complete cartridge header",
      reason: "The compact header ends at the entry point. Add the reserved words when compatibility with conventional OS7 cartridge layouts matters.",
      snippet: ".dw 0,0 ; reserved cartridge-header words"
    });
  }
  return suggestions;
}

export function analyzeAssembly(lines, symbols, removedLineCount, unresolvedConditions, structuralWarnings) {
  const labels = new Map();
  const cvbasicOs7Opportunities = catalogCvbasicOs7Opportunities(lines.join("\n"));
  const reachability = analyzeReachability(lines.join("\n"));
  const featureProfile = buildCvbasicFeatureProfile(reachability, lines.join("\n"));
  const references = [];
  const directVdpAccesses = [];
  const interruptControls = [];
  const blockIoOperations = [];
  const timingSensitiveOperations = [];
  lines.forEach((line, index) => {
    const label = line.match(EQUATE) ? null : line.match(LABEL)?.[1];
    if (label) labels.set(label, index + 1);
    if (DIRECT_VDP.test(line)) directVdpAccesses.push({ line: index + 1, source: line.trim() });
    if (INTERRUPT_CONTROL.test(line)) interruptControls.push({ line: index + 1, source: line.trim() });
    if (BLOCK_IO.test(line)) blockIoOperations.push({ line: index + 1, source: line.trim() });
    if (TIMING_LOOP.test(line)) timingSensitiveOperations.push({ line: index + 1, source: line.trim() });
    const control = line.match(CONTROL);
    if (!control) return;
    const target = parseTarget(control[2]);
    if (target) references.push({ line: index + 1, opcode: control[1].toUpperCase(), target });
  });
  const calls = references.filter((entry) => entry.opcode === "CALL");
  const branches = references.filter((entry) => entry.opcode !== "CALL");
  const routineContracts = calls.map((entry) => ({ ...entry, contract: contractFor(entry.target) })).filter((entry) => entry.contract);
  const os7Calls = routineContracts.filter((entry) => entry.contract.kind === "bios").map((entry) => ({ ...entry, service: entry.contract.service }));
  const knownExternalTargets = new Set(routineContracts.map((entry) => entry.target.toUpperCase()));
  const unresolvedReferences = references.filter((entry) => !labels.has(entry.target) && !knownExternalTargets.has(entry.target.toUpperCase()));
  const safetyFindings = [];
  for (const entry of routineContracts) {
    if (["WRITE_VRAM", "READ_VRAM"].includes(entry.contract.service)) {
      safetyFindings.push({
        severity: "caution",
        code: "RAW_OS7_VRAM_COUNT_SEMANTICS",
        line: entry.line,
        target: entry.target,
        message: `${entry.contract.service} is the raw OS7 entry; counts with C != 0 require the Amy count-fix wrapper unless the count is proven byte-sized`
      });
    }
  }
  if (directVdpAccesses.length && os7Calls.length === 0) {
    safetyFindings.push({
      severity: "caution",
      code: "DIRECT_VDP_WITHOUT_OS7_INIT",
      message: "direct VDP I/O is used without a recognized OS7 initialization call; verify cold boot, interrupt, stack, RAM, and real-hardware behavior"
    });
  }
  if (timingSensitiveOperations.length) {
    safetyFindings.push({
      severity: "information",
      code: "TIMING_SENSITIVE_CODE",
      message: "HALT or DJNZ timing is present; cycle-changing rewrites require runtime and timing validation"
    });
  }
  const os7Guide = buildOs7Guide(lines, directVdpAccesses, os7Calls);
  return {
    format: "cvbasic-asm-refiner-report-v2",
    target: "colecovision",
    lineCount: lines.length,
    removedConditionalLines: removedLineCount,
    symbols: Object.fromEntries([...symbols].sort(([a], [b]) => a.localeCompare(b))),
    labels: [...labels].map(([name, line]) => ({ name, line })),
    calls,
    os7Calls,
    routineContracts,
    os7Guide,
    cvbasicOs7Opportunities,
    reachability,
    featureProfile,
    branches,
    directVdpAccesses,
    interruptControls,
    blockIoOperations,
    timingSensitiveOperations,
    optimizationPolicy: {
      defaultLevel: "fidelity-only",
      eligibleForUnverifiedRewrite: false,
      requiresRuntimeValidation: directVdpAccesses.length > 0 || interruptControls.length > 0 || timingSensitiveOperations.length > 0
    },
    safetyFindings,
    unresolvedReferences,
    unresolvedConditions,
    structuralWarnings
  };
}

export function refineAssembly(source, options = {}) {
  const inputLines = String(source).replace(/\r\n?/g, "\n").split("\n");
  let existingBanner = null;
  if (/^; (?:CVBasic ASM Refiner|ColecoVision Code Refiner): ColecoVision specialization; .*instruction order preserved\.$/.test(inputLines[0] || "")) {
    existingBanner = inputLines.shift();
    if (inputLines[0] === "") inputLines.shift();
  }
  const symbols = new Map();
  for (const [name, value] of Object.entries(options.defines ?? {})) {
    symbols.set(name.toUpperCase(), Number(value));
  }
  // CVBasic's shared Z80 prologue tests KONAMI even for targets where the
  // compiler does not emit an EQU. GASM80 treats that absent feature flag as
  // zero; model the known dialect behavior explicitly rather than treating
  // every misspelled symbol as zero.
  if (!symbols.has("KONAMI")) symbols.set("KONAMI", 0);

  const output = [];
  const stack = [];
  const unresolvedConditions = [];
  const structuralWarnings = [];
  let active = true;
  let removedLineCount = 0;

  for (let index = 0; index < inputLines.length; index += 1) {
    const line = inputLines[index];
    const conditional = line.match(CONDITIONAL);
    if (conditional) {
      const directive = conditional[1].toLowerCase();
      const expression = conditional[2]?.trim() ?? "";
      if (directive === "else") {
        if (!stack.length) throw new Error(`line ${index + 1}: ELSE without IF`);
        const frame = stack.at(-1);
        if (frame.sawElse) throw new Error(`line ${index + 1}: duplicate ELSE`);
        frame.sawElse = true;
        frame.branchActive = frame.parentActive && !frame.condition;
        active = frame.branchActive;
      } else if (directive === "endif") {
        if (!stack.length) {
          // GASM80 accepts this construct and current CVBasic output contains
          // it. Preserve compatibility, but make the malformed structure
          // visible in the report rather than silently normalizing it.
          structuralWarnings.push({ line: index + 1, directive: "ENDIF", message: "unmatched ENDIF ignored for GASM80 compatibility" });
          removedLineCount += 1;
          continue;
        }
        stack.pop();
        active = stack.length ? stack.at(-1).branchActive : true;
      } else {
        let condition;
        try {
          if (directive === "ifdef") condition = symbols.has(expression.toUpperCase());
          else if (directive === "ifndef") condition = !symbols.has(expression.toUpperCase());
          else condition = Boolean(evaluateExpression(expression, symbols));
        } catch (error) {
          unresolvedConditions.push({ line: index + 1, expression, message: error.message });
          throw new Error(`line ${index + 1}: cannot resolve IF '${expression}': ${error.message}`);
        }
        const parentActive = active;
        const frame = { parentActive, condition, branchActive: parentActive && condition, sawElse: false };
        stack.push(frame);
        active = frame.branchActive;
      }
      removedLineCount += 1;
      continue;
    }

    if (!active) {
      removedLineCount += 1;
      continue;
    }

    const equate = line.match(EQUATE);
    if (equate) {
      const name = (equate[1] ?? equate[3]).toUpperCase();
      const expression = equate[2] ?? equate[4];
      try {
        symbols.set(name, evaluateExpression(expression, symbols));
      } catch {
        // Address-bearing EQU expressions are valid assembly but are not needed
        // unless a later compile-time IF refers to them.
      }
    }
    output.push(line);
  }

  if (stack.length) throw new Error("unterminated IF block");

  const banner = [existingBanner ?? `; ColecoVision Code Refiner: ColecoVision specialization; ${removedLineCount} directives removed; instruction order preserved.`, ""];
  const lines = [...banner, ...output];
  return {
    text: `${lines.join("\n").replace(/\n+$/, "")}\n`,
    report: analyzeAssembly(lines, symbols, removedLineCount, unresolvedConditions, structuralWarnings)
  };
}
