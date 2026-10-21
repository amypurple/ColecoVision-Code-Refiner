import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { annotateOptimizedAssembly } from "../src/humanize.mjs";
import { proveAssembly } from "../src/proof.mjs";

const fixture = (name) => resolve(import.meta.dirname, `../fixtures/matthew-ttst/${name}`);

test("explains separately meaningful B and C bytes after a proven pair fusion", () => {
  const source = `CTRL_PORT equ $bf\n ld c,CTRL_PORT\n ld b,$10 ; send 16 bytes\n otir\n`;
  const result = annotateOptimizedAssembly(source, " ld bc,$10bf\n otir\n");
  assert.match(result.text, /B=\$10 \(send 16 bytes; block-transfer byte count\)/);
  assert.match(result.text, /C=CTRL_PORT \(I\/O port; VDP control port\)/);
  assert.equal(result.annotations.length, 1);
});

test("does not invent provenance for an original LD BC", () => {
  const result = annotateOptimizedAssembly("ld bc,$1234\nret\n", "ld bc,$1234\nret\n");
  assert.equal(result.annotations.length, 0);
  assert.doesNotMatch(result.text, /packed from/);
});

test("Matthew candidate keeps byte identity after human annotations", async () => {
  const source = await readFile(fixture("ttst2.z80"), "utf8");
  const proof = await proveAssembly({ "main.asm": source }, { dialect: "tasm" });
  assert.equal(proof.report.optimized.humanizedFidelity.identical, true);
  assert.equal(proof.report.optimized.humanAnnotations.length, 5);
  assert.match(proof.artifacts.humanizedOptimizedAsm, /NUMBER OF TEXT PATTERNS/);
  assert.match(proof.artifacts.humanizedOptimizedAsm, /COLOR CYCLE SPEED/);
  assert.match(proof.artifacts.humanizedOptimizedAsm, /B=\$78 \([^)]*120 bytes/);
  assert.match(proof.artifacts.humanizedOptimizedAsm, /^DATA_PORT: \.EQU \$BE$/m);
  assert.match(proof.artifacts.humanizedOptimizedAsm, /^CTRL_PORT: \.EQU \$BF$/m);
  assert.match(proof.artifacts.humanizedOptimizedAsm, /^\s+\.ORG \$8000$/m);
  assert.match(proof.artifacts.humanizedOptimizedAsm, /^\s+\.DW \$AA55$/m);
  assert.match(proof.artifacts.humanizedOptimizedAsm, /call \$1F85\s+; OS7 MODE_1/);
  assert.match(proof.artifacts.humanizedOptimizedAsm, /out \(DATA_PORT\),A/i);
});
