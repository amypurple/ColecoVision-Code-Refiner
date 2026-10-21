import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assembleAmysCVAssembly } from "../vendor/amyscvassembly/compilerCore.js";
import { refineAssembly } from "../src/refiner.mjs";

const fixture = (name) => resolve(import.meta.dirname, `../fixtures/matthew-ttst/${name}`);

async function assemble(source) {
  const result = await assembleAmysCVAssembly({ "main.asm": source }, "main.asm", {
    outputFilename: "ttst2.rom",
    outputMode: "binary",
    targetPlatform: "raw",
    optimizerEnabled: false,
    tasmCompatibility: true,
  });
  assert.equal(result.ok, true, result.log);
  return Buffer.from(result.binary);
}

test("Amy TASM mode reproduces Matthew's published ROM exactly", async () => {
  const source = await readFile(fixture("ttst2.z80"), "utf8");
  const expected = await readFile(fixture("TTST2.ROM"));
  assert.deepEqual(await assemble(source), expected);
});

test("fidelity specialization preserves Matthew's TASM binary", async () => {
  const source = await readFile(fixture("ttst2.z80"), "utf8");
  const refined = refineAssembly(source);
  assert.deepEqual(await assemble(refined.text), await assemble(source));
});

test("TASM accepts byte-width port EQU values without leading zeroes", async () => {
  const shortPort = `DATA_PORT: .EQU $BE\n.ORG $8000\nLD C,DATA_PORT\nOUT (C),A\n.END\n`;
  const widePort = shortPort.replace("$BE", "$00BE");
  assert.deepEqual(await assemble(shortPort), await assemble(widePort));
});
