import { createXXHash128 } from "hash-wasm";
import { isXxh3_128, xxh3_128Stream } from "./xxh3-128.js";
import { openConversationDatabase } from "../app/storage.js";

export const MODEL_CACHE_NAME = "typed-voice-model-assets-v2";
const STORE_NAME = "assets";
const VIRTUAL_PREFIX = "__typed_voice_assets/";
const CACHE_CHUNK_BYTES = 16 * 1024 * 1024;
const CACHE_CHUNK_QUERY = "__typed_voice_part";

function openDatabase(indexedDBImpl = indexedDB) {
  return openConversationDatabase(indexedDBImpl);
}

function runTransaction(db, mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    transaction.oncomplete = () => {
      if (request && typeof request === "object" && "result" in request) resolve(request.result);
      else resolve(request);
    };
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function isSha256(value) {
  return typeof value === "string" && value.length === 64 && /^[0-9a-f]{64}$/i.test(value);
}

function validateAsset(asset) {
  if (!asset || typeof asset !== "object") throw new Error("Invalid asset entry");
  for (const field of ["id", "localPath", "sha256", "xxh3_128"]) {
    if (typeof asset[field] !== "string" || asset[field].length === 0) throw new Error(`Asset ${field} is required`);
  }
  if (!isSha256(asset.sha256)) throw new Error(`Asset ${asset.id} has invalid SHA-256`);
  if (!isXxh3_128(asset.xxh3_128)) throw new Error(`Asset ${asset.id} has invalid XXH3-128`);
  if (!Number.isSafeInteger(asset.byteSize) || asset.byteSize <= 0) throw new Error(`Asset ${asset.id} has invalid byteSize`);
  const source = asset.source;
  if (!source || source.provider !== "huggingface") throw new Error(`Asset ${asset.id} requires a Hugging Face source`);
  for (const field of ["repo", "revision", "path"]) {
    if (typeof source[field] !== "string" || source[field].length === 0) throw new Error(`Asset ${asset.id} source.${field} is required`);
  }
  if (source.revision === "main" || source.revision === "master") throw new Error(`Asset ${asset.id} must pin an immutable revision`);
}

export function validateVoiceManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 2) throw new Error("Unsupported voice manifest schema");
  if (typeof manifest.id !== "string" || manifest.id.length === 0) throw new Error("Manifest id is required");
  if (!manifest.voice || manifest.voice.engine !== "omnivoice") throw new Error("This PoC requires voice.engine=omnivoice");
  if (!manifest.voice.source?.repo || !manifest.voice.source?.revision) throw new Error("Voice source repo/revision are required");
  if (["main", "master"].includes(manifest.voice.source.revision)) throw new Error("Voice source revision must be immutable");
  if (!Array.isArray(manifest.assets)) throw new Error("Manifest assets must be an array");
  if (manifest.installable !== false && manifest.assets.length === 0) throw new Error("Installable manifest requires assets");
  const ids = new Set();
  const paths = new Set();
  for (const asset of manifest.assets) {
    validateAsset(asset);
    if (ids.has(asset.id)) throw new Error(`Duplicate asset id: ${asset.id}`);
    if (paths.has(asset.localPath)) throw new Error(`Duplicate asset localPath: ${asset.localPath}`);
    ids.add(asset.id);
    paths.add(asset.localPath);
  }
  if (manifest.installable !== false) {
    const sessions = manifest.runtime?.sessions;
    if (!sessions || typeof sessions !== "object") throw new Error("Installable OmniVoice manifest requires runtime.sessions");
    for (const sessionName of ["audioEmbeddings", "llm", "audioHeads", "higgsDecoder"]) {
      const session = sessions[sessionName];
      if (!session?.model || !paths.has(session.model)) {
        throw new Error(`Runtime session ${sessionName} model is missing from assets`);
      }
      for (const entry of session.externalData ?? []) {
        if (!entry?.localPath || !paths.has(entry.localPath)) {
          throw new Error(`Runtime session ${sessionName} external data is missing from assets`);
        }
      }
    }
    const tokenizerDirectory = (manifest.runtime.tokenizerDirectory || ".").replace(/^\.\/?|\/$/g, "");
    const tokenizerPrefix = tokenizerDirectory ? `${tokenizerDirectory}/` : "";
    for (const name of ["tokenizer.json", "tokenizer_config.json"]) {
      if (!paths.has(`${tokenizerPrefix}${name}`)) throw new Error(`Runtime tokenizer asset is missing: ${tokenizerPrefix}${name}`);
    }
  }
  return manifest;
}

export function buildHuggingFaceResolveUrl(asset) {
  validateAsset(asset);
  const { repo, revision, path } = asset.source;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/${repo}/resolve/${revision}/${encodedPath}`;
}

export function buildVirtualAssetUrl(manifestId, localPath, baseUrl = globalThis.location?.href) {
  if (!baseUrl) throw new Error("A base URL is required to build a virtual asset URL");
  const encodedId = encodeURIComponent(manifestId);
  const encodedPath = localPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return new URL(`${VIRTUAL_PREFIX}${encodedId}/${encodedPath}`, baseUrl).href;
}

function keyFor(manifestId, assetId) {
  return `${manifestId}:${assetId}`;
}

function buildCacheChunkUrl(virtualUrl, index) {
  const url = new URL(virtualUrl);
  url.searchParams.set(CACHE_CHUNK_QUERY, String(index));
  return url.href;
}

function isCacheChunkUrl(candidateUrl, virtualUrl) {
  const candidate = new URL(candidateUrl);
  const base = new URL(virtualUrl);
  if (!candidate.searchParams.has(CACHE_CHUNK_QUERY)) return false;
  candidate.searchParams.delete(CACHE_CHUNK_QUERY);
  return candidate.href === base.href;
}

async function deleteCachedAsset(cache, virtualUrl) {
  const indexResponse = await cache.match(virtualUrl);
  const chunkCount = Number(indexResponse?.headers.get("x-typed-voice-chunk-count") || 0);
  await cache.delete(virtualUrl);
  if (Number.isSafeInteger(chunkCount) && chunkCount > 0) {
    await Promise.all(Array.from({ length: chunkCount }, (_, index) => cache.delete(buildCacheChunkUrl(virtualUrl, index))));
    return;
  }
  const requests = await cache.keys();
  await Promise.all(
    requests
      .filter((request) => isCacheChunkUrl(request.url, virtualUrl))
      .map((request) => cache.delete(request))
  );
}

function createCachedChunkStream(cache, virtualUrl, chunkCount) {
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
          const response = await cache.match(buildCacheChunkUrl(virtualUrl, chunkIndex));
          if (!response?.body) throw new Error(`Cached model chunk is missing: ${chunkIndex}`);
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

async function openCachedAsset(cache, virtualUrl) {
  const response = await cache.match(virtualUrl);
  if (!response) return null;
  const chunkCount = Number(response.headers.get("x-typed-voice-chunk-count") || 0);
  if (!Number.isSafeInteger(chunkCount) || chunkCount <= 0) return response;
  const byteSize = Number(response.headers.get("x-typed-voice-byte-size") || 0);
  return new Response(createCachedChunkStream(cache, virtualUrl, chunkCount), {
    status: 200,
    headers: {
      "content-type": response.headers.get("x-typed-voice-content-type") || "application/octet-stream",
      ...(Number.isSafeInteger(byteSize) && byteSize > 0 ? { "content-length": String(byteSize) } : {}),
      "x-typed-voice-xxh3-128": response.headers.get("x-typed-voice-xxh3-128") || "",
    },
  });
}

async function readMetadata(db, key) {
  return runTransaction(db, "readonly", (store) => store.get(key));
}

async function writeMetadata(db, record) {
  return runTransaction(db, "readwrite", (store) => store.put(record));
}

function normalizedAssetMetadata(manifest, asset, virtualUrl, verified) {
  const installedAt = Date.now();
  return {
    key: keyFor(manifest.id, asset.id),
    manifestId: manifest.id,
    assetId: asset.id,
    version: asset.source?.revision ?? manifest.runtimeSource?.revision ?? manifest.voice?.source?.revision ?? null,
    virtualUrl,
    sha256: asset.sha256.toLowerCase(),
    xxh3_128: verified.xxh3_128,
    size: verified.byteSize,
    byteSize: verified.byteSize,
    installedAt,
    verifiedAt: installedAt,
    source: asset.source,
    licenseId: asset.licenseId ?? manifest.licenses?.voiceModel ?? null,
  };
}

async function deleteMetadata(db, key) {
  return runTransaction(db, "readwrite", (store) => store.delete(key));
}

async function verifyCachedAsset({ cache, db, manifest, asset, virtualUrl, onProgress }) {
  const [cached, metadata] = await Promise.all([openCachedAsset(cache, virtualUrl), readMetadata(db, keyFor(manifest.id, asset.id))]);
  if (!cached?.body) return false;
  if (metadata && (metadata.byteSize !== asset.byteSize || metadata.virtualUrl !== virtualUrl)) return false;

  let verified;
  try {
    verified = await xxh3_128Stream(cached.body, ({ loaded }) => {
      onProgress?.({ assetId: asset.id, loaded, total: asset.byteSize });
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Cached model chunk is missing:")) {
      return false;
    }
    throw error;
  }

  if (verified.byteSize !== asset.byteSize || verified.xxh3_128 !== asset.xxh3_128.toLowerCase()) {
    await Promise.all([deleteCachedAsset(cache, virtualUrl), deleteMetadata(db, keyFor(manifest.id, asset.id))]);
    return false;
  }
  if (!metadata || metadata.xxh3_128 !== verified.xxh3_128 || metadata.sha256 !== asset.sha256.toLowerCase()) {
    await writeMetadata(db, normalizedAssetMetadata(manifest, asset, virtualUrl, verified));
  }
  return true;
}

async function downloadAndVerifyAsset({ fetchImpl, cache, db, manifest, asset, virtualUrl, onProgress }) {
  const response = await fetchImpl(buildHuggingFaceResolveUrl(asset), { cache: "no-store" });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${asset.id}`);
  if (!response.body) throw new Error(`Streaming response body is unavailable for ${asset.id}`);
  const declaredSize = Number(response.headers.get("content-length") || response.headers.get("x-linked-size") || 0);
  if (declaredSize > 0 && declaredSize !== asset.byteSize) {
    throw new Error(`Content-Length mismatch for ${asset.id}: expected ${asset.byteSize}, got ${declaredSize}`);
  }

  await deleteCachedAsset(cache, virtualUrl);
  const hasher = await createXXHash128();
  const reader = response.body.getReader();
  let loaded = 0;
  let lastReported = 0;
  let chunkIndex = 0;
  let pendingBytes = 0;
  let pendingParts = [];
  const contentType = response.headers.get("content-type") || "application/octet-stream";

  const flushChunk = async () => {
    if (pendingBytes === 0) return;
    const body = new Blob(pendingParts, { type: contentType });
    await cache.put(buildCacheChunkUrl(virtualUrl, chunkIndex), new Response(body, {
      status: 200,
      headers: {
        "content-type": contentType,
        "content-length": String(pendingBytes),
      },
    }));
    chunkIndex += 1;
    pendingBytes = 0;
    pendingParts = [];
  };

  let verified;
  try {
    for (;;) {
      const current = await reader.read();
      if (current.done) break;
      const value = current.value;
      hasher.update(value);
      loaded += value.byteLength;
      let offset = 0;
      while (offset < value.byteLength) {
        const take = Math.min(CACHE_CHUNK_BYTES - pendingBytes, value.byteLength - offset);
        pendingParts.push(value.subarray(offset, offset + take));
        pendingBytes += take;
        offset += take;
        if (pendingBytes === CACHE_CHUNK_BYTES) await flushChunk();
      }
      if (loaded - lastReported >= 1024 * 1024 || loaded === asset.byteSize) {
        lastReported = loaded;
        onProgress?.({ assetId: asset.id, loaded, total: asset.byteSize });
      }
    }
    await flushChunk();
    verified = { xxh3_128: hasher.digest(), byteSize: loaded };
  } catch (error) {
    await deleteCachedAsset(cache, virtualUrl);
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (verified.byteSize !== asset.byteSize || verified.xxh3_128 !== asset.xxh3_128.toLowerCase()) {
    await Promise.all([deleteCachedAsset(cache, virtualUrl), deleteMetadata(db, keyFor(manifest.id, asset.id))]);
    throw new Error(`Integrity mismatch for ${asset.id}`);
  }

  await cache.put(virtualUrl, new Response(null, {
    status: 200,
    headers: {
      "x-typed-voice-chunk-count": String(chunkIndex),
      "x-typed-voice-byte-size": String(asset.byteSize),
      "x-typed-voice-content-type": contentType,
      "x-typed-voice-xxh3-128": asset.xxh3_128.toLowerCase(),
    },
  }));

  await writeMetadata(db, normalizedAssetMetadata(manifest, asset, virtualUrl, verified));
}

export async function prepareVoiceAssets(manifest, options = {}) {
  validateVoiceManifest(manifest);
  if (manifest.preparable === false) throw new Error("Manifest preparation is disabled");
  if (manifest.assets.length === 0) throw new Error("Manifest has no assets to prepare");
  const fetchImpl = options.fetchImpl ?? fetch;
  const cachesImpl = options.cachesImpl ?? caches;
  const db = options.db ?? (await openDatabase(options.indexedDBImpl));
  const cache = await cachesImpl.open(MODEL_CACHE_NAME);
  const baseUrl = options.baseUrl ?? globalThis.location?.href;
  const totalBytes = manifest.assets.reduce((sum, asset) => sum + asset.byteSize, 0);
  let completedBytes = 0;

  for (const asset of manifest.assets) {
    const virtualUrl = buildVirtualAssetUrl(manifest.id, asset.localPath, baseUrl);
    if (await verifyCachedAsset({
      cache,
      db,
      manifest,
      asset,
      virtualUrl,
      onProgress: ({ loaded }) => options.onProgress?.({
        phase: "verifying-cache",
        assetId: asset.id,
        loadedBytes: completedBytes + loaded,
        totalBytes,
      }),
    })) {
      completedBytes += asset.byteSize;
      options.onProgress?.({ phase: "verified-cache", assetId: asset.id, loadedBytes: completedBytes, totalBytes });
      continue;
    }
    await downloadAndVerifyAsset({
      fetchImpl,
      cache,
      db,
      manifest,
      asset,
      virtualUrl,
      onProgress: ({ loaded }) => options.onProgress?.({
        phase: "downloading",
        assetId: asset.id,
        loadedBytes: completedBytes + loaded,
        totalBytes,
      }),
    });
    completedBytes += asset.byteSize;
    options.onProgress?.({ phase: "verified", assetId: asset.id, loadedBytes: completedBytes, totalBytes });
  }

  return { manifestId: manifest.id, totalBytes, assetBaseUrl: buildVirtualAssetUrl(manifest.id, "", baseUrl) };
}

export async function storePreparedVoiceManifest(manifestUrl, manifest, options = {}) {
  validateVoiceManifest(manifest);
  const cachesImpl = options.cachesImpl ?? caches;
  const cache = await cachesImpl.open(MODEL_CACHE_NAME);
  await cache.put(manifestUrl, new Response(JSON.stringify(manifest), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  }));
}

export async function readPreparedVoiceManifest(manifestUrl, options = {}) {
  const cachesImpl = options.cachesImpl ?? caches;
  const cache = await cachesImpl.open(MODEL_CACHE_NAME);
  const response = await cache.match(manifestUrl);
  if (!response) return null;
  try {
    return validateVoiceManifest(await response.json());
  } catch (error) {
    await cache.delete(manifestUrl);
    throw new Error(`Cached voice manifest is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function assertPreparedVoiceAssets(manifest, options = {}) {
  validateVoiceManifest(manifest);
  if (manifest.installable === false) throw new Error(manifest.blockedReason || "Manifest is not installable");
  const cachesImpl = options.cachesImpl ?? caches;
  const db = options.db ?? (await openDatabase(options.indexedDBImpl));
  const cache = await cachesImpl.open(MODEL_CACHE_NAME);
  const baseUrl = options.baseUrl ?? globalThis.location?.href;
  const totalBytes = manifest.assets.reduce((sum, asset) => sum + asset.byteSize, 0);
  let completedBytes = 0;
  for (const asset of manifest.assets) {
    const virtualUrl = buildVirtualAssetUrl(manifest.id, asset.localPath, baseUrl);
    const verified = await verifyCachedAsset({
      cache,
      db,
      manifest,
      asset,
      virtualUrl,
      onProgress: ({ loaded }) => options.onProgress?.({
        phase: "verifying-cache",
        assetId: asset.id,
        loadedBytes: completedBytes + loaded,
        totalBytes,
      }),
    });
    if (!verified) {
      throw new Error(`Prepared asset is missing or corrupt: ${asset.id}. Run offline voice preparation again.`);
    }
    completedBytes += asset.byteSize;
    options.onProgress?.({ phase: "verified-cache", assetId: asset.id, loadedBytes: completedBytes, totalBytes });
  }
  return { manifestId: manifest.id, assetBaseUrl: buildVirtualAssetUrl(manifest.id, "", baseUrl) };
}

export async function verifyAssetBytes(bytes, expectedXxh3_128) {
  const { xxh3_128 } = await xxh3_128Stream(new Blob([bytes]).stream());
  if (xxh3_128 !== expectedXxh3_128.toLowerCase()) {
    throw new Error(`XXH3-128 mismatch: expected ${expectedXxh3_128}, got ${xxh3_128}`);
  }
  return xxh3_128;
}
