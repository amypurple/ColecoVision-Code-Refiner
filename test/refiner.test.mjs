import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateExpression } from "../src/expression.mjs";
import { refineAssembly } from "../src/refiner.mjs";

test("evaluates CVBasic feature expressions without executing source", () => {
  const symbols = new Map([["COLECO", 1], ["SMS", 0], ["SGM", 1]]);
  assert.equal(evaluateExpression("COLECO+SMS+SGM", symbols), 2);
  assert.equal(evaluateExpression("COLECO && !SMS", symbols), 1);
  assert.equal(evaluateExpression("($10 + 2) << 1", symbols), 36);
});

test("specializes nested CVBasic platform conditions", () => {
  const source = `COLECO: equ 1
SMS: equ 0
if COLECO+SMS
shared:
  if SMS
    ld a,2
  else
    ld a,1
  endif
endif
if MSX
msx_only:
  ret
endif
START:
  call shared
  ret
`;
  const { text, report } = refineAssembly(source, { defines: { MSX: 0 } });
  assert.match(text, /shared:\n\s+ld a,1/);
  assert.doesNotMatch(text, /ld a,2|msx_only|\bif\b|\bendif\b/i);
  assert.equal(report.calls[0].target, "shared");
  assert.equal(report.unresolvedConditions.length, 0);
});

test("fails closed when a conditional cannot be proven", () => {
  assert.throws(() => refineAssembly("if UNKNOWN\n db 1\nendif\n"), /cannot resolve IF/);
});

test("reports the unmatched ENDIF tolerated by GASM80", () => {
  const { report, text } = refineAssembly("db 1\nendif\ndb 2\n");
  assert.equal(report.structuralWarnings.length, 1);
  assert.doesNotMatch(text, /endif/i);
  assert.match(text, /db 1[\s\S]*db 2/);
});

test("is deterministic and idempotent when refining its own result", () => {
  const source = `COLECO: equ 1\nif COLECO\nstart:\n  nop\nendif\n`;
  const first = refineAssembly(source);
  const second = refineAssembly(first.text);
  assert.equal(second.text, first.text);
  assert.equal(second.report.removedConditionalLines, 0);
});

test("classifies TASM equates, OS7 calls, and direct VDP access", () => {
  const source = `DATA_PORT: .EQU $00BE
START:
  call $1f85
  out (DATA_PORT),a
  ret
`;
  const { report } = refineAssembly(source);
  assert.deepEqual(report.labels.map((entry) => entry.name), ["START"]);
  assert.equal(report.os7Calls[0].service, "MODE_1");
  assert.equal(report.unresolvedReferences.length, 0);
  assert.equal(report.directVdpAccesses.length, 1);
  assert.equal(report.safetyFindings.length, 0);
});

test("warns when a direct-only VDP program relies on implicit machine state", () => {
  const { report } = refineAssembly("START:\n out ($bf),a\n jr START\n");
  assert.equal(report.safetyFindings[0].code, "DIRECT_VDP_WITHOUT_OS7_INIT");
});

test("marks timing and block-I/O code as requiring runtime validation", () => {
  const { report } = refineAssembly("START:\n ld b,8\nloop:\n otir\n djnz loop\n ret\n");
  assert.equal(report.blockIoOperations.length, 1);
  assert.equal(report.timingSensitiveOperations.length, 1);
  assert.equal(report.optimizationPolicy.requiresRuntimeValidation, true);
  assert.equal(report.safetyFindings.at(-1).code, "TIMING_SENSITIVE_CODE");
});

test("reports Amy wrapper contracts and warns about raw OS7 VRAM count semantics", () => {
  const source = `WRITE_VRAM equ $1fdf\n call WRITE_VRAM\n call AMY_COPY_BYTES_TO_VRAM\n`;
  const result = refineAssembly(source);
  assert.equal(result.report.routineContracts.length, 2);
  assert.equal(result.report.routineContracts[0].contract.service, "WRITE_VRAM");
  assert.match(result.report.routineContracts[0].contract.notes, /C != 0/);
  assert.equal(result.report.routineContracts[1].contract.service, "AMY_COPY_BYTES_TO_VRAM");
  assert.equal(result.report.safetyFindings.filter((item) => item.code === "RAW_OS7_VRAM_COUNT_SEMANTICS").length, 1);
});

test("offers an OS7 migration guide for direct-port cartridge code", () => {
  const source = `.org $8000\n.dw $aa55\n.dw 0\n.dw 0\n.dw 0\n.dw 0\n.dw START\nSTART:\n ld c,CTRL_PORT\n ld b,16\n ld hl,REGS\n out (CTRL_PORT),a\n otir\n ld c,DATA_PORT\n ld b,8\n otir\nREGS: .db 0\n`;
  const result = refineAssembly(source);
  const codes = result.report.os7Guide.map((item) => item.code);
  assert.ok(codes.includes("ESTABLISH_OS7_STARTUP"));
  assert.ok(codes.includes("REVIEW_CARTRIDGE_HEADER_POINTERS"));
  assert.ok(codes.includes("VDP_REGISTER_STREAM"));
  assert.ok(codes.includes("DIRECT_VRAM_TRANSFER"));
});

test("uses a compact one-line provenance banner", () => {
  const result = refineAssembly("org $8000\nret\n");
  assert.match(result.text, /^; ColecoVision Code Refiner:/);
  assert.doesNotMatch(result.text, /^; -{20,}/m);
  assert.equal(result.text.split("\n").slice(0, 2).filter(Boolean).length, 1);
});

test("distinguishes Matthew's minimal and OS7-restored TTST variants", () => {
  const fixture = (name) => readFileSync(resolve(import.meta.dirname, `../fixtures/matthew-ttst/${name}`), "utf8");
  const minimal = refineAssembly(fixture("ttst.z80")).report;
  const restored = refineAssembly(fixture("ttst2.z80")).report;
  assert.equal(minimal.os7Calls.length, 0);
  assert.equal(minimal.safetyFindings[0].code, "DIRECT_VDP_WITHOUT_OS7_INIT");
  assert.deepEqual(restored.os7Calls.map((entry) => entry.service), [
    "MODE_1", "TURN_OFF_SOUND", "FILL_VRAM", "WRITE_VRAM",
    "INIT_SPR_ORDER", "WR_SPR_NM_TBL", "WRITE_REGISTER"
  ]);
  assert.equal(restored.safetyFindings.some((entry) => entry.code === "DIRECT_VDP_WITHOUT_OS7_INIT"), false);
  assert.equal(restored.safetyFindings.some((entry) => entry.code === "TIMING_SENSITIVE_CODE"), true);
});
