import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { proveAssembly } from "../src/proof.mjs";

const run = promisify(execFile);
const executable = resolve(process.argv[2] || process.env.TASM_EXE || "");
if (!process.argv[2] && !process.env.TASM_EXE) {
  throw new Error("usage: node test/real-tasm.mjs <path-to-TASM.EXE>");
}

const source = await readFile(resolve(import.meta.dirname, "../fixtures/face/face.asm"), "utf8");
const proof = await proveAssembly({ "main.asm": source }, {
  dialect: "gasm80",
  outputDialect: "tasm"
});
const expected = proof.artifacts.optimizedRom;
if (!expected?.length) throw new Error("the Face fixture did not produce an optimized ROM");

const work = await mkdtemp(resolve(tmpdir(), "cvbasic-refiner-tasm-"));
try {
  const asmPath = resolve(work, "face.asm");
  const romPath = resolve(work, "face.rom");
  const listPath = resolve(work, "face.lst");
  await writeFile(asmPath, proof.artifacts.humanizedOptimizedAsm);
  const { stdout, stderr } = await run(executable, ["-80", "-b", "-fFF", asmPath, romPath, listPath], {
    cwd: dirname(executable),
    windowsHide: true
  });
  const actual = await readFile(romPath);
  if (!actual.equals(expected)) {
    const first = actual.findIndex((value, index) => value !== expected[index]);
    throw new Error(`Telemark TASM output differs from Amy output at file offset $${first.toString(16).toUpperCase()}`);
  }
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  console.log(`PASS: Telemark TASM produced ${actual.length} byte-identical bytes.`);
} finally {
  await rm(work, { recursive: true, force: true });
}
