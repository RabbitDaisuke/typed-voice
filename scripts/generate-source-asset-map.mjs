import { createReadStream } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { createXXHash128 } from "hash-wasm";

const outputDirectory = resolve(process.argv[2] || "dist");
const outputFileName = "source-asset-map.json";
const serviceWorkerFileName = "app-service-worker.js";
const serviceWorkerReviewPlaceholder = "__TYPED_VOICE_SERVICE_WORKER_REVIEW_ID__";
const excludedFiles = new Set([
  outputFileName,
  serviceWorkerFileName,
  "quick-fix.js",
  ".vite/manifest.json",
]);

const viteManifestPath = join(outputDirectory, ".vite", "manifest.json");
const projectDirectory = resolve(".");
const buildNumber = /^\d+$/.test(String(process.env.GITHUB_RUN_NUMBER || ""))
  ? String(process.env.GITHUB_RUN_NUMBER)
  : null;

async function fallbackOriginalFiles(relativePath) {
  if (["index.html", "worker.html", "pairing.html", "poc.html", "licenses.html"].includes(relativePath)) {
    return [relativePath];
  }
  try {
    const info = await stat(join(projectDirectory, "public", relativePath));
    if (info.isFile()) return [`public/${relativePath}`];
  } catch {
    // Unknown build origin is represented by an empty list.
  }
  return [];
}

function collectManifestFiles(viteManifest, rootKey, { includeDynamic = false } = {}) {
  const files = new Set();
  const visited = new Set();
  const visit = (key) => {
    if (!key || visited.has(key)) return;
    visited.add(key);
    const entry = viteManifest[key];
    if (!entry) return;
    if (entry.file) files.add(entry.file);
    for (const css of entry.css || []) files.add(css);
    for (const asset of entry.assets || []) files.add(asset);
    for (const imported of entry.imports || []) visit(imported);
    if (includeDynamic) {
      for (const imported of entry.dynamicImports || []) visit(imported);
    }
  };
  visit(rootKey);
  return files;
}

function findManifestKey(viteManifest, suffix) {
  return Object.entries(viteManifest).find(([key, entry]) => (
    key === suffix
    || key.endsWith(`/${suffix}`)
    || entry?.src === suffix
    || String(entry?.src || "").endsWith(`/${suffix}`)
  ))?.[0] || null;
}

function classifyAsset(path, sets) {
  if (sets.core.has(path) || path === "index.html" || path === "worker.html" || path === "voice-manifest.json") return "core";
  if (sets.client.has(path)) return "client";
  if (sets.engine.has(path)
    || /(?:^|\/)(?:engine(?:\.worker|-client)|kanalizer-normalizer)-/i.test(path)
    || /(?:^|\/)(?:kanalizer_browser_bg|dictionary-)/i.test(path)) return "engine";
  return "optional";
}

async function listFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

async function xxh3_128File(path) {
  const hasher = await createXXHash128();
  for await (const chunk of createReadStream(path)) hasher.update(chunk);
  return hasher.digest();
}

async function buildServiceWorkerReview() {
  const path = join(outputDirectory, serviceWorkerFileName);
  const source = await readFile(path, "utf8");
  const placeholderCount = source.split(serviceWorkerReviewPlaceholder).length - 1;
  if (placeholderCount !== 1) throw new Error(`Expected one Service Worker review placeholder, found ${placeholderCount}.`);
  const hasher = await createXXHash128();
  hasher.update(new TextEncoder().encode(source));
  const reviewId = hasher.digest();
  const rendered = source.replace(serviceWorkerReviewPlaceholder, reviewId);
  await writeFile(path, rendered, "utf8");
  return Object.freeze({
    path: serviceWorkerFileName,
    byteSize: Buffer.byteLength(rendered),
    xxh3_128: reviewId,
    buildNumber,
  });
}

function portablePath(path) {
  return path.split(sep).join("/");
}

const viteManifest = JSON.parse(await readFile(viteManifestPath, "utf8"));
const outputOrigins = new Map(Object.entries(viteManifest)
  .filter(([, entry]) => entry?.file)
  .map(([key, entry]) => [entry.file, [String(entry.src || key)]]));
const indexKey = findManifestKey(viteManifest, "index.html");
const workerKey = findManifestKey(viteManifest, "worker.html");
const engineKey = findManifestKey(viteManifest, "src/app/voice-runtime-adapter.js");
const clientKey = findManifestKey(viteManifest, "src/app/remote-voice-runtime.js");
const groups = {
  core: collectManifestFiles(viteManifest, indexKey),
  engine: collectManifestFiles(viteManifest, engineKey, { includeDynamic: true }),
  client: collectManifestFiles(viteManifest, clientKey, { includeDynamic: true }),
};
for (const file of collectManifestFiles(viteManifest, workerKey)) groups.core.add(file);

// main.js dynamically imports one thin runtime adapter before the tutorial can
// be shown. Those adapters and their *static* dependency graphs are therefore
// bootstrap code, not deferred engine/client payloads. Their own dynamic
// imports (EngineClient, Kanalizer, ORT, etc.) stay in engine/client and remain
// behind the main app's download/update consent. worker.html fetches its own
// Vite-resolved same-origin runtime directly through the Service Worker path.
for (const bootstrapKey of [engineKey, clientKey]) {
  for (const file of collectManifestFiles(viteManifest, bootstrapKey)) groups.core.add(file);
}
for (const file of groups.core) {
  groups.engine.delete(file);
  groups.client.delete(file);
}

const assets = {};
const files = (await listFiles(outputDirectory))
  .map((path) => ({ path, relativePath: portablePath(relative(outputDirectory, path)) }))
  .filter(({ relativePath }) => !excludedFiles.has(relativePath))
  .sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));

for (const file of files) {
  const info = await stat(file.path);
  const originalFiles = outputOrigins.get(file.relativePath) || [];
  assets[file.relativePath] = {
    byteSize: info.size,
    extension: extname(file.relativePath).toLowerCase(),
    group: classifyAsset(file.relativePath, groups),
    xxh3_128: await xxh3_128File(file.path),
    buildNumber,
    originalFiles: originalFiles.length > 0 ? originalFiles : await fallbackOriginalFiles(file.relativePath),
  };
}

const generationHasher = await createXXHash128();
const generationAssets = Object.fromEntries(Object.entries(assets).map(([path, entry]) => [path, {
  byteSize: entry.byteSize,
  extension: entry.extension,
  group: entry.group,
  xxh3_128: entry.xxh3_128,
}]));
generationHasher.update(new TextEncoder().encode(JSON.stringify(generationAssets)));
const generation = generationHasher.digest();
const serviceWorker = await buildServiceWorkerReview();

const manifest = {
  version: 2,
  algorithm: "xxh3-128",
  buildNumber,
  generation,
  serviceWorker,
  assets,
};

await writeFile(
  join(outputDirectory, outputFileName),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

console.log(`Generated ${outputFileName} for ${Object.keys(assets).length} assets.`);
