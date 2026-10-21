import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const port = Number(process.env.PORT || 8092);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm"
};

createServer(async (request, response) => {
  try {
    const cleanUrl = request.url.split("?")[0];
    const requested = cleanUrl === "/" ? "index.html" : cleanUrl.endsWith("/") ? `${cleanUrl.slice(1)}index.html` : cleanUrl.slice(1);
    if (!/^[\w./-]+$/.test(requested) || requested.includes("..")) throw new Error("invalid path");
    const contents = await readFile(resolve(root, requested));
    response.writeHead(200, { "content-type": types[extname(requested)] || "application/octet-stream" });
    response.end(contents);
  } catch {
    console.warn(`404 ${request.url}`);
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`Static-only Refiner: http://127.0.0.1:${port}`));
