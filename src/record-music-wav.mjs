#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  GearcolecoTestCore,
  GEARCOLECO_TEST_INPUT,
  GEARCOLECO_TEST_REGION
} from "../vendor/studio-core/gearcolecoTestCore.js";

function wav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const output = Buffer.alloc(44 + dataBytes);
  output.write("RIFF", 0);
  output.writeUInt32LE(36 + dataBytes, 4);
  output.write("WAVEfmt ", 8);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36);
  output.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples.length; index += 1) output.writeInt16LE(samples[index], 44 + index * 2);
  return output;
}

const [romArgument, outputArgument, choice = "left", secondsArgument = "20"] = process.argv.slice(2);
if (!romArgument || !outputArgument) {
  throw new Error("usage: record-music-wav.mjs ROM OUTPUT.wav [left|right] [seconds]");
}

if (!process.env.COLECOVISION_BIOS) throw new Error("set COLECOVISION_BIOS to record emulator audio");
const core = await GearcolecoTestCore.create({ seed: 0x4d555349 });
try {
  core.loadBios(await readFile(resolve(process.env.COLECOVISION_BIOS)));
  core.loadRom(await readFile(resolve(romArgument)), { region: GEARCOLECO_TEST_REGION.NTSC });
  for (let frame = 0; frame < 120; frame += 1) core.runFrame();
  core.setControllerMask(0, choice === "right" ? GEARCOLECO_TEST_INPUT.FIRE_RIGHT : GEARCOLECO_TEST_INPUT.FIRE_LEFT);
  for (let frame = 0; frame < 4; frame += 1) core.runFrame();
  core.setControllerMask(0, 0);
  const samples = [];
  const frames = Math.ceil(Number(secondsArgument) * 60);
  for (let frame = 0; frame < frames; frame += 1) {
    core.runFrame();
    samples.push(...core.getAudioFrame().samples);
  }
  await writeFile(resolve(outputArgument), wav(samples, core.getAudioFrame().sampleRate || 44100));
} finally {
  core.destroy();
}
