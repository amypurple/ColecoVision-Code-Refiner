# Matthew TTST refinement fixture

These files were supplied by Matthew Eggleston on October 16, 2026. They are
kept byte-for-byte as historical input for CVBasic ASM Refiner.

## Files

- `ttst.z80`: minimum direct-hardware experiment derived from a CVBasic idea.
- `ttst2.z80`: OS7-initialized variant with three sprites.
- `TTST2.ROM`: supplied 846-byte assembled ROM for the second variant.
- `*.refined.asm` and `*.report.json`: deterministic Refiner outputs.

Supplied ROM SHA-256:

`E0E6339AE7E847EFE88C87F84010401776FF8F61ED335C23DCACC22D558E5617`

## What the human changed

The minimal version replaces the normal CVBasic runtime with a cartridge
header, direct TMS9918 register writes, narrow pattern/name/color transfers and
two tiny helper routines. It deliberately depends on the machine's existing
stack and startup state. Its own comment warns that omitted restart vectors may
be required on physical hardware.

The second version restores selected OS7 responsibilities before executing the
same compact direct-VDP effect:

- establish a known screen state and silence sound;
- clear all VRAM;
- upload a 16x16 sprite pattern;
- initialize and publish the OS7 sprite tables;
- turn the display on through the BIOS register service;
- provide cartridge-header pointers and two reserved words.

This pair is useful because it demonstrates that the smallest listing is not
automatically the safest listing. Refiner may learn conservative region and ABI
classification from it, but must not automatically delete startup contracts or
replace BIOS services merely because an emulator happens to boot the smaller
form.

## Amy assembler evidence

`node tools/amyz80.mjs ttst2.z80 output.rom --tasm` reproduces the supplied ROM
byte for byte: 846 bytes and the SHA-256 above. Amy's optimizer currently emits
an 841-byte candidate, while MDL emits 839 bytes. Both candidates preserve the
framebuffer, VRAM, writable RAM state, and VDP registers at deterministic frames
1, 2, 10, 60, and 120. Their only raw-RAM differences are relocated return
addresses in the active OS7 stack word, validated by matching stack pointers and
instruction forms. The supplied 846-byte ROM remains the immutable fidelity
oracle; optimized artifacts remain separately identified candidates.
