import test from "node:test";
import assert from "node:assert/strict";
import { isRelocatedStackReturnOnly } from "../src/runtime-proof.mjs";

const before = { sp: 0x73B7, returnInstruction: "CALL $8308" };
const after = { sp: 0x73B7, returnInstruction: "CALL $8305" };

test("accepts only an equivalent relocated return on the active stack", () => {
  assert.equal(isRelocatedStackReturnOnly([
    { address: 0x73B7, baseline: 0x74, candidate: 0x72 }
  ], before, after), true);
});

test("does not hide writable RAM or stack-control changes", () => {
  assert.equal(isRelocatedStackReturnOnly([
    { address: 0x73B6, baseline: 1, candidate: 2 }
  ], before, after), false);
  assert.equal(isRelocatedStackReturnOnly([
    { address: 0x73B7, baseline: 0x74, candidate: 0x72 }
  ], before, { ...after, returnInstruction: "JP $8305" }), false);
  assert.equal(isRelocatedStackReturnOnly([
    { address: 0x73B7, baseline: 0x74, candidate: 0x72 }
  ], before, { ...after, sp: 0x73B5 }), false);
});
