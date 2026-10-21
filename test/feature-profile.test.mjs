import test from "node:test";
import assert from "node:assert/strict";
import { buildCvbasicFeatureProfile } from "../src/feature-profile.mjs";

test("builds a minimal runtime profile from reachable CVBasic symbols", () => {
  const profile = buildCvbasicFeatureProfile({ reachable: ["START", "NMI_HANDLER", "PRINT_STRING", "LDIRVM"] });
  assert.deepEqual(profile.required.map((item) => item.id), ["vblankNmi", "text", "vramTransfer"]);
  assert.ok(profile.omitted.some((item) => item.id === "music"));
  assert.ok(profile.omitted.some((item) => item.id === "sprites"));
});

test("does not inherit unused controller and sprite features from the generic NMI", () => {
  const source = `nmi_handler:\n call update_sprite\n; CVBasic program start.\n call mode_2\n halt\n call print_string\n; CVBasic epilogue\n`;
  const profile = buildCvbasicFeatureProfile({ reachable: ["NMI_HANDLER", "UPDATE_SPRITE", "PRINT_STRING"] }, source);
  assert.deepEqual(profile.required.map((item) => item.id), ["vblankNmi", "text"]);
});
