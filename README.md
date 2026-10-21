# ColecoVision Code Refiner

ColecoVision Code Refiner is a proof-oriented web tool for turning CVBasic source
or generated Z80 assembly into smaller, more readable, ColecoVision-specific code.
It recognizes GASM80, Telemark TASM and Amy syntax, can export any of those
dialects, applies Amy Studio's Z80 optimizer, identifies safe OS7 substitutions,
and keeps unproven rewrites separate from byte-identical output.

## What it does

- Accepts pasted source or `.bas`, `.bas.txt`, `.asm`, `.z80` and `.s` files by picker or drag and drop.
- Compiles CVBasic locally, or starts directly from generated assembly.
- Exports readable Amy, GASM80 or Telemark TASM assembly.
- Offers Off, Balanced and Aggressive optimization profiles.
- Produces byte-identity, occupied-size and safety reports.
- Removes only proven unreachable CVBasic runtime groups.
- Recognizes direct VDP code and proposes or applies OS7 calls when their contracts fit.
- Converts supported `DEFINE VRAM PLETTER` assets to ZX0 with a mandatory data round trip.
- Synthesizes a proven Amy/OS7 Tiny Sound profile for compatible CVBasic programs.
- Can compare framebuffer, VRAM and VDP registers when a legal ColecoVision BIOS is supplied.

The tool fails closed: unsupported program shapes remain unchanged or are reported as
not applicable. It does not silently delete behavior to produce a smaller ROM.

## Run locally

Requirements: Node.js 20 or newer.

```powershell
npm test
npm start
```

Open `http://127.0.0.1:8091`. The repository includes the CVBasic 0.9.2 binaries
and runtime sources used by the project. Set `CVBASIC_EXECUTABLE` to use another build.

Optional environment variables:

```text
PORT=8091
HOST=127.0.0.1
CVBASIC_EXECUTABLE=C:\path\to\cvbasic.exe
TASM_EXECUTABLE=C:\path\to\TASM.EXE
COLECOVISION_BIOS=C:\path\to\colecovision.rom
```

No ColecoVision BIOS or Telemark TASM binary is distributed. Without a BIOS, ROMs
can still be assembled and downloaded, but runtime equivalence is explicitly marked
as awaiting validation. Without TASM, TASM output is checked by the bundled Amy
assembler's compatibility mode rather than the external Telemark executable.

`GET /api/health` reports which optional capabilities are available.

## Put it online

This is a Node web application, not a static GitHub Pages site: CVBasic compilation
and ROM proof run on the server. GitHub can host the repository, while a Node host
or the included Docker image runs the application.

```bash
docker build -t colecovision-code-refiner .
docker run --rm -p 8091:8091 colecovision-code-refiner
```

For public deployment, do not upload a copyrighted BIOS. The service operates
without one and labels emulator-dependent proof as unavailable. Set `HOST=0.0.0.0`
on a remote host; the Docker image already does this.

## Proof levels

- **Fidelity specialization** resolves directives and normalizes syntax; its ROM
  must be byte-identical to the input build.
- **Optimized** output must assemble and preserve all recognized contracts.
- **Compact CV** removes only closed, unreachable CVBasic runtime groups.
- **OS7 engineered** output is emitted only for statically proven call contracts.
- **Runtime proof** compares complete visible VDP state at deterministic checkpoints.

The UI keeps these artifacts separate so a readable suggestion cannot be mistaken
for a validated replacement.

## Tests

```powershell
npm test
npm run smoke
npm run test:tasm-real -- C:\path\to\TASM.EXE
```

`npm test` is self-contained. `npm run smoke` invokes the bundled CVBasic and
GASM80 binaries. Runtime tests require `COLECOVISION_BIOS`.

## Third-party components

- CVBasic 0.9.2 and GASM80 are included under their upstream terms in
  `third_party/cvbasic`.
- The Amy assembler/optimizer and selected runtime knowledge originate in Amy Studio.
- RetroCompress-Lite codec modules provide the verified Pletter and ZX0 transforms.
- The GearColeco test core is used only when runtime proof is enabled.

See source headers and third-party license files for their respective terms. Choose
and add a repository-level license before accepting external contributions.

## Scope

The refiner currently specializes ColecoVision cartridge code. It is not a general
Z80 decompiler, and an OS7 call is not automatically better than direct code: the
tool retains `OTIR`, `INIR` or direct VDP routines when a wrapper would be larger,
slower, or dependent on machine state that the source does not maintain.
