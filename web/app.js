import { runStaticPipeline } from "./static-pipeline.js";

const $ = (id) => document.getElementById(id);
let loaded = [];
let lastResult = null;
let backendAvailable = false;

function looksLikeCvbasic(source) {
  const tests = [
    /^\s*(?:MODE|SCREEN|CLS|PRINT|DEFINE|DIM|BITMAP|SPRITE|MUSIC|SOUND|PLAY)\b/im,
    /^\s*(?:IF\b.*\bTHEN|FOR\b.*\bTO|DO\s*$|LOOP\s*$|WHILE\b|GOTO\b)/im,
    /^\s*[A-Za-z_][\w$]*\s*:\s*(?:DATA|MUSIC)\b/im,
    /\bCONT\d?\.(?:UP|DOWN|LEFT|RIGHT|BUTTON\d*)\b/i,
    /\b(?:PRINT|PUT|VPOKE|VPEEK)\s+AT\b/i
  ];
  return tests.filter((pattern) => pattern.test(source)).length >= 2;
}

async function reportServerCapabilities() {
  if (window.CVR_PROOF_SERVICE !== true) {
    backendAvailable = false;
    $("metrics").innerHTML = "<span>Standalone browser mode</span><span>CVBasic ready</span><span>Runtime proof unavailable</span>";
    return;
  }
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error();
    const health = await response.json();
    backendAvailable = true;
    const capabilities = health.capabilities || {};
    $("metrics").innerHTML = `<span>Server ready</span><span>CVBasic ${capabilities.cvbasic ? "ready" : "unavailable"}</span><span>BIOS proof ${capabilities.colecoVisionBios ? "ready" : "optional"}</span><span>Telemark TASM ${capabilities.telemarkTasm ? "ready" : "optional"}</span>`;
  } catch {
    backendAvailable = false;
    $("metrics").innerHTML = "<span>Standalone browser mode</span><span>CVBasic ready</span><span>Runtime proof unavailable</span>";
  }
}

async function accept(fileList) {
  const candidates = [...fileList].filter((file) => /\.(?:bas|txt|asm|z80|s)$/i.test(file.name));
  loaded = await Promise.all(candidates.map(async (file) => ({ name: file.webkitRelativePath || file.name, text: await file.text() })));
  loaded = loaded.filter((file) =>
    /(?:\.bas(?:\.txt)?|\.(?:asm|z80|s))$/i.test(file.name) ||
    (/\.txt$/i.test(file.name) && (looksLikeCvbasic(file.text) || /\b(?:org|equ|db|dw|ld|jp|call)\b/i.test(file.text))));
  $("mainFile").replaceChildren(...loaded.map((file) => new Option(file.name, file.name)));
  const likelyMain = loaded.find((file) => /\.bas(?:\.txt)?$/i.test(file.name))
    ?? loaded.find((file) => !/(?:^|[\\/])(?:library|runtime|include|header)[^\\/]*\.(?:asm|z80|s)$/i.test(file.name)) ?? loaded[0];
  if (likelyMain) $("mainFile").value = likelyMain.name;
  $("source").value = likelyMain?.text || "";
  $("metrics").innerHTML = loaded.length
    ? `<span>${loaded.length} file${loaded.length === 1 ? "" : "s"}</span><span>${looksLikeCvbasic(likelyMain?.text || "") ? "CVBasic source detected" : "Z80 assembly detected"}</span>`
    : "<span>FAILED: no CVBasic or Z80 listing was recognized in the dropped files.</span>";
}

$("files").addEventListener("change", (event) => accept(event.target.files));
$("mainFile").addEventListener("change", () => { $("source").value = loaded.find((file) => file.name === $("mainFile").value)?.text || ""; });
let dragDepth = 0;
function showDropOverlay(show) {
  document.body.classList.toggle("is-dragging", show);
  $("dropOverlay").classList.toggle("is-visible", show);
  $("dropOverlay").setAttribute("aria-hidden", String(!show));
}
window.addEventListener("dragenter", (event) => { event.preventDefault(); dragDepth += 1; showDropOverlay(true); });
window.addEventListener("dragover", (event) => { event.preventDefault(); });
window.addEventListener("dragleave", (event) => { event.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) showDropOverlay(false); });
window.addEventListener("drop", (event) => { event.preventDefault(); dragDepth = 0; showDropOverlay(false); accept(event.dataTransfer.files); });

function cards(items, formatter, empty) {
  return items?.length ? items.map((item) => `<div class="card ${item.severity === "caution" ? "warn" : ""}">${formatter(item)}</div>`).join("") : empty;
}

function groupContracts(entries) {
  const grouped = new Map();
  for (const entry of entries || []) {
    const key = entry.contract.service;
    const current = grouped.get(key) || { ...entry, lines: [] };
    current.lines.push(entry.line);
    grouped.set(key, current);
  }
  return [...grouped.values()];
}

$("run").addEventListener("click", async () => {
  const pastedSource = $("source").value;
  if (!loaded.length && !pastedSource.trim()) {
    $("metrics").innerHTML = "<span>FAILED: open a CVBasic/ASM file or paste source code first.</span>";
    return;
  }
  if (!loaded.length) {
    const name = looksLikeCvbasic(pastedSource) ? "pasted.bas" : "pasted.asm";
    loaded = [{ name, text: pastedSource }];
    $("mainFile").replaceChildren(new Option(name, name));
    $("mainFile").value = name;
  }
  const main = loaded.find((file) => file.name === $("mainFile").value);
  if (main) main.text = pastedSource;
  $("run").disabled = true;
  $("metrics").innerHTML = "<span>Analyzing...</span>";
  try {
    const request = {
      files: loaded,
      main: $("mainFile").value,
      sourceKind: $("sourceKind").value,
      dialect: $("dialect").value,
      outputDialect: $("outputDialect").value,
      runtime: $("runtime").value,
      tinySound: $("tinySound").value,
      optimization: $("optimization").value,
      compression: $("compression").value,
      looksLikeCvbasic
    };
    let result;
    if (backendAvailable) {
      const serializable = { ...request };
      delete serializable.looksLikeCvbasic;
      const response = await fetch("/api/refine", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(serializable) });
      const responseText = await response.text();
      if (!response.headers.get("content-type")?.includes("application/json")) {
        const returnedHtml = /^\s*</.test(responseText);
        throw new Error(`the compiler API failed at ${response.url} (${response.status})${returnedHtml ? "; HTML was returned instead of JSON" : ""}`);
      }
      try {
        result = JSON.parse(responseText);
      } catch {
        throw new Error(`the backend returned invalid JSON from ${response.url}`);
      }
      if (!response.ok) throw new Error(result.error);
    } else {
      result = await runStaticPipeline(request);
    }
    lastResult = result;
    $("refined").value = result.refinedAsm;
    $("optimized").value = result.optimizedAsm;
    $("compact").value = result.compactAsm || "; NOT APPLICABLE\n; Compact CV removes only proven unreachable blocks from the generated CVBasic runtime.\n; This source has no catalogued runtime block that can be removed safely.\n; Use Human ASM or OS7 engineered for this file.\n";
    $("os7").value = result.os7Asm || "; No statically proven OS7 rewrite for this source.\n";
    const pureReason = result.report?.pureCv?.reason || "the source does not match a supported closed-program profile";
    $("purecv").value = result.pureCvAsm || `; NOT APPLICABLE\n; Pure CV currently synthesizes only strictly recognized complete CVBasic program shapes.\n; Reason: ${pureReason}.\n; No source instructions were discarded.\n`;
    const tiny = result.tinySound;
    $("tinysound").value = tiny?.asm || "; NOT APPLICABLE\n; Load a CVBasic BAS source containing DATA BYTE and MUSIC statements.\n; Unsupported music is rejected rather than silently changed.\n";
    const amyMusic = result.amyMusic;
    $("amymusic").value = amyMusic?.asm || `; NOT APPLICABLE\n; ${amyMusic?.error || "This BASIC source does not match the supported two-choice music-player profile."}\n`;
    const report = result.report;
    const detected = result.detection;
    const os7Metric = report.os7
      ? `${report.os7.bytes} OS7 candidate (${report.os7Assessment.savedVsBestNonOs7} beyond optimized, ${report.os7.status})`
      : report.os7Assessment?.status === "SKIPPED_NO_SIZE_GAIN"
        ? `direct I/O kept (${Math.abs(report.os7Assessment.savedVsBestNonOs7)} byte OS7 cost)`
        : "no proven OS7 rewrite";
    const pureMetric = report.pureCv?.bytes ? `${report.pureCv.bytes} pure CV (${report.pureCv.savedVsBaseline} saved, ${report.pureCv.status})` : "no Pure CV micro-runtime";
    const tinyMetric = tiny ? `${tiny.blocks.length} Tiny tune${tiny.blocks.length === 1 ? "" : "s"}, ${tiny.rejectedBlocks.length} rejected` : "no Tiny Sound source";
    const amyMusicProof = amyMusic?.telemark?.byteIdentical ? "real TASM verified" : (amyMusic?.byteIdentical ? "byte-identical" : amyMusic?.status);
    const amyMusicMetric = amyMusic?.bytes ? `${amyMusic.bytes} Amy/OS7 ${amyMusic.outputDialect?.toUpperCase() || "native"} music ROM (${amyMusicProof})` : "no Amy/OS7 music ROM";
    $("metrics").innerHTML = [result.standalone ? "standalone browser" : "proof service", `${report.baseline.bytes} bytes baseline`, `${report.optimized?.bytes ?? report.specialized.bytes} ${report.optimization.effective}`, report.compact ? `${report.compact.bytes} compact (${report.compact.savedVsBaseline} saved, ${report.compact.status})` : "no compact candidate", os7Metric, pureMetric, tinyMetric, amyMusicMetric, result.compression?.summary || "compression preserved", report.fidelity.identical ? "byte-identical specialization" : "fidelity failed", `${report.optimized?.humanAnnotations?.length ?? 0} byte-role notes`, `${detected.origin} source`, `${result.dialect.toUpperCase()} ${detected.confidence} confidence`, `exports ${result.outputDialect.toUpperCase()}`].map((value) => `<span>${value}</span>`).join("");
    const generatedContracts = amyMusic?.analysis?.routineContracts;
    const contractSource = generatedContracts?.length ? "Amy/OS7 generated ASM" : "analyzed input ASM";
    const contractEntries = groupContracts(generatedContracts?.length ? generatedContracts : report.analysis.routineContracts);
    $("contracts").innerHTML = `<div class="card"><b>ACTUAL CALLS · ${contractSource}</b><br>Only calls present in this artifact are listed below.</div>` +
      cards(contractEntries, (item) => `<b>${item.contract.service}</b> · ${item.lines.length} call${item.lines.length === 1 ? "" : "s"} · line${item.lines.length === 1 ? "" : "s"} ${item.lines.join(", ")}<br>${item.contract.notes || "Contract known."}<br><small>clobbers: ${item.contract.clobbers.join(", ") || "none"}</small>`, "No known OS7/Amy calls occur in this artifact.");
    const engineered = report.os7Assessment?.transformations?.map((item) => ({
      title: item.kind === "STATIC_NAME_RECTANGLE_TO_PUTOBJ" ? "Static tile rectangle -> PUTOBJ" : `${item.kind.includes("READ") ? "Read" : "Write"} VRAM through OS7`,
      reason: item.kind === "STATIC_NAME_RECTANGLE_TO_PUTOBJ"
        ? `Proved ${item.width}x${item.height} NAME-table rectangle at $${item.destination.toString(16).toUpperCase()}. Reused existing tile bytes as an OS7 type-0 frame; removed the private writer. Estimated local saving: ${item.estimatedBytesSaved} bytes.`
        : `Proved ${item.byteCount} byte transfer. Estimated local saving: ${item.estimatedBytesSaved} bytes.`,
      snippet: item.contract
    })) ?? [];
    const blocked = report.os7Assessment?.opportunities?.map((item) => ({
      title: "PUTOBJ recognized, direct writer retained",
      reason: `${item.width}x${item.height} rectangle at $${item.destination.toString(16).toUpperCase()}: ${item.reason}`,
      snippet: `Potential saving in an OS7-synchronized project: ${item.localBytesSavedWhenOs7Ready} bytes.`
    })) ?? [];
    const catalog = report.analysis.cvbasicOs7Opportunities?.map((item) => ({
      title: `${item.id} -> ${item.service}`,
      reason: `${item.status.replaceAll("_", " ")} · ${item.summary} Prerequisite: ${item.prerequisite}`,
      snippet: `${item.vector} · risk ${item.risk}${item.matchedLabels.length ? ` · labels ${item.matchedLabels.join(", ")}` : " · body signature"}`
    })) ?? [];
    $("os7Guide").innerHTML = `<div class="card"><b>MIGRATION OPPORTUNITIES · original CVBasic ASM</b><br>These are candidate substitutions and prerequisites, not calls already made by the input.</div>` +
      cards([...engineered, ...blocked, ...catalog, ...report.analysis.os7Guide], (item) => `<b>${item.title}</b><br>${item.reason}<pre>${item.snippet}</pre>`, "No OS7 migration opportunity recognized.");
    const dialectEvidence = detected.evidence.filter((item) => item.dialect === result.dialect).map((item) => ({ severity: "information", code: `DIALECT +${item.points}`, message: item.message }));
    const deadCodeEvidence = report.analysis.reachability?.removable?.length ? [{ severity: "information", code: "UNREACHABLE_RUNTIME", message: `${report.analysis.reachability.removable.length} isolated code blocks are unreachable candidates: ${report.analysis.reachability.removable.slice(0, 12).map((item) => item.name).join(", ")}${report.analysis.reachability.removable.length > 12 ? "..." : ""}. They remain present until assembly and runtime proof passes.` }] : [];
    const profileEvidence = [{ severity: "information", code: "MICRO_RUNTIME_PROFILE", message: `Required: ${report.analysis.featureProfile?.required.map((item) => item.id).join(", ") || "startup only"}. Omitted: ${report.analysis.featureProfile?.omitted.map((item) => item.id).join(", ") || "none"}.` }];
    const tinyEvidence = tiny ? [
      { severity: "caution", code: `TINY_SOUND_${tiny.status}`, message: tiny.approximations.join(" ") },
      ...tiny.rejectedBlocks.map((item) => ({ severity: "caution", code: `TINY_REJECTED_${item.name}`, message: item.reason }))
    ] : [];
    $("findings").innerHTML = cards([...tinyEvidence, ...dialectEvidence, ...profileEvidence, ...deadCodeEvidence, ...report.analysis.safetyFindings], (item) => `<b>${item.code}</b><br>${item.message}`, "No static safety finding. Runtime proof may still be required.");
    $("saveAction").disabled = false;
    for (const option of $("saveAction").options) {
      option.disabled = (option.value === "os7" && !result.os7Asm) ||
        (option.value === "os7rom" && (!result.os7Rom || report.os7?.status === "REJECTED_RUNTIME")) ||
        (option.value === "compact" && !result.compactAsm) ||
        (option.value === "compactrom" && (!result.compactRom || report.compact?.status === "REJECTED_RUNTIME")) ||
        (option.value === "purecv" && !result.pureCvAsm) ||
        (option.value === "tinysound" && !result.tinySound?.firstSongLabel) ||
        (option.value === "amymusic" && !result.amyMusic?.asm) ||
        (option.value === "amymusicrom" && !result.amyMusic?.rom) ||
        (option.value === "purecvrom" && (!result.pureCvRom || report.pureCv?.status === "REJECTED_RUNTIME"));
    }
    if (result.policy?.runtime === "amy-os7") {
      $("saveAction").value = result.amyMusic?.asm ? "amymusic" : (result.pureCvAsm ? "purecv" : "optimized");
      const preferredView = result.amyMusic?.asm ? "amymusic" : "purecv";
      document.querySelector(`[data-output-tab="${preferredView}"]`)?.click();
    } else if ($("saveAction").selectedOptions[0]?.disabled) {
      $("saveAction").value = "optimized";
    }
    $("save").disabled = false;
  } catch (error) {
    const message = error instanceof TypeError && /fetch/i.test(error.message)
      ? "the Node backend is unavailable; run npm start or deploy the Docker/Node application"
      : error.message;
    $("metrics").innerHTML = `<span>FAILED: ${message}</span>`;
  } finally { $("run").disabled = false; }
});

function download(name, contents, type) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([contents], { type }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

reportServerCapabilities();

const saveActions = {
  refined: () => download("game.refined.asm", lastResult.refinedAsm, "text/plain"),
  optimized: () => download("game.amy-opt.asm", lastResult.optimizedAsm, "text/plain"),
  compact: () => download("game.compact-cv.asm", lastResult.compactAsm, "text/plain"),
  os7: () => download("game.os7-engineered.asm", lastResult.os7Asm, "text/plain"),
  purecv: () => download("game.pure-cv.asm", lastResult.pureCvAsm, "text/plain"),
  tinysound: () => download("game.tiny-sound.asm", lastResult.tinySound.asm, "text/plain"),
  amymusic: () => download(`game.amy-os7-music.${lastResult.amyMusic.outputDialect || "native"}.asm`, lastResult.amyMusic.asm, "text/plain"),
  rom: () => {
    const raw = atob(lastResult.optimizedRom);
    download("game.candidate.rom", Uint8Array.from(raw, (character) => character.charCodeAt(0)), "application/octet-stream");
  },
  compactrom: () => {
    const raw = atob(lastResult.compactRom);
    download("game.compact-cv.rom", Uint8Array.from(raw, (character) => character.charCodeAt(0)), "application/octet-stream");
  },
  os7rom: () => {
    const raw = atob(lastResult.os7Rom);
    download("game.os7-engineered.rom", Uint8Array.from(raw, (character) => character.charCodeAt(0)), "application/octet-stream");
  },
  purecvrom: () => {
    const raw = atob(lastResult.pureCvRom);
    download("game.pure-cv.rom", Uint8Array.from(raw, (character) => character.charCodeAt(0)), "application/octet-stream");
  },
  amymusicrom: () => {
    const raw = atob(lastResult.amyMusic.rom);
    download("game.amy-os7-music.rom", Uint8Array.from(raw, (character) => character.charCodeAt(0)), "application/octet-stream");
  }
};

$("save").addEventListener("click", () => saveActions[$("saveAction").value]?.());

for (const button of document.querySelectorAll("[data-output-tab]")) {
  button.addEventListener("click", () => {
    const view = button.dataset.outputTab;
    for (const tab of document.querySelectorAll("[data-output-tab]")) tab.classList.toggle("is-active", tab === button);
    for (const panel of document.querySelectorAll("[data-output-panel]")) panel.classList.toggle("is-active", panel.dataset.outputPanel === view);
  });
}

for (const button of document.querySelectorAll("[data-analysis-tab]")) {
  button.addEventListener("click", () => {
    const view = button.dataset.analysisTab;
    for (const tab of document.querySelectorAll("[data-analysis-tab]")) tab.classList.toggle("is-active", tab === button);
    for (const panel of document.querySelectorAll("[data-analysis-panel]")) panel.classList.toggle("is-active", panel.dataset.analysisPanel === view);
  });
}

for (const button of document.querySelectorAll("[data-view-tab]")) {
  button.addEventListener("click", () => {
    const view = button.dataset.viewTab;
    for (const tab of document.querySelectorAll("[data-view-tab]")) tab.classList.toggle("is-active", tab === button);
    for (const panel of document.querySelectorAll("[data-view-panel]")) panel.classList.toggle("is-view-active", panel.dataset.viewPanel === view);
  });
}
