import { Tokenizer } from "@huggingface/tokenizers";
import { buildVirtualAssetUrl } from "./asset-store.js";
import { loadOrt, ORT_DIST_BASE_URL } from "./onnxruntime-web-runtime.js";
import { configureOrtWasm } from "./threading.js";
import { buildOmniVoiceAttentionMask, createPythonRandom, generateOmniVoiceCodes, prepareOmniVoiceInputs } from "./omnivoice-generation.js";

function halfToFloat(value) {
  const sign = (value & 0x8000) ? -1 : 1;
  const exponent = (value >>> 10) & 0x1f;
  const fraction = value & 0x03ff;
  if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}

function tensorToFloat32(tensor) {
  if (tensor.data instanceof Float32Array) return new Float32Array(tensor.data);
  if (tensor.type === "float16" && tensor.data instanceof Uint16Array) {
    return Float32Array.from(tensor.data, halfToFloat);
  }
  return Float32Array.from(tensor.data, Number);
}

function normalizePcm(input) {
  let start = 0;
  let end = input.length;
  const threshold = 0.0005;
  while (start < end && Math.abs(input[start]) < threshold) start += 1;
  while (end > start && Math.abs(input[end - 1]) < threshold) end -= 1;
  const pcm = input.slice(start, end);
  let peak = 0;
  for (const sample of pcm) peak = Math.max(peak, Math.abs(sample));
  if (peak > 0) {
    const scale = Math.min(0.95 / peak, 3);
    for (let index = 0; index < pcm.length; index += 1) pcm[index] *= scale;
  }
  return pcm;
}

function bigintRange(length, batch) {
  const result = new BigInt64Array(batch * length);
  for (let row = 0; row < batch; row += 1) {
    for (let index = 0; index < length; index += 1) result[row * length + index] = BigInt(index);
  }
  return result;
}

function tokenHash(tokens) {
  let hash = 0x811c9dc5;
  for (const token of tokens) {
    const value = Number(token);
    hash ^= value & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (value >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export class OmniVoiceEngine {
  constructor({ preferredThreadCount } = {}) {
    this.preferredThreadCount = preferredThreadCount;
    this.manifest = null;
    this.tokenizer = null;
    this.sessions = null;
    this.backend = null;
    this.runtime = null;
    this.ort = null;
  }

  async initialize(manifest, { onStatus = () => {}, appBaseUrl = new URL("./", globalThis.location.href).href } = {}) {
    if (!manifest.runtime) throw new Error("OmniVoice runtime description is missing");
    this.manifest = manifest;
    this.runtime = manifest.runtime;
    this.appBaseUrl = appBaseUrl;
    this.ort = await loadOrt();
    configureOrtWasm(this.ort, {
      preferredThreadCount: this.preferredThreadCount,
      wasmBaseUrl: ORT_DIST_BASE_URL,
    });

    const assetRoot = buildVirtualAssetUrl(manifest.id, "", appBaseUrl);
    const sessionTotal = Object.keys(this.runtime.sessions || {}).length;
    const engineTotal = sessionTotal + 2;
    onStatus({ phase: "tokenizer", engineLoaded: 0, engineTotal });
    this.tokenizer = await loadTokenizer(assetRoot, this.runtime.tokenizerDirectory || "tokenizer");
    onStatus({ phase: "tokenizer-ready", engineLoaded: 1, engineTotal });

    const candidates = buildSessionPlans(manifest, Boolean(globalThis.navigator?.gpu) && this.runtime.preferWebGpu !== false);
    let lastError;
    for (const candidate of candidates) {
      try {
        onStatus({ phase: "sessions", backend: candidate.label, engineLoaded: 1, engineTotal });
        this.sessions = await this.#createSessions(candidate, onStatus, engineTotal);
        this.backend = candidate.label;
        onStatus({ phase: "warmup", backend: candidate.label, engineLoaded: sessionTotal + 1, engineTotal });
        await this.#warmup();
        onStatus({ phase: "ready", backend: candidate.label, engineLoaded: engineTotal, engineTotal });
        return { backend: this.backend, sampleRate: this.runtime.sampleRate };
      } catch (error) {
        lastError = error;
        await this.dispose();
        this.manifest = manifest;
        this.runtime = manifest.runtime;
        this.tokenizer = await loadTokenizer(assetRoot, this.runtime.tokenizerDirectory || "tokenizer");
        onStatus({ phase: "backend-failed", backend: candidate.label, message: error.message });
      }
    }
    throw new Error(`OmniVoice initialization failed: ${lastError?.message || "no usable backend"}`);
  }

  async synthesize(text, options = {}) {
    if (!this.sessions || !this.tokenizer) throw new Error("OmniVoice engine is not initialized");
    const inputs = await prepareOmniVoiceInputs(text, this.tokenizer, this.runtime.generation, options);
    const numStep = options.numStep ?? this.runtime.generation.numStep ?? 16;
    const generated = await generateOmniVoiceCodes({
      inputs,
      config: this.runtime.generation,
      runBackboneStep: (step) => this.#runBackboneStep(step),
      numStep,
      guidanceScale: options.guidanceScale ?? this.runtime.generation.guidanceScale ?? 4,
      tShift: options.tShift ?? this.runtime.generation.tShift ?? 0.05,
      layerPenalty: options.layerPenalty ?? this.runtime.generation.layerPenalty ?? 5,
      positionTemperature: options.positionTemperature ?? this.runtime.generation.positionTemperature ?? 0,
      classTemperature: options.classTemperature ?? this.runtime.generation.classTemperature ?? 0,
      attentionMode: this.runtime.llmAttention?.mode ?? "legacy-causal-2d",
      isCancelled: options.isCancelled,
      onStep: (progress) => options.onStep?.({
        ...progress,
        phase: "generate",
        completed: progress.step,
        totalSteps: numStep + 1,
      }),
      random: options.seed == null ? Math.random : createPythonRandom(options.seed),
    });
    if (options.isCancelled?.()) throw new Error("cancelled");
    options.onStep?.({ phase: "decode", completed: numStep, totalSteps: numStep + 1 });
    const pcm = await this.#decode(generated.tokens, generated.codebooks, generated.targetLength);
    options.onStep?.({ phase: "decode-complete", completed: numStep + 1, totalSteps: numStep + 1 });
    return {
      pcm: normalizePcm(pcm),
      sampleRate: this.runtime.sampleRate,
      backend: this.backend,
      tokenHash: tokenHash(generated.tokens),
      targetLength: generated.targetLength,
    };
  }

  async #createSessions(candidate, onStatus, engineTotal) {
    const sessions = {};
    const entries = Object.entries(this.runtime.sessions);
    try {
      for (let index = 0; index < entries.length; index += 1) {
        const [name, definition] = entries[index];
        const modelUrl = buildVirtualAssetUrl(this.manifest.id, definition.model, this.appBaseUrl);
        const sessionBackend = candidate.backends[name] || candidate.defaultBackend;
        const options = {
          executionProviders: [sessionBackend],
          graphOptimizationLevel: "all",
        };
        if (definition.externalData?.length) {
          options.externalData = definition.externalData.map((entry) => ({
            path: entry.path,
            data: buildVirtualAssetUrl(this.manifest.id, entry.localPath, this.appBaseUrl),
          }));
        }
        try {
          sessions[name] = await this.ort.InferenceSession.create(modelUrl, options);
          onStatus({
            phase: "session-ready",
            backend: candidate.label,
            sessionName: name,
            engineLoaded: index + 2,
            engineTotal,
          });
        } catch (error) {
          throw new Error(`${candidate.label}/${name} (${sessionBackend}) session creation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return sessions;
    } catch (error) {
      await Promise.allSettled(Object.values(sessions).map((session) => session.release?.()));
      throw error;
    }
  }

  async #warmup() {
    const codebooks = this.runtime.generation.num_audio_codebook;
    const sequenceLength = 4;
    const inputIds = new BigInt64Array(2 * codebooks * sequenceLength).fill(BigInt(this.runtime.generation.audio_mask_id));
    const audioMask = new Uint8Array(2 * sequenceLength).fill(1);
    const attention = buildOmniVoiceAttentionMask({
      sequenceLength,
      targetLength: sequenceLength,
      mode: this.runtime.llmAttention?.mode ?? "legacy-causal-2d",
    });
    const logits = await this.#runBackboneStep({
      inputIds,
      audioMask,
      attentionMask: attention.data,
      attentionMaskType: attention.type,
      attentionMaskShape: attention.shape,
      batch: 2,
      codebooks,
      sequenceLength,
    });
    if (logits.length !== 2 * codebooks * sequenceLength * this.runtime.generation.audio_vocab_size) {
      throw new Error(`Unexpected warmup logits length: ${logits.length}`);
    }
  }

  async #runBackboneStep({ inputIds, audioMask, attentionMask, attentionMaskType = "int64", attentionMaskShape, batch, codebooks, sequenceLength }) {
    const embeddingsResult = await this.sessions.audioEmbeddings.run({
      input_ids: new this.ort.Tensor("int64", inputIds, [batch, codebooks, sequenceLength]),
      audio_mask: new this.ort.Tensor("bool", audioMask, [batch, sequenceLength]),
    });
    const embeddings = embeddingsResult.inputs_embeds;
    const llmFeed = {
      inputs_embeds: new this.ort.Tensor("float32", tensorToFloat32(embeddings), [batch, sequenceLength, this.runtime.hiddenSize]),
    };
    const llmInputNames = new Set(this.sessions.llm.inputNames);
    if (llmInputNames.has("attention_mask")) {
      llmFeed.attention_mask = new this.ort.Tensor(
        attentionMaskType,
        attentionMask,
        attentionMaskShape ?? [batch, sequenceLength]
      );
    }
    if (llmInputNames.has("position_ids")) {
      llmFeed.position_ids = new this.ort.Tensor("int64", bigintRange(sequenceLength, batch), [batch, sequenceLength]);
    }
    for (const inputName of this.sessions.llm.inputNames) {
      if (!inputName.includes("past")) continue;
      llmFeed[inputName] = new this.ort.Tensor("float32", new Float32Array(0), [batch, this.runtime.numKvHeads, 0, this.runtime.headDim]);
    }
    const llmResult = await this.sessions.llm.run(llmFeed);
    const hidden = llmResult.hidden_states;
    const headsResult = await this.sessions.audioHeads.run({
      hidden_states: new this.ort.Tensor("float32", tensorToFloat32(hidden), [batch, sequenceLength, this.runtime.hiddenSize]),
    });
    return tensorToFloat32(headsResult.logits);
  }

  async #decode(tokens, codebooks, targetLength) {
    const decoderInputName = this.runtime.decoderInputName || "codes";
    const decoderOutputName = this.runtime.decoderOutputName || "waveform_24k";
    const result = await this.sessions.higgsDecoder.run({
      [decoderInputName]: new this.ort.Tensor("int64", tokens, [codebooks, 1, targetLength]),
    });
    const waveform = result[decoderOutputName];
    if (!waveform) throw new Error(`Higgs decoder output not found: ${decoderOutputName}`);
    return tensorToFloat32(waveform);
  }

  async dispose() {
    if (this.sessions) {
      await Promise.all(Object.values(this.sessions).map((session) => session.release?.()));
    }
    this.sessions = null;
    this.backend = null;
    this.tokenizer = null;
  }
}

function buildSessionPlans(manifest, webGpuAvailable) {
  if (!webGpuAvailable) {
    return [{ label: "wasm", defaultBackend: "wasm", backends: {} }];
  }

  const isMobileInt8 = manifest.runtimeSource?.qualityProfile === "mobile-int8-weight-only"
    || manifest.conversion?.targetProfile === "mobile-int8-weight-only";
  const isMobileInt4 = manifest.runtimeSource?.qualityProfile === "mobile-int4-weight-only"
    || manifest.conversion?.targetProfile === "mobile-int4-weight-only";
  if (isMobileInt8 || isMobileInt4) {
    return [
      {
        label: "webgpu+llm-wasm+higgs-wasm",
        defaultBackend: "webgpu",
        backends: { llm: "wasm", higgsDecoder: "wasm" },
      },
      { label: "wasm", defaultBackend: "wasm", backends: {} },
    ];
  }

  return [
    {
      label: "webgpu+higgs-wasm",
      defaultBackend: "webgpu",
      backends: { higgsDecoder: "wasm" },
    },
    { label: "wasm", defaultBackend: "wasm", backends: {} },
  ];
}

async function loadTokenizer(assetRoot, tokenizerDirectory) {
  const base = new URL(`${tokenizerDirectory.replace(/\/$/, "")}/`, assetRoot);
  const [tokenizerResponse, configResponse] = await Promise.all([
    fetch(new URL("tokenizer.json", base)),
    fetch(new URL("tokenizer_config.json", base)),
  ]);
  if (!tokenizerResponse.ok) {
    throw new Error(`Tokenizer model is unavailable offline: ${tokenizerResponse.status}`);
  }
  if (!configResponse.ok) {
    throw new Error(`Tokenizer config is unavailable offline: ${configResponse.status}`);
  }
  const [tokenizerJson, tokenizerConfig] = await Promise.all([
    tokenizerResponse.json(),
    configResponse.json(),
  ]);
  return new Tokenizer(tokenizerJson, tokenizerConfig);
}
