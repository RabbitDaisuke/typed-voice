import {
  clearTypedVoiceLocalStorage,
  createApplicationBackupFilename,
  downloadApplicationBackup,
  writeApplicationBackupToFileHandle,
} from "./application-backup.js";

const MODEL_CACHE_NAME = "typed-voice-model-assets-v2";
const KANALIZER_MODEL_CACHE_NAME = "typed-voice-kanalizer-model-v1";
const SOURCE_CACHE_PREFIX = "typed-voice-source-";
const HUGGINGFACE_RESOLVE_CACHE_PREFIX = "typed-voice-huggingface-resolve-";
const ORT_RUNTIME_CACHE_NAME = "typed-voice-onnxruntime-web-1.27.0";

export function isTypedVoiceOwnedCacheName(name) {
  return name === MODEL_CACHE_NAME
    || name === KANALIZER_MODEL_CACHE_NAME
    || name === ORT_RUNTIME_CACHE_NAME
    || name.startsWith(SOURCE_CACHE_PREFIX)
    || name.startsWith(HUGGINGFACE_RESOLVE_CACHE_PREFIX);
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export async function clearTypedVoiceDatabase(db) {
  if (!db) throw new Error("IndexedDB connection is unavailable.");
  const storeNames = [...db.objectStoreNames];
  if (storeNames.length === 0) return [];
  const transaction = db.transaction(storeNames, "readwrite");
  const done = transactionDone(transaction);
  for (const storeName of storeNames) transaction.objectStore(storeName).clear();
  await done;
  return storeNames;
}

export async function clearTypedVoiceCacheStorage(cachesImpl = globalThis.caches) {
  if (!cachesImpl?.keys || !cachesImpl?.delete) throw new Error("Cache Storageを利用できません。");
  const names = (await cachesImpl.keys()).filter(isTypedVoiceOwnedCacheName);
  await Promise.all(names.map((name) => cachesImpl.delete(name)));
  return names;
}

function workerScriptMatches(worker, expectedWorkerUrl) {
  if (!worker?.scriptURL) return false;
  const actual = new URL(worker.scriptURL);
  return actual.origin === expectedWorkerUrl.origin && actual.pathname === expectedWorkerUrl.pathname;
}

export async function findTypedVoiceServiceWorkerRegistration({
  serviceWorkerContainer = globalThis.navigator?.serviceWorker,
  baseUrl = globalThis.document?.baseURI,
} = {}) {
  if (!serviceWorkerContainer?.getRegistration) throw new Error("Service Workerを利用できません。");
  if (!baseUrl) throw new Error("typed-voiceのURLを確認できません。");
  const expectedWorkerUrl = new URL("app-service-worker.js", baseUrl);
  const scopeUrl = new URL("./", expectedWorkerUrl);
  const registration = await serviceWorkerContainer.getRegistration(scopeUrl.href);
  if (!registration) return null;
  const workers = [registration.active, registration.waiting, registration.installing];
  if (!workers.some((worker) => workerScriptMatches(worker, expectedWorkerUrl))) {
    throw new Error("typed-voice以外のService Workerは登録解除しません。");
  }
  return registration;
}

export async function resetTypedVoiceOfflineRuntime({
  db,
  storage = globalThis.localStorage,
  cachesImpl = globalThis.caches,
  serviceWorkerContainer = globalThis.navigator?.serviceWorker,
  baseUrl = globalThis.document?.baseURI,
} = {}) {
  const registration = await findTypedVoiceServiceWorkerRegistration({ serviceWorkerContainer, baseUrl });
  const [deletedCaches, clearedStores] = await Promise.all([
    clearTypedVoiceCacheStorage(cachesImpl),
    clearTypedVoiceDatabase(db),
  ]);
  clearTypedVoiceLocalStorage(storage);
  let serviceWorkerUnregistered = false;
  if (registration) {
    serviceWorkerUnregistered = await registration.unregister();
    if (!serviceWorkerUnregistered) throw new Error("Service Workerの登録解除に失敗しました。");
  }
  return { serviceWorkerUnregistered, deletedCaches, clearedStores };
}

export class OfflineRuntimeResetUiController {
  constructor(documentRef = document, {
    db = null,
    cachesImpl = globalThis.caches,
    serviceWorkerContainer = globalThis.navigator?.serviceWorker,
    locationRef = globalThis.location,
    modelProfileUi = null,
    app = null,
    storage = globalThis.localStorage,
  } = {}) {
    this.document = documentRef;
    this.db = db;
    this.cachesImpl = cachesImpl;
    this.serviceWorkerContainer = serviceWorkerContainer;
    this.location = locationRef;
    this.modelProfileUi = modelProfileUi;
    this.app = app;
    this.storage = storage;
    this.running = false;
    this.backupVerified = false;
    this.dialogGeneration = 0;
    this.elements = this.#resolveElements();
  }

  initialize() {
    this.elements.reset.addEventListener("click", () => this.#openDialog());
    this.elements.backup.addEventListener("click", () => void this.#downloadBackup());
    this.elements.backupConfirm.addEventListener("click", () => this.#confirmBackupSaved());
    this.elements.confirm.addEventListener("click", () => void this.#reset());
    this.elements.cancel.addEventListener("click", () => this.#closeDialog());
    this.elements.dialog.addEventListener("pointerdown", (event) => {
      if (event.target === this.elements.dialog) this.#closeDialog();
    });
    this.document.addEventListener?.("keydown", (event) => {
      if (event.key === "Escape" && !this.elements.dialog.hidden) this.#closeDialog();
    });
    this.elements.reload.addEventListener("click", () => this.location.reload());
    return this;
  }

  #openDialog() {
    if (this.running) return;
    this.dialogGeneration += 1;
    this.modelProfileUi?.closeSettings?.();
    this.elements.status.textContent = "";
    this.backupVerified = false;
    this.elements.dialogStatus.textContent = "バックアップを保存してください。保存後にアンインストールできます。";
    this.elements.backup.disabled = false;
    this.elements.backupConfirm.hidden = true;
    this.elements.backupConfirm.disabled = false;
    this.elements.confirm.disabled = true;
    this.elements.cancel.disabled = false;
    this.elements.dialog.hidden = false;
    this.elements.backup.focus({ preventScroll: true });
  }

  #closeDialog() {
    if (this.running) return;
    this.dialogGeneration += 1;
    this.elements.dialog.hidden = true;
    this.backupVerified = false;
    this.elements.confirm.disabled = true;
    this.elements.backupConfirm.hidden = true;
    this.elements.reset.focus({ preventScroll: true });
  }

  async #downloadBackup() {
    const generation = this.dialogGeneration;
    this.backupVerified = false;
    this.elements.confirm.disabled = true;
    this.elements.backupConfirm.hidden = true;
    this.elements.backupConfirm.disabled = false;
    this.elements.backup.disabled = true;
    try {
      if (!this.app?.createBackup) throw new Error("バックアップを作成できません。");
      if (typeof globalThis.showSaveFilePicker === "function") {
        let fileHandle;
        try {
          fileHandle = await globalThis.showSaveFilePicker({
            suggestedName: createApplicationBackupFilename(),
            types: [{
              description: "typed-voice バックアップ",
              accept: { "application/json": [".json"] },
            }],
          });
        } catch (error) {
          if (generation !== this.dialogGeneration) return;
          if (error?.name === "AbortError") {
            this.elements.dialogStatus.textContent = "バックアップの保存をキャンセルしました。アンインストールはまだできません。";
            return;
          }
          throw error;
        }
        this.elements.dialogStatus.textContent = "バックアップを作成して保存しています。";
        const backup = await this.app.createBackup();
        const filename = await writeApplicationBackupToFileHandle(fileHandle, backup);
        if (generation !== this.dialogGeneration) return;
        this.#markBackupSaved(`${filename} を保存しました。アンインストールできます。`);
        return;
      }

      const backup = await this.app.createBackup();
      const filename = downloadApplicationBackup(this.document, backup);
      if (generation !== this.dialogGeneration) return;
      this.elements.backupConfirm.hidden = false;
      this.elements.dialogStatus.textContent = `${filename} のダウンロードを開始しました。保存されたバックアップファイルを確認してください。`;
      this.elements.backupConfirm.focus({ preventScroll: true });
    } catch (error) {
      if (generation !== this.dialogGeneration) return;
      this.backupVerified = false;
      this.elements.confirm.disabled = true;
      this.elements.dialogStatus.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === this.dialogGeneration) this.elements.backup.disabled = false;
    }
  }

  #confirmBackupSaved() {
    if (this.elements.backupConfirm.hidden) return;
    this.elements.backupConfirm.disabled = true;
    this.#markBackupSaved("バックアップファイルを確認しました。アンインストールできます。");
  }

  #markBackupSaved(message) {
    this.backupVerified = true;
    this.elements.confirm.disabled = false;
    this.elements.dialogStatus.textContent = message;
    this.elements.confirm.focus({ preventScroll: true });
  }

  showFreeze() {
    this.elements.freeze.hidden = false;
    for (const child of this.document.body.children) {
      if (child !== this.elements.freeze) child.inert = true;
    }
    this.document.documentElement.classList.add("offline-runtime-frozen");
    this.elements.reload.focus({ preventScroll: true });
  }

  async #reset() {
    if (this.running || !this.backupVerified || this.elements.confirm.disabled) return;
    this.running = true;
    this.elements.reset.disabled = true;
    this.elements.confirm.disabled = true;
    this.elements.cancel.disabled = true;
    this.elements.backup.disabled = true;
    this.elements.dialogStatus.textContent = "typed-voiceの保存データとオフライン用データを削除しています。";
    try {
      await resetTypedVoiceOfflineRuntime({
        db: this.db,
        storage: this.storage,
        cachesImpl: this.cachesImpl,
        serviceWorkerContainer: this.serviceWorkerContainer,
        baseUrl: this.document.baseURI,
      });
      this.elements.dialog.hidden = true;
      this.showFreeze();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.elements.dialogStatus.textContent = message;
      this.elements.status.textContent = message;
      this.elements.reset.disabled = false;
      this.elements.backup.disabled = false;
      this.elements.confirm.disabled = !this.backupVerified;
      this.elements.cancel.disabled = false;
      this.running = false;
    }
  }

  #resolveElements() {
    const byId = (id) => {
      const element = this.document.getElementById(id);
      if (!element) throw new Error(`Required offline reset UI element is missing: ${id}`);
      return element;
    };
    return {
      reset: byId("offline-runtime-reset"),
      status: byId("offline-runtime-reset-status"),
      dialog: byId("offline-runtime-reset-dialog"),
      dialogStatus: byId("offline-runtime-reset-dialog-status"),
      backup: byId("offline-runtime-reset-backup"),
      backupConfirm: byId("offline-runtime-reset-backup-confirm"),
      confirm: byId("offline-runtime-reset-confirm"),
      cancel: byId("offline-runtime-reset-cancel"),
      freeze: byId("offline-reset-freeze"),
      reload: byId("offline-reset-reload"),
    };
  }
}

export function initializeOfflineRuntimeResetUi(documentRef = document, options = {}) {
  return new OfflineRuntimeResetUiController(documentRef, options).initialize();
}
