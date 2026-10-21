#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { refineAssembly } from "./refiner.mjs";
import { proveAssembly } from "./proof.mjs";
import { renderAssemblyDialect } from "./dialect-output.mjs";

function usage() {
  console.error("Usage:");
  console.error("  node src/cli.mjs refine input.asm output.asm [--output-dialect native|gasm80|tasm] [--report report.json] [-DNAME=value]");
  console.error("  node src/cli.mjs compile input.bas output.asm --cvbasic cvbasic.exe --library dir [--output-dialect native|gasm80|tasm] [--raw raw.asm] [--report report.json]");
  console.error("  node src/cli.mjs prove input.asm output-dir [--dialect native|gasm80|tasm] [--output-dialect same|native|gasm80|tasm] [--reference expected.rom] [--bios colecovision.rom] [--frames 1,2,10,60,120] [--mdl-jar mdl.jar] [--no-opt]");
}

function parseArguments(argv) {
  const positional = [];
  const options = { defines: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith("-D")) {
      const [name, rawValue = "1"] = argument.slice(2).split("=", 2);
      options.defines[name] = Number(rawValue);
    } else if (["--report", "--cvbasic", "--library", "--raw", "--dialect", "--output-dialect", "--reference", "--bios", "--frames", "--mdl-jar"].includes(argument)) {
      options[argument.slice(2)] = argv[++index];
    } else if (argument === "--no-opt") {
      options.optimize = false;
    } else positional.push(argument);
  }
  return { positional, options };
}

async function save(path, contents) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, contents);
}

async function collectAssemblyFiles(entryPath) {
  const files = {};
  const visited = new Set();
  async function visit(absolutePath, key) {
    const normalized = resolve(absolutePath);
    if (visited.has(normalized)) return;
    visited.add(normalized);
    const source = await readFile(normalized, "utf8");
    files[key] = source;
    const includePattern = /^\s*include\s+["']([^"']+)["']/gim;
    for (const match of source.matchAll(includePattern)) {
      const includeKey = match[1].replace(/\\/g, "/");
      await visit(resolve(dirname(normalized), match[1]), includeKey);
    }
  }
  await visit(resolve(entryPath), "main.asm");
  return files;
}

async function main() {
  const { positional, options } = parseArguments(process.argv.slice(2));
  const [command, input, output] = positional;
  if (!["refine", "compile", "prove"].includes(command) || !input || !output) {
    usage();
    process.exitCode = 2;
    return;
  }

  if (command === "prove") {
    const files = await collectAssemblyFiles(input);
    const referenceBytes = options.reference ? await readFile(resolve(options.reference)) : null;
    const bios = options.bios ? await readFile(resolve(options.bios)) : null;
    const proof = await proveAssembly(files, {
      dialect: options.dialect ?? "native",
      outputDialect: options["output-dialect"] === "same" ? undefined : options["output-dialect"],
      defines: options.defines,
      optimize: options.optimize,
      referenceBytes,
      runtime: bios ? {
        bios,
        checkpoints: options.frames?.split(",").map((value) => Number(value.trim()))
      } : null,
      mdl: options["mdl-jar"] ? { jar: resolve(options["mdl-jar"]) } : null
    });
    const outDir = resolve(output);
    const stem = basename(input).replace(/\.(?:asm|z80|s)$/i, "");
    await save(`${outDir}/${stem}.refined.asm`, proof.artifacts.refinedAsm);
    await save(`${outDir}/${stem}.baseline.rom`, proof.artifacts.baselineRom);
    await save(`${outDir}/${stem}.specialized.rom`, proof.artifacts.specializedRom);
    if (proof.artifacts.optimizedRom) await save(`${outDir}/${stem}.amy-opt.rom`, proof.artifacts.optimizedRom);
    if (proof.artifacts.optimizedAsm) await save(`${outDir}/${stem}.amy-opt.raw.asm`, proof.artifacts.optimizedAsm);
    if (proof.artifacts.humanizedOptimizedAsm) await save(`${outDir}/${stem}.amy-opt.asm`, proof.artifacts.humanizedOptimizedAsm);
    if (proof.artifacts.compactAsm) await save(`${outDir}/${stem}.compact-cv.asm`, proof.artifacts.compactAsm);
    if (proof.artifacts.compactRom) await save(`${outDir}/${stem}.compact-cv.rom`, proof.artifacts.compactRom);
    if (proof.artifacts.os7Asm) await save(`${outDir}/${stem}.os7-engineered.asm`, proof.artifacts.os7Asm);
    if (proof.artifacts.os7Rom) await save(`${outDir}/${stem}.os7-engineered.rom`, proof.artifacts.os7Rom);
    if (proof.artifacts.mdlRom) await save(`${outDir}/${stem}.mdl.rom`, proof.artifacts.mdlRom);
    if (proof.artifacts.mdlAsm) await save(`${outDir}/${stem}.mdl.asm`, proof.artifacts.mdlAsm);
    if (proof.artifacts.mdlLog) await save(`${outDir}/${stem}.mdl.log`, `${proof.artifacts.mdlLog}\n`);
    if (proof.artifacts.pureCvAsm) await save(`${outDir}/${stem}.pure-cv.asm`, proof.artifacts.pureCvAsm);
    if (proof.artifacts.pureCvRom) await save(`${outDir}/${stem}.pure-cv.rom`, proof.artifacts.pureCvRom);
    await save(`${outDir}/${stem}.proof.json`, `${JSON.stringify(proof.report, null, 2)}\n`);
    console.log(`${proof.report.status}: ${proof.report.baseline.bytes} baseline bytes; fidelity ${proof.report.fidelity.identical ? "byte-identical" : "FAILED"}.`);
    if (proof.report.optimized) console.log(`Amy candidate: ${proof.report.optimized.bytes} bytes (${proof.report.optimized.savedVsBaseline} saved), ${proof.report.optimized.status}.`);
    if (proof.report.compact) console.log(`Compact CV candidate: ${proof.report.compact.bytes} bytes (${proof.report.compact.savedVsBaseline} saved), ${proof.report.compact.status}.`);
    if (proof.report.os7) console.log(`OS7-engineered candidate: ${proof.report.os7.bytes} bytes (${proof.report.os7.savedVsBaseline} saved), ${proof.report.os7.status}.`);
    if (proof.report.mdl) console.log(proof.report.mdl.status === "MDL_FAILED"
      ? `MDL candidate failed: ${proof.report.mdl.error}`
      : `MDL candidate: ${proof.report.mdl.bytes} bytes (${proof.report.mdl.savedVsBaseline} saved), ${proof.report.mdl.status}.`);
    if (proof.report.pureCv?.bytes) console.log(`Pure CV micro-runtime: ${proof.report.pureCv.bytes} bytes (${proof.report.pureCv.savedVsBaseline} saved), ${proof.report.pureCv.status}.`);
    if (proof.report.status === "REJECTED") process.exitCode = 1;
    return;
  }

  let assemblyPath = input;
  if (command === "compile") {
    if (!options.cvbasic || !options.library) throw new Error("compile requires --cvbasic and --library");
    assemblyPath = options.raw ?? `${output}.cvbasic.asm`;
    await mkdir(dirname(resolve(assemblyPath)), { recursive: true });
    const result = spawnSync(resolve(options.cvbasic), [resolve(input), resolve(assemblyPath), resolve(options.library)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (result.error) throw new Error(`cannot launch CVBasic: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`CVBasic failed (${result.status}):\n${result.stderr || result.stdout}`);
  }

  const refined = refineAssembly(await readFile(assemblyPath, "utf8"), options);
  const outputText = options["output-dialect"]
    ? renderAssemblyDialect(refined.text, options["output-dialect"])
    : refined.text;
  await save(output, outputText);
  if (options.report) await save(options.report, `${JSON.stringify(refined.report, null, 2)}\n`);
  console.log(`Refined ${assemblyPath} -> ${output}`);
  console.log(`Removed ${refined.report.removedConditionalLines} conditional/directive lines; ${refined.report.labels.length} labels; ${refined.report.calls.length} calls.`);
}

main().catch((error) => {
  console.error(`ColecoVision Code Refiner: ${error.message}`);
  process.exitCode = 1;
});
