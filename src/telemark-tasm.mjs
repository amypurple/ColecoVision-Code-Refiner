import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function findBundledTelemarkTasm(base = import.meta.dirname) {
  const executable = resolve(base, "../tools/external/tasm32/tasm.exe");
  try {
    await access(executable);
    return executable;
  } catch {
    return null;
  }
}

export async function validateWithTelemarkTasm(source, expectedBinary, executable) {
  if (!executable) return { status: "UNAVAILABLE", byteIdentical: false };
  const work = await mkdtemp(resolve(tmpdir(), "cvbasic-refiner-real-tasm-"));
  try {
    const asmPath = resolve(work, "candidate.asm");
    const romPath = resolve(work, "candidate.rom");
    const listPath = resolve(work, "candidate.lst");
    await writeFile(asmPath, source);
    const { stdout, stderr } = await run(executable, ["-80", "-b", "-fFF", asmPath, romPath, listPath], {
      cwd: dirname(executable),
      windowsHide: true
    });
    const actual = await readFile(romPath);
    const expected = Buffer.from(expectedBinary);
    const byteIdentical = actual.equals(expected);
    let firstDifference = null;
    if (!byteIdentical) {
      const length = Math.max(actual.length, expected.length);
      for (let offset = 0; offset < length; offset += 1) {
        if (actual[offset] !== expected[offset]) {
          firstDifference = offset;
          break;
        }
      }
    }
    return {
      status: byteIdentical ? "PASS_REAL_TASM" : "REJECTED_BINARY_DIFFERENCE",
      byteIdentical,
      bytes: actual.length,
      firstDifference,
      banner: `${stdout}${stderr}`.split(/\r?\n/).find(line => /TASM Z80 Assembler/i.test(line)) || "Telemark TASM"
    };
  } catch (error) {
    return {
      status: "REJECTED_REAL_TASM",
      byteIdentical: false,
      error: `${error.stdout || ""}${error.stderr || ""}${error.message || error}`.trim()
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
