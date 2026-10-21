import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assembleAmysCVAssembly } from "../vendor/amyscvassembly/compilerCore.js";
import { compressBytes } from "../vendor/studio-core/compression.js";
import { replacePletterWithZx0 } from "../src/pletter-zx0.mjs";

test("converts CVBasic DEFINE VRAM PLETTER payloads to verified ZX0", async () => {
  const raw = Uint8Array.from([1, 2, 3, 1, 2, 3, 1, 2]);
  const packed = await compressBytes("pletter", raw);
  const packedDb = [...packed].map((value) => `$${value.toString(16).padStart(2, "0")}`).join(",");
  const basic = "DEFINE VRAM PLETTER $0000,8,picture";
  const assembly = `CVBASIC_COMPRESSION: equ 1
mode: equ $7000
org $8000
; DEFINE VRAM PLETTER $0000,8,picture
LD HL,0
EX DE,HL
LD HL,cvb_PICTURE
CALL unpack
JP $
cvb_PICTURE:
 DB ${packedDb}
after_picture:
 RET
rom_end:
`;
  const decoder = await readFile(resolve(import.meta.dirname, "../vendor/compression/zx0_vram.asm"), "utf8");
  const converted = await replacePletterWithZx0(basic, assembly, decoder);
  assert.equal(converted.changed, true);
  assert.equal(converted.assets.length, 1);
  assert.equal(converted.assets[0].rawBytes, 8);
  assert.match(converted.source, /CALL zx0_decompress/i);
  const result = await assembleAmysCVAssembly({ "main.asm": converted.source }, "main.asm", {
    outputMode: "binary",
    targetPlatform: "raw",
    gasm80Compatibility: true,
    optimizerEnabled: false
  });
  assert.equal(result.ok, true, result.log);
});

test("refuses Pletter wrapper shapes whose destination ABI is not yet proven", async () => {
  await assert.rejects(
    replacePletterWithZx0("DEFINE CHAR PLETTER 0,1,data", "", ""),
    /refuses CHAR\/COLOR\/SPRITE/
  );
});
