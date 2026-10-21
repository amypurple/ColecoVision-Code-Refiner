import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { adaptAssemblyToOs7 } from "../src/os7-adapter.mjs";
import { proveAssembly } from "../src/proof.mjs";

test("converts a proven fixed direct VRAM write to the OS7 contract", () => {
  const source = `CTRL_PORT equ $bf\nDATA_PORT equ $be\n ld hl,picture\n ld a,$08\n out (CTRL_PORT),a\n ld a,$08\n or $40\n out (CTRL_PORT),a\n ld b,$78\n ld c,DATA_PORT\n otir\npicture: db 0\n`;
  const result = adaptAssemblyToOs7(source);
  assert.equal(result.transformations.length, 1);
  assert.equal(result.transformations[0].estimatedBytesSaved, 7);
  assert.match(result.text, /ld de,\$0808 ; fixed VRAM destination/);
  assert.match(result.text, /ld bc,\$0078 ; 120 bytes, proven byte-sized transfer/);
  assert.match(result.text, /call \$1FDF ; OS7 WRITE_VRAM/);
});

test("refuses dynamic and non-byte-sized-looking direct transfers", () => {
  const source = `CTRL_PORT equ $bf\nDATA_PORT equ $be\n ld hl,picture\n out (CTRL_PORT),a\n ld a,$08\n or $40\n out (CTRL_PORT),a\n ld b,0\n ld c,DATA_PORT\n otir\n`;
  assert.equal(adaptAssemblyToOs7(source).transformations.length, 0);
});

test("converts a proven fixed direct VRAM read to the OS7 contract", () => {
  const source = `CTRL_PORT equ $bf\nDATA_PORT equ $be\n ld hl,buffer\n ld a,$20\n out (CTRL_PORT),a\n ld a,$01\n out (CTRL_PORT),a\n ld b,$10\n ld c,DATA_PORT\n inir\nbuffer: db 0\n`;
  const result = adaptAssemblyToOs7(source);
  assert.equal(result.transformations.length, 1);
  assert.equal(result.transformations[0].kind, "FIXED_VRAM_READ_TO_OS7");
  assert.equal(result.transformations[0].estimatedBytesSaved, 5);
  assert.match(result.text, /ld hl,buffer/);
  assert.match(result.text, /ld de,\$0120 ; fixed VRAM source/);
  assert.match(result.text, /ld bc,\$0010 ; 16 bytes/);
  assert.match(result.text, /call \$1FE2 ; OS7 READ_VRAM/);
});

test("refuses zero-sized and dynamic direct VRAM reads", () => {
  const zero = `CTRL_PORT equ $bf\nDATA_PORT equ $be\n ld hl,buffer\n ld a,$20\n out (CTRL_PORT),a\n ld a,$01\n out (CTRL_PORT),a\n ld b,0\n ld c,DATA_PORT\n inir\n`;
  const dynamic = zero.replace("ld a,$20", "ld a,(address)").replace("ld b,0", "ld b,$10");
  assert.equal(adaptAssemblyToOs7(zero).transformations.length, 0);
  assert.equal(adaptAssemblyToOs7(dynamic).transformations.length, 0);
});

test("builds a separate OS7-engineered Matthew candidate", async () => {
  const source = await readFile(resolve(import.meta.dirname, "../fixtures/matthew-ttst/ttst2.z80"), "utf8");
  const proof = await proveAssembly({ "main.asm": source }, { dialect: "tasm" });
  assert.ok(proof.report.os7);
  assert.equal(proof.report.os7Assessment.status, "BENEFICIAL");
  assert.ok(proof.report.os7Assessment.savedVsBestNonOs7 > 0);
  assert.equal(proof.report.os7.transformations.length, 3);
  assert.equal(proof.report.os7.humanizedFidelity.identical, true);
  assert.match(proof.artifacts.os7Asm, /OS7 WRITE_VRAM/);
});

test("recognizes Matthew's SET_LINES object but retains it when OS7 VDP shadows are stale", async () => {
  const source = await readFile(resolve(import.meta.dirname, "../fixtures/matthew-ttst/ttst.z80"), "utf8");
  const adaptation = adaptAssemblyToOs7(source);
  const putobj = adaptation.opportunities.find((entry) => entry.kind === "STATIC_NAME_RECTANGLE_TO_PUTOBJ");
  assert.ok(putobj);
  assert.deepEqual(
    { status: putobj.status, destination: putobj.destination, width: putobj.width, height: putobj.height, localBytesSavedWhenOs7Ready: putobj.localBytesSavedWhenOs7Ready },
    { status: "BLOCKED_UNSYNCED_VDP_SHADOW", destination: 0x192c, width: 5, height: 3, localBytesSavedWhenOs7Ready: 3 }
  );
  assert.doesNotMatch(adaptation.text, /call \$1FFA ; OS7 PUTOBJ/);
  assert.match(adaptation.text, /CALL SET_LINES/i);
});

test("converts the same static rectangle when OS7 mode state is synchronized", async () => {
  const original = await readFile(resolve(import.meta.dirname, "../fixtures/matthew-ttst/ttst.z80"), "utf8");
  const source = original.replace("GRAPHICS_MODE_2:", "GRAPHICS_MODE_2:\n\tLD A, $02\n\tLD ($73C3), A ; synchronize OS7 VDP0 shadow");
  const adaptation = adaptAssemblyToOs7(source);
  const putobj = adaptation.transformations.find((entry) => entry.kind === "STATIC_NAME_RECTANGLE_TO_PUTOBJ");
  assert.ok(putobj);
  assert.match(adaptation.text, /call \$1FFA ; OS7 PUTOBJ/);
  assert.match(adaptation.text, /__REFINER_OS7_FRAME: db 5,3\s+TEXT:/);
  assert.doesNotMatch(adaptation.text, /CALL SET_LINES/i);
  assert.doesNotMatch(adaptation.text, /^SET_LINES:/im);

  const proof = await proveAssembly({ "main.asm": source }, { dialect: "tasm", outputDialect: "tasm" });
  assert.ok(proof.report.os7);
  assert.equal(proof.report.os7Assessment.status, "BENEFICIAL");
  assert.ok(proof.report.os7.transformations.some((entry) => entry.kind === "STATIC_NAME_RECTANGLE_TO_PUTOBJ"));
  assert.match(proof.artifacts.os7Asm, /call \$1FFA/);
});
