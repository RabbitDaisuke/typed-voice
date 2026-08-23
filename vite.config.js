import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const isCodespaces = process.env.CODESPACES === "true";
const rootDirectory = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  base: "./",
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
    hmr: isCodespaces ? false : undefined,
  },
  build: {
    target: "es2022",
    manifest: true,
    rollupOptions: {
      input: {
        app: resolve(rootDirectory, "index.html"),
        worker: resolve(rootDirectory, "worker.html"),
        pairing: resolve(rootDirectory, "pairing.html"),
        poc: resolve(rootDirectory, "poc.html"),
        licenses: resolve(rootDirectory, "licenses.html"),
      },
    },
  },
  worker: {
    format: "es",
  },
});