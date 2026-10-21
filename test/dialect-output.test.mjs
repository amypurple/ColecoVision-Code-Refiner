import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderAssemblyDialect } from "../src/dialect-output.mjs";
import { proveAssembly } from "../src/proof.mjs";

test("renders human output as TASM without decimalizing hardware values", () => {
  const source = `DATA_PORT equ $00BE\n org $8000\n dw $AA55\ndata: db $00\n end\n`;
  const output = renderAssemblyDialect(source, "tasm");
  assert.match(output, /^DATA_PORT: \.EQU \$BE$/m);
  assert.match(output, /^ \.ORG \$8000$/m);
  assert.match(output, /^ \.DW \$AA55$/m);
  assert.match(output, /^data: \.DB \$00$/m);
  assert.match(output, /^ \.END$/m);
});

test("exports Matthew's TASM input as byte-identical GASM80 and Amy syntax", async () => {
  const source = await readFile(resolve(import.meta.dirname, "../fixtures/matthew-ttst/ttst2.z80"), "utf8");
  for (const outputDialect of ["gasm80", "native"]) {
    const proof = await proveAssembly({ "main.asm": source }, { dialect: "tasm", outputDialect });
    assert.equal(proof.report.optimized.humanizedFidelity.identical, true);
    assert.equal(proof.report.os7.humanizedFidelity.identical, true);
    assert.equal(proof.report.outputDialect, outputDialect);
  }
});

test("keeps addresses wide but renders proven byte ports as byte values", () => {
  const source = `DATA_PORT equ $00be\nSCREEN_BASE equ $00be\n`;
  const output = renderAssemblyDialect(source, "tasm");
  assert.match(output, /^DATA_PORT: \.EQU \$BE$/m);
  assert.match(output, /^SCREEN_BASE: \.EQU \$00be$/m);
});

test("renders GASM80 locals, reservations, alignment and shadow AF as Telemark TASM", () => {
  const source = `SG1000 equ 0
SMS equ 0
JOY1 equ $fc-$20*(SG1000+SMS)
org $8000
Routine:
.1:
 ex af,af
 jr .1
rom_end:
 align $2000
 org $7000
buffer:
 rb $20
value rb 1
`;
  const output = renderAssemblyDialect(source, "tasm");
  assert.match(output, /L_Routine_1:/);
  assert.match(output, /jr L_Routine_1/i);
  assert.match(output, /EX AF,AF'/);
  assert.match(output, /JOY1: \.EQU \$FC ; TASM folded from/);
  assert.match(output, /buffer:\s+\.ORG \$\+\$20/);
  assert.match(output, /value:\s+\.ORG \$\+1/);
  assert.match(output, /\.FILL \(\(\(\$ \+ \$1FFF\) & \$E000\)-\$\),\$FF/);
  assert.match(output, /^\s*\.END\s*$/m);
  assert.doesNotMatch(output, /^\s*\.1:|\brb\b|^\s*align\b/im);
});

test("renders normalized optimizer syntax as real GASM80 syntax", () => {
  const output = renderAssemblyDialect(`PORT equ $BE\nVALUE rb 1\nEX AF,AF\n`, "gasm80");
  assert.match(output, /^PORT: equ \$BE$/m);
  assert.match(output, /^VALUE: rb 1$/m);
  assert.match(output, /^\s*ex af,af'$/m);
});

test("renders column-one instructions and long symbols for real Telemark TASM", () => {
  const longLabel = "AMY_TINY_SOUND_NEW_NOTE_NO_ARPEGGIO";
  const output = renderAssemblyDialect(`org $8000\njp ${longLabel}\n${longLabel}:\n ret\n`, "tasm");
  const definition = output.match(/^([A-Za-z_?][\w.$?]*):$/m);
  assert.ok(definition, output);
  assert.ok(definition[1].length <= 31, definition[1]);
  assert.match(output, new RegExp(`^\\s+jp ${definition[1]}$`, "mi"));
  assert.doesNotMatch(output, new RegExp(`^${longLabel}:$`, "m"));
});
