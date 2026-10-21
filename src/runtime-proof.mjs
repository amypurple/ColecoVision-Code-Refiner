import { createHash } from "node:crypto";
import {
  GearcolecoTestCore,
  GEARCOLECO_TEST_REGION
} from "../vendor/studio-core/gearcolecoTestCore.js";

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeInstruction(text) {
  return String(text || "").replace(/\$[0-9A-F]+/gi, "$ADDR").replace(/\b\d+\b/g, "N");
}

export function isRelocatedStackReturnOnly(ramDifferences, before, after) {
  return ramDifferences.length > 0 &&
    before.sp === after.sp &&
    normalizeInstruction(before.returnInstruction) === normalizeInstruction(after.returnInstruction) &&
    ramDifferences.every((entry) => entry.address >= before.sp && entry.address < before.sp + 2);
}

async function captureTrace(rom, bios, checkpoints, seed) {
  const core = await GearcolecoTestCore.create({ seed });
  try {
    core.loadBios(bios);
    core.loadRom(rom, { region: GEARCOLECO_TEST_REGION.NTSC });
    const trace = [];
    let frame = 0;
    for (const checkpoint of checkpoints) {
      while (frame < checkpoint) {
        core.runFrame();
        frame += 1;
      }
      const framebuffer = core.getFramebuffer();
      const ramBytes = core.readRam(0x7000, 0x0400);
      const sp = core.getSp();
      const stackBytes = core.readRam(sp, 2);
      const returnAddress = stackBytes.length === 2 ? stackBytes[0] | (stackBytes[1] << 8) : null;
      trace.push({ summary: {
        frame,
        framebuffer: hash(new Uint8Array(framebuffer.pixels.buffer)),
        vram: hash(core.readVram(0, 0x4000)),
        ram: hash(ramBytes),
        sp,
        returnAddress,
        returnInstruction: returnAddress === null ? null : core.disassemble(returnAddress).text,
        vdpRegisters: [...core.getVdpRegisters()]
      }, ramBytes });
    }
    return trace;
  } finally {
    core.destroy();
  }
}

async function captureTraceWithInputs(rom, bios, checkpoints, seed, inputEvents = []) {
  const events = new Map(inputEvents.map((event) => [event.frame, event.masks ?? [event.mask ?? 0, 0]]));
  const core = await GearcolecoTestCore.create({ seed });
  try {
    core.loadBios(bios);
    core.loadRom(rom, { region: GEARCOLECO_TEST_REGION.NTSC });
    const trace = [];
    let frame = 0;
    let masks = [0, 0];
    for (const checkpoint of checkpoints) {
      while (frame < checkpoint) {
        if (events.has(frame)) masks = events.get(frame);
        core.setControllerMask(0, masks[0] ?? 0);
        core.setControllerMask(1, masks[1] ?? 0);
        core.runFrame();
        frame += 1;
      }
      const framebuffer = core.getFramebuffer();
      const ramBytes = core.readRam(0x7000, 0x0400);
      const sp = core.getSp();
      const stackBytes = core.readRam(sp, 2);
      const returnAddress = stackBytes.length === 2 ? stackBytes[0] | (stackBytes[1] << 8) : null;
      trace.push({ summary: {
        frame, framebuffer: hash(new Uint8Array(framebuffer.pixels.buffer)), vram: hash(core.readVram(0, 0x4000)),
        ram: hash(ramBytes), sp, returnAddress,
        returnInstruction: returnAddress === null ? null : core.disassemble(returnAddress).text,
        vdpRegisters: [...core.getVdpRegisters()]
      }, ramBytes });
    }
    return trace;
  } finally { core.destroy(); }
}

export async function proveRuntimeParity(baselineRom, candidateRom, options) {
  const checkpoints = [...new Set(options.checkpoints ?? [1, 2, 10, 60, 120])]
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((a, b) => a - b);
  if (!checkpoints.length) throw new Error("runtime proof requires at least one positive frame checkpoint");
  const seed = options.seed ?? 0x43565246;
  const capture = options.inputEvents?.length ? captureTraceWithInputs : captureTrace;
  const baseline = await capture(baselineRom, options.bios, checkpoints, seed, options.inputEvents);
  const candidate = await capture(candidateRom, options.bios, checkpoints, seed, options.inputEvents);
  const mismatches = [];
  let outputMismatch = false;
  let ramMismatch = false;
  for (let index = 0; index < checkpoints.length; index += 1) {
    const before = baseline[index];
    const after = candidate[index];
    if (JSON.stringify(before.summary) !== JSON.stringify(after.summary)) {
      const ramDifferences = [];
      for (let offset = 0; offset < before.ramBytes.length && ramDifferences.length < 32; offset += 1) {
        if (before.ramBytes[offset] !== after.ramBytes[offset]) {
          ramDifferences.push({
            address: 0x7000 + offset,
            baseline: before.ramBytes[offset],
            candidate: after.ramBytes[offset]
          });
        }
      }
      const visibleStateChanged = before.summary.framebuffer !== after.summary.framebuffer ||
        before.summary.vram !== after.summary.vram ||
        JSON.stringify(before.summary.vdpRegisters) !== JSON.stringify(after.summary.vdpRegisters);
      outputMismatch ||= visibleStateChanged;
      const stackReturnOnly = isRelocatedStackReturnOnly(ramDifferences, before.summary, after.summary);
      ramMismatch ||= ramDifferences.length > 0 && !stackReturnOnly;
      mismatches.push({
        frame: checkpoints[index],
        visibleStateChanged,
        stackReturnOnly,
        baseline: before.summary,
        candidate: after.summary,
        ramDifferences
      });
    }
  }
  const status = outputMismatch
    ? "RUNTIME_OUTPUT_MISMATCH"
    : ramMismatch
      ? "PASS_RUNTIME_OUTPUT_RAM_REVIEW"
      : "PASS_RUNTIME_STATE";
  return {
    status,
    checkpoints,
    seed,
    inputEvents: options.inputEvents ?? [],
    compared: ["framebuffer", "vram", "ram:$7000-$73ff", "vdp-registers"],
    mismatches,
    baseline: baseline.map((entry) => entry.summary),
    candidate: candidate.map((entry) => entry.summary)
  };
}
