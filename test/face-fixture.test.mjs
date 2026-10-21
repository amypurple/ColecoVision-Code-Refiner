import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { proveAssembly } from "../src/proof.mjs";
import { GEARCOLECO_TEST_INPUT as INPUT } from "../vendor/studio-core/gearcolecoTestCore.js";

test("Face fixture removes dead runtime groups and preserves interactive output", async () => {
  const source = await readFile(resolve(import.meta.dirname, "../fixtures/face/face.asm"), "utf8");
  const bios = await readFile(resolve(process.env.COLECOVISION_BIOS));
  const proof = await proveAssembly({ "main.asm": source }, {
    dialect: "gasm80",
    outputDialect: "tasm",
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
  assert.equal(proof.report.baseline.bytes, 1608);
  assert.equal(proof.report.fidelity.identical, true);
  assert.equal(proof.report.optimized.optimizerStats.jpToJr, 0);
  assert.equal(proof.report.compact.bytes, 1206);
  assert.equal(proof.report.compact.savedVsBaseline, 402);
  assert.ok(proof.report.compact.transformations.some(item => item.routine === "_mod16s"));
  assert.ok(proof.report.compact.runtime.mismatches.every(item => !item.visibleStateChanged));
});
