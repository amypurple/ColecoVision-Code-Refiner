import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { catalogCvbasicOs7Opportunities } from "../src/os7-catalog.mjs";
import { refineAssembly } from "../src/refiner.mjs";

test("catalogs the main CVBasic runtime routines that overlap OS7", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../third_party/cvbasic/cvbasic_prologue.asm"), "utf8");
  const found = catalogCvbasicOs7Opportunities(source);
  const ids = new Set(found.map((item) => item.id));
  for (const id of ["FILVRM", "LDIRVM", "LDIRMV", "WRTVDP", "CLS", "MODE_INIT", "SPRITE_UPDATE", "RANDOM", "PSG", "MUSIC", "TEXT"]) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
  assert.equal(found.find((item) => item.id === "FILVRM").status, "PROVEN_CALLSITE");
  assert.equal(found.find((item) => item.id === "RANDOM").status, "KEEP_DIRECT");
  assert.equal(found.find((item) => item.id === "SPRITE_UPDATE").status, "CONDITIONAL");
});

test("recognizes renamed helper bodies instead of relying only on labels", () => {
  const source = `MY_FILL:\n call SETWRT\n.loop:\n out (VDP),a\n dec c\n jp nz,.loop\n djnz .loop\n ret\n`;
  const found = catalogCvbasicOs7Opportunities(source);
  assert.equal(found.find((item) => item.id === "FILVRM")?.signatureMatched, true);
});

test("exposes the CVBasic-to-OS7 catalog in the refinement report", () => {
  const result = refineAssembly("random:\n ld hl,(lfsr)\n ld (lfsr),hl\n ret\n");
  assert.equal(result.report.cvbasicOs7Opportunities[0].id, "RANDOM");
});
