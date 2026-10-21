# ColecoVision Code Refiner: Proof-Oriented Pipeline

## Objective

Turn portable CVBasic-generated Z80 into readable ColecoVision assembly, then
offer smaller candidates using Amy's OS7 knowledge, assembler optimizer, and
MDL without silently changing the game. Every accepted byte saving must retain
its source provenance and pass the validation gates appropriate to its risk.

## Pipeline

1. **Acquire**: accept CVBasic BASIC plus generated assembly, or an existing
   `.asm`/`.z80` file. Preserve the compiler version, command line, hashes, and
   all included files in a build manifest.
2. **Normalize dialect**: parse GASM80, TASM, or native Amy syntax into one
   internal representation. Formatting and aliases may change; instructions,
   addresses, data, and ordering may not.
3. **Specialize target**: resolve only proven compile-time branches for
   ColecoVision/OS7. Unknown expressions fail closed instead of guessing.
4. **Inventory contracts**: classify ROM code/data, RAM reservations, cartridge
   header references, NMI/interrupt paths, OS7 calls, direct VDP/PSG I/O,
   banked regions, block I/O, timing loops, indirect references, and suspected
   self-modifying code.
5. **Build the oracle**: assemble the unmodified and specialized forms. The
   fidelity stage requires byte-identical output.
6. **Generate candidates**: run independent Amy peephole, ABI-aware, and MDL
   passes. Keep each pass attributable and reversible; never stack an unknown
   rewrite onto an unverified candidate.
   Emit a raw optimizer listing plus a human listing. Proven byte-pair fusions
   retain separate B/C meanings in comments; comments are then checked by
   reassembly against the raw candidate.
   OS7 engineering passes operate as another independent lane. Each rewrite
   must identify a complete hardware idiom, bind it to a documented ABI, and
   fail closed when addresses, counts, register liveness, or call effects are
   not proven.
7. **Prove candidates**: reassemble, validate layout/header/vector invariants,
   compare changed instruction regions, and reject unexpected data movement.
8. **Execute**: run deterministic GearColeco recordings and self-tests. Compare
   checkpoints, RAM, VRAM, VDP registers, framebuffer, audio/timing-sensitive
   state, and bank state as applicable.
   Relocated return addresses may differ only inside the active stack word when
   both stack pointers and decoded instruction forms agree; all other RAM
   differences remain failures or explicit review items.
9. **Promote**: select the smallest candidate that clears every required gate.
   Emit the readable assembly, ROM, map, listing, report, and a pass-by-pass
   size ledger. A smaller failure never replaces the last proven artifact.

## Safety Levels

| Level | Allowed work | Required proof |
| --- | --- | --- |
| Fidelity | Dialect aliases, formatting, proven conditional removal | Byte-identical ROM |
| Local | Peepholes with explicit register/flag/memory contracts | Unit proof, assembly diff, full optimizer suite |
| ABI-aware | OS7 substitutions, call/return and clobber-aware rewrites | ABI tests plus deterministic runtime |
| Whole-program | Reachability, data pruning, routine replacement | Reference graph, header/NMI/bank audit, runtime corpus |
| Experimental | Timing changes, direct-hardware substitutions, MDL discoveries | Isolated artifact only until all applicable gates pass |

## Non-Regression Corpus

- Tiny instruction fixtures for every accepted GASM80 and TASM spelling.
- Matthew's `TTST2.ROM` as an 846-byte, SHA-256-pinned TASM oracle.
- The six toolchain-comparison programs with exact size and runtime baselines.
- Amy optimizer self-tests, especially flags, shadow registers, indexed
  addressing, call barriers, NMI, DSOUND/PCM, and bank switching.
- Representative CVBasic games using sprites, controllers, music, scrolling,
  compression, MegaCart, SGM, and direct VDP code.
- Deterministic GearColeco scenarios through title, gameplay, transitions, and
  completion rather than boot-only screenshots.

No baseline size may increase silently. A deliberate increase needs a named
correctness reason, before/after evidence, and an updated approved baseline.

## MDL Policy

MDL is initially an adviser and candidate generator, not an authority. Its
suggestions are grouped by rewrite pattern and measured against Amy's optimizer.
A repeated MDL win may become a native Amy peephole only after its register,
flags, memory, stack, control-flow, interrupt, and timing assumptions are made
explicit and covered by focused negative tests.

## Near-Term Milestones

1. Finish dialect fixtures and include/macro coverage for TASM and GASM80.
2. Extend the existing instruction provenance to BASIC source lines and add a
   section/routine size ledger.
3. Add conservative unreachable-runtime analysis that treats headers, data
   pointers, NMI, indirect jumps, and banks as roots.
4. Feed Amy and MDL candidates through the same proof runner.
5. Extend the local workbench with configured CVBasic compilation, GearColeco
   replay manifests, and an HTML comparison report.
6. Promote only transformations that pass the complete corpus without a size
   or behavior regression.
