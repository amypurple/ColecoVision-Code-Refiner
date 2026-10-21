import test from "node:test";
import assert from "node:assert/strict";
import { assembleAmysCVAssembly } from "../vendor/amyscvassembly/compilerCore.js";

async function optimize(body) {
  const result = await assembleAmysCVAssembly({ "main.asm": `org $8000\n${body}\nret\n` }, "main.asm", {
    outputMode: "binary",
    targetPlatform: "raw",
    optimizerEnabled: true
  });
  assert.equal(result.ok, true, result.log);
  return result.optimizedAsm.toLowerCase();
}

test("keeps CVBasic PC-relative JP expressions at their original width", async () => {
  const result = await assembleAmysCVAssembly({ "main.asm": `
org $8000
start:
    ld de,$7000
    xor a
clear_loop:
    ld (de),a
    inc de
    bit 2,d
    jp z,$-4
    ret
` }, "main.asm", {
    outputMode: "binary",
    targetPlatform: "raw",
    optimizerEnabled: true,
    optimizerConfig: { peephole: true, branchShortening: true }
  });

  assert.equal(result.ok, true, result.log);
  assert.match(result.optimizedAsm, /jp z,\$-4/i);
  assert.doesNotMatch(result.optimizedAsm, /jr z,\$-4/i);
});

test("folds CVBasic byte-to-word truth normalization without changing final state", async () => {
  const asm = await optimize("ld l,a\nld h,0\nld a,h\nor l");
  assert.match(asm, /ld l,a\s+ld h,0\s+or a/);
  assert.doesNotMatch(asm, /ld a,h/);
});

test("does not fold across labels or with a nonzero high byte", async () => {
  const labeled = await optimize("ld l,a\nld h,0\nkeep:\nld a,h\nor l");
  const nonzero = await optimize("ld l,a\nld h,1\nld a,h\nor l");
  assert.match(labeled, /ld a,h/);
  assert.match(nonzero, /ld a,h/);
});
