import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { proveAssembly } from "../src/proof.mjs";

const run = promisify(execFile);
const executable = resolve(process.argv[2] || process.env.GASM80_EXE || "");
if (!process.argv[2] && !process.env.GASM80_EXE) {
  throw new Error("usage: node test/real-gasm80.mjs <path-to-gasm80.exe>");
}

const source = await readFile(resolve(import.meta.dirname, "../fixtures/face/face.asm"), "utf8");
const proof = await proveAssembly({ "main.asm": source }, {
  dialect: "gasm80",
  outputDialect: "gasm80"
});
const expected = proof.artifacts.optimizedRom;
if (!expected?.length) throw new Error("the Face fixture did not produce an optimized ROM");
const occupied = proof.report.optimized.bytes;

const work = await mkdtemp(resolve(tmpdir(), "cvbasic-refiner-gasm80-"));
try {
  const asmPath = resolve(work, "face.asm");
  const romPath = resolve(work, "face.rom");
  const listPath = resolve(work, "face.lst");
  await writeFile(asmPath, proof.artifacts.humanizedOptimizedAsm);
  const { stdout, stderr } = await run(executable, [asmPath, "-o", romPath, "-l", listPath], {
    windowsHide: true
  });
  const actual = await readFile(romPath);
  if (!actual.subarray(0, occupied).equals(expected.subarray(0, occupied))) {
    const first = actual.subarray(0, occupied).findIndex((value, index) => value !== expected[index]);
    throw new Error(`GASM80 output differs from Amy output at file offset $${first.toString(16).toUpperCase()}`);
  }
  const gasmPadding = actual.subarray(occupied);
  if (!gasmPadding.every(value => value === 0x00)) {
    throw new Error("GASM80 produced unexpected nonzero bytes after the occupied program");
  }
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  console.log(`PASS: GASM80 produced ${occupied} byte-identical occupied bytes; its remaining ALIGN padding is $00.`);
} finally {
  await rm(work, { recursive: true, force: true });
}
