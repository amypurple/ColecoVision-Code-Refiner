import assert from "node:assert/strict";
import { resolve } from "node:path";
import { assembleAmysCVAssembly } from "../vendor/amyscvassembly/compilerCore.js";
import { synthesizeCvbasicMusicMicroRuntime } from "../src/cvbasic-music-micro-runtime.mjs";
import { renderAssemblyDialect } from "../src/dialect-output.mjs";
import { validateWithTelemarkTasm } from "../src/telemark-tasm.mjs";

const executable = resolve(process.argv[2] || process.env.TASM_EXE || "");
if (!process.argv[2] && !process.env.TASM_EXE) throw new Error("usage: node test/real-tasm-music.mjs <path-to-TASM.EXE>");

const basic = `
wait_key:
  PRINT AT 66,"Press button"
  IF CONT1.BUTTON THEN GOTO play_1
  IF CONT1.BUTTON2 THEN GOTO play_2
play_1:
  PRINT AT 66,"First tune"
  PRINT AT 130,"(fragment)"
  PLAY tune_1
play_2:
  PRINT AT 66,"Second tune"
  PRINT AT 130,"(fragment)"
  PLAY tune_2
tune_1: DATA BYTE 5
  MUSIC C4,E4
  MUSIC STOP
tune_2: DATA BYTE 5
  MUSIC D4,F4,-,M1
  MUSIC REPEAT
`;
const native = synthesizeCvbasicMusicMicroRuntime(basic, { prefix: "fixture" }).assembly;
const assembled = await assembleAmysCVAssembly({ "main.asm": native }, "main.asm", {
  outputFilename: "music.rom",
  outputMode: "binary",
  targetPlatform: "raw",
  optimizerEnabled: false
});
assert.equal(assembled.ok, true, assembled.log);
const result = await validateWithTelemarkTasm(renderAssemblyDialect(native, "tasm"), Buffer.from(assembled.binary), executable);
assert.equal(result.status, "PASS_REAL_TASM", result.error);
console.log(`PASS: ${result.banner} produced ${result.bytes} byte-identical music bytes.`);
