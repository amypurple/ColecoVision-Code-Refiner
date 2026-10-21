let pending = null;
let sequence = 0;

function waitForFileSystem(context, retries = 0) {
  if (context.FS && context.Module?.callMain) {
    pending?.resolve(context);
    return;
  }
  if (retries >= 100) {
    pending?.reject(new Error("CVBasic browser compiler did not initialize"));
    return;
  }
  setTimeout(() => waitForFileSystem(context, retries + 1), 50);
}

globalThis.CvBasicBrowser = {
  createModule() {
    return {
      preRun: [],
      postRun: [],
      print(text) { pending?.output.push(String(text)); },
      printErr(text) { pending?.output.push(String(text)); },
      setStatus() {},
      monitorRunDependencies() {}
    };
  },
  handleIframe(context) {
    waitForFileSystem(context);
  }
};

function compilerContext() {
  if (pending) throw new Error("CVBasic compilation is already running");
  return new Promise((resolve, reject) => {
    pending = { resolve, reject, output: [] };
    const iframe = document.createElement("iframe");
    iframe.hidden = true;
    iframe.dataset.cvbasicCompiler = "true";
    iframe.src = `vendor/cvbasic/cvbasic-iframe.html?run=${sequence += 1}`;
    iframe.addEventListener("error", () => reject(new Error("CVBasic browser compiler failed to load")), { once: true });
    document.body.appendChild(iframe);
  });
}

export async function compileCvbasicInBrowser(source) {
  const context = await compilerContext();
  const output = pending.output;
  try {
    context.FS.writeFile("game.bas", source, { encoding: "utf8" });
    context.Module.callMain(["game.bas", "game.asm"]);
    const generated = context.FS.readFile("game.asm", { encoding: "utf8" });
    const assembly = typeof generated === "string"
      ? generated
      : generated instanceof Uint8Array
        ? new TextDecoder().decode(generated)
        : null;
    if (!assembly?.trim()) {
      const files = context.FS.readdir("/").join(", ");
      throw new Error(`CVBasic produced no readable game.asm (virtual files: ${files})`);
    }
    return {
      assembly,
      diagnostics: output.join("\n")
    };
  } catch (error) {
    throw new Error(`${output.join("\n")}\n${error.message}`.trim());
  } finally {
    document.querySelector('iframe[data-cvbasic-compiler="true"]')?.remove();
    pending = null;
  }
}
