#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GearcolecoTestCore, GEARCOLECO_TEST_INPUT, GEARCOLECO_TEST_REGION } from "../vendor/studio-core/gearcolecoTestCore.js";

const root = resolve(import.meta.dirname, "..");
if (!process.env.COLECOVISION_BIOS) throw new Error("set COLECOVISION_BIOS to run the music ROM test");
const bios = await readFile(resolve(process.env.COLECOVISION_BIOS));
const romPath = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(root, "artifacts/cvbasic-asm-refiner/music/proof/music.hybrid-rom-candidate.baseline.rom");
const rom = await readFile(romPath);
const tinySlotAddress = /(?:amy-os7|telemark-tasm|micro-wrapper)/i.test(romPath) ? 0x7114 : 0x710a;

async function exercise(mask, name) {
  const core = await GearcolecoTestCore.create({ seed: 0x4d555349 });
  try {
    core.loadBios(bios);
    core.loadRom(rom, { region: GEARCOLECO_TEST_REGION.NTSC });
    for (let frame = 0; frame < 120; frame += 1) core.runFrame();
    core.setControllerMask(0, mask);
    for (let frame = 0; frame < 4; frame += 1) core.runFrame();
    core.setControllerMask(0, 0);
    let nonZero = 0;
    const samples = [];
    const tinyPointers = new Set();
    const tinyPointer1 = new Set();
    const tinyPointer2 = new Set();
    const soundFrames = new Set();
    const tinySamples = [];
    let firstSoundState = "";
    for (let frame = 0; frame < 240; frame += 1) {
      core.runFrame();
      const tinyState = core.readRam(tinySlotAddress, 32);
      const tinyPointer = `${tinyState[2]}:${tinyState[3]}:${tinyState[18]}:${tinyState[19]}`;
      tinyPointers.add(tinyPointer);
      tinyPointer1.add(`${tinyState[2]}:${tinyState[3]}`);
      tinyPointer2.add(`${tinyState[18]}:${tinyState[19]}`);
      if (tinySamples.length < 20) tinySamples.push(Buffer.from(tinyState).toString("hex"));
      const soundState = Buffer.from(core.readRam(0x7020, 51)).toString("hex");
      if (!firstSoundState) firstSoundState = soundState;
      soundFrames.add(soundState);
      const frameSamples = core.getAudioFrame().samples;
      samples.push(...frameSamples);
      for (const sample of frameSamples) if (sample !== 0) nonZero += 1;
    }
    assert.ok(nonZero > 1000, `${name} produced no sustained audio`);
    assert.ok(tinyPointers.size > 4, `${name} Tiny Sound stream pointers did not advance (${tinyPointers.size} states: ${tinySamples.join(", ")}; sound ${firstSoundState})`);
    assert.ok(tinyPointer1.size > 4, `${name} Tiny Sound channel 1 remained stuck (${[...tinyPointer1].join(", ")})`);
    assert.ok(tinyPointer2.size > 4, `${name} Tiny Sound channel 2 remained stuck (${[...tinyPointer2].join(", ")})`);
    assert.ok(soundFrames.size > 4, `${name} BIOS sound areas did not evolve (${soundFrames.size} states; Tiny pointers ${tinyPointers.size}: ${tinySamples.join(", ")})`);
    const pcm = Int16Array.from(samples);
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    return {
      nonZero,
      tinyPointerStates: tinyPointers.size,
      tinyChannel1States: tinyPointer1.size,
      tinyChannel2States: tinyPointer2.size,
      soundAreaStates: soundFrames.size,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  } finally {
    core.destroy();
  }
}

const bach = await exercise(GEARCOLECO_TEST_INPUT.FIRE_LEFT, "Bach");
const mecha = await exercise(GEARCOLECO_TEST_INPUT.FIRE_RIGHT, "Mecha-8");
assert.notEqual(bach.sha256, mecha.sha256, "both menu choices produced the same PCM stream");
console.log(JSON.stringify({ status: "PASS", bach, mecha }, null, 2));
