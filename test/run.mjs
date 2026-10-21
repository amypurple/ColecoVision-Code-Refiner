// Keep the suite in one process. Some managed Windows environments prohibit
// node:test worker creation even though the tests themselves need no workers.
await import("./humanize.test.mjs");
await import("./dialect.test.mjs");
await import("./dialect-output.test.mjs");
await import("./os7-adapter.test.mjs");
await import("./os7-catalog.test.mjs");
await import("./reachability.test.mjs");
await import("./feature-profile.test.mjs");
if (process.env.COLECOVISION_BIOS) await import("./face-fixture.test.mjs");
await import("./mdl-candidate.test.mjs");
await import("./optimizer-cvbasic.test.mjs");
await import("./micro-runtime.test.mjs");
await import("./os7-putobj-size.test.mjs");
await import("./proof.test.mjs");
await import("./refiner.test.mjs");
await import("./runtime-proof.test.mjs");
await import("./tasm-oracle.test.mjs");
await import("./tiny-sound.test.mjs");
await import("./pletter-zx0.test.mjs");
