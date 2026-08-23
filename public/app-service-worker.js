/*
 * Cross-origin isolation response rewriting is derived from coi-serviceworker:
 * https://github.com/gzuidhof/coi-serviceworker
 * Copyright (c) Guido Zuidhof and contributors, MIT License.
 */

const MODEL_CACHE = "typed-voice-model-assets-v2";
const KANALIZER_MODEL_CACHE = "typed-voice-kanalizer-model-v1";
const SOURCE_CACHE_PREFIX = "typed-voice-source-";
const SOURCE_METADATA_CACHE = "typed-voice-source-metadata-v1";
const OFFLINE_TUTORIAL_CACHE = "typed-voice-offline-tutorial-v1";
const PAIRING_ON_DEMAND_CACHE_PREFIX = "typed-voice-pairing-on-demand-";
const HUGGINGFACE_RESOLVE_CACHE = "typed-voice-huggingface-resolve-v1";
const ORT_RUNTIME_CACHE = "typed-voice-onnxruntime-web-1.27.0";
const ORT_DIST_BASE_URL = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";
const ORT_RUNTIME_ASSETS = Object.freeze([
  Object.freeze({ url: `${ORT_DIST_BASE_URL}ort.min.js`, byteSize: 360434 }),
  Object.freeze({ url: `${ORT_DIST_BASE_URL}ort-wasm-simd-threaded.jsep.mjs`, byteSize: 46614 }),
  Object.freeze({ url: `${ORT_DIST_BASE_URL}ort-wasm-simd-threaded.jsep.wasm`, byteSize: 26827543 }),
]);
const ORT_RUNTIME_URLS = new Set(ORT_RUNTIME_ASSETS.map((asset) => asset.url));
const OFFLINE_TUTORIAL_URL = new URL("offline-tutorial-required.html", self.registration.scope).href;
const SOURCE_ASSET_MAP_URL = new URL("source-asset-map.json", self.registration.scope).href;
const SOURCE_LATEST_REVIEW_URL = new URL("__typed_voice_source/latest-review.json", self.registration.scope).href;
const QUICK_FIX_URL = new URL("quick-fix.js", self.registration.scope).href;
const QUICK_FIX_APPLIED_URL = new URL("__typed_voice_source/quick-fix-applied.json", self.registration.scope).href;
const SOURCE_STATE_URL = new URL("__typed_voice_source/state-v1.json", self.registration.scope).href;
const SOURCE_VERIFY_URL = new URL("__typed_voice_source/verify", self.registration.scope);
const MODEL_PREFIX = new URL("__typed_voice_assets/", self.registration.scope).pathname;
const DIRECT_WORKER_RUNTIME_REGISTER_URL = new URL("__typed_voice_worker_runtime/register", self.registration.scope);
const MODEL_CHUNK_QUERY = "__typed_voice_part";
const MODEL_DOWNLOAD_LOCK_LEASE_MS = 2 * 60 * 1000;
const MODEL_DOWNLOAD_LOCK_RETRY_MS = 500;
const SOURCE_PROTOCOL_VERSION = 2;
const SERVICE_WORKER_REVIEW_ID = "__TYPED_VOICE_SERVICE_WORKER_REVIEW_ID__";
const LOAD_REPAIR_KEY = "typed-voice-load-repair";
const LOAD_TRANSITION_HTML = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>typed-voice</title>
  <style>
    html,body{margin:0;min-height:100%;background:#f3f1ed;color:#2f2b27}
    body{min-height:100vh;display:grid;place-items:center;text-align:center;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
    h1{margin:0;padding:24px;font-size:clamp(1.35rem,4vw,2rem)}
  </style>
</head>
<body>
  <h1>読み込み中です... しばらくお待ちください</h1>
  <script>
    const key = ${JSON.stringify(LOAD_REPAIR_KEY)};
    const load = async () => {
      const response = await fetch(location.href);
      const html = await response.text();
      document.open();
      document.write(html);
      document.close();
    };
    if (localStorage.getItem(key) === "1") {
      void load();
    } else {
      localStorage.setItem(key, "1");
      setTimeout(() => void load(), 300);
    }
  </script>
</body>
</html>`;

const modelDownloadLocks = new Map();
const sourceApplyControllers = new Map();
const sourceClientGenerations = new Map();
const directWorkerRuntimeClients = new Set();
const DEV_MODE = new URL(self.location.href).searchParams.get("dev") === "1";
const REQUEST_LOG_LIMIT = 512;
const requestLog = [];
let candidateSourceAssetMapPromise = null;

function recordRequest(request, route, status, reason = "") {
  requestLog.push({
    time: new Date().toISOString(),
    method: request.method,
    url: request.url,
    destination: request.destination || "",
    mode: request.mode,
    route,
    status,
    reason,
  });
  if (requestLog.length > REQUEST_LOG_LIMIT) requestLog.splice(0, requestLog.length - REQUEST_LOG_LIMIT);
}

async function tracedResponse(request, route, responsePromise, reason = "") {
  try {
    const response = await responsePromise;
    recordRequest(request, route, response.status, reason || response.statusText || "");
    return response;
  } catch (error) {
    recordRequest(request, route, "ERROR", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

function isExplicitlyOffline() {
  return self.navigator?.onLine === false;
}

function sourceGroupsNeedOrtRuntime(groups) {
  return Array.isArray(groups) && groups.includes("engine");
}

async function planOrtRuntimeAssets(groups) {
  if (!sourceGroupsNeedOrtRuntime(groups)) {
    return { totalBytes: 0, fetchBytes: 0, reusableBytes: 0, assetCount: 0, fetchCount: 0 };
  }
  const cache = await caches.open(ORT_RUNTIME_CACHE);
  let fetchBytes = 0;
  let reusableBytes = 0;
  let fetchCount = 0;
  for (const asset of ORT_RUNTIME_ASSETS) {
    if (await cache.match(asset.url)) reusableBytes += asset.byteSize;
    else {
      fetchBytes += asset.byteSize;
      fetchCount += 1;
    }
  }
  return {
    totalBytes: ORT_RUNTIME_ASSETS.reduce((sum, asset) => sum + asset.byteSize, 0),
    fetchBytes,
    reusableBytes,
    assetCount: ORT_RUNTIME_ASSETS.length,
    fetchCount,
  };
}

async function applyOrtRuntimeAssets(groups, { signal = null } = {}) {
  if (!sourceGroupsNeedOrtRuntime(groups)) return { networkBytes: 0, reusedBytes: 0, fetchedCount: 0 };
  const cache = await caches.open(ORT_RUNTIME_CACHE);
  let networkBytes = 0;
  let reusedBytes = 0;
  let fetchedCount = 0;
  for (const asset of ORT_RUNTIME_ASSETS) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Source update cancelled", "AbortError");
    if (await cache.match(asset.url)) {
      reusedBytes += asset.byteSize;
      continue;
    }
    const response = await fetch(asset.url, { cache: "no-cache", signal });
    if (!response.ok) throw new Error(`ONNX Runtime Web asset fetch failed: ${response.status} ${asset.url}`);
    await cache.put(asset.url, response.clone());
    networkBytes += asset.byteSize;
    fetchedCount += 1;
  }
  return { networkBytes, reusedBytes, fetchedCount };
}

async function readOrtRuntimeAsset(request) {
  const cache = await caches.open(ORT_RUNTIME_CACHE);
  const cached = await cache.match(request.url);
  if (cached) return cached;
  if (isExplicitlyOffline()) {
    return new Response("ONNX Runtime Web asset is unavailable offline", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const response = await fetch(request);
  if (response.ok) await cache.put(request.url, response.clone());
  return response;
}

/*
self.reloadTypedVoiceWindows = async function reloadTypedVoiceWindows() {
  const scopeUrl = new URL(self.registration.scope);
  const indexPath = new URL("index.html", scopeUrl).pathname;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: false });
  await Promise.all(windows.map(async (client) => {
    try {
      const clientUrl = new URL(client.url);
      if (clientUrl.origin !== scopeUrl.origin) return;
      if (clientUrl.pathname !== scopeUrl.pathname && clientUrl.pathname !== indexPath) return;
      await client.navigate(client.url);
    } catch {
      // Best-effort emergency reload only.
    }
  }));
};
*/

async function readAppliedQuickFixVersions() {
  const cache = await caches.open(SOURCE_METADATA_CACHE);
  const response = await cache.match(QUICK_FIX_APPLIED_URL);
  if (!response) return null;
  const versions = await response?.json().catch(() => []);
  return Array.isArray(versions) ? versions.filter((version) => typeof version === "string") : [];
}

async function writeAppliedQuickFixVersions(versions) {
  const cache = await caches.open(SOURCE_METADATA_CACHE);
  await cache.put(QUICK_FIX_APPLIED_URL, new Response(JSON.stringify([...new Set(versions)])));
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    let sourceManifestFetchFailed = false;
    try {
      await fetch(SOURCE_ASSET_MAP_URL, { cache: "no-store" });
    } catch {
      sourceManifestFetchFailed = true;
    }
    if (!sourceManifestFetchFailed) {
      importScripts(QUICK_FIX_URL);
      if (Array.isArray(self.__typedVoiceQuickFixVersions)) {
        if (!self.registration.active) {
          await writeAppliedQuickFixVersions(self.__typedVoiceQuickFixVersions);
        }
      }
    }
    const response = await fetch(OFFLINE_TUTORIAL_URL, { cache: "reload" });
    if (!response.ok) throw new Error(`Offline tutorial page fetch failed: ${response.status}`);
    const cache = await caches.open(OFFLINE_TUTORIAL_CACHE);
    await cache.put(OFFLINE_TUTORIAL_URL, response);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    if (typeof self.__typedVoiceQuickFixActivate === "function") {
      const appliedVersions = await readAppliedQuickFixVersions() ?? [];
      await self.__typedVoiceQuickFixActivate(appliedVersions);
      await writeAppliedQuickFixVersions(appliedVersions);
    }
  })());
});

function sourceCacheName(generation) {
  return `${SOURCE_CACHE_PREFIX}${generation}`;
}

function isSourceGenerationCacheName(name) {
  return new RegExp(`^${SOURCE_CACHE_PREFIX}[0-9a-f]{32}$`).test(String(name || ""));
}

function isAnySourcePayloadCacheName(name) {
  const value = String(name || "");
  return value.startsWith(SOURCE_CACHE_PREFIX) && value !== SOURCE_METADATA_CACHE;
}

function sourceMapMetadataUrl(generation) {
  return new URL(`__typed_voice_source/maps/${encodeURIComponent(generation)}.json`, self.registration.scope).href;
}

function normalizeSourceAssetMap(raw) {
  const generation = String(raw?.generation || "").toLowerCase();
  if (raw?.version !== 2
    || raw?.algorithm !== "xxh3-128"
    || !/^[0-9a-f]{32}$/.test(generation)
    || !raw.assets
    || typeof raw.assets !== "object") {
    throw new Error("Source asset map is invalid");
  }
  const assets = Object.create(null);
  const serviceWorkerReviewId = String(raw?.serviceWorker?.xxh3_128 || "").toLowerCase();
  const serviceWorker = /^[0-9a-f]{32}$/.test(serviceWorkerReviewId)
    ? Object.freeze({
        path: "app-service-worker.js",
        xxh3_128: serviceWorkerReviewId,
        byteSize: Number(raw?.serviceWorker?.byteSize) || 0,
        buildNumber: /^\d+$/.test(String(raw?.serviceWorker?.buildNumber || ""))
          ? String(raw.serviceWorker.buildNumber)
          : null,
      })
    : null;
  const buildNumber = /^\d+$/.test(String(raw?.buildNumber || "")) ? String(raw.buildNumber) : null;
  for (const [path, entry] of Object.entries(raw.assets)) {
    const normalizedPath = normalizeSourcePath(path);
    const xxh3_128 = String(entry?.xxh3_128 || "").toLowerCase();
    const byteSize = Number(entry?.byteSize);
    const extension = String(entry?.extension || "").toLowerCase();
    const group = ["core", "client", "engine", "optional"].includes(entry?.group) ? entry.group : "optional";
    const assetBuildNumber = /^\d+$/.test(String(entry?.buildNumber || "")) ? String(entry.buildNumber) : null;
    const originalFiles = Array.isArray(entry?.originalFiles)
      ? entry.originalFiles.map((item) => String(item || "")).filter(Boolean)
      : [];
    if (!normalizedPath || !/^[0-9a-f]{32}$/.test(xxh3_128)) continue;
    if (!Number.isSafeInteger(byteSize) || byteSize < 0) continue;
    assets[normalizedPath] = Object.freeze({ xxh3_128, byteSize, extension, group, buildNumber: assetBuildNumber, originalFiles: Object.freeze(originalFiles) });
  }
  return Object.freeze({ version: 2, algorithm: "xxh3-128", buildNumber, generation, serviceWorker, assets: Object.freeze(assets) });
}

function normalizeSourcePath(path) {
  const value = String(path || "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!value || value.startsWith("/") || value.includes("../")) return null;
  return value;
}

function defaultSourceState() {
  return {
    version: 1,
    acceptedGeneration: null,
    locations: Object.create(null),
    invalidated: Object.create(null),
  };
}

function normalizeSourceState(raw) {
  const state = defaultSourceState();
  const acceptedGeneration = String(raw?.acceptedGeneration || "").toLowerCase();
  if (/^[0-9a-f]{32}$/.test(acceptedGeneration)) state.acceptedGeneration = acceptedGeneration;
  if (raw?.locations && typeof raw.locations === "object") {
    for (const [key, value] of Object.entries(raw.locations)) {
      const cacheName = String(value?.cacheName || "");
      const path = normalizeSourcePath(value?.path);
      if (!key || !isSourceGenerationCacheName(cacheName) || !path) continue;
      state.locations[key] = { cacheName, path };
    }
  }
  if (raw?.invalidated && typeof raw.invalidated === "object") {
    for (const [key, value] of Object.entries(raw.invalidated)) {
      const generation = String(value?.generation || "").toLowerCase();
      const path = normalizeSourcePath(value?.path);
      if (!key || !/^[0-9a-f]{32}$/.test(generation) || !path) continue;
      state.invalidated[key] = { generation, path };
    }
  }
  return state;
}

async function loadSourceState() {
  const cache = await caches.open(SOURCE_METADATA_CACHE);
  const response = await cache.match(SOURCE_STATE_URL);
  if (!response) return defaultSourceState();
  try {
    return normalizeSourceState(await response.json());
  } catch {
    return defaultSourceState();
  }
}

async function saveSourceState(state) {
  const cache = await caches.open(SOURCE_METADATA_CACHE);
  await cache.put(SOURCE_STATE_URL, new Response(JSON.stringify(state), {
    headers: { "content-type": "application/json" },
  }));
}

async function storeSourceAssetMap(manifest) {
  const cache = await caches.open(SOURCE_METADATA_CACHE);
  const response = new Response(JSON.stringify(manifest), {
    headers: { "content-type": "application/json" },
  });
  let latestReview = manifest;
  const previousLatestReview = await cache.match(SOURCE_LATEST_REVIEW_URL);
  if (previousLatestReview) {
    try {
      const previous = normalizeSourceAssetMap(await previousLatestReview.json());
      latestReview = {
        ...manifest,
        serviceWorker: manifest.serviceWorker
          ? {
              ...manifest.serviceWorker,
              buildNumber: previous.serviceWorker?.xxh3_128 === manifest.serviceWorker.xxh3_128
                ? previous.serviceWorker.buildNumber
                : manifest.serviceWorker.buildNumber,
            }
          : null,
        assets: Object.fromEntries(Object.entries(manifest.assets).map(([path, entry]) => {
          const previousEntry = previous.assets[path];
          const unchanged = previousEntry && sourceReuseKey(path, previousEntry) === sourceReuseKey(path, entry);
          return [path, { ...entry, buildNumber: unchanged ? previousEntry.buildNumber : entry.buildNumber }];
        })),
      };
    } catch {
      latestReview = manifest;
    }
  }
  const latestReviewResponse = new Response(JSON.stringify(latestReview), {
    headers: { "content-type": "application/json" },
  });
  await Promise.all([
    cache.put(sourceMapMetadataUrl(manifest.generation), response.clone()),
    cache.put(SOURCE_LATEST_REVIEW_URL, latestReviewResponse),
    // source-asset-map.json cannot be part of the hashed asset list because it
    // contains the generation derived from that list. Keep the manifest itself
    // as bootstrap metadata at its public URL so an accepted source cache does
    // not become unusable merely because the network copy is unavailable.
    cache.put(SOURCE_ASSET_MAP_URL, response),
  ]);
}

async function loadSourceAssetMap(generation) {
  if (!/^[0-9a-f]{32}$/.test(String(generation || ""))) return null;
  const cache = await caches.open(SOURCE_METADATA_CACHE);
  const response = await cache.match(sourceMapMetadataUrl(generation));
  if (!response) return null;
  try {
    return normalizeSourceAssetMap(await response.json());
  } catch {
    return null;
  }
}

async function loadCachedCandidateSourceAssetMap() {
  const cache = await caches.open(SOURCE_METADATA_CACHE);
  const response = await cache.match(SOURCE_ASSET_MAP_URL);
  if (!response) return null;
  try {
    return normalizeSourceAssetMap(await response.json());
  } catch {
    await cache.delete(SOURCE_ASSET_MAP_URL);
    return null;
  }
}

async function fetchCandidateSourceAssetMap() {
  if (isExplicitlyOffline()) throw new Error("Offline");
  if (!candidateSourceAssetMapPromise) {
    candidateSourceAssetMapPromise = (async () => {
      const response = await fetch(SOURCE_ASSET_MAP_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`Source asset map fetch failed: ${response.status}`);
      const manifest = normalizeSourceAssetMap(await response.json());
      await storeSourceAssetMap(manifest);
      return manifest;
    })().catch((error) => {
      candidateSourceAssetMapPromise = null;
      throw error;
    });
  }
  return candidateSourceAssetMapPromise;
}

async function getCandidateSourceAssetMap({ allowCachedFallback = true } = {}) {
  try {
    return await fetchCandidateSourceAssetMap();
  } catch (error) {
    if (allowCachedFallback) {
      const cached = await loadCachedCandidateSourceAssetMap();
      if (cached) return cached;
    }
    throw error;
  }
}

function sourceReuseKey(path, entry) {
  return `${entry.xxh3_128}:${entry.byteSize}:${entry.extension || sourceExtension(path)}`;
}

function sourceExtension(path) {
  const match = /(?:^|\/)[^/]*(\.[A-Za-z0-9]+)$/.exec(path);
  return match ? match[1].toLowerCase() : "";
}

function sourceAssetUrl(path) {
  return new URL(path, self.registration.scope).href;
}

function sourceVerificationUrl(path) {
  const url = new URL(SOURCE_VERIFY_URL.href);
  url.searchParams.set("path", path);
  return url.href;
}

function sourcePathForRequest(request) {
  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return null;
  let path = url.pathname.slice(scope.pathname.length);
  if (!path || path === "/") path = "index.html";
  return normalizeSourcePath(path.replace(/^\//, ""));
}

function normalizeSourceGroups(groups) {
  const requested = Array.isArray(groups) ? groups : [];
  const result = new Set(requested.filter((group) => ["core", "client", "engine", "optional"].includes(group)));
  if (result.size === 0) result.add("core");
  return result;
}

function sourceEntriesForGroups(manifest, groups) {
  const selected = normalizeSourceGroups(groups);
  return Object.entries(manifest?.assets || {}).filter(([, entry]) => selected.has(entry.group));
}

function sourceGroupSignature(manifest, groups) {
  return sourceEntriesForGroups(manifest, groups)
    .map(([path, entry]) => sourceReuseKey(path, entry))
    .sort()
    .join("\n");
}

async function sourceLocationResponse(state, reuseKey) {
  const location = state.locations[reuseKey];
  if (!location) return null;
  try {
    const cache = await caches.open(location.cacheName);
    const response = await cache.match(sourceAssetUrl(location.path));
    if (response) return response;
  } catch {
    // A transient CacheStorage read failure is not proof that the payload is
    // gone. Keep the location so repair/pruning cannot silently delete data.
    return null;
  }
  delete state.locations[reuseKey];
  return null;
}

function sourceRepairMarker(state, generation, path, entry) {
  const marker = state.invalidated?.[sourceReuseKey(path, entry)];
  return marker?.generation === generation && marker?.path === path ? marker : null;
}

function markSourceRepairRequired(state, generation, path, entry) {
  state.invalidated[sourceReuseKey(path, entry)] = { generation, path };
}

async function repairCandidateLocationsFromCache(candidate, state, groups) {
  const cacheName = sourceCacheName(candidate.generation);
  const cache = await caches.open(cacheName);
  let changed = false;
  for (const [path, entry] of sourceEntriesForGroups(candidate, groups)) {
    const reuseKey = sourceReuseKey(path, entry);
    if (state.locations[reuseKey]) continue;
    const response = await cache.match(sourceAssetUrl(path));
    if (!response) continue;
    state.locations[reuseKey] = { cacheName, path };
    changed = true;
  }
  if (changed) await saveSourceState(state);
  return changed;
}

async function getSourceVerificationPlan({ groups } = {}) {
  const state = await loadSourceState();
  const accepted = state.acceptedGeneration
    ? await loadSourceAssetMap(state.acceptedGeneration)
    : null;
  if (!accepted) {
    return {
      generation: state.acceptedGeneration,
      entries: [],
      availableBytes: 0,
      missingBytes: 0,
      missingCount: 0,
    };
  }

  const entries = [];
  let availableBytes = 0;
  let missingBytes = 0;
  let missingCount = 0;
  for (const [path, entry] of sourceEntriesForGroups(accepted, groups)) {
    const reuseKey = sourceReuseKey(path, entry);
    if (sourceRepairMarker(state, accepted.generation, path, entry)) {
      missingBytes += entry.byteSize;
      missingCount += 1;
      continue;
    }
    // An accepted manifest entry is not necessarily a persisted source asset.
    // Initial installs intentionally have no source payload cache yet. Only
    // verify files for which we have previously recorded a concrete location.
    if (!state.locations[reuseKey]) continue;
    const cached = await sourceLocationResponse(state, reuseKey);
    if (!cached) {
      markSourceRepairRequired(state, accepted.generation, path, entry);
      missingBytes += entry.byteSize;
      missingCount += 1;
      continue;
    }
    availableBytes += entry.byteSize;
    entries.push({
      path,
      byteSize: entry.byteSize,
      xxh3_128: entry.xxh3_128,
      url: sourceVerificationUrl(path),
    });
  }
  await saveSourceState(state);
  return {
    generation: accepted.generation,
    entries,
    availableBytes,
    missingBytes,
    missingCount,
  };
}

async function invalidateAcceptedSourceAsset({ generation, path } = {}) {
  const normalizedGeneration = String(generation || "").toLowerCase();
  const normalizedPath = normalizeSourcePath(path);
  if (!normalizedPath || !/^[0-9a-f]{32}$/.test(normalizedGeneration)) return false;
  const state = await loadSourceState();
  if (state.acceptedGeneration !== normalizedGeneration) return false;
  const accepted = await loadSourceAssetMap(normalizedGeneration);
  const entry = accepted?.assets?.[normalizedPath];
  if (!entry) return false;
  const reuseKey = sourceReuseKey(normalizedPath, entry);
  const location = state.locations[reuseKey] ?? null;
  const urlsToDelete = new Set([
    sourceAssetUrl(normalizedPath),
    ...(location?.path ? [sourceAssetUrl(location.path)] : []),
  ]);
  for (const cacheName of (await caches.keys()).filter(isAnySourcePayloadCacheName)) {
    const cache = await caches.open(cacheName);
    for (const url of urlsToDelete) await cache.delete(url);
  }
  delete state.locations[reuseKey];
  markSourceRepairRequired(state, normalizedGeneration, normalizedPath, entry);
  await saveSourceState(state);
  return true;
}

async function readSourceVerificationAsset(request) {
  const url = new URL(request.url);
  const path = normalizeSourcePath(url.searchParams.get("path"));
  if (!path) return new Response("Invalid source verification path", { status: 400 });
  const state = await loadSourceState();
  if (!state.acceptedGeneration) return new Response("No accepted source generation", { status: 404 });
  const accepted = await loadSourceAssetMap(state.acceptedGeneration);
  const entry = accepted?.assets?.[path];
  if (!entry) return new Response("Source asset is not part of the accepted generation", { status: 404 });
  const response = await sourceLocationResponse(state, sourceReuseKey(path, entry));
  await saveSourceState(state);
  if (!response) return new Response("Source asset is unavailable", { status: 404 });
  return response;
}

async function planSourceAssets({ groups, knownAcceptedKey = null } = {}) {
  const state = await loadSourceState();
  // A successful candidate lookup is shared while one page is starting, but it
  // must not hide a newer deployed manifest on a later online startup while the
  // same Service Worker instance is still alive.
  candidateSourceAssetMapPromise = null;
  let candidate;
  let sourceAssetMapNetworkAvailable = true;
  try {
    candidate = await getCandidateSourceAssetMap({ allowCachedFallback: false });
  } catch (error) {
    sourceAssetMapNetworkAvailable = false;
    if (!state.acceptedGeneration) throw error;
    candidate = await loadSourceAssetMap(state.acceptedGeneration);
    if (!candidate) throw error;
  }
  await repairCandidateLocationsFromCache(candidate, state, groups);
  const hadLegacyAcceptedSource = Boolean(String(knownAcceptedKey || ""));

  if (!state.acceptedGeneration && !hadLegacyAcceptedSource) {
    state.acceptedGeneration = candidate.generation;
    await saveSourceState(state);
  }

  const accepted = state.acceptedGeneration
    ? await loadSourceAssetMap(state.acceptedGeneration)
    : null;
  let missingAcceptedBytes = 0;
  let missingAcceptedCount = 0;
  for (const [path, entry] of sourceEntriesForGroups(accepted, groups)) {
    const reuseKey = sourceReuseKey(path, entry);
    if (sourceRepairMarker(state, accepted.generation, path, entry)) {
      missingAcceptedBytes += entry.byteSize;
      missingAcceptedCount += 1;
      continue;
    }
    // No location means this accepted asset has simply never been persisted.
    // That is normal on the first load and must not become a repair/update.
    if (!state.locations[reuseKey]) continue;
    if (await sourceLocationResponse(state, reuseKey)) continue;
    markSourceRepairRequired(state, accepted.generation, path, entry);
    missingAcceptedBytes += entry.byteSize;
    missingAcceptedCount += 1;
  }
  const generationChanged = state.acceptedGeneration
    ? state.acceptedGeneration !== candidate.generation
      && sourceGroupSignature(accepted, groups) !== sourceGroupSignature(candidate, groups)
    : hadLegacyAcceptedSource;
  const repairRequired = missingAcceptedCount > 0;
  const updateAvailable = generationChanged || repairRequired;

  let totalBytes = 0;
  let fetchBytes = 0;
  let reusableBytes = 0;
  let assetCount = 0;
  let fetchCount = 0;
  for (const [path, entry] of sourceEntriesForGroups(candidate, groups)) {
    assetCount += 1;
    totalBytes += entry.byteSize;
    const reuseKey = sourceReuseKey(path, entry);
    if (await sourceLocationResponse(state, reuseKey)) {
      reusableBytes += entry.byteSize;
    } else {
      fetchBytes += entry.byteSize;
      fetchCount += 1;
    }
  }
  const ortRuntimePlan = await planOrtRuntimeAssets(groups);
  totalBytes += ortRuntimePlan.totalBytes;
  fetchBytes += ortRuntimePlan.fetchBytes;
  reusableBytes += ortRuntimePlan.reusableBytes;
  assetCount += ortRuntimePlan.assetCount;
  fetchCount += ortRuntimePlan.fetchCount;
  await saveSourceState(state);
  return {
    generation: candidate.generation,
    acceptedGeneration: state.acceptedGeneration,
    updateAvailable,
    totalBytes,
    fetchBytes,
    reusableBytes,
    assetCount,
    fetchCount,
    generationChanged,
    repairRequired,
    missingAcceptedBytes,
    missingAcceptedCount,
    sourceAssetMapNetworkAvailable,
  };
}

async function applySourceAssets({ groups, signal = null, onProgress = () => {} } = {}) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Source update cancelled", "AbortError");
  const candidate = await getCandidateSourceAssetMap();
  const state = await loadSourceState();
  await repairCandidateLocationsFromCache(candidate, state, groups);
  const targetCacheName = sourceCacheName(candidate.generation);
  const targetCache = await caches.open(targetCacheName);
  let networkBytes = 0;
  let reusedBytes = 0;
  let fetchedCount = 0;
  let fetchBytes = 0;
  const work = [];

  for (const [path, entry] of sourceEntriesForGroups(candidate, groups)) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Source update cancelled", "AbortError");
    const reuseKey = sourceReuseKey(path, entry);
    const reused = await sourceLocationResponse(state, reuseKey);
    work.push({ path, entry, reuseKey, reused });
    if (!reused) fetchBytes += entry.byteSize;
  }

  onProgress({ loadedBytes: 0, totalBytes: fetchBytes });
  for (const { path, entry, reuseKey, reused } of work) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Source update cancelled", "AbortError");
    if (reused) {
      delete state.invalidated[reuseKey];
      reusedBytes += entry.byteSize;
      continue;
    }
    const response = await fetch(sourceAssetUrl(path), { cache: "no-cache", signal });
    if (!response.ok) throw new Error(`Source asset fetch failed: ${response.status} ${path}`);
    await targetCache.put(sourceAssetUrl(path), response.clone());
    state.locations[reuseKey] = { cacheName: targetCacheName, path };
    delete state.invalidated[reuseKey];
    await saveSourceState(state);
    networkBytes += entry.byteSize;
    fetchedCount += 1;
    onProgress({ path, loadedBytes: networkBytes, totalBytes: fetchBytes });
  }

  const ortRuntime = await applyOrtRuntimeAssets(groups, { signal });
  networkBytes += ortRuntime.networkBytes;
  reusedBytes += ortRuntime.reusedBytes;
  fetchedCount += ortRuntime.fetchedCount;

  if (signal?.aborted) throw signal.reason ?? new DOMException("Source update cancelled", "AbortError");
  state.acceptedGeneration = candidate.generation;
  await saveSourceState(state);
  return {
    generation: candidate.generation,
    networkBytes,
    reusedBytes,
    fetchedCount,
  };
}

async function pruneSourceCachesIfAllClientsCurrent(generation) {
  if (!/^[0-9a-f]{32}$/.test(String(generation || ""))) return false;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: false });
  if (windows.some((client) => sourceClientGenerations.get(client.id) !== generation)) return false;
  const state = await loadSourceState();
  if (state.acceptedGeneration !== generation) return false;
  const manifest = await loadSourceAssetMap(generation);
  if (!manifest) return false;
  await pruneSourceCaches(manifest, state);
  return true;
}

async function pruneSourceCaches(candidate, state) {
  const requiredKeys = new Set(
    Object.entries(candidate.assets).map(([path, entry]) => sourceReuseKey(path, entry))
  );
  for (const key of Object.keys(state.locations)) {
    if (!requiredKeys.has(key)) delete state.locations[key];
  }
  await saveSourceState(state);

  const keepUrlsByCache = new Map();
  for (const [reuseKey, location] of Object.entries(state.locations)) {
    if (!requiredKeys.has(reuseKey)) continue;
    let urls = keepUrlsByCache.get(location.cacheName);
    if (!urls) {
      urls = new Set();
      keepUrlsByCache.set(location.cacheName, urls);
    }
    urls.add(sourceAssetUrl(location.path));
  }

  for (const cacheName of (await caches.keys()).filter(isSourceGenerationCacheName)) {
    const keepUrls = keepUrlsByCache.get(cacheName) || new Set();
    const cache = await caches.open(cacheName);
    for (const request of await cache.keys()) {
      if (!keepUrls.has(request.url)) await cache.delete(request);
    }
    if ((await cache.keys()).length === 0) await caches.delete(cacheName);
  }
}

async function acceptedSourceResponse(path) {
  const state = await loadSourceState();
  if (!state.acceptedGeneration) return { managed: false, response: null, repairRequired: false };
  const accepted = await loadSourceAssetMap(state.acceptedGeneration);
  const entry = accepted?.assets?.[path];
  if (!entry) return { managed: false, response: null, repairRequired: false };
  const reuseKey = sourceReuseKey(path, entry);
  if (sourceRepairMarker(state, accepted.generation, path, entry)) {
    return { managed: true, response: null, repairRequired: true };
  }
  const hadLocation = Boolean(state.locations[reuseKey]);
  const cached = await sourceLocationResponse(state, reuseKey);
  if (cached) {
    await saveSourceState(state);
    return { managed: true, response: cached, repairRequired: false };
  }
  if (hadLocation) {
    markSourceRepairRequired(state, accepted.generation, path, entry);
    await saveSourceState(state);
    return { managed: true, response: null, repairRequired: true };
  }
  await saveSourceState(state);
  return { managed: true, response: null, repairRequired: false };
}

async function readNewerBootstrapSource(request, path) {
  const state = await loadSourceState();
  if (!state.acceptedGeneration) return null;
  const [accepted, candidate] = await Promise.all([
    loadSourceAssetMap(state.acceptedGeneration),
    getCandidateSourceAssetMap({ allowCachedFallback: false }).catch(() => null),
  ]);
  if (!candidate || candidate.generation === state.acceptedGeneration) return null;
  const candidateEntry = candidate.assets?.[path];
  if (!candidateEntry || candidateEntry.group !== "core") return null;
  const acceptedEntry = accepted?.assets?.[path] ?? null;
  if (acceptedEntry && sourceReuseKey(path, acceptedEntry) === sourceReuseKey(path, candidateEntry)) return null;
  try {
    const response = await fetch(request, { cache: "no-store" });
    return response.ok ? response : null;
  } catch {
    return null;
  }
}

function isOnDemandPairingSource(path) {
  return path === "pairing.html"
    || /^assets\/pairing-[^/]+\.(?:js|css)$/i.test(String(path || ""));
}

async function readOnDemandPairingSource(path) {
  if (!isOnDemandPairingSource(path)) return null;
  const candidate = await getCandidateSourceAssetMap().catch(() => null);
  const entry = candidate?.assets?.[path];
  if (!candidate || !entry) return null;

  const cacheName = `${PAIRING_ON_DEMAND_CACHE_PREFIX}${candidate.generation}`;
  for (const name of await caches.keys()) {
    if (name.startsWith(PAIRING_ON_DEMAND_CACHE_PREFIX) && name !== cacheName) await caches.delete(name);
  }
  const cache = await caches.open(cacheName);
  const cached = await cache.match(sourceAssetUrl(path));
  if (cached) return cached;

  if (isExplicitlyOffline()) return null;

  const response = await fetch(sourceAssetUrl(path), { cache: "no-cache" });
  if (!response.ok) return response;
  await cache.put(sourceAssetUrl(path), response.clone());
  return response;
}

self.addEventListener("message", (event) => {
  const message = event.data;
  /*
  if (message?.type === "typed-voice:reload-windows") {
    event.waitUntil(self.reloadTypedVoiceWindows());
    return;
  }
  */
  if (message?.type === "typed-voice:claim-clients") {
    event.waitUntil(self.clients.claim());
    return;
  }
  if (message?.type === "typed-voice:source-protocol") {
    event.ports?.[0]?.postMessage({ ok: true, version: SOURCE_PROTOCOL_VERSION });
    return;
  }
  if (message?.type === "typed-voice:service-worker-review") {
    event.ports?.[0]?.postMessage({ ok: true, reviewId: SERVICE_WORKER_REVIEW_ID });
    return;
  }
  if (message?.type === "typed-voice:request-log") {
    event.ports?.[0]?.postMessage({ ok: true, entries: requestLog.slice() });
    return;
  }

  if (message?.type === "typed-voice:plan-source-assets") {
    const port = event.ports?.[0];
    if (!port) return;
    const clientId = event.source?.id;
    if (clientId) sourceClientGenerations.set(clientId, String(message.knownAcceptedKey || "").toLowerCase());
    event.waitUntil((async () => {
      try {
        const plan = await planSourceAssets({
          groups: message.groups,
          knownAcceptedKey: message.knownAcceptedKey,
        });
        if (clientId && String(message.knownAcceptedKey || "").toLowerCase() === plan.generation) {
          await pruneSourceCachesIfAllClientsCurrent(plan.generation);
        }
        port.postMessage({ ok: true, plan });
      } catch (error) {
        port.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
      }
    })());
    return;
  }
  if (message?.type === "typed-voice:source-verification-plan") {
    const port = event.ports?.[0];
    if (!port) return;
    event.waitUntil((async () => {
      try {
        const plan = await getSourceVerificationPlan({ groups: message.groups });
        port.postMessage({ ok: true, plan });
      } catch (error) {
        port.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
      }
    })());
    return;
  }
  if (message?.type === "typed-voice:invalidate-source-asset") {
    const port = event.ports?.[0];
    if (!port) return;
    event.waitUntil((async () => {
      try {
        const invalidated = await invalidateAcceptedSourceAsset(message);
        port.postMessage({ ok: true, result: { invalidated } });
      } catch (error) {
        port.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
      }
    })());
    return;
  }

  if (message?.type === "typed-voice:apply-source-assets") {
    const port = event.ports?.[0];
    if (!port) return;
    const requestId = String(message.requestId || "");
    const clientId = event.source?.id;
    if (!requestId || !clientId) {
      port.postMessage({ ok: false, message: "invalid source update request" });
      return;
    }
    const key = `${clientId}:${requestId}`;
    const controller = new AbortController();
    sourceApplyControllers.set(key, controller);
    event.waitUntil((async () => {
      try {
        const result = await applySourceAssets({
          groups: message.groups,
          signal: controller.signal,
          onProgress(progress) {
            port.postMessage({ progress });
          },
        });
        port.postMessage({ ok: true, result });
      } catch (error) {
        port.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
      } finally {
        sourceApplyControllers.delete(key);
      }
    })());
    return;
  }
  if (message?.type === "typed-voice:cancel-source-assets") {
    const requestId = String(message.requestId || "");
    const clientId = event.source?.id;
    if (!requestId || !clientId) return;
    sourceApplyControllers.get(`${clientId}:${requestId}`)?.abort(new DOMException("Source update cancelled", "AbortError"));
    return;
  }
  if (message?.type === "typed-voice:check-model-cache") {
    const port = event.ports?.[0];
    if (!port) return;
    event.waitUntil((async () => {
      try {
        const prepared = await isPreparedModelCached(message.manifestUrl, message.appBaseUrl);
        port.postMessage({ ok: true, prepared });
      } catch (error) {
        port.postMessage({ ok: false, prepared: false, message: error instanceof Error ? error.message : String(error) });
      }
    })());
    return;
  }
  if (message?.type === "typed-voice:model-download-lock-acquire") {
    const port = event.ports?.[0];
    if (!port) return;
    event.waitUntil(handleModelDownloadLockAcquire(event, message, port));
    return;
  }
  if (message?.type === "typed-voice:model-download-lock-renew") {
    renewModelDownloadLock(event, message);
    return;
  }
  if (message?.type === "typed-voice:model-download-lock-release") {
    releaseModelDownloadLock(event, message);
  }
});

function normalizedModelDownloadLockKey(value) {
  const key = String(value ?? "");
  if (!key || key.length > 8192) return null;
  return key;
}

function modelDownloadLockOwnerMatches(lock, event, message) {
  return Boolean(lock)
    && lock.clientId === event.source?.id
    && lock.requestId === String(message.requestId ?? "");
}

async function handleModelDownloadLockAcquire(event, message, port) {
  const key = normalizedModelDownloadLockKey(message.key);
  const requestId = String(message.requestId ?? "");
  const clientId = event.source?.id;
  if (!key || !requestId || !clientId) {
    port.postMessage({ ok: false, granted: false, message: "invalid model download lock request" });
    return;
  }

  const now = Date.now();
  let lock = modelDownloadLocks.get(key);
  if (lock && lock.expiresAt <= now) {
    modelDownloadLocks.delete(key);
    lock = null;
  }
  if (lock && !modelDownloadLockOwnerMatches(lock, event, message)) {
    const ownerClient = await self.clients.get(lock.clientId).catch(() => null);
    if (ownerClient) {
      port.postMessage({ ok: true, granted: false, retryAfterMs: MODEL_DOWNLOAD_LOCK_RETRY_MS });
      return;
    }
    modelDownloadLocks.delete(key);
    lock = null;
  }

  modelDownloadLocks.set(key, {
    clientId,
    requestId,
    expiresAt: now + MODEL_DOWNLOAD_LOCK_LEASE_MS,
  });
  port.postMessage({ ok: true, granted: true, leaseMs: MODEL_DOWNLOAD_LOCK_LEASE_MS });
}

function renewModelDownloadLock(event, message) {
  const key = normalizedModelDownloadLockKey(message.key);
  if (!key) return;
  const lock = modelDownloadLocks.get(key);
  if (!modelDownloadLockOwnerMatches(lock, event, message)) return;
  lock.expiresAt = Date.now() + MODEL_DOWNLOAD_LOCK_LEASE_MS;
}

function releaseModelDownloadLock(event, message) {
  const key = normalizedModelDownloadLockKey(message.key);
  if (!key) return;
  const lock = modelDownloadLocks.get(key);
  if (!modelDownloadLockOwnerMatches(lock, event, message)) return;
  modelDownloadLocks.delete(key);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    recordRequest(request, "passthrough:method", "PASSTHROUGH");
    return;
  }
  const url = new URL(request.url);
  if (url.origin === self.location.origin && url.pathname === DIRECT_WORKER_RUNTIME_REGISTER_URL.pathname) {
    if (event.clientId) directWorkerRuntimeClients.add(event.clientId);
    event.respondWith(tracedResponse(request, "direct-worker-register", Promise.resolve(isolatedResponse(new Response(null, { status: 204 })))));
    return;
  }
  if (url.origin === self.location.origin && url.pathname === SOURCE_VERIFY_URL.pathname) {
    event.respondWith(tracedResponse(request, "source-verify", readSourceVerificationAsset(request).then(isolatedResponse)));
    return;
  }
  if (url.origin === self.location.origin && url.pathname.startsWith(MODEL_PREFIX)) {
    event.respondWith(tracedResponse(request, "model-cache", readPreparedModelAsset(request)));
    return;
  }
  if (url.protocol === "https:" && url.hostname.endsWith(".trycloudflare.com")) {
    recordRequest(request, "passthrough:trycloudflare", "PASSTHROUGH");
    return;
  }
  if (isHuggingFaceResolveUrl(url) && request.cache !== "no-store") {
    event.respondWith(tracedResponse(request, "huggingface-cache", readHuggingFaceResolveAsset(request)));
    return;
  }
  if (ORT_RUNTIME_URLS.has(url.href)) {
    event.respondWith(tracedResponse(request, "onnxruntime-web-cache", readOrtRuntimeAsset(request)));
    return;
  }
  if (url.origin !== self.location.origin) {
    recordRequest(request, "passthrough:cross-origin", "PASSTHROUGH");
    return;
  }
  const scopeUrl = new URL(self.registration.scope);
  const indexUrl = new URL("index.html", scopeUrl);
  if (request.mode === "navigate"
    && (url.pathname === scopeUrl.pathname || url.pathname === indexUrl.pathname)) {
    event.respondWith(tracedResponse(
      request,
      "load-transition",
      Promise.resolve(isolatedResponse(new Response(LOAD_TRANSITION_HTML, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })))
    ));
    return;
  }
  if (DEV_MODE) {
    event.respondWith(tracedResponse(request, "dev-network", fetch(request).then(isolatedResponse)));
    return;
  }
  event.respondWith(readPageAsset(event));
});

async function readPageAsset(event) {
  const request = event.request;
  if (event.clientId && directWorkerRuntimeClients.has(event.clientId)) {
    if (isExplicitlyOffline()) {
      const cached = await caches.match(request);
      if (cached) return tracedResponse(request, "direct-worker:offline-cache", Promise.resolve(isolatedResponse(cached)), "cache hit");
      return tracedResponse(request, "direct-worker:offline-miss", Promise.resolve(isolatedResponse(new Response("Asset is unavailable offline", { status: 503 }))), "offline cache miss");
    }
    return tracedResponse(request, "direct-worker:network", fetch(request).then(isolatedResponse), "network");
  }
  const client = event.clientId ? await self.clients.get(event.clientId) : null;
  if (client?.url) {
    const clientUrl = new URL(client.url);
    const pocUrl = new URL("poc.html", self.registration.scope);
    const workerUrl = new URL("worker.html", self.registration.scope);
    if (clientUrl.origin === self.location.origin
      && (clientUrl.pathname === pocUrl.pathname || clientUrl.pathname === workerUrl.pathname)) {
      const clientKind = clientUrl.pathname === pocUrl.pathname ? "poc" : "worker";
      if (isExplicitlyOffline()) {
        const cached = await caches.match(request);
        if (cached) return tracedResponse(request, `${clientKind}:offline-cache`, Promise.resolve(isolatedResponse(cached)), "cache hit");
        return tracedResponse(request, `${clientKind}:offline-miss`, Promise.resolve(isolatedResponse(new Response("Asset is unavailable offline", { status: 503 }))), "offline cache miss");
      }
      return tracedResponse(request, `${clientKind}:network`, fetch(request).then(isolatedResponse), "network");
    }
  }
  return tracedResponse(request, "shell", readShellAsset(request));
}

function isHuggingFaceResolveUrl(url) {
  if (url.origin !== "https://huggingface.co") return false;
  return /^\/RabbitDaisuke\/tsukuyomichan-omnivoice-full-finetune-onnx\/resolve\/[^/]+\/.+/.test(url.pathname);
}

async function readHuggingFaceResolveAsset(request) {
  const cache = await caches.open(HUGGINGFACE_RESOLVE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  if (isExplicitlyOffline()) {
    return new Response("Hugging Face asset is unavailable offline", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const response = await fetch(request);
  if (response.ok) {
    try {
      await cache.put(request, response.clone());
    } catch {
      // A successful network response must remain usable even if this browser rejects caching it.
    }
  }
  return response;
}

async function readPreparedModelAsset(request) {
  const cache = await caches.open(MODEL_CACHE);
  const response = await cache.match(request);
  if (!response) {
    return isolatedResponse(
      new Response("Prepared model asset is unavailable offline", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    );
  }
  const chunkCount = Number(response.headers.get("x-typed-voice-chunk-count") || 0);
  if (!Number.isSafeInteger(chunkCount) || chunkCount <= 0) return isolatedResponse(response);
  const byteSize = Number(response.headers.get("x-typed-voice-byte-size") || 0);
  const virtualUrl = new URL(request.url);
  virtualUrl.searchParams.delete(MODEL_CHUNK_QUERY);
  return isolatedResponse(new Response(createModelChunkStream(cache, virtualUrl.href, chunkCount), {
    status: 200,
    headers: {
      "content-type": response.headers.get("x-typed-voice-content-type") || "application/octet-stream",
      ...(Number.isSafeInteger(byteSize) && byteSize > 0 ? { "content-length": String(byteSize) } : {}),
      "x-typed-voice-xxh3-128": response.headers.get("x-typed-voice-xxh3-128") || "",
    },
  }));
}

function buildModelChunkUrl(virtualUrl, index) {
  const url = new URL(virtualUrl);
  url.searchParams.set(MODEL_CHUNK_QUERY, String(index));
  return url.href;
}

function buildModelAssetUrl(manifestId, localPath, baseUrl) {
  const encodedId = encodeURIComponent(manifestId);
  const encodedPath = String(localPath || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return new URL(`__typed_voice_assets/${encodedId}/${encodedPath}`, baseUrl || self.registration.scope).href;
}

async function isPreparedModelCached(manifestUrl, appBaseUrl) {
  if (!manifestUrl) return false;
  const cache = await caches.open(MODEL_CACHE);
  const manifestResponse = await cache.match(manifestUrl);
  if (!manifestResponse) return false;
  const manifest = await manifestResponse.json();
  if (!manifest?.id || !Array.isArray(manifest.assets) || manifest.assets.length === 0) return false;
  for (const asset of manifest.assets) {
    const virtualUrl = buildModelAssetUrl(manifest.id, asset.localPath, appBaseUrl);
    const indexResponse = await cache.match(virtualUrl);
    if (!indexResponse) return false;
    const chunkCount = Number(indexResponse.headers.get("x-typed-voice-chunk-count") || 0);
    const byteSize = Number(indexResponse.headers.get("x-typed-voice-byte-size") || 0);
    const xxh3 = indexResponse.headers.get("x-typed-voice-xxh3-128") || "";
    if (!Number.isSafeInteger(chunkCount) || chunkCount <= 0) return false;
    if (Number(asset.byteSize) !== byteSize) return false;
    if (String(asset.xxh3_128 || "").toLowerCase() !== xxh3.toLowerCase()) return false;
    for (let index = 0; index < chunkCount; index += 1) {
      if (!await cache.match(buildModelChunkUrl(virtualUrl, index))) return false;
    }
  }
  return true;
}

function createModelChunkStream(cache, virtualUrl, chunkCount) {
  let chunkIndex = 0;
  let reader = null;
  return new ReadableStream({
    async pull(controller) {
      try {
        for (;;) {
          if (reader) {
            const current = await reader.read();
            if (!current.done) {
              controller.enqueue(current.value);
              return;
            }
            reader.releaseLock();
            reader = null;
            chunkIndex += 1;
          }
          if (chunkIndex >= chunkCount) {
            controller.close();
            return;
          }
          const response = await cache.match(buildModelChunkUrl(virtualUrl, chunkIndex));
          if (!response?.body) throw new Error(`Prepared model chunk is unavailable offline: ${chunkIndex}`);
          reader = response.body.getReader();
        }
      } catch (error) {
        if (reader) reader.releaseLock();
        reader = null;
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (!reader) return;
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
        reader = null;
      }
    },
  });
}

async function readShellAsset(request) {
  const sourcePath = sourcePathForRequest(request);
  if (sourcePath) {
    if (isOnDemandPairingSource(sourcePath)) {
      const onDemand = await readOnDemandPairingSource(sourcePath).catch(() => null);
      if (onDemand) return isolatedResponse(onDemand);
    }
    const newerBootstrap = await readNewerBootstrapSource(request, sourcePath);
    if (newerBootstrap) return isolatedResponse(newerBootstrap);
    const accepted = await acceptedSourceResponse(sourcePath).catch(() => ({ managed: false, response: null, repairRequired: false }));
    if (accepted.response) return isolatedResponse(accepted.response);
  }

  if (isExplicitlyOffline()) {
    let response = await caches.match(request);
    if (!response && request.mode === "navigate") {
      const canonicalUrl = new URL(request.url);
      canonicalUrl.search = "";
      canonicalUrl.hash = "";
      response = await caches.match(canonicalUrl.href);
      if (!response && sourcePath !== "poc.html") response = await caches.match(new URL("./index.html", self.registration.scope).href);
      if (!response && sourcePath !== "poc.html") {
        const offlineTutorialCache = await caches.open(OFFLINE_TUTORIAL_CACHE);
        response = await offlineTutorialCache.match(OFFLINE_TUTORIAL_URL);
      }
    }
    if (response) return isolatedResponse(response);
    return isolatedResponse(new Response("Asset is unavailable offline", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    }));
  }

  try {
    const response = await fetch(request);
    if (!response.ok) {
      const cached = await caches.match(request);
      if (cached) return isolatedResponse(cached);
    }
    return isolatedResponse(response);
  } catch (error) {
    let response = await caches.match(request);
    if (!response && request.mode === "navigate") {
      const canonicalUrl = new URL(request.url);
      canonicalUrl.search = "";
      canonicalUrl.hash = "";
      response = await caches.match(canonicalUrl.href);
      if (!response && sourcePath !== "poc.html") response = await caches.match(new URL("./index.html", self.registration.scope).href);
    }
    if (!response) throw error;
    return isolatedResponse(response);
  }
}

function isolatedResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
