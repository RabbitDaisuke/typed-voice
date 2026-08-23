import test from "node:test";
import assert from "node:assert/strict";
import {
  clearTypedVoiceCacheStorage,
  findTypedVoiceServiceWorkerRegistration,
  isTypedVoiceOwnedCacheName,
  OfflineRuntimeResetUiController,
  resetTypedVoiceOfflineRuntime,
} from "../src/app/offline-runtime-reset.js";

function createDb() {
  const stores = {
    assets: [{ key: "voice:model" }],
    sessions: [{ id: "conversation-1" }],
    settings: [
      { key: "speechSpeed", value: 1 },
      { key: "tutorialCompleteV1", value: "1" },
    ],
  };
  const objectStoreNames = Object.keys(stores);
  objectStoreNames.contains = (name) => Object.hasOwn(stores, name);
  return {
    stores,
    objectStoreNames,
    transaction(names) {
      const transactionStoreNames = Array.isArray(names) ? names : [names];
      const transaction = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore(name = transactionStoreNames[0]) {
          return {
            clear() {
              stores[name] = [];
              queueMicrotask(() => transaction.oncomplete?.());
            },
          };
        },
      };
      return transaction;
    },
  };
}

test("typed-voice所有Cacheだけを判定する", () => {
  assert.equal(isTypedVoiceOwnedCacheName("typed-voice-model-assets-v2"), true);
  assert.equal(isTypedVoiceOwnedCacheName("typed-voice-kanalizer-model-v1"), true);
  assert.equal(isTypedVoiceOwnedCacheName("typed-voice-onnxruntime-web-1.27.0"), true);
  assert.equal(isTypedVoiceOwnedCacheName("typed-voice-source-2026-08-17-45"), true);
  assert.equal(isTypedVoiceOwnedCacheName("typed-voice-huggingface-resolve-2026-08-17-45"), true);
  assert.equal(isTypedVoiceOwnedCacheName("desmume_webassembly-cache-v1"), false);
  assert.equal(isTypedVoiceOwnedCacheName("other-app-cache"), false);
});

test("Cache Storage削除はdesmume_webassemblyなど他アプリを巻き込まない", async () => {
  const names = new Set([
    "typed-voice-model-assets-v2",
    "typed-voice-source-old",
    "desmume_webassembly-cache-v1",
    "other-app-cache",
  ]);
  const deleted = [];
  await clearTypedVoiceCacheStorage({
    async keys() { return [...names]; },
    async delete(name) { deleted.push(name); names.delete(name); return true; },
  });
  assert.deepEqual(new Set(deleted), new Set(["typed-voice-model-assets-v2", "typed-voice-source-old"]));
  assert.equal(names.has("desmume_webassembly-cache-v1"), true);
  assert.equal(names.has("other-app-cache"), true);
});

test("typed-voiceのService Workerだけを登録解除対象にする", async () => {
  const registration = {
    active: { scriptURL: "https://example.test/typed-voice/app-service-worker.js?source-cache=x" },
    waiting: null,
    installing: null,
  };
  const found = await findTypedVoiceServiceWorkerRegistration({
    baseUrl: "https://example.test/typed-voice/",
    serviceWorkerContainer: { async getRegistration() { return registration; } },
  });
  assert.equal(found, registration);

  await assert.rejects(() => findTypedVoiceServiceWorkerRegistration({
    baseUrl: "https://example.test/typed-voice/",
    serviceWorkerContainer: {
      async getRegistration() {
        return { active: { scriptURL: "https://example.test/desmume_webassembly/sw.js" } };
      },
    },
  }), /typed-voice以外/);
});

test("アンインストールはService Worker・typed-voice Cache・保存データを削除する", async () => {
  const db = createDb();
  const names = new Set(["typed-voice-model-assets-v2", "desmume_webassembly-cache-v1"]);
  const storageData = new Map([
    ["typed-voice-tutorial-v1-complete", "1"],
    ["typed-voice-ui-model-profile-v1", "fp16"],
    ["other-app", "keep"],
  ]);
  const storage = {
    get length() { return storageData.size; },
    key(index) { return [...storageData.keys()][index] ?? null; },
    removeItem(key) { storageData.delete(key); },
  };
  let unregistered = false;
  const result = await resetTypedVoiceOfflineRuntime({
    db,
    storage,
    baseUrl: "https://example.test/typed-voice/",
    cachesImpl: {
      async keys() { return [...names]; },
      async delete(name) { names.delete(name); return true; },
    },
    serviceWorkerContainer: {
      async getRegistration() {
        return {
          active: { scriptURL: "https://example.test/typed-voice/app-service-worker.js?source-cache=x" },
          async unregister() {
            assert.deepEqual(db.stores.sessions, []);
            assert.deepEqual(db.stores.settings, []);
            unregistered = true;
            return true;
          },
        };
      },
    },
  });
  assert.equal(unregistered, true);
  assert.deepEqual(result.deletedCaches, ["typed-voice-model-assets-v2"]);
  assert.deepEqual(db.stores.assets, []);
  assert.deepEqual(db.stores.sessions, []);
  assert.deepEqual(db.stores.settings, []);
  assert.equal(storageData.has("typed-voice-tutorial-v1-complete"), false);
  assert.equal(storageData.has("typed-voice-ui-model-profile-v1"), false);
  assert.equal(storageData.get("other-app"), "keep");
  assert.equal(names.has("desmume_webassembly-cache-v1"), true);
});

test("フリーズUIだけを表示するとアプリ本体をinertにして再登録ボタンだけ残す", () => {
  const reset = { addEventListener() {} };
  const status = { textContent: "" };
  const dialog = { hidden: true, addEventListener() {} };
  const dialogStatus = { textContent: "" };
  const backup = { addEventListener() {} };
  const backupConfirm = { addEventListener() {} };
  const confirm = { addEventListener() {} };
  const cancel = { addEventListener() {} };
  const reload = {
    focused: false,
    addEventListener() {},
    focus() { this.focused = true; },
  };
  const app = { inert: false };
  const freeze = { hidden: true, inert: false };
  const elements = new Map([
    ["offline-runtime-reset", reset],
    ["offline-runtime-reset-status", status],
    ["offline-runtime-reset-dialog", dialog],
    ["offline-runtime-reset-dialog-status", dialogStatus],
    ["offline-runtime-reset-backup", backup],
    ["offline-runtime-reset-backup-confirm", backupConfirm],
    ["offline-runtime-reset-confirm", confirm],
    ["offline-runtime-reset-cancel", cancel],
    ["offline-reset-freeze", freeze],
    ["offline-reset-reload", reload],
  ]);
  const classes = new Set();
  const documentRef = {
    body: { children: [app, freeze] },
    documentElement: { classList: { add(name) { classes.add(name); } } },
    getElementById(id) { return elements.get(id) ?? null; },
  };

  const controller = new OfflineRuntimeResetUiController(documentRef, { locationRef: { reload() {} } });
  controller.showFreeze();

  assert.equal(freeze.hidden, false);
  assert.equal(freeze.inert, false);
  assert.equal(app.inert, true);
  assert.equal(reload.focused, true);
  assert.equal(classes.has("offline-runtime-frozen"), true);
});

function createInteractiveElement({ hidden = false } = {}) {
  const listeners = new Map();
  return {
    hidden,
    disabled: false,
    textContent: "",
    focused: false,
    addEventListener(type, listener) { listeners.set(type, listener); },
    click() { listeners.get("click")?.({ target: this }); },
    dispatch(type, event = {}) { listeners.get(type)?.({ target: this, ...event }); },
    focus() { this.focused = true; },
  };
}

test("アンインストールボタンはバックアップ画面を開くだけで、保存確認まではService WorkerやCacheを変更しない", async () => {
  const reset = createInteractiveElement();
  const status = createInteractiveElement();
  const dialog = createInteractiveElement({ hidden: true });
  const dialogStatus = createInteractiveElement();
  const backup = createInteractiveElement();
  const backupConfirm = createInteractiveElement({ hidden: true });
  const confirm = createInteractiveElement();
  const cancel = createInteractiveElement();
  const freeze = createInteractiveElement({ hidden: true });
  const reload = createInteractiveElement();
  const elements = new Map([
    ["offline-runtime-reset", reset],
    ["offline-runtime-reset-status", status],
    ["offline-runtime-reset-dialog", dialog],
    ["offline-runtime-reset-dialog-status", dialogStatus],
    ["offline-runtime-reset-backup", backup],
    ["offline-runtime-reset-backup-confirm", backupConfirm],
    ["offline-runtime-reset-confirm", confirm],
    ["offline-runtime-reset-cancel", cancel],
    ["offline-reset-freeze", freeze],
    ["offline-reset-reload", reload],
  ]);
  let serviceWorkerQueries = 0;
  let cacheQueries = 0;
  let settingsClosed = 0;
  const documentListeners = new Map();
  const documentRef = {
    baseURI: "https://example.test/typed-voice/",
    body: { children: [dialog, freeze] },
    documentElement: { classList: { add() {} } },
    addEventListener(type, listener) { documentListeners.set(type, listener); },
    getElementById(id) { return elements.get(id) ?? null; },
  };
  new OfflineRuntimeResetUiController(documentRef, {
    db: createDb(),
    cachesImpl: {
      async keys() { cacheQueries += 1; return []; },
      async delete() { return true; },
    },
    serviceWorkerContainer: {
      async getRegistration() { serviceWorkerQueries += 1; return null; },
    },
    locationRef: { reload() {} },
    modelProfileUi: { closeSettings() { settingsClosed += 1; } },
  }).initialize();

  reset.click();
  await Promise.resolve();

  assert.equal(dialog.hidden, false);
  assert.equal(backup.focused, true);
  assert.equal(confirm.disabled, true);
  assert.equal(settingsClosed, 1);
  assert.equal(serviceWorkerQueries, 0);
  assert.equal(cacheQueries, 0);

  cancel.click();
  assert.equal(dialog.hidden, true);
  assert.equal(serviceWorkerQueries, 0);
  assert.equal(cacheQueries, 0);

  reset.click();
  dialog.dispatch("pointerdown", { target: dialog });
  assert.equal(dialog.hidden, true);
  assert.equal(serviceWorkerQueries, 0);
  assert.equal(cacheQueries, 0);

  reset.click();
  documentListeners.get("keydown")?.({ key: "Escape" });
  assert.equal(dialog.hidden, true);
  assert.equal(serviceWorkerQueries, 0);
  assert.equal(cacheQueries, 0);
});
