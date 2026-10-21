import test from "node:test";
import assert from "node:assert/strict";
import { analyzeReachability, pruneUnreachableCvbasicRuntime } from "../src/reachability.mjs";

test("finds an isolated unreachable routine without deleting data", () => {
  const report = analyzeReachability(`dw START\nSTART:\n call USED\n ret\nUSED:\n ret\nDEAD:\n ld a,1\n ret\nTABLE:\n db 1,2,3\n`);
  assert.deepEqual(report.removable.map((item) => item.name), ["DEAD"]);
  assert.ok(report.guarded.some((item) => item.name === "TABLE"));
});

test("keeps address-taken and transitively reached routines", () => {
  const report = analyzeReachability(`dw START\ndw CALLBACK\nSTART:\n call A\n ret\nA:\n jp B\nB:\n ret\nCALLBACK:\n ret\n`);
  assert.equal(report.removable.length, 0);
  assert.equal(report.reachableCount, 4);
});

test("does not classify a fall-through block as removable", () => {
  const report = analyzeReachability(`dw START\nSTART:\n ld a,1\nFALL:\n inc a\n ret\nDEAD:\n ret\n`);
  assert.ok(report.guarded.some((item) => item.name === "FALL"));
});

test("prunes only known CVBasic runtime routines, never similarly unreachable user code", () => {
  const source = `dw START\nSTART:\n ret\nWRTVRM:\n ld a,1\n ret\nMY_UNUSED:\n ld a,2\n ret\n`;
  const result = pruneUnreachableCvbasicRuntime(source);
  assert.doesNotMatch(result.text, /WRTVRM:/);
  assert.match(result.text, /MY_UNUSED:/);
  assert.deepEqual(result.transformations.map((item) => item.routine), ["WRTVRM"]);
});

test("retains an unreachable helper while another retained dead block references it", () => {
  const source = `dw START\nSTART:\n ret\nWRTVRM:\n ret\nUNSAFE_GROUP:\n call WRTVRM\n ret\n`;
  const result = pruneUnreachableCvbasicRuntime(source);
  assert.match(result.text, /WRTVRM:/);
  assert.equal(result.transformations.length, 0);
});

test("prunes a closed group of mutually dependent CVBasic runtime helpers", () => {
  const source = `dw START\nSTART:\n ret\n_DIV16S:\n call _NEG16\n ret\n_NEG16:\n jp _DIV16\n_DIV16:\n ret\n`;
  const result = pruneUnreachableCvbasicRuntime(source);
  assert.doesNotMatch(result.text, /_(?:DIV16S|NEG16|DIV16):/);
  assert.deepEqual(result.transformations.map((item) => item.routine), ["_DIV16S", "_NEG16", "_DIV16"]);
});
