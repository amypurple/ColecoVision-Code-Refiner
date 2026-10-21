import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { detectAssemblyDialect } from "../src/dialect.mjs";

test("detects Matthew's CVBasic-derived TASM conversion", async () => {
  const source = await readFile(resolve(import.meta.dirname, "../fixtures/matthew-ttst/ttst2.z80"), "utf8");
  const result = detectAssemblyDialect(source, "ttst2.z80");
  assert.equal(result.dialect, "tasm");
  assert.equal(result.origin, "cvbasic");
  assert.equal(result.confidence, "high");
});

test("detects GASM80-specific padding and virtual RAM", () => {
  const result = detectAssemblyDialect("COLECO equ 1\nif COLECO\ntimes 4 db 0\nbuffer: rb 8\nendif\n", "game.asm");
  assert.equal(result.dialect, "gasm80");
  assert.equal(result.origin, "cvbasic");
  assert.equal(result.confidence, "high");
});

test("reports ambiguous plain Z80 honestly", () => {
  const result = detectAssemblyDialect("org $8000\nstart: xor a\nret\n", "game.asm");
  assert.equal(result.dialect, "native");
  assert.equal(result.confidence, "unknown");
  assert.equal(result.origin, "generic-z80");
});
