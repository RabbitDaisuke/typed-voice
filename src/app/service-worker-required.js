import { createXXHash128 } from "hash-wasm";

export const SOURCE_UPDATE_STORAGE_KEY = "typed-voice-source-cache-key-v2";
const PREVIOUS_SOURCE_UPDATE_STORAGE_KEY = "typed-voice-source-cache-key-v1";
const SOURCE_PROTOCOL_VERSION = 2;
const SERVICE_WORKER_REVIEW_TIMEOUT_MS = 750;
const MODEL_CACHE_READ_RELOAD_KEY = "typed-voice-model-cache-read-reloads";

function readStorageValue(key, storage = globalThis.localStorage) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function readStoredSourceGeneration(storage = globalThis.localStorage) {
  return readStorageValue(SOURCE_UPDATE_STORAGE_KEY, storage);
}

export async function readServiceWorkerRequestLog() {
  try {
    const entries = await requestServiceWorker("typed-voice:request-log", {}, "entries", 750);
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

async function readControllerServiceWorkerReview(controller, timeoutMs = SERVICE_WORKER_REVIEW_TIMEOUT_MS) {
  if (!controller) return null;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (reviewId) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      channel.port1.close();
      resolve(/^[0-9a-f]{32}$/i.test(String(reviewId || "")) ? String(reviewId).toLowerCase() : null);
    };
    const timeout = globalThis.setTimeout(() => finish(null), timeoutMs);
    channel.port1.onmessage = (event) => finish(event.data?.ok ? event.data?.reviewId : null);
    controller.postMessage({ type: "typed-voice:service-worker-review" }, [channel.port2]);
  });
}

async function reviewControlledServiceWorker(scopeUrl) {
  let response;
  try {
    response = await fetch(new URL("source-asset-map.json", scopeUrl), { cache: "no-store" });
  } catch {
    return Object.freeze({ reviewed: false, repairRequired: false });
  }
  if (!response.ok) throw new Error(`Service Worker審査書類を取得できませんでした (${response.status})`);
  const manifest = await response.json();
  const expectedReviewId = String(manifest?.serviceWorker?.xxh3_128 || "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(expectedReviewId)) {
    throw new Error("Service Worker審査書類に自己ハッシュがありません。");
  }
  const currentReviewId = await readControllerServiceWorkerReview(navigator.serviceWorker?.controller);
  return Object.freeze({
    reviewed: true,
    repairRequired: currentReviewId !== expectedReviewId,
    expectedReviewId,
    currentReviewId,
  });
}

export function markSourceUpdateAcknowledged(generation, storage = globalThis.localStorage) {
  const value = String(generation || "");
  if (!/^[0-9a-f]{32}$/i.test(value)) return false;
  try {
    storage?.setItem(SOURCE_UPDATE_STORAGE_KEY, value.toLowerCase());
    if (storage?.getItem(SOURCE_UPDATE_STORAGE_KEY) !== value.toLowerCase()) return false;
    storage?.removeItem(PREVIOUS_SOURCE_UPDATE_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export async function planSourceAssets(groups, { storage = globalThis.localStorage } = {}) {
  const storedGeneration = readStoredSourceGeneration(storage);
  const previousStoredGeneration = readStorageValue(PREVIOUS_SOURCE_UPDATE_STORAGE_KEY, storage);
  const migrationPending = !storedGeneration && Boolean(previousStoredGeneration);
  const forceMigrationUpdate = navigator.onLine && migrationPending;
  const controller = navigator.serviceWorker?.controller;
  if (!await supportsSourceProtocol(controller)) {
    if (!navigator.onLine) {
      return Object.freeze({
        generation: storedGeneration,
        acceptedGeneration: storedGeneration,
        updateAvailable: false,
        totalBytes: 0,
        fetchBytes: 0,
        reusableBytes: 0,
        assetCount: 0,
        fetchCount: 0,
        protocolUnavailable: true,
      });
    }
    throw new Error("Service Workerの更新確認機能がまだ有効になっていません。再読み込みしてください。");
  }
  const plan = await requestServiceWorker("typed-voice:plan-source-assets", {
    groups,
    knownAcceptedKey: storedGeneration ?? previousStoredGeneration,
  }, "plan");
  if (forceMigrationUpdate) {
    return Object.freeze({ ...plan, updateAvailable: true, forcedMigration: true });
  }
  if (!migrationPending
    && !plan.updateAvailable
    && plan.acceptedGeneration === plan.generation
    && storedGeneration !== plan.generation) {
    markSourceUpdateAcknowledged(plan.generation, storage);
  }
  return plan;
}

export async function applySourceAssets(groups, {
  storage = globalThis.localStorage,
  signal = null,
  onProgress = () => {},
} = {}) {
  if (!await supportsSourceProtocol(navigator.serviceWorker?.controller)) {
    throw new Error("Service Workerの更新機能がまだ有効になっていません。再読み込みしてください。");
  }
  const requestId = crypto.randomUUID();
  const result = await requestServiceWorker(
    "typed-voice:apply-source-assets",
    { groups, requestId },
    "result",
    120_000,
    {
      signal,
      cancelType: "typed-voice:cancel-source-assets",
      requestId,
      progressKey: "progress",
      onProgress,
    },
  );
  if (!markSourceUpdateAcknowledged(result.generation, storage)) {
    throw new Error("更新済みソースの世代を保存できませんでした。");
  }
  return result;
}

export async function planOrtRuntimeAssets() {
  if (!await supportsSourceProtocol(navigator.serviceWorker?.controller)) {
    throw new Error("Service WorkerのONNX Runtime確認機能がまだ有効になっていません。再読み込みしてください。");
  }
  return requestServiceWorker("typed-voice:plan-ort-runtime-assets", {}, "plan");
}

export async function prepareOrtRuntimeAssets({ signal = null } = {}) {
  if (!await supportsSourceProtocol(navigator.serviceWorker?.controller)) {
    throw new Error("Service WorkerのONNX Runtime保存機能がまだ有効になっていません。再読み込みしてください。");
  }
  const requestId = crypto.randomUUID();
  return requestServiceWorker(
    "typed-voice:prepare-ort-runtime-assets",
    { requestId },
    "result",
    120_000,
    {
      signal,
      cancelType: "typed-voice:cancel-ort-runtime-assets",
      requestId,
    },
  );
}

export async function verifyStoredSourceAssets(groups, { onProgress = () => {} } = {}) {
  if (!await supportsSourceProtocol(navigator.serviceWorker?.controller)) {
    return Object.freeze({
      generation: readStoredSourceGeneration(),
      checkedCount: 0,
      checkedBytes: 0,
      corruptCount: 0,
      corruptBytes: 0,
      missingCount: 0,
      missingBytes: 0,
      protocolUnavailable: true,
    });
  }

  const plan = await requestServiceWorker(
    "typed-voice:source-verification-plan",
    { groups },
    "plan",
  );
  const totalBytes = Number(plan?.availableBytes || 0);
  let checkedBytes = 0;
  let checkedCount = 0;
  let corruptCount = 0;
  let corruptBytes = 0;

  for (const entry of plan?.entries || []) {
    const expectedBytes = Number(entry?.byteSize || 0);
    let loadedForEntry = 0;
    let valid = false;
    try {
      const response = await fetch(entry.url, { cache: "no-store" });
      if (!response.ok || !response.body) throw new Error(`Source verification stream unavailable: ${entry.path}`);
      const hasher = await createXXHash128();
      const reader = response.body.getReader();
      try {
        for (;;) {
          const current = await reader.read();
          if (current.done) break;
          hasher.update(current.value);
          loadedForEntry += current.value.byteLength;
          onProgress({
            path: entry.path,
            checkedBytes: checkedBytes + loadedForEntry,
            totalBytes,
            checkedCount,
            totalCount: plan.entries.length,
          });
        }
      } finally {
        reader.releaseLock();
      }
      valid = loadedForEntry === expectedBytes
        && hasher.digest().toLowerCase() === String(entry.xxh3_128 || "").toLowerCase();
    } catch {
      valid = false;
    }

    checkedBytes += loadedForEntry;
    checkedCount += 1;
    if (!valid) {
      corruptCount += 1;
      corruptBytes += expectedBytes;
      await requestServiceWorker("typed-voice:invalidate-source-asset", {
        generation: plan.generation,
        path: entry.path,
      }, "result");
    }
    onProgress({
      path: entry.path,
      checkedBytes,
      totalBytes,
      checkedCount,
      totalCount: plan.entries.length,
    });
  }

  return Object.freeze({
    generation: plan?.generation ?? null,
    checkedCount,
    checkedBytes,
    corruptCount,
    corruptBytes,
    missingCount: Number(plan?.missingCount || 0),
    missingBytes: Number(plan?.missingBytes || 0),
  });
}

async function requestServiceWorker(type, payload, resultKey, timeoutMs = 10_000, {
  signal = null,
  cancelType = null,
  requestId = null,
  progressKey = null,
  onProgress = null,
} = {}) {
  const controller = navigator.serviceWorker?.controller;
  if (!controller) throw new Error("Service Worker is not controlling this page.");
  if (signal?.aborted) throw signal.reason ?? new DOMException("Request aborted", "AbortError");
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      channel.port1.close();
      callback(value);
    };
    const cancel = () => {
      if (cancelType && requestId) controller.postMessage({ type: cancelType, requestId });
    };
    const abort = () => {
      cancel();
      finish(reject, signal?.reason ?? new DOMException("Request aborted", "AbortError"));
    };
    const timeout = globalThis.setTimeout(() => {
      cancel();
      finish(reject, new Error("Service Worker source update request timed out."));
    }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    channel.port1.onmessage = (event) => {
      if (progressKey && event.data?.[progressKey]) {
        if (typeof onProgress === "function") onProgress(event.data[progressKey]);
        return;
      }
      if (event.data?.ok) finish(resolve, event.data[resultKey]);
      else finish(reject, new Error(event.data?.message || "Service Worker source update request failed."));
    };
    controller.postMessage({ type, ...payload }, [channel.port2]);
  });
}

async function supportsSourceProtocol(controller, timeoutMs = 750) {
  if (!controller) return false;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (supported) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      channel.port1.close();
      resolve(Boolean(supported));
    };
    const timeout = globalThis.setTimeout(() => finish(false), timeoutMs);
    channel.port1.onmessage = (event) => finish(
      event.data?.ok && Number(event.data?.version) === SOURCE_PROTOCOL_VERSION
    );
    controller.postMessage({ type: "typed-voice:source-protocol" }, [channel.port2]);
  });
}

export async function requireServiceWorker({ reloadKey = "typed-voice-coi-reloaded" } = {}) {
  if (!("serviceWorker" in navigator)) {
    showServiceWorkerRequired();
    throw new Error("Service Worker is unavailable in this browser.");
  }

  const scopeUrl = new URL(import.meta.env.BASE_URL, document.baseURI);
  const serviceWorkerUrl = new URL("app-service-worker.js", scopeUrl);
  if (import.meta.env.DEV) serviceWorkerUrl.searchParams.set("dev", "1");


  // An already-controlled page must remain usable with no network at all.
  // Refreshing the worker is an online maintenance operation, not an offline startup dependency.
  if (navigator.serviceWorker.controller) {
    sessionStorage.removeItem(reloadKey);
    if (navigator.onLine) return reviewControlledServiceWorker(scopeUrl);
    return Object.freeze({ reviewed: false, repairRequired: false });
  }

  // A previously installed active worker is persisted by the browser independently of Cache Storage.
  // If this document was loaded before it became controlled, one reload lets that worker handle navigation,
  // including a fully offline navigation from the application shell cache.
  const existing = await navigator.serviceWorker.getRegistration(scopeUrl.href).catch(() => null);
  if (existing?.active) {
    await navigator.serviceWorker.ready;
    // This document itself was loaded before the worker controlled navigation.
    // Once an active worker is available, reload so every later request starts
    // under Service Worker control even on slower devices.
    location.reload();
    return new Promise(() => {});
  }

  if (!navigator.onLine) {
    showServiceWorkerRequired();
    throw new Error("Service Worker has not been installed yet. Connect once to prepare offline use.");
  }

  try {
    await navigator.serviceWorker.register(serviceWorkerUrl, { scope: scopeUrl.pathname });
  } catch (error) {
    console.error("Service Worker registration failed", error);
    showServiceWorkerRequired();
    throw error;
  }

  if (navigator.serviceWorker.controller) {
    sessionStorage.removeItem(reloadKey);
    return;
  }
  sessionStorage.setItem(reloadKey, "1");
  await navigator.serviceWorker.ready;
  location.reload();
  return new Promise(() => {});
}

export async function unregisterTypedVoiceServiceWorker() {
  const scopeUrl = new URL(import.meta.env.BASE_URL, document.baseURI);
  const expectedWorkerUrl = new URL("app-service-worker.js", scopeUrl);
  const registration = await navigator.serviceWorker?.getRegistration?.(scopeUrl.href);
  if (!registration) return true;
  const workers = [registration.active, registration.waiting, registration.installing].filter(Boolean);
  if (workers.some((worker) => {
    const actual = new URL(worker.scriptURL);
    return actual.origin !== expectedWorkerUrl.origin || actual.pathname !== expectedWorkerUrl.pathname;
  })) {
    throw new Error("typed-voice以外のService Workerは登録解除しません。");
  }
  const unregistered = await registration.unregister();
  if (!unregistered) throw new Error("古いService Workerの登録解除に失敗しました。");
  return true;
}

async function waitForController(timeoutMs = 5000) {
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener("controllerchange", finish);
      resolve(navigator.serviceWorker.controller ?? null);
    };
    const timeout = globalThis.setTimeout(finish, timeoutMs);
    navigator.serviceWorker.addEventListener("controllerchange", finish);
  });
}

async function reloadAfterModelCacheReadFailure() {
  const reloadCount = Number(sessionStorage.getItem(MODEL_CACHE_READ_RELOAD_KEY) || 0);
  if (reloadCount >= 2) {
    throw new Error("Service Workerからモデルキャッシュを確認できませんでした。自動再読み込みは2回で停止しました。");
  }

  const registration = await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    registration.active?.postMessage({ type: "typed-voice:claim-clients" });
    await waitForController();
  }
  if (!navigator.serviceWorker.controller) {
    throw new Error("Service Workerがこのページを制御していないため、モデルキャッシュを確認できませんでした。");
  }

  sessionStorage.setItem(MODEL_CACHE_READ_RELOAD_KEY, String(reloadCount + 1));
  location.reload();
  return new Promise(() => {});
}

export async function queryPreparedModelCache(manifestUrl, { appBaseUrl = null } = {}) {
  const controller = navigator.serviceWorker?.controller;
  if (!controller) return reloadAfterModelCacheReadFailure();
  try {
    const prepared = await new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      channel.port1.close();
      callback(value);
    };
    const timeout = globalThis.setTimeout(() => finish(reject, new Error("Service Worker model cache query timed out.")), 5000);
    channel.port1.onmessage = (event) => {
      if (event.data?.ok) finish(resolve, Boolean(event.data?.prepared));
      else finish(reject, new Error(event.data?.message || "Service Worker model cache query failed."));
    };
    try {
      controller.postMessage({
        type: "typed-voice:check-model-cache",
        manifestUrl,
        appBaseUrl,
      }, [channel.port2]);
    } catch (error) {
      finish(reject, error);
    }
    });
    sessionStorage.removeItem(MODEL_CACHE_READ_RELOAD_KEY);
    return prepared;
  } catch {
    return reloadAfterModelCacheReadFailure();
  }
}

export function showServiceWorkerRequired() {
  const overlay = document.querySelector("#service-worker-required");
  if (!overlay) return;
  overlay.hidden = false;
  document.documentElement.classList.add("service-worker-blocked");
  const retry = overlay.querySelector("button");
  retry?.focus({ preventScroll: true });
}

