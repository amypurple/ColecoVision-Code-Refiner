import test from "node:test";
import assert from "node:assert/strict";
import { assembleAmysCVAssembly } from "../vendor/amyscvassembly/compilerCore.js";

async function sizeOf(source) {
  const result = await assembleAmysCVAssembly({ "main.asm": source }, "main.asm", {
    outputFilename: "putobj-size.bin",
    outputMode: "binary",
    targetPlatform: "raw",
    optimizerEnabled: false
  });
  assert.equal(result.ok, true, result.log);
  return result.binary.length;
}

const frame = "db 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15";

test("Matthew's 5x3 NAME writer is smaller than mutable PUTOBJ but larger than static no-save PUTOBJ", async () => {
  const direct = `
CTRL_PORT equ $BF
DATA_PORT equ $BE
org $8000
  ld a,$2C
  ld hl,Frame
  call SetLine
  ld a,$4C
  call SetLine
  ld a,$6C
  call SetLine
Done: jr Done
SetLine:
  out (CTRL_PORT),a
  ld a,$19
  or $40
  out (CTRL_PORT),a
  ld b,5
  ld c,DATA_PORT
  otir
  ret
Frame: ${frame}
`;

  const putobj = `
PUTOBJ equ $1FFA
STATUS equ $7100
org $8000
  ld hl,InitialStatus
  ld de,STATUS
  ld bc,6
  ldir
  ld ix,Object
  ld b,0
  call PUTOBJ
Done: jr Done
Object: dw Graphics,STATUS,$8000
Graphics: db 0,0
  dw 0
  db 0
  dw Frame
Frame: db 5,3
  ${frame}
InitialStatus: db 0
  dw 96,72
  db 0
`;

  const directBytes = await sizeOf(direct);
  const putobjBytes = await sizeOf(putobj);
  assert.equal(directBytes, 50);
  assert.equal(putobjBytes, 58);
  assert.equal(putobjBytes - directBytes, 8);

  const staticPutobj = `
PUTOBJ equ $1FFA
org $8000
  ld ix,Object
  ld b,0
  call PUTOBJ
Done: jr Done
Object: dw Graphics,Status,$8000
Graphics: db 0,0
  dw 0
  db 0
  dw Frame
Frame: db 5,3
  ${frame}
Status: db 0
  dw 96,72
  db 0
`;

  const staticPutobjBytes = await sizeOf(staticPutobj);
  assert.equal(staticPutobjBytes, 47);
  assert.equal(directBytes - staticPutobjBytes, 3);
});
