import { assembleAmysCVAssembly } from "../vendor/amyscvassembly/compilerCore.js";
import { getOptimizationProfile } from "../vendor/studio-core/optimization.js";
import { refineAssembly } from "../src/refiner.mjs";
import { detectAssemblyDialect } from "../src/dialect.mjs";
import { renderAssemblyDialect } from "../src/dialect-output.mjs";
import { annotateOptimizedAssembly } from "../src/humanize.mjs";
import { compileCvbasicInBrowser } from "./cvbasic-browser.js?v=20261021-browser-compiler-2";

function occupiedBytes(result) {
  const romEnd = Number(Object.entries(result.symbols || {}).find(([name]) => name.toUpperCase() === "ROM_END")?.[1]);
  return Number.isFinite(romEnd) && romEnd >= 0x8000 && romEnd <= 0x10000
    ? romEnd - 0x8000
    : result.binary.length;
}

function sameBytes(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function base64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x4000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x4000));
  }
  return btoa(binary);
}

async function assemble(files, mainName, dialect, optimization = null) {
  const profile = optimization ? getOptimizationProfile(optimization, files[mainName]) : null;
  const result = await assembleAmysCVAssembly(files, mainName, {
    outputFilename: "refined.rom",
    outputMode: "binary",
    targetPlatform: "raw",
    optimizerEnabled: profile?.optimizerEnabled ?? false,
    optimizerConfig: profile?.optimizerConfig ?? null,
    gasm80Compatibility: dialect === "gasm80",
    tasmCompatibility: dialect === "tasm"
  });
  if (!result.ok) throw new Error(result.log || "assembly failed");
  return { ...result, bytes: Uint8Array.from(result.binary), profile };
}

export async function runStaticPipeline(input) {
  if (input.compression === "pletter-zx0") {
    throw new Error("Pletter to ZX0 proof currently requires the Node pipeline; use Preserve in standalone mode");
  }
  const requestedKind = input.sourceKind || "auto";
  const inferredBasic = /\.bas(?:\.txt)?$/i.test(input.main) || input.looksLikeCvbasic(input.files.find((file) => file.name === input.main)?.text || "");
  const isBasic = requestedKind === "cvbasic" || (requestedKind === "auto" && inferredBasic);
  const originalFiles = Object.fromEntries(input.files.map((file) => [file.name, file.text]));
  const source = originalFiles[input.main];
  const compiled = isBasic ? await compileCvbasicInBrowser(source) : { assembly: source, diagnostics: "" };
  const generatedName = isBasic ? "main.asm" : input.main;
  const baselineFiles = isBasic ? { "main.asm": compiled.assembly } : { ...originalFiles };
  const detection = detectAssemblyDialect(compiled.assembly, generatedName);
  const dialect = isBasic || input.dialect === "auto" ? detection.dialect : input.dialect;
  const outputDialect = input.outputDialect === "same" ? dialect : input.outputDialect;
  const refined = refineAssembly(compiled.assembly);
  const refinedFiles = { ...baselineFiles, [generatedName]: refined.text };
  const baseline = await assemble(baselineFiles, generatedName, dialect);
  const specialized = await assemble(refinedFiles, generatedName, dialect);
  if (!sameBytes(baseline.bytes, specialized.bytes)) throw new Error("fidelity specialization changed the ROM bytes");
  const optimized = await assemble(refinedFiles, generatedName, dialect, input.optimization);
  const optimizedNative = optimized.profile.optimizerEnabled && optimized.optimizedAsm ? optimized.optimizedAsm : refined.text;
  const humanized = annotateOptimizedAssembly(refined.text, optimizedNative);
  const rendered = renderAssemblyDialect(humanized.text, outputDialect);
  const renderedResult = await assemble({ "main.asm": rendered }, "main.asm", outputDialect);
  if (!sameBytes(optimized.bytes, renderedResult.bytes)) throw new Error(`${outputDialect} export changed the optimized ROM bytes`);
  const baselineSize = occupiedBytes(baseline);
  const optimizedSize = occupiedBytes(optimized);
  return {
    mainName: input.main,
    sourceKind: isBasic ? "cvbasic-bas" : "assembly",
    generatedAsm: isBasic ? compiled.assembly : null,
    tinySound: null,
    amyMusic: null,
    dialect,
    outputDialect,
    policy: { runtime: input.runtime, optimization: input.optimization, compression: "preserve" },
    compression: { policy: "preserve", changed: false, summary: "compression preserved" },
    detection,
    report: {
      baseline: { bytes: baselineSize, fileBytes: baseline.bytes.length },
      specialized: { bytes: occupiedBytes(specialized), fileBytes: specialized.bytes.length },
      optimized: { bytes: optimizedSize, fileBytes: optimized.bytes.length, savedVsBaseline: baselineSize - optimizedSize, humanAnnotations: humanized.annotations || [] },
      optimization: { requested: input.optimization, effective: optimized.profile.effectiveLevel },
      fidelity: { identical: true },
      compact: null,
      os7: null,
      os7Assessment: { status: "STANDALONE_ANALYSIS_ONLY", savedVsBestNonOs7: 0, opportunities: [], transformations: [] },
      pureCv: { status: "STANDALONE_ANALYSIS_ONLY", reason: "micro-runtime synthesis requires the complete proof service" },
      analysis: refined.report
    },
    refinedAsm: renderAssemblyDialect(refined.text, outputDialect),
    optimizedAsm: rendered,
    rawOptimizedAsm: optimizedNative,
    optimizedRom: base64(optimized.bytes),
    compactAsm: null,
    compactRom: null,
    os7Asm: null,
    os7Rom: null,
    pureCvAsm: null,
    pureCvRom: null,
    standalone: true,
    compilerDiagnostics: compiled.diagnostics
  };
}
