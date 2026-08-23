import "./poc.css";
import { EngineClient } from "./engine/engine-client.js";
import { requireServiceWorker } from "./app/service-worker-required.js";
import {
  hasKanalizerCandidate,
  normalizeAsciiLetterRunsForPoc,
  prepareKanalizerOffline,
} from "./text/kanalizer-normalizer.js";

const isolationStatus = document.querySelector("#isolation-status");
const engineStatus = document.querySelector("#engine-status");
const voiceNotice = document.querySelector("#voice-notice");
const prepareButton = document.querySelector("#prepare-button");
const initializeButton = document.querySelector("#initialize-button");
const speakButton = document.querySelector("#speak-button");
const speechText = document.querySelector("#speech-text");
const speechSpeed = document.querySelector("#speech-speed");
const voiceProfile = document.querySelector("#voice-profile");
const normalizeEnglish = document.querySelector("#normalize-english");
const normalizeButton = document.querySelector("#normalize-button");
const kanalizerStatus = document.querySelector("#kanalizer-status");
const normalizedText = document.querySelector("#normalized-text");

const REMOTE_MANIFEST_URLS = {
  "mobile-int4": "https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/mobile-int4/typed-voice-manifest.json",
  "mobile-int8": "https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/mobile-int8/typed-voice-manifest.json",
  fp16: "https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/fp16/typed-voice-manifest.json",
};

const PROFILE_LABELS = {
  "mobile-int4": "Mobile INT4",
  "mobile-int8": "Mobile INT8",
  fp16: "LLM FP16",
  fp32: "FP32",
};

let client = null;
let manifest = null;
let prepared = false;
let initialized = false;
let busy = false;
let normalizerBusy = false;

await requireServiceWorker({ reloadKey: "typed-voice-poc-coi-reloaded" });
isolationStatus.textContent = globalThis.crossOriginIsolated
  ? "Cross-Origin Isolation: 有効。WASMマルチスレッドを利用できます。"
  : "Cross-Origin Isolation: 無効。WASMは1スレッドへフォールバックします。";

const requestedProfile = new URL(location.href).searchParams.get("profile");
voiceProfile.value = normalizeProfile(requestedProfile);
await loadVoiceManifest(voiceProfile.value);

voiceProfile.addEventListener("change", async () => {
  const url = new URL(location.href);
  if (voiceProfile.value === "fp16") url.searchParams.delete("profile");
  else url.searchParams.set("profile", voiceProfile.value);
  history.replaceState(null, "", url);
  await loadVoiceManifest(voiceProfile.value);
});

speechText.addEventListener("input", () => {
  normalizedText.textContent = "";
});

normalizeButton.addEventListener("click", async () => {
  const text = speechText.value.trim();
  if (!text) return;
  await runNormalizerTask(async () => {
    await normalizeForPoc(text);
  });
});

prepareButton.addEventListener("click", async () => {
  await runButtonTask(async () => {
    engineStatus.textContent = `${manifest.displayName} runtimeを取得し、ストリーミングXXH3-128検証後にオフラインCacheへ保存しています。`;
    const result = await client.prepare();
    const kanalizer = await prepareKanalizerOffline({
      onStatus(message) {
        kanalizerStatus.textContent = message;
      },
    });
    prepared = true;
    const totalBytes = result.totalBytes + kanalizer.modelBytes + kanalizer.dictionaryBytes + kanalizer.wasmBytes;
    engineStatus.textContent = `オフライン音声準備完了: ${(totalBytes / 1024 / 1024).toFixed(1)} MiB（音声 + Kanalizer）`;
  });
});

initializeButton.addEventListener("click", async () => {
  await runButtonTask(async () => {
    engineStatus.textContent = "検証済みモデルからOmniVoiceエンジンを起動し、実forwardでbackendを検証しています。";
    const ready = await client.initialize();
    initialized = true;
    engineStatus.textContent = `エンジン起動完了: backend=${ready.backend}, sampleRate=${ready.sampleRate}`;
  });
});

speakButton.addEventListener("click", async () => {
  const text = speechText.value.trim();
  if (!text) return;
  const speed = Number(speechSpeed.value);
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) {
    engineStatus.textContent = "速度は0.5〜2.0倍で指定してください。";
    return;
  }
  const audioContext = new AudioContext();
  try {
    await audioContext.resume();
    await runButtonTask(async () => {
      let synthesisText = text;
      if (normalizeEnglish.checked) {
        const normalized = await normalizeForPoc(text);
        synthesisText = normalized.text;
      }
      const utteranceId = crypto.randomUUID();
      const startedAt = performance.now();
      const language = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text) ? "ja" : "en";
      const result = await client.synthesize({
        utteranceId,
        generation: 1,
        text: synthesisText,
        options: { language, speed },
      });
      const elapsed = performance.now() - startedAt;
      await playFloat32(audioContext, result.samples, result.sampleRate);
      engineStatus.textContent = `生成 ${elapsed.toFixed(0)} ms / 音声 ${(result.samples.length / result.sampleRate).toFixed(2)} s / 速度 ${speed.toFixed(1)}x / ${result.backend} / target=${result.targetLength} / tokens=${result.tokenHash}`;
    });
  } finally {
    await audioContext.close().catch(() => {});
  }
});

async function loadVoiceManifest(profile = "fp16") {
  busy = true;
  prepared = false;
  initialized = false;
  syncControls();
  if (client) await client.dispose().catch(() => {});
  client = null;
  manifest = null;
  const appBaseUrl = new URL(import.meta.env.BASE_URL, document.baseURI).href;
  const manifestUrl = REMOTE_MANIFEST_URLS[profile]
    || new URL(`${import.meta.env.BASE_URL}voice-manifest.json`, document.baseURI).href;
  try {
    client = new EngineClient({
      manifestUrl,
      appBaseUrl,
      onProgress(message) {
      if (message.stage === "download") {
        const loaded = Number(message.loadedBytes || 0);
        const total = Number(message.totalBytes || 0);
        const percentage = total > 0 ? ((loaded / total) * 100).toFixed(1) : "?";
        engineStatus.textContent = `取得・検証: ${message.assetId || "asset"} ${(loaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MiB (${percentage}%)`;
      } else if (message.stage === "generate") {
        engineStatus.textContent = `OmniVoice生成: step ${message.step}/${message.numStep}, masked=${message.remaining}`;
      } else if (message.stage === "initialize") {
        if (message.phase === "verifying-cache" || message.phase === "verified-cache") {
          const loaded = Number(message.loadedBytes || 0);
          const total = Number(message.totalBytes || 0);
          const percentage = total > 0 ? ((loaded / total) * 100).toFixed(1) : "?";
          engineStatus.textContent = `保存済み音声をXXH3-128再検証: ${message.assetId || "asset"} ${(loaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MiB (${percentage}%)`;
        } else if (message.phase === "backend-failed") {
          engineStatus.textContent = `エンジン初期化: ${message.backend || "backend"} 失敗: ${message.message || "詳細なし"}`;
        } else {
          engineStatus.textContent = `エンジン初期化: ${message.phase}${message.backend ? ` (${message.backend})` : ""}`;
        }
      }
      },
    });
    manifest = await client.getManifest();
    voiceNotice.textContent = manifest.displayName;
    engineStatus.textContent = manifest.installable === false
      ? (manifest.blockedReason || "音声runtimeは現在利用できません。")
      : "最初に「オフライン音声を準備」を実行してください。";
  } catch (error) {
    manifest = null;
    await client?.dispose().catch(() => {});
    client = null;
    voiceNotice.textContent = REMOTE_MANIFEST_URLS[profile]
      ? `${PROFILE_LABELS[profile]} runtimeを読み込めません。`
      : "";
    engineStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    busy = false;
    syncControls();
  }
}

function normalizeProfile(profile) {
  return Object.hasOwn(PROFILE_LABELS, profile) ? profile : "fp16";
}

async function normalizeForPoc(text) {
  if (!hasKanalizerCandidate(text)) {
    kanalizerStatus.textContent = "Kanalizer正規化をスキップしました。";
    normalizedText.textContent = text;
    return { text, replacements: [], modelRevision: null };
  }
  const result = await normalizeAsciiLetterRunsForPoc(text, {
    onStatus(message) {
      kanalizerStatus.textContent = message;
    },
  });
  normalizedText.textContent = result.text;
  const summary = result.replacements.map(({ source, reading }) => `${source}→${reading}`).join(" / ");
  kanalizerStatus.textContent = summary
    ? `正規化完了: ${summary}`
    : "正規化対象の英字列はありません。";
  return result;
}

async function playFloat32(audioContext, samples, sampleRate) {
  const buffer = audioContext.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(samples, 0);
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  await new Promise((resolve) => {
    source.addEventListener("ended", resolve, { once: true });
    source.start();
  });
}

async function runButtonTask(task) {
  busy = true;
  syncControls();
  try {
    await task();
  } catch (error) {
    engineStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    busy = false;
    syncControls();
  }
}

async function runNormalizerTask(task) {
  normalizerBusy = true;
  syncControls();
  try {
    await task();
  } catch (error) {
    kanalizerStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    normalizerBusy = false;
    syncControls();
  }
}

function syncControls() {
  const hasAssets = Array.isArray(manifest?.assets) && manifest.assets.length > 0;
  const preparable = Boolean(manifest) && manifest.preparable !== false && hasAssets;
  const installable = Boolean(manifest) && manifest.installable !== false;
  voiceProfile.disabled = busy;
  normalizeEnglish.disabled = busy || normalizerBusy;
  normalizeButton.disabled = busy || normalizerBusy;
  prepareButton.disabled = busy || !preparable || initialized;
  initializeButton.disabled = busy || !installable || !prepared || initialized;
  speakButton.disabled = busy || !initialized;
}


