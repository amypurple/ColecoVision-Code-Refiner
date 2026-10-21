import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { proveAssembly } from "../src/proof.mjs";

const fixture = (name) => resolve(import.meta.dirname, `../fixtures/matthew-ttst/${name}`);

test("proof runner separates fidelity from an unvalidated optimized candidate", async () => {
  const source = await readFile(fixture("ttst2.z80"), "utf8");
  const referenceBytes = await readFile(fixture("TTST2.ROM"));
  const proof = await proveAssembly({ "main.asm": source }, { dialect: "tasm", referenceBytes });

  assert.equal(proof.report.status, "PASS_FIDELITY");
  assert.equal(proof.report.fidelity.identical, true);
  assert.equal(proof.report.reference.identical, true);
  assert.equal(proof.report.baseline.bytes, 846);
  assert.equal(proof.report.optimized.bytes, 841);
  assert.equal(proof.report.optimized.savedVsBaseline, 5);
  assert.equal(proof.report.optimized.status, "AWAITING_RUNTIME");
});

test("proof runner rejects a mismatching external oracle", async () => {
  const source = await readFile(fixture("ttst2.z80"), "utf8");
  const proof = await proveAssembly({ "main.asm": source }, {
    dialect: "tasm",
    referenceBytes: Buffer.from([0x00]),
  });
  assert.equal(proof.report.status, "REJECTED");
  assert.equal(proof.report.optimized, null);
  assert.equal(proof.report.reference.identical, false);
});

test("proof runner preserves included assembly modules", async () => {
  const proof = await proveAssembly({
    "main.asm": "org $8000\ninclude \"helper.asm\"\ncall helper\nret\n",
    "helper.asm": "helper:\n ld a,7\n ret\n"
  }, { dialect: "native", optimize: false });
  assert.equal(proof.report.status, "PASS_FIDELITY");
  assert.equal(proof.report.fidelity.identical, true);
  assert.equal(proof.report.optimized, null);
});
