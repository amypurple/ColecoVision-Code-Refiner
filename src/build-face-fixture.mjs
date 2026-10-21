import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { GEARCOLECO_TEST_INPUT as INPUT } from "../vendor/studio-core/gearcolecoTestCore.js";
import { proveAssembly } from "./proof.mjs";
import { renderAssemblyDialect } from "./dialect-output.mjs";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "build/face");
const argument = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? resolve(process.argv[index + 1]) : null;
};
const tasm = argument("--tasm");
const gasm80 = argument("--gasm80");

const source = await readFile(resolve(import.meta.dirname, "../fixtures/face/face.asm"), "utf8");
if (!process.env.COLECOVISION_BIOS) throw new Error("set COLECOVISION_BIOS to build the runtime-proven Face fixture");
const bios = await readFile(resolve(process.env.COLECOVISION_BIOS));
await mkdir(output, { recursive: true });
const proof = await proveAssembly({ "main.asm": source }, {
  dialect: "gasm80",
  outputDialect: "native",
  runtime: {
    bios,
    checkpoints: [1, 2, 10, 60, 120, 145, 175, 205, 235, 265, 300],
    inputEvents: [
      { frame: 120, mask: INPUT.UP },
      { frame: 145, mask: INPUT.RIGHT },
      { frame: 175, mask: INPUT.DOWN },
      { frame: 205, mask: INPUT.LEFT },
      { frame: 235, mask: INPUT.FIRE_LEFT },
      { frame: 265, mask: INPUT.FIRE_RIGHT },
      { frame: 285, mask: 0 }
    ]
  }
});

const optimized = proof.artifacts.humanizedOptimizedAsm;
const tasmSource = renderAssemblyDialect(optimized, "tasm");
const gasm80Source = renderAssemblyDialect(optimized, "gasm80");
const expected = proof.artifacts.optimizedRom;
const occupied = proof.report.optimized.bytes;
const external = {};
const compact = proof.artifacts.compactAsm;
const compactExpected = proof.artifacts.compactRom;
const compactOccupied = proof.report.compact.bytes;

await writeFile(resolve(output, "face.amy-opt.asm"), optimized);
await writeFile(resolve(output, "face.amy-opt.rom"), expected);
await writeFile(resolve(output, "face.tasm.asm"), tasmSource);
await writeFile(resolve(output, "face.gasm80.asm"), gasm80Source);
await writeFile(resolve(output, "face.compact.amy.asm"), compact);
await writeFile(resolve(output, "face.compact.rom"), compactExpected);
await writeFile(resolve(output, "face.compact.tasm.asm"), renderAssemblyDialect(compact, "tasm"));
await writeFile(resolve(output, "face.compact.gasm80.asm"), renderAssemblyDialect(compact, "gasm80"));

if (tasm) {
  const rom = resolve(output, "face.tasm.rom");
  const listing = resolve(output, "face.tasm.lst");
  await run(tasm, ["-80", "-b", "-fFF", resolve(output, "face.tasm.asm"), rom, listing], {
    cwd: dirname(tasm), windowsHide: true
  });
  const bytes = await readFile(rom);
  external.tasm = { errors: 0, bytes: bytes.length, byteIdentical: bytes.equals(expected) };
  if (!external.tasm.byteIdentical) throw new Error("Face TASM ROM differs from the Amy candidate");
  const compactRom = resolve(output, "face.compact.tasm.rom");
  await run(tasm, ["-80", "-b", "-fFF", resolve(output, "face.compact.tasm.asm"), compactRom,
    resolve(output, "face.compact.tasm.lst")], { cwd: dirname(tasm), windowsHide: true });
  const compactBytes = await readFile(compactRom);
  external.compactTasm = { errors: 0, bytes: compactBytes.length, byteIdentical: compactBytes.equals(compactExpected) };
  if (!external.compactTasm.byteIdentical) throw new Error("Compact Face TASM ROM differs from the Amy candidate");
}

if (gasm80) {
  const rom = resolve(output, "face.gasm80.rom");
  const listing = resolve(output, "face.gasm80.lst");
  await run(gasm80, [resolve(output, "face.gasm80.asm"), "-o", rom, "-l", listing], { windowsHide: true });
  const bytes = await readFile(rom);
  const occupiedIdentical = bytes.subarray(0, occupied).equals(expected.subarray(0, occupied));
  external.gasm80 = { bytes: bytes.length, occupied, occupiedIdentical, padding: "$00" };
  if (!occupiedIdentical) throw new Error("Face GASM80 occupied bytes differ from the Amy candidate");
  const compactRom = resolve(output, "face.compact.gasm80.rom");
  await run(gasm80, [resolve(output, "face.compact.gasm80.asm"), "-o", compactRom, "-l",
    resolve(output, "face.compact.gasm80.lst")], { windowsHide: true });
  const compactBytes = await readFile(compactRom);
  const compactIdentical = compactBytes.subarray(0, compactOccupied)
    .equals(compactExpected.subarray(0, compactOccupied));
  external.compactGasm80 = {
    bytes: compactBytes.length, occupied: compactOccupied,
    occupiedIdentical: compactIdentical, padding: "$00"
  };
  if (!compactIdentical) throw new Error("Compact Face GASM80 occupied bytes differ from the Amy candidate");
}

proof.report.externalAssemblers = external;
await writeFile(resolve(output, "face.proof.json"), `${JSON.stringify(proof.report, null, 2)}\n`);
console.log(JSON.stringify({ optimized: proof.report.optimized, compact: proof.report.compact, external }, null, 2));
