import { createHash } from "node:crypto";
import { assembleAmysCVAssembly } from "../vendor/amyscvassembly/compilerCore.js";
import { refineAssembly } from "./refiner.mjs";
import { proveRuntimeParity } from "./runtime-proof.mjs";
import { buildMdlCandidate } from "./mdl-candidate.mjs";
import { annotateOptimizedAssembly } from "./humanize.mjs";
import { adaptAssemblyToOs7 } from "./os7-adapter.mjs";
import { renderAssemblyDialect } from "./dialect-output.mjs";
import { pruneUnreachableCvbasicRuntime } from "./reachability.mjs";
import { synthesizePureCvProgram } from "./micro-runtime.mjs";
import { getOptimizationProfile } from "../vendor/studio-core/optimization.js";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function occupiedBytes(assembly) {
  const symbols = assembly?.result?.symbols ?? {};
  const romEndEntry = Object.entries(symbols).find(([name]) => name.toUpperCase() === "ROM_END");
  const romEnd = Number(romEndEntry?.[1]);
  if (Number.isFinite(romEnd) && romEnd >= 0x8000 && romEnd <= 0x10000) return romEnd - 0x8000;
  return assembly.bytes.length;
}

function describe(assembly) {
  return { bytes: occupiedBytes(assembly), fileBytes: assembly.bytes.length, sha256: sha256(assembly.bytes) };
}

function compareBytes(actual, expected, limit = 16) {
  const differences = [];
  const length = Math.max(actual.length, expected.length);
  for (let offset = 0; offset < length && differences.length < limit; offset += 1) {
    const actualByte = offset < actual.length ? actual[offset] : null;
    const expectedByte = offset < expected.length ? expected[offset] : null;
    if (actualByte !== expectedByte) differences.push({ offset, actual: actualByte, expected: expectedByte });
  }
  return {
    identical: actual.length === expected.length && differences.length === 0,
    lengthDifference: actual.length - expected.length,
    firstDifferences: differences
  };
}

async function assemble(files, dialect, optimization = "off") {
  const profile = typeof optimization === "string"
    ? getOptimizationProfile(optimization, files?.["main.asm"] || "")
    : optimization;
  const result = await assembleAmysCVAssembly(files, "main.asm", {
    outputFilename: "candidate.rom",
    outputMode: "binary",
    targetPlatform: "raw",
    optimizerEnabled: Boolean(profile?.optimizerEnabled),
    optimizerConfig: profile?.optimizerConfig ?? null,
    gasm80Compatibility: dialect === "gasm80",
    tasmCompatibility: dialect === "tasm"
  });
  if (!result.ok) throw new Error(result.log || "assembly failed");
  return { bytes: Buffer.from(result.binary), result };
}

export async function proveAssembly(files, options = {}) {
  const dialect = options.dialect ?? "native";
  const outputDialect = options.outputDialect ?? dialect;
  if (!["native", "gasm80", "tasm"].includes(dialect)) throw new Error(`unsupported dialect: ${dialect}`);
  if (!["native", "gasm80", "tasm"].includes(outputDialect)) throw new Error(`unsupported output dialect: ${outputDialect}`);
  if (!files?.["main.asm"]) throw new Error("proof requires a main.asm source");
  const optimization = options.optimize === false
    ? getOptimizationProfile("off", files["main.asm"])
    : options.optimization
      ? getOptimizationProfile(options.optimization, files["main.asm"])
      : {
          requestedLevel: "legacy",
          effectiveLevel: "legacy",
          optimizerEnabled: true,
          optimizerConfig: undefined,
          note: "legacy optimizer defaults"
        };

  const refined = refineAssembly(files["main.asm"], { defines: options.defines });
  const refinedFiles = { ...files, "main.asm": refined.text };
  const baseline = await assemble(files, dialect, "off");
  const specialized = await assemble(refinedFiles, dialect, "off");
  const fidelity = compareBytes(specialized.bytes, baseline.bytes);
  const reference = options.referenceBytes ? compareBytes(baseline.bytes, Buffer.from(options.referenceBytes)) : null;

  let optimized = null;
  if (optimization.optimizerEnabled && fidelity.identical && (!reference || reference.identical)) {
    const candidate = await assemble(refinedFiles, dialect, optimization);
    const humanized = annotateOptimizedAssembly(refined.text, candidate.result.optimizedAsm || "");
    const rendered = renderAssemblyDialect(humanized.text, outputDialect);
    const humanizedCandidate = await assemble({ ...refinedFiles, "main.asm": rendered }, outputDialect, "off");
    const humanizedFidelity = compareBytes(humanizedCandidate.bytes, candidate.bytes);
    if (!humanizedFidelity.identical) throw new Error("human-readable annotations changed optimized machine code");
    optimized = {
      ...describe(candidate),
      savedVsBaseline: occupiedBytes(baseline) - occupiedBytes(candidate),
      status: "AWAITING_RUNTIME",
      binary: candidate.bytes,
      optimizedAsm: candidate.result.optimizedAsm || "",
      humanizedAsm: rendered,
      annotations: humanized.annotations,
      humanizedFidelity,
      optimizerStats: candidate.result.stats?.optimizer ?? null
    };
  }

  let runtime = null;
  if (optimized && options.runtime?.bios) {
    runtime = await proveRuntimeParity(baseline.bytes, optimized.binary, options.runtime);
    optimized.status = runtime.status === "PASS_RUNTIME_STATE"
      ? "PASS_RUNTIME_STATE"
      : runtime.status === "PASS_RUNTIME_OUTPUT_RAM_REVIEW"
        ? "AWAITING_RAM_REVIEW"
        : "REJECTED_RUNTIME";
  }

  let compact = null;
  let pruned = { text: refined.text, transformations: [] };
  for (let round = 1; round <= 8; round += 1) {
    const next = pruneUnreachableCvbasicRuntime(pruned.text);
    if (!next.transformations.length) break;
    pruned = {
      text: next.text,
      transformations: [...pruned.transformations, ...next.transformations.map(item => ({ ...item, round }))]
    };
  }
  if (pruned.transformations.length && fidelity.identical && (!reference || reference.identical)) {
    const compactFiles = { ...refinedFiles, "main.asm": pruned.text };
    const candidate = await assemble(compactFiles, dialect, optimization);
    if (occupiedBytes(candidate) < (optimized?.bytes ?? occupiedBytes(specialized))) {
      const humanized = annotateOptimizedAssembly(pruned.text, candidate.result.optimizedAsm || "");
      const rendered = renderAssemblyDialect(humanized.text, outputDialect);
      const renderedCandidate = await assemble({ ...compactFiles, "main.asm": rendered }, outputDialect, "off");
      const humanizedFidelity = compareBytes(renderedCandidate.bytes, candidate.bytes);
      if (!humanizedFidelity.identical) throw new Error("compact human-readable candidate changed machine code");
      let status = "AWAITING_RUNTIME";
      let compactRuntime = null;
      if (options.runtime?.bios) {
        compactRuntime = await proveRuntimeParity(baseline.bytes, candidate.bytes, options.runtime);
        status = compactRuntime.status === "PASS_RUNTIME_STATE" ? "PASS_RUNTIME_STATE" : compactRuntime.status === "PASS_RUNTIME_OUTPUT_RAM_REVIEW" ? "AWAITING_RAM_REVIEW" : "REJECTED_RUNTIME";
      }
      compact = { ...describe(candidate), savedVsBaseline: occupiedBytes(baseline) - occupiedBytes(candidate), status, runtime: compactRuntime, transformations: pruned.transformations, asm: rendered, binary: candidate.bytes, humanizedFidelity };
    }
  }

  const compactBaseText = pruned.transformations.length ? pruned.text : refined.text;
  const adaptation = adaptAssemblyToOs7(compactBaseText);
  let os7 = null;
  let os7Assessment = adaptation.opportunities.length ? {
    status: "NO_SAFE_BENEFICIAL_REWRITE",
    opportunities: adaptation.opportunities,
    transformations: []
  } : null;
  if (adaptation.transformations.length && fidelity.identical && (!reference || reference.identical)) {
    const adaptedFiles = { ...refinedFiles, "main.asm": adaptation.text };
    const candidate = await assemble(adaptedFiles, dialect, optimization);
    const candidateOccupied = occupiedBytes(candidate);
    const bestNonOs7Bytes = compact?.bytes ?? optimized?.bytes ?? occupiedBytes(specialized);
    os7Assessment = {
      status: candidateOccupied < bestNonOs7Bytes ? "BENEFICIAL" : "SKIPPED_NO_SIZE_GAIN",
      bytes: candidateOccupied,
      bestNonOs7Bytes,
      savedVsBestNonOs7: bestNonOs7Bytes - candidateOccupied,
      transformations: adaptation.transformations,
      opportunities: adaptation.opportunities
    };
    if (candidateOccupied < bestNonOs7Bytes) {
      const humanized = annotateOptimizedAssembly(adaptation.text, candidate.result.optimizedAsm || "");
      const rendered = renderAssemblyDialect(humanized.text, outputDialect);
      const humanizedCandidate = await assemble({ ...adaptedFiles, "main.asm": rendered }, outputDialect, "off");
      const humanizedFidelity = compareBytes(humanizedCandidate.bytes, candidate.bytes);
      if (!humanizedFidelity.identical) throw new Error("OS7 human-readable candidate changed optimized machine code");
      let status = "AWAITING_RUNTIME";
      let os7Runtime = null;
      if (options.runtime?.bios) {
        os7Runtime = await proveRuntimeParity(baseline.bytes, candidate.bytes, options.runtime);
        status = os7Runtime.status === "PASS_RUNTIME_STATE" ? "PASS_RUNTIME_STATE" : os7Runtime.status === "PASS_RUNTIME_OUTPUT_RAM_REVIEW" ? "AWAITING_RAM_REVIEW" : "REJECTED_RUNTIME";
      }
      os7 = {
        ...describe(candidate),
        savedVsBaseline: occupiedBytes(baseline) - candidateOccupied,
        status,
        runtime: os7Runtime,
        transformations: adaptation.transformations,
        asm: rendered,
        binary: candidate.bytes,
        humanizedFidelity
      };
    }
  }

  let mdl = null;
  if (options.mdl?.jar && fidelity.identical && (!reference || reference.identical)) {
    try {
      const candidate = await buildMdlCandidate(refinedFiles, options.mdl);
      let status = "AWAITING_RUNTIME";
      let mdlRuntime = null;
      if (options.runtime?.bios) {
        mdlRuntime = await proveRuntimeParity(baseline.bytes, candidate.bytes, options.runtime);
        status = mdlRuntime.status === "PASS_RUNTIME_STATE"
          ? "PASS_RUNTIME_STATE"
          : mdlRuntime.status === "PASS_RUNTIME_OUTPUT_RAM_REVIEW"
            ? "AWAITING_RAM_REVIEW"
            : "REJECTED_RUNTIME";
      }
      mdl = {
        bytes: candidate.savedBytes === null ? null : occupiedBytes(baseline) - candidate.savedBytes,
        fileBytes: candidate.bytes.length,
        sha256: sha256(candidate.bytes),
        savedVsBaseline: candidate.savedBytes,
        status,
        runtime: mdlRuntime,
        binary: candidate.bytes,
        asm: candidate.asm,
        log: candidate.log
      };
    } catch (error) {
      mdl = { status: "MDL_FAILED", error: error.message };
    }
  }

  let pureCv = null;
  const synthesis = synthesizePureCvProgram(refined.text);
  if (synthesis.matched && fidelity.identical && (!reference || reference.identical)) {
    const candidate = await assemble({ "main.asm": synthesis.text }, "native", "off");
    const bestExistingBytes = os7?.bytes ?? compact?.bytes ?? optimized?.bytes ?? occupiedBytes(specialized);
    let status = "AWAITING_RUNTIME";
    let pureRuntime = null;
    if (options.runtime?.bios) {
      pureRuntime = await proveRuntimeParity(baseline.bytes, candidate.bytes, {
        ...options.runtime,
        checkpoints: options.runtime.specializedCheckpoints ?? (synthesis.runtimeInputEvents?.length ? [60, 70, 80, 90, 100, 120] : [60, 120]),
        inputEvents: synthesis.runtimeInputEvents ?? options.runtime.inputEvents
      });
      const visibleEquivalent = pureRuntime.mismatches.every((entry) =>
        entry.baseline.framebuffer === entry.candidate.framebuffer &&
        JSON.stringify(entry.baseline.vdpRegisters) === JSON.stringify(entry.candidate.vdpRegisters));
      status = visibleEquivalent ? "PASS_SPECIALIZED_VISIBLE_STATE" : "REJECTED_RUNTIME";
    }
    if (occupiedBytes(candidate) < bestExistingBytes) {
      pureCv = {
        ...describe(candidate),
        savedVsBaseline: occupiedBytes(baseline) - occupiedBytes(candidate),
        savedVsBestExisting: bestExistingBytes - occupiedBytes(candidate),
        status,
        runtime: pureRuntime,
        transformations: synthesis.transformations,
        profile: synthesis.profile,
        asm: synthesis.text,
        binary: candidate.bytes
      };
    }
  }

  const proofPassed = fidelity.identical && (!reference || reference.identical);
  return {
    report: {
      format: "cvbasic-asm-refiner-proof-v1",
      status: proofPassed ? "PASS_FIDELITY" : "REJECTED",
      dialect,
      outputDialect,
      optimization: {
        requested: optimization.requestedLevel,
        effective: optimization.effectiveLevel,
        enabled: optimization.optimizerEnabled,
        note: optimization.note
      },
      baseline: describe(baseline),
      specialized: describe(specialized),
      fidelity,
      reference,
      optimized: optimized ? {
        bytes: optimized.bytes,
        fileBytes: optimized.fileBytes,
        sha256: optimized.sha256,
        savedVsBaseline: optimized.savedVsBaseline,
        status: optimized.status,
        optimizerStats: optimized.optimizerStats
        ,humanAnnotations: optimized.annotations,
        humanizedFidelity: optimized.humanizedFidelity
      } : null,
      runtime,
      compact: compact ? {
        bytes: compact.bytes, fileBytes: compact.fileBytes, sha256: compact.sha256,
        savedVsBaseline: compact.savedVsBaseline, status: compact.status,
        transformations: compact.transformations, runtime: compact.runtime,
        humanizedFidelity: compact.humanizedFidelity
      } : null,
      os7: os7 ? {
        bytes: os7.bytes,
        fileBytes: os7.fileBytes,
        sha256: os7.sha256,
        savedVsBaseline: os7.savedVsBaseline,
        status: os7.status,
        transformations: os7.transformations,
        runtime: os7.runtime,
        humanizedFidelity: os7.humanizedFidelity
      } : null,
      os7Assessment,
      mdl: mdl ? {
        bytes: mdl.bytes ?? null,
        fileBytes: mdl.fileBytes ?? null,
        sha256: mdl.sha256 ?? null,
        savedVsBaseline: mdl.savedVsBaseline ?? null,
        status: mdl.status,
        runtime: mdl.runtime ?? null,
        error: mdl.error ?? null
      } : null,
      pureCv: pureCv ? {
        bytes: pureCv.bytes,
        fileBytes: pureCv.fileBytes,
        sha256: pureCv.sha256,
        savedVsBaseline: pureCv.savedVsBaseline,
        savedVsBestExisting: pureCv.savedVsBestExisting,
        status: pureCv.status,
        transformations: pureCv.transformations,
        profile: pureCv.profile,
        runtime: pureCv.runtime
      } : synthesis.matched ? null : { status: "NOT_APPLICABLE", reason: synthesis.reason },
      analysis: refined.report
    },
    artifacts: {
      baselineRom: baseline.bytes,
      specializedRom: specialized.bytes,
      optimizedRom: optimized?.binary ?? null,
      optimizedAsm: optimized?.optimizedAsm ?? "",
      humanizedOptimizedAsm: optimized?.humanizedAsm ?? "",
      compactRom: compact?.binary ?? null,
      compactAsm: compact?.asm ?? "",
      os7Rom: os7?.binary ?? null,
      os7Asm: os7?.asm ?? "",
      mdlRom: mdl?.binary ?? null,
      mdlAsm: mdl?.asm ?? "",
      mdlLog: mdl?.log ?? "",
      pureCvRom: pureCv?.binary ?? null,
      pureCvAsm: pureCv?.asm ?? "",
      refinedAsm: renderAssemblyDialect(refined.text, outputDialect)
    }
  };
}
