import test from "node:test";
import assert from "node:assert/strict";
import { extractMdlBytesSaved } from "../src/mdl-candidate.mjs";

test("extracts occupied-byte savings from the MDL optimization summary", () => {
  assert.equal(extractMdlBytesSaved("INFO: mdl optimization summary: 5 bytes, 17 t-states saved."), 5);
  assert.equal(extractMdlBytesSaved("no optimization summary"), null);
});
