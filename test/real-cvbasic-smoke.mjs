import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { refineAssembly } from "../src/refiner.mjs";

const root = resolve(import.meta.dirname, "..");
const toolchain = join(root, "third_party/cvbasic");
const cvbasic = process.env.CVBASIC_EXECUTABLE || join(toolchain, process.platform === "win32" ? "cvbasic.exe" : "cvbasic_linux");
const gasm80 = process.env.GASM80_EXECUTABLE || join(toolchain, process.platform === "win32" ? "gasm80.exe" : "gasm80_linux");
const basic = join(root, "fixtures/smoke/hello.bas");
const scratch = await mkdtemp(join(tmpdir(), "cvbasic-refiner-"));
const originalAsm = join(scratch, "original.asm");
const refinedAsm = join(scratch, "refined.asm");
const originalRom = join(scratch, "original.rom");
const refinedRom = join(scratch, "refined.rom");

function run(executable, args) {
  const result = spawnSync(executable, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${executable} failed:\n${result.stdout}\n${result.stderr}`);
}

try {
  run(cvbasic, [basic, originalAsm, toolchain]);
  const refined = refineAssembly(await readFile(originalAsm, "utf8"));
  await writeFile(refinedAsm, refined.text);
  run(gasm80, [originalAsm, "-o", originalRom]);
  run(gasm80, [refinedAsm, "-o", refinedRom]);

  const original = await readFile(originalRom);
  const specialized = await readFile(refinedRom);
  assert.deepEqual(specialized, original, "specialized assembly must produce the exact CVBasic ROM");
  console.log(`PASS: ${original.length} byte ROM is byte-identical after ColecoVision specialization.`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
