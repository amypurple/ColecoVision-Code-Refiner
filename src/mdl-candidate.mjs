import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { translateAmyAsm } from "./translate-amy-asm-to-mdl.js";

export function extractMdlBytesSaved(log) {
  const match = String(log || "").match(/optimization summary:\s*(\d+)\s+bytes?/i);
  return match ? Number(match[1]) : null;
}

export async function buildMdlCandidate(files, options) {
  const scratch = await mkdtemp(join(tmpdir(), "cvbasic-refiner-mdl-"));
  for (const [key, source] of Object.entries(files)) {
    const output = resolve(scratch, key);
    await mkdir(dirname(output), { recursive: true });
    const translated = await translateAmyAsm(source, output, { target: "mdl" });
    await writeFile(output, translated, "utf8");
  }
  const input = resolve(scratch, "main.asm");
  const asmOutput = resolve(scratch, "candidate.mdl.asm");
  const binOutput = resolve(scratch, "candidate.mdl.bin");
  const result = spawnSync(options.java ?? "java", [
    "-jar", resolve(options.jar), input,
    "-dialect", "mdl", "-po",
    "-asm", asmOutput, "-bin", binOutput
  ], { encoding: "utf8" });
  if (result.error) throw new Error(`cannot launch MDL: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`MDL failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  const log = `${result.stdout || ""}${result.stderr || ""}`.trim();
  return {
    bytes: await readFile(binOutput),
    asm: await readFile(asmOutput, "utf8"),
    log,
    savedBytes: extractMdlBytesSaved(log)
  };
}
