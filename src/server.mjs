#!/usr/bin/env node
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { refineAssembly } from "./refiner.mjs";
import { proveAssembly } from "./proof.mjs";
import { detectAssemblyDialect } from "./dialect.mjs";
import { convertCvbasicMusicToTinyAsm } from "./convert-cvbasic-music.mjs";
import { synthesizeCvbasicMusicMicroRuntime } from "./cvbasic-music-micro-runtime.mjs";
import { assembleAmysCVAssembly } from "../vendor/amyscvassembly/compilerCore.js";
import { renderAssemblyDialect } from "./dialect-output.mjs";
import { findBundledTelemarkTasm, validateWithTelemarkTasm } from "./telemark-tasm.mjs";
import { replacePletterWithZx0 } from "./pletter-zx0.mjs";
import { proveRuntimeParity } from "./runtime-proof.mjs";
import { getOptimizationProfile } from "../vendor/studio-core/optimization.js";

const root = resolve(import.meta.dirname, "../web");
const port = Number(process.env.PORT || 8091);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const biosPath = process.env.COLECOVISION_BIOS ? resolve(process.env.COLECOVISION_BIOS) : null;
const colecoBios = biosPath ? await readFile(biosPath).catch(() => null) : null;
const run = promisify(execFile);
const cvbasicDirectory = resolve(import.meta.dirname, "../third_party/cvbasic");
const cvbasicExecutable = process.env.CVBASIC_EXECUTABLE
  ? resolve(process.env.CVBASIC_EXECUTABLE)
  : join(cvbasicDirectory, process.platform === "win32" ? "cvbasic.exe" : "cvbasic_linux");
const telemarkTasmExecutable = process.env.TASM_EXECUTABLE
  ? resolve(process.env.TASM_EXECUTABLE)
  : await findBundledTelemarkTasm();
const zx0VramDecoder = await readFile(resolve(import.meta.dirname, "../vendor/compression/zx0_vram.asm"), "utf8");

function looksLikeCvbasicSource(source) {
  const tests = [
    /^\s*(?:MODE|SCREEN|CLS|PRINT|DEFINE|DIM|BITMAP|SPRITE|MUSIC|SOUND|PLAY)\b/im,
    /^\s*(?:IF\b.*\bTHEN|FOR\b.*\bTO|DO\s*$|LOOP\s*$|WHILE\b|GOTO\b)/im,
    /^\s*[A-Za-z_][\w$]*\s*:\s*(?:DATA|MUSIC)\b/im,
    /\bCONT\d?\.(?:UP|DOWN|LEFT|RIGHT|BUTTON\d*)\b/i,
    /\b(?:PRINT|PUT|VPOKE|VPEEK)\s+AT\b/i
  ];
  return tests.filter((pattern) => pattern.test(source)).length >= 2;
}

async function compileBasic(source) {
  const work = await mkdtemp(join(tmpdir(), "cvbasic-refiner-web-"));
  try {
    const basic = join(work, "program.bas");
    const assembly = join(work, "program.asm");
    await writeFile(basic, source);
    try {
      await run(cvbasicExecutable, [basic, assembly, cvbasicDirectory], { windowsHide: true });
    } catch (error) {
      if (error.code === "ENOENT") throw new Error(`CVBasic executable not found at ${cvbasicExecutable}. Build third_party/cvbasic or set CVBASIC_EXECUTABLE.`);
      const diagnostics = `${error.stdout || ""}${error.stderr || ""}`.trim();
      throw new Error(diagnostics || `CVBasic compilation failed: ${error.message}`);
    }
    return await readFile(assembly, "utf8");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw new Error("request exceeds 4 MiB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/api/health") {
      const exists = async (path) => {
        if (!path) return false;
        try { await access(path); return true; } catch { return false; }
      };
      return json(response, 200, {
        status: "ok",
        name: "ColecoVision Code Refiner",
        capabilities: {
          cvbasic: await exists(cvbasicExecutable),
          colecoVisionBios: Boolean(colecoBios),
          telemarkTasm: await exists(telemarkTasmExecutable)
        }
      });
    }
    if (request.method === "POST" && request.url === "/api/refine") {
      const input = await body(request);
      const files = Object.fromEntries((input.files ?? []).map((file) => [file.name, file.text]));
      const mainName = input.main || input.files?.[0]?.name;
      if (!mainName || !files[mainName]) throw new Error("select a main assembly file");
      const requestedSourceKind = ["auto", "cvbasic", "assembly"].includes(input.sourceKind) ? input.sourceKind : "auto";
      const inferredBasic = /\.bas(?:\.txt)?$/i.test(mainName) || (/\.txt$/i.test(mainName) && looksLikeCvbasicSource(files[mainName]));
      const isBasic = requestedSourceKind === "cvbasic" || (requestedSourceKind === "auto" && inferredBasic);
      const runtimePolicy = ["auto", "cvbasic", "amy-os7"].includes(input.runtime) ? input.runtime : "auto";
      const optimization = ["off", "balanced", "aggressive"].includes(input.optimization) ? input.optimization : "balanced";
      const optimizationProfile = getOptimizationProfile(optimization, files[mainName]);
      const compressionPolicy = input.compression === "pletter-zx0" ? "pletter-zx0" : "preserve";
      let tinySound = null;
      let amyMusic = null;
      if (isBasic && /\bMUSIC\b/i.test(files[mainName])) {
        try {
          const converted = convertCvbasicMusicToTinyAsm(files[mainName], {
            prefix: mainName.replace(/\.[^.]+$/, ""),
            skipUnsupportedBlocks: true
          });
          tinySound = {
            asm: converted.asm,
            blocks: converted.blocks,
            rejectedBlocks: converted.rejectedBlocks,
            soundTableLabel: converted.soundTableLabel,
            firstSongLabel: converted.firstSongLabel,
            status: converted.rejectedBlocks.length ? "PARTIAL_APPROXIMATE" : "APPROXIMATE",
            approximations: [
              "Notes are mapped to the nearest Tiny Sound period.",
              "Tempo rows are rescaled from CVBasic's 50 Hz convention to 60 Hz.",
              "Tone 1/2 use compact Tiny envelopes; Tone 3 and M1/M2/M3 use synchronized BIOS streams.",
              "Audible equivalence remains unproven until PSG-write traces are compared."
            ]
          };
        } catch (error) {
          tinySound = { asm: null, blocks: [], rejectedBlocks: [{ name: "input", reason: error.message }], status: "REJECTED", approximations: [] };
        }
        try {
          const synthesized = synthesizeCvbasicMusicMicroRuntime(files[mainName], { prefix: mainName.replace(/\.[^.]+$/, "") });
          const assembled = await assembleAmysCVAssembly({ "main.asm": synthesized.assembly }, "main.asm", {
            outputFilename: "music.amy-os7.rom",
            outputMode: "binary",
            targetPlatform: "raw",
            optimizerEnabled: optimizationProfile.optimizerEnabled,
            optimizerConfig: optimizationProfile.optimizerConfig
          });
          if (!assembled.ok) throw new Error(assembled.log || "Amy/OS7 music assembly failed");
          const optimizedAssembly = optimizationProfile.optimizerEnabled && assembled.optimizedAsm
            ? assembled.optimizedAsm
            : synthesized.assembly;
          const romEnd = Number(assembled.symbols?.ROM_END);
          amyMusic = {
            status: "ASSEMBLED_AWAITING_RUNTIME",
            asm: optimizedAssembly,
            rom: Buffer.from(assembled.binary).toString("base64"),
            bytes: Number.isFinite(romEnd) ? romEnd - 0x8000 : assembled.binary.length,
            report: { ...synthesized.report, optimization: optimizationProfile.effectiveLevel },
            nativeBinary: Buffer.from(assembled.binary)
          };
        } catch (error) {
          amyMusic = { status: "REJECTED", asm: null, rom: null, bytes: null, error: error.message };
        }
      }
      const originalMainSource = isBasic ? await compileBasic(files[mainName]) : files[mainName];
      let compression = { policy: compressionPolicy, changed: false, summary: "compression preserved", assets: [] };
      let mainSource = originalMainSource;
      if (compressionPolicy === "pletter-zx0") {
        if (!isBasic) throw new Error("Pletter to ZX0 currently requires CVBasic BAS so declared raw lengths can be verified");
        compression = { policy: compressionPolicy, ...(await replacePletterWithZx0(files[mainName], mainSource, zx0VramDecoder)) };
        mainSource = compression.source;
        delete compression.source;
      }
      const detection = detectAssemblyDialect(mainSource, mainName);
      const dialect = isBasic ? "gasm80" : input.dialect === "auto" || !input.dialect ? detection.dialect : input.dialect;
      if (input.prove === false) return json(response, 200, { refined: refineAssembly(mainSource), mainName, dialect, detection });
      files["main.asm"] = mainSource;
      if (mainName !== "main.asm") delete files[mainName];
      const outputDialect = input.outputDialect === "same" || !input.outputDialect ? dialect : input.outputDialect;
      if (compression.changed) {
        const assembleRaw = async (source) => {
          const result = await assembleAmysCVAssembly({ "main.asm": source }, "main.asm", {
            outputFilename: "codec-proof.rom",
            outputMode: "binary",
            targetPlatform: "raw",
            optimizerEnabled: false,
            gasm80Compatibility: dialect === "gasm80",
            tasmCompatibility: dialect === "tasm"
          });
          if (!result.ok) throw new Error(result.log || "codec proof assembly failed");
          return Buffer.from(result.binary);
        };
        const [originalRom, convertedRom] = await Promise.all([assembleRaw(originalMainSource), assembleRaw(mainSource)]);
        if (!colecoBios) {
          compression.status = "PASS_CODEC_ROUNDTRIP_AWAITING_RUNTIME";
          compression.summary += ", byte round-trip verified; set COLECOVISION_BIOS for emulator proof";
        } else {
          const runtime = await proveRuntimeParity(originalRom, convertedRom, { bios: colecoBios, checkpoints: [300] });
          const visibleEquivalent = runtime.mismatches.every((entry) =>
            entry.baseline.framebuffer === entry.candidate.framebuffer &&
            entry.baseline.vram === entry.candidate.vram &&
            JSON.stringify(entry.baseline.vdpRegisters) === JSON.stringify(entry.candidate.vdpRegisters));
          compression.runtime = runtime;
          compression.status = visibleEquivalent ? "PASS_VDP_STATE" : "REJECTED_RUNTIME";
          if (!visibleEquivalent) throw new Error("Pletter to ZX0 changed the rendered VDP state at the proof checkpoint");
          compression.summary += ", visible state verified";
        }
      }
      if (amyMusic?.nativeBinary) {
        const rendered = renderAssemblyDialect(amyMusic.asm, outputDialect);
        const renderedAssembly = await assembleAmysCVAssembly({ "main.asm": rendered }, "main.asm", {
          outputFilename: "music.amy-os7.rom",
          outputMode: "binary",
          targetPlatform: "raw",
          optimizerEnabled: false,
          gasm80Compatibility: outputDialect === "gasm80",
          tasmCompatibility: outputDialect === "tasm"
        });
        if (!renderedAssembly.ok) {
          amyMusic = { status: "REJECTED_DIALECT", asm: null, rom: null, bytes: null, error: renderedAssembly.log || `${outputDialect} assembly failed` };
        } else {
          const renderedBinary = Buffer.from(renderedAssembly.binary);
          const byteIdentical = renderedBinary.equals(amyMusic.nativeBinary);
          const telemark = byteIdentical && outputDialect === "tasm"
            ? await validateWithTelemarkTasm(rendered, renderedBinary, telemarkTasmExecutable)
            : null;
          const externallyValid = !telemark || telemark.byteIdentical;
          amyMusic = {
            ...amyMusic,
            status: byteIdentical && externallyValid
              ? (telemark ? "PASS_REAL_TASM_AWAITING_RUNTIME" : "PASS_DIALECT_BYTE_IDENTITY_AWAITING_RUNTIME")
              : (byteIdentical ? "REJECTED_REAL_TASM" : "REJECTED_DIALECT_FIDELITY"),
            asm: byteIdentical && externallyValid ? rendered : null,
            rom: byteIdentical && externallyValid ? renderedBinary.toString("base64") : null,
            outputDialect,
            byteIdentical,
            telemark,
            nativeBinary: undefined
          };
        }
      }
      const proof = await proveAssembly(files, {
        dialect,
        outputDialect,
        optimization,
        runtime: colecoBios ? { bios: colecoBios, checkpoints: [1, 2, 10, 60, 120] } : null
      });
      if (runtimePolicy === "cvbasic") {
        proof.report.pureCv = { status: "DISABLED_BY_POLICY", reason: "CVBasic wrapper selected" };
        proof.artifacts.pureCvAsm = "";
        proof.artifacts.pureCvRom = null;
        amyMusic = null;
      } else if (runtimePolicy === "amy-os7" && !proof.artifacts.pureCvRom && !amyMusic?.rom) {
        throw new Error("Amy/OS7 wrapper was requested, but this program does not match a proven complete micro-runtime profile");
      }
      return json(response, 200, {
        mainName,
        sourceKind: isBasic ? "cvbasic-bas" : "assembly",
        generatedAsm: isBasic ? mainSource : null,
        tinySound,
        amyMusic,
        dialect,
        outputDialect,
        policy: { runtime: runtimePolicy, optimization, compression: compressionPolicy },
        compression,
        detection,
        report: proof.report,
        refinedAsm: proof.artifacts.refinedAsm,
        optimizedAsm: proof.artifacts.humanizedOptimizedAsm || proof.artifacts.refinedAsm,
        rawOptimizedAsm: proof.artifacts.optimizedAsm,
        optimizedRom: (proof.artifacts.optimizedRom ?? proof.artifacts.specializedRom)?.toString("base64") ?? null,
        compactAsm: proof.artifacts.compactAsm,
        compactRom: proof.artifacts.compactRom?.toString("base64") ?? null,
        os7Asm: proof.artifacts.os7Asm,
        os7Rom: proof.artifacts.os7Rom?.toString("base64") ?? null,
        pureCvAsm: proof.artifacts.pureCvAsm,
        pureCvRom: proof.artifacts.pureCvRom?.toString("base64") ?? null
      });
    }
    if (request.method !== "GET") return json(response, 405, { error: "method not allowed" });
    const relative = request.url === "/" ? "index.html" : request.url.slice(1).split("?")[0];
    if (!/^[\w./-]+$/.test(relative) || relative.includes("..")) return json(response, 400, { error: "invalid path" });
    const contents = await readFile(resolve(root, relative));
    response.writeHead(200, {
      "content-type": types[extname(relative)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    response.end(contents);
  } catch (error) {
    if (request.url?.startsWith("/api/")) return json(response, 400, { error: error.message });
    response.writeHead(404);
    response.end("Not found");
  }
}).listen(port, process.env.HOST || "127.0.0.1", () => {
  console.log(`ColecoVision Code Refiner: http://${process.env.HOST || "127.0.0.1"}:${port}`);
});
