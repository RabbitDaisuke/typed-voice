import { queryPreparedModelCache } from "./service-worker-required.js";

const REMOTE_MANIFEST_URLS = Object.freeze({
  "mobile-int4": "https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/mobile-int4/typed-voice-manifest.json",
  "mobile-int8": "https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/mobile-int8/typed-voice-manifest.json",
  fp16: "https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/fp16/typed-voice-manifest.json",
});

export class VoiceRuntimeAdapter {
  constructor({ manifestUrl, appBaseUrl = null, onStatus = () => {} }) {
    this.manifestUrl = manifestUrl;
    this.appBaseUrl = appBaseUrl;
    this.onStatus = onStatus;
    this.speed = 1;
    this.ready = false;
    this.prepared = false;
    this.activeProfile = null;
    this.activeManifest = null;
    this.audioContext = null;
    this.playbackTail = Promise.resolve();
    this.client = null;
    this.progressListeners = new Set();
    this.loading = false;
    
    this.initializePromise = null;
    this.initializeProfile = null;
    
    this.replayAfterLoad = true;
    this.deferredSynthesis = [];
    this.replayingDeferred = false;
  }

  subscribeProgress(listener) {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  setSpeed(speed) {
    const value = Number(speed);
    if (!Number.isFinite(value) || value < 0.5 || value > 2) {
      throw new Error("速度は0.5〜2.0倍で指定してください。");
    }
    this.speed = value;
  }

  manifestUrlForProfile(profile = "fp32") {
    return REMOTE_MANIFEST_URLS[profile] || this.manifestUrl;
  }

  async getProfilePlan(profile = "fp32") {
    const normalized = Object.hasOwn(REMOTE_MANIFEST_URLS, profile) || profile === "fp32" ? profile : "fp16";
    const manifestUrl = this.manifestUrlForProfile(normalized);
    let manifest = this.activeProfile === normalized ? this.activeManifest : null;
    if (!manifest) {
      const response = await fetch(manifestUrl, { cache: "no-cache" });
      if (!response.ok) throw new Error(`音声モデル情報の取得に失敗しました (${response.status})`);
      manifest = await response.json();
      if (!manifest?.id || !Array.isArray(manifest.assets)) throw new Error("音声モデル情報が不正です。");
    }
    const totalBytes = Array.isArray(manifest?.assets)
      ? manifest.assets.reduce((sum, asset) => sum + Number(asset.byteSize || 0), 0)
      : 0;
    return {
      profile: normalized,
      manifest,
      totalBytes,
      manifestUrl,
    };
  }

  async isProfilePrepared(profile = "fp32") {
    const normalized = Object.hasOwn(REMOTE_MANIFEST_URLS, profile) || profile === "fp32" ? profile : "fp16";
    return queryPreparedModelCache(this.manifestUrlForProfile(normalized), { appBaseUrl: this.appBaseUrl });
  }

  setReplayAfterLoad(enabled) {
    this.replayAfterLoad = Boolean(enabled);
    if (!this.replayAfterLoad) this.#releaseDeferredSynthesis(false);
    return this.replayAfterLoad;
  }

  async prepare(profile = "fp32", { signal = null } = {}) {
    await this.#ensureProfileClient(profile);
    if (this.prepared) {
      const plan = await this.getProfilePlan(profile);
      return { manifestId: plan.manifest?.id, totalBytes: plan.totalBytes, cached: true };
    }
    if (signal?.aborted) throw signal.reason ?? new DOMException("Download aborted", "AbortError");
    const client = this.client;
    const abort = () => {
      if (this.client !== client) return;
      client.abort(signal?.reason ?? new DOMException("Download aborted", "AbortError"));
      this.client = null;
      this.activeManifest = null;
      this.prepared = false;
      this.ready = false;
    };
    signal?.addEventListener("abort", abort, { once: true });
    this.onStatus("音声データをこの端末へ保存しています。");
    try {
      const result = await client.prepare();
      if (signal?.aborted) throw signal.reason ?? new DOMException("Download aborted", "AbortError");
      this.prepared = true;
      this.onStatus("音声データを保存しました。オフラインでも使えます。");
      return result;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async initializePrepared(profile = this.activeProfile ?? "fp32", { enableAudio = true } = {}) {
    
    if (this.initializePromise) {
      const initializedProfile = this.initializeProfile;
      const initialized = await this.initializePromise;
      if (initializedProfile !== profile) {
        return this.initializePrepared(profile, { enableAudio });
      }
      if (enableAudio) await this.#enableAudioContext();
      if (this.audioEnabled) this.#releaseDeferredSynthesis(true);
      else this.#markDeferredAwaitingAudio();
      return initialized;
    }
    this.loading = true;
    this.initializeProfile = profile;
    const initializePromise = (async () => {
      await this.#ensureProfileClient(profile);
      if (this.ready) {
        if (enableAudio) await this.#enableAudioContext();
        if (this.audioEnabled) this.#releaseDeferredSynthesis(true);
        else this.#markDeferredAwaitingAudio();
        return { ready: true, profile: this.activeProfile };
      }
      if (enableAudio) await this.#enableAudioContext();
      this.onStatus("保存済みモデルから音声エンジンを起動しています。");
      const initialized = await this.client.initialize();
      this.prepared = true;
      this.ready = true;
      this.onStatus(`音声を利用できます。${initialized.backend}`);
      if (this.audioEnabled) this.#releaseDeferredSynthesis(true);
      else this.#markDeferredAwaitingAudio();
      return initialized;
    })();
    this.initializePromise = initializePromise;
    try {
      return await initializePromise;
    } catch (error) {
      this.#releaseDeferredSynthesis(false);
      // onnxruntime-web keeps a failed initWasm() state inside the worker. A
      // retry on that same worker only reports "previous call to initWasm()
      // failed" even after the source/cache problem has been repaired. Throw
      // this worker away so the next retry starts from a clean runtime.
      const failedClient = this.client;
      await failedClient?.dispose().catch(() => {});
      if (this.client === failedClient) {
        this.client = null;
        this.activeManifest = null;
        this.ready = false;
        this.prepared = false;
      }
      throw error;
    } finally {
      if (this.initializePromise === initializePromise) {
        this.initializePromise = null;
        this.initializeProfile = null;
        this.loading = false;
      }
    }
    
  }

  async enable(profile = this.activeProfile ?? "fp32") {
    await this.prepare(profile);
    return this.initializePrepared(profile, { enableAudio: true });
  }

  async unlockAudio() {
    await this.#enableAudioContext();
    if (this.ready) this.#releaseDeferredSynthesis(true);
    return true;
  }

  get audioEnabled() {
    return this.audioContext?.state === "running";
  }

  async synthesize({ utteranceId, generation, text }, { fromDeferred = false } = {}) {
    if (this.ready && !this.audioEnabled) {
      try {
        await this.#enableAudioContext();
      } catch {
        // User activation can be required. The normal deferred path below remains the fallback.
      }
    }
    if (!this.ready || !this.audioEnabled) {
      if (this.replayAfterLoad && (this.loading || this.ready)) {
        const phase = this.loading ? "waiting-for-model" : "waiting-for-audio";
        this.#emitProgress({ stage: "synthesis-deferred", phase, utteranceId, generation });
        const shouldReplay = await this.#waitForModelLoad(utteranceId, generation);
        if (shouldReplay && this.ready && this.audioEnabled) {
          return this.synthesize({ utteranceId, generation, text }, { fromDeferred: true });
        }
      }
      this.#emitProgress({ stage: "synthesis-skipped", utteranceId, generation });
      return { skipped: true, durationMs: 0 };
    }
    try {
      let synthesisText = text;
      const language = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text) ? "ja" : "en";
      if (language === "ja" && /[A-Za-z]+/.test(text)) {
        this.#emitProgress({ stage: "normalize", phase: "kanalizer", utteranceId, generation, completed: 0, totalSteps: 1 });
        const { normalizeAsciiLetterRuns } = await import("../text/kanalizer-normalizer.js");
        const normalized = await normalizeAsciiLetterRuns(text);
        synthesisText = normalized.text;
        this.#emitProgress({ stage: "normalize", phase: "kanalizer", utteranceId, generation, completed: 1, totalSteps: 1 });
      }
      const result = await this.client.synthesize({
        utteranceId,
        generation,
        text: synthesisText,
        options: {
          language,
          speed: this.speed,
        },
      });
      this.#emitProgress({ stage: "synthesis-complete", utteranceId, generation });
      return {
        ...result,
        durationMs: result.samples.length / result.sampleRate * 1000,
      };
    } finally {
      if (fromDeferred) {
        this.replayingDeferred = false;
        this.#releaseNextDeferredSynthesis();
      }
    }
  }

  async cancel(utteranceId, generation) {
    const deferredIndex = this.deferredSynthesis.findIndex((item) => (
      item.utteranceId === utteranceId && item.generation === generation
    ));
    if (deferredIndex >= 0) {
      const [deferred] = this.deferredSynthesis.splice(deferredIndex, 1);
      deferred.resolve(false);
      this.#emitProgress({ stage: "synthesis-cancelled", utteranceId, generation });
      return;
    }
    if (!this.ready || !this.client) return;
    await this.client.cancel(utteranceId, generation);
    this.#emitProgress({ stage: "synthesis-cancelled", utteranceId, generation });
  }

  async play({ samples, sampleRate, durationMs }) {
    if (!this.ready || !this.audioContext) return { durationMs: 0 };
    const playback = this.playbackTail.then(async () => {
      await this.audioContext.resume();
      const buffer = this.audioContext.createBuffer(1, samples.length, sampleRate);
      buffer.copyToChannel(samples, 0);
      const source = this.audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audioContext.destination);
      await new Promise((resolve) => {
        source.addEventListener("ended", resolve, { once: true });
        source.start();
      });
      return { durationMs: Number(durationMs || samples.length / sampleRate * 1000) };
    });
    this.playbackTail = playback.catch(() => {});
    return playback;
  }

  async dispose() {
    await this.client?.dispose();
    await this.audioContext?.close();
    this.client = null;
    this.audioContext = null;
    this.ready = false;
    this.prepared = false;
    this.loading = false;
    this.replayingDeferred = false;
    this.#releaseDeferredSynthesis(false);
    this.activeProfile = null;
    this.activeManifest = null;
  }

  async #ensureProfileClient(profile) {
    const normalized = Object.hasOwn(REMOTE_MANIFEST_URLS, profile) || profile === "fp32" ? profile : "fp16";
    if (this.client && this.activeProfile === normalized) {
      if (!this.activeManifest) this.activeManifest = await this.client.getManifest();
      return;
    }
    if (this.ready && this.activeProfile !== normalized) {
      this.ready = false;
    }
    await this.client?.dispose().catch(() => {});
    const { EngineClient } = await import("../engine/engine-client.js");
    this.client = new EngineClient({
      manifestUrl: this.manifestUrlForProfile(normalized),
      appBaseUrl: this.appBaseUrl,
      onProgress: (message) => this.#handleProgress(message),
    });
    this.activeProfile = normalized;
    this.activeManifest = await this.client.getManifest();
    this.prepared = false;
  }

  async #enableAudioContext() {
    this.audioContext ??= new AudioContext();
    await this.audioContext.resume();
  }

  #handleProgress(message) {
    this.#emitProgress(message);
    if (message.stage === "download" || message.phase === "verifying-cache" || message.phase === "verified-cache") {
      const loaded = Number(message.loadedBytes || 0);
      const total = Number(message.totalBytes || 0);
      const percentage = total > 0 ? ((loaded / total) * 100).toFixed(1) : "?";
      this.onStatus(`音声データを確認中 ${percentage}%`);
      return;
    }
    if (message.stage === "initialize") {
      this.onStatus(`音声エンジンを起動中${message.backend ? ` (${message.backend})` : ""}`);
    }
  }

  #emitProgress(message) {
    for (const listener of this.progressListeners) {
      try {
        listener(message);
      } catch {
        // A UI progress observer must never break engine preparation.
      }
    }
  }

  #waitForModelLoad(utteranceId, generation) {
    return new Promise((resolve) => {
      this.deferredSynthesis.push({ utteranceId, generation, resolve });
    });
  }

  #releaseDeferredSynthesis(ready) {
    if (ready && this.replayAfterLoad) {
      this.#releaseNextDeferredSynthesis();
      return;
    }
    const pending = this.deferredSynthesis.splice(0);
    for (const item of pending) item.resolve(false);
  }

  #releaseNextDeferredSynthesis() {
    if (this.replayingDeferred || !this.replayAfterLoad || !this.ready || !this.audioEnabled) return;
    const item = this.deferredSynthesis.shift();
    if (!item) return;
    this.replayingDeferred = true;
    item.resolve(true);
  }

  #markDeferredAwaitingAudio() {
    for (const item of this.deferredSynthesis) {
      this.#emitProgress({
        stage: "synthesis-deferred",
        phase: "waiting-for-audio",
        utteranceId: item.utteranceId,
        generation: item.generation,
      });
    }
  }
}
