import { IndexedDbConversationRepository, openConversationDatabase } from "./storage.js";
import { UtteranceOrchestrator } from "./utterance-orchestrator.js";
import {
  getCompletedLineFromLineBreak,
  retainRecentSubmittedLines,
} from "./composer-policy.js";
import { planComposerRevisions } from "./revision-target.js";

import {
  createConversationFromSubmittedText,
  normalizeConversationId,
  resolveCurrentConversation,
  selectBootstrapConversationId,
} from "./conversation-session-policy.js";
import {
  clearAllApplicationData,
  clearConversationData,
  createApplicationBackup,
  restoreApplicationBackup,
} from "./application-backup.js";
import { markTutorialComplete } from "./tutorial-persistence.js";
import { planOrtRuntimeAssets, prepareOrtRuntimeAssets } from "./service-worker-required.js";

const DEFAULT_REASONING_SECONDS = 2;
const CONVERSATION_PARAM = "conversation";
const RESTORED_UI_SESSION_KEY = "typed-voice-restored-ui-v1";
const BOOTSTRAP_SESSION_KEY = "typed-voice-bootstrap-conversation-v1";
const BOOTSTRAP_SESSION_MAX_AGE_MS = 10_000;

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatNumber(value) {
  return new Intl.NumberFormat("ja-JP").format(Number(value || 0));
}


function isInteractiveTarget(target) {
  return Boolean(target.closest("button, a, input, textarea, select, label"));
}

export class UiOrchestrator {
  constructor(documentRef = document, { voiceRuntime = null, getModelProfile = () => "fp16" } = {}) {
    this.document = documentRef;
    this.voiceRuntime = voiceRuntime;
    this.getModelProfile = getModelProfile;
    this.repository = null;
    this.utterances = null;
    this.currentSession = null;
    this.channel = "BroadcastChannel" in globalThis ? new BroadcastChannel("typed-voice-conversations") : null;
    this.typingStartedAt = null;
    this.deletedChars = 0;
    this.pendingTicker = null;
    this.refreshAllPromise = null;
    this.refreshAllQueued = false;
    
    this.refreshAllResumePendingQueued = false;
    
    this.messageRenderKey = null;
    this.pendingRenderKey = null;
    this.conversationRenderKey = null;
    this.statisticsRenderKey = null;
    this.synthesisProgress = new Map();
    this.replayUtteranceIds = new Set();
    this.voiceProgressUnsubscribe = null;
    this.ensureConversationPromise = null;
    this.secondaryView = "timeline";
    this.elements = this.#resolveElements();
  }

  async initialize() {
    const db = await openConversationDatabase();
    this.repository = new IndexedDbConversationRepository(db);
    this.utterances = new UtteranceOrchestrator({
      repository: this.repository,
      speech: this.voiceRuntime,
      playback: this.voiceRuntime,
      onChange: (change) => {
        if (change?.type === "message-committed" || change?.type === "pending-cancelled") {
          const id = change?.message?.id ?? change?.id;
          if (id) this.synthesisProgress.delete(id);
        }
        if (change?.type === "message-committed") {
          void this.refreshAll();
        } else {
          void this.refreshPending();
        }
      },
    });
    this.voiceProgressUnsubscribe = this.voiceRuntime?.subscribeProgress?.((message) => this.#handleVoiceProgress(message)) ?? null;
    this.setReplayAfterVoiceLoad(this.elements.voiceLoadReplayAfterLoad.checked);
    this.#bindEvents();

    const storedWait = Number(await this.repository.getSetting("reasoningSeconds", DEFAULT_REASONING_SECONDS));
    this.elements.reasoningSeconds.value = Number.isFinite(storedWait) ? String(storedWait) : String(DEFAULT_REASONING_SECONDS);
    const storedSpeed = Number(await this.repository.getSetting("speechSpeed", 1));
    const speed = Number.isFinite(storedSpeed) ? Math.min(2, Math.max(0.5, storedSpeed)) : 1;
    this.elements.speechSpeed.value = String(speed);
    this.voiceRuntime?.setSpeed(speed);

    const requestedId = normalizeConversationId(new URL(location.href).searchParams.get(CONVERSATION_PARAM));
    const session = requestedId ? await this.repository.getSession(requestedId) : null;
    if (session) {
      
      await this.openConversation(session.id, { replaceUrl: true, resumePending: true });
      
    } else {
      const navigationType = performance.getEntriesByType("navigation")[0]?.type ?? "navigate";
      const storedBootstrap = this.#readBootstrapSession();
      const bootstrapId = selectBootstrapConversationId({
        requestedId,
        reloadId: storedBootstrap?.id,
        navigationType,
      });
      this.#writeBootstrapSession(bootstrapId);
      this.#writeUrl(bootstrapId, true);
      await this.ensureCurrentConversation({ replaceUrl: true, preferredId: bootstrapId });
      
      await this.refreshAll({ resumePending: true });
      
      this.#showSecondaryView("timeline");
      this.focusComposer();
    }
    this.#restoreUiStateAfterImport();

    
    // 他タブのpendingは、そのタブ自身がすでに合成している。BroadcastChannel通知では表示だけ同期し、
    // 同じ共有IndexedDB pendingを別タブのEngineClientへ二重投入しない。
    this.channel?.addEventListener("message", () => void this.refreshAll({ resumePending: false }));
    
    window.addEventListener("popstate", () => void this.#openFromUrl());
    this.elements.status.textContent = "入力できます。音声の受入試験は「音声テスト」からいつでも開けます。";
    this.focusComposer();
  }

  async createConversation({ replaceUrl = false } = {}) {
    const session = await this.repository.createSession();
    await this.openConversation(session.id, { replaceUrl });
    this.#broadcast();
    return session;
  }

  getBackupUiState() {
    return {
      currentSessionId: this.currentSession?.id ?? null,
      composerValue: this.elements.composer.value,
      composerSelectionStart: this.elements.composer.selectionStart,
      composerSelectionEnd: this.elements.composer.selectionEnd,
      secondaryView: this.secondaryView,
    };
  }

  async createBackup() {
    return createApplicationBackup({
      db: this.repository?.db,
      storage: globalThis.localStorage,
      uiState: this.getBackupUiState(),
    });
  }

  async restoreBackup(backup) {
    await this.#cancelAllPendingJobs();
    await restoreApplicationBackup({ db: this.repository?.db, storage: globalThis.localStorage }, backup);
    if (backup.uiState) sessionStorage.setItem(RESTORED_UI_SESSION_KEY, JSON.stringify(backup.uiState));
    const url = new URL(location.href);
    if (backup.uiState?.currentSessionId) url.searchParams.set(CONVERSATION_PARAM, backup.uiState.currentSessionId);
    else url.searchParams.delete(CONVERSATION_PARAM);
    history.replaceState(null, "", url);
    location.reload();
  }

  async resetForTutorial() {
    await this.#cancelAllPendingJobs();
    await clearAllApplicationData({ db: this.repository?.db, storage: globalThis.localStorage });
    sessionStorage.removeItem(RESTORED_UI_SESSION_KEY);
    const url = new URL(location.href);
    url.searchParams.delete(CONVERSATION_PARAM);
    location.replace(url);
  }

  async finishTutorialData() {
    await this.#cancelAllPendingJobs();
    await clearConversationData(this.repository?.db);
    this.currentSession = null;
    this.elements.composer.value = "";
    this.elements.composer.setSelectionRange(0, 0);
    await this.ensureCurrentConversation({ replaceUrl: true });
    await this.refreshAll();
    this.#showSecondaryView("timeline");
    this.focusComposer();
  }

  async markTutorialComplete() {
    return markTutorialComplete(this.repository, globalThis.localStorage);
  }

  async startConversationFromSubmittedText(text) {
    const session = await createConversationFromSubmittedText(this.repository, text);
    this.currentSession = session;
    this.#writeUrl(session.id, false);
    this.#showSecondaryView("timeline");
    this.#broadcast();
    return session;
  }

  async ensureCurrentConversation({ replaceUrl = true, preferredId = null } = {}) {
    if (this.ensureConversationPromise) return this.ensureConversationPromise;
    const currentSession = this.currentSession;
    this.ensureConversationPromise = (async () => {
      const session = await resolveCurrentConversation(this.repository, currentSession, { preferredId });
      const changed = !currentSession || currentSession.id !== session.id;
      this.currentSession = session;
      if (changed) {
        this.#writeUrl(session.id, replaceUrl);
        this.#broadcast();
      }
      return session;
    })();
    try {
      return await this.ensureConversationPromise;
    } finally {
      this.ensureConversationPromise = null;
    }
  }

  
  async openConversation(id, { replaceUrl = false, resumePending = true } = {}) {
    const session = await this.repository.getSession(id);
    if (!session) return this.createConversation({ replaceUrl: true });
    this.currentSession = session;
    this.#writeUrl(session.id, replaceUrl);
    await Promise.all([
      this.refreshCurrentConversation({ resumePending }),
      this.refreshConversationList(),
      this.refreshStatistics(),
    ]);
    this.#showSecondaryView("timeline");
    this.focusComposer();
  }
  

  focusComposer() {
    this.elements.composer.focus({ preventScroll: true });
  }


  getReasoningSeconds() {
    const value = Number(this.elements.reasoningSeconds.value);
    return Number.isFinite(value) ? Math.min(30, Math.max(0, value)) : DEFAULT_REASONING_SECONDS;
  }

  async setReasoningSeconds(value) {
    const normalized = Number.isFinite(Number(value))
      ? Math.min(30, Math.max(0, Number(value)))
      : DEFAULT_REASONING_SECONDS;
    this.elements.reasoningSeconds.value = String(normalized);
    await this.repository?.setSetting("reasoningSeconds", normalized);
    return normalized;
  }

  get voiceRuntimeState() {
    return {
      ready: Boolean(this.voiceRuntime?.ready),
      prepared: Boolean(this.voiceRuntime?.prepared),
      profile: this.voiceRuntime?.activeProfile ?? null,
    };
  }

  async getVoiceProfilePlan(profile = this.getModelProfile()) {
    if (!this.voiceRuntime?.getProfilePlan) throw new Error("音声モデル情報を取得できません。");
    return this.voiceRuntime.getProfilePlan(profile);
  }

  async isVoiceProfileCached(profile = this.getModelProfile()) {
    return Boolean(await this.voiceRuntime?.isProfilePrepared?.(profile));
  }

  async getOfflineRuntimePlan() {
    return planOrtRuntimeAssets();
  }

  async prepareOfflineRuntime({ signal = null } = {}) {
    return prepareOrtRuntimeAssets({ signal });
  }

  async prepareOfflineVoice(profile = this.getModelProfile(), { onKanalizerStatus = () => {}, signal = null } = {}) {
    if (!this.voiceRuntime?.prepare) throw new Error("音声データを準備できません。");
    const kanalizerModulePromise = import("../text/kanalizer-normalizer.js");
    const voice = await this.voiceRuntime.prepare(profile, { signal });
    const { prepareKanalizerOffline } = await kanalizerModulePromise;
    const kanalizer = await prepareKanalizerOffline({ onStatus: onKanalizerStatus, signal });
    return {
      profile,
      voice,
      kanalizer,
      totalBytes: Number(voice?.totalBytes || 0)
        + Number(kanalizer?.modelBytes || 0)
        + Number(kanalizer?.dictionaryBytes || 0)
        + Number(kanalizer?.wasmBytes || 0),
    };
  }

  async unlockVoiceAudio() {
    if (!this.voiceRuntime?.unlockAudio) return false;
    return this.voiceRuntime.unlockAudio();
  }

  setReplayAfterVoiceLoad(enabled) {
    const value = Boolean(enabled);
    this.elements.voiceLoadReplayAfterLoad.checked = value;
    this.voiceRuntime?.setReplayAfterLoad?.(value);
    return value;
  }

  async initializePreparedVoice(profile = this.getModelProfile(), { enableAudio = true, onBlockingProgress = null, showPanel = true } = {}) {
    if (!this.voiceRuntime?.initializePrepared) throw new Error("保存済み音声モデルを読み込めません。");
    const activeProfileMatches = this.voiceRuntime.activeProfile === profile;
    if (activeProfileMatches && this.voiceRuntime.ready && (!enableAudio || this.voiceRuntime.audioEnabled)) {
      return { ready: true, profile };
    }
    const panel = this.elements.voiceLoadProgress;
    const progress = this.elements.voiceLoadProgressBar;
    const status = this.elements.voiceLoadStatus;
    const detail = this.elements.voiceLoadDetail;
    const modelValue = this.elements.voiceLoadModelValue;
    const engineProgress = this.elements.voiceLoadEngineProgress;
    const engineValue = this.elements.voiceLoadEngineValue;
    if (showPanel) panel.hidden = false;
    progress.value = 0;
    modelValue.textContent = "確認中…";
    engineProgress.max = 1;
    engineProgress.value = 0;
    engineValue.textContent = "開始待ち";
    status.textContent = "音声は現在利用可能な状態ではありません。ロード中です。";
    detail.textContent = "会話と入力はこのまま利用できます。";
    const unsubscribe = this.voiceRuntime.subscribeProgress((message) => {
      if (message.stage !== "initialize") return;
      const loaded = Number(message.loadedBytes || 0);
      const total = Number(message.totalBytes || 0);
      if (total > 0) {
        const percent = Math.max(0, Math.min(100, loaded / total * 100));
        progress.value = percent;
        modelValue.textContent = `${(loaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MiB`;
        onBlockingProgress?.({
          detail: "保存済みモデルを検証しています。",
          primary: {
            label: "モデルデータ",
            value: loaded,
            total,
            text: `${(loaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MiB`,
          },
        });
      } else if (message.phase) {
        detail.textContent = message.backend ? `${message.phase} · ${message.backend}` : message.phase;
      }
      const engineLoaded = Number(message.engineLoaded);
      const engineTotal = Number(message.engineTotal);
      if (Number.isFinite(engineLoaded) && Number.isFinite(engineTotal) && engineTotal > 0) {
        engineProgress.max = engineTotal;
        engineProgress.value = Math.max(0, Math.min(engineTotal, engineLoaded));
        engineValue.textContent = `${engineLoaded} / ${engineTotal}`;
        const phaseLabels = {
          tokenizer: "Tokenizerを準備しています",
          "tokenizer-ready": "Tokenizerを読み込みました",
          sessions: "推論セッションを作成しています",
          "session-ready": message.sessionName ? `${message.sessionName} を読み込みました` : "推論セッションを読み込みました",
          warmup: "推論エンジンをウォームアップしています",
          ready: "音声エンジンの準備が完了しました",
        };
        onBlockingProgress?.({
          detail: phaseLabels[message.phase] || message.phase || "音声エンジンを起動しています。",
          secondary: {
            label: "音声エンジン",
            value: engineLoaded,
            total: engineTotal,
            text: `${engineLoaded} / ${engineTotal}`,
          },
        });
      }
    });
    try {
      const initialized = await this.voiceRuntime.initializePrepared(profile, { enableAudio });
      progress.value = 100;
      modelValue.textContent = "準備済み";
      if (engineProgress.max > 0) engineProgress.value = engineProgress.max;
      engineValue.textContent = "完了";
      status.textContent = "音声を利用できます。";
      detail.textContent = initialized?.backend ? `音声エンジン: ${initialized.backend}` : "準備完了";
      if (showPanel) {
        globalThis.setTimeout(() => {
          if (status.textContent === "音声を利用できます。") panel.hidden = true;
        }, 1600);
      }
      return initialized;
    } catch (error) {
      status.textContent = "音声モデルの読み込みに失敗しました。";
      detail.textContent = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      unsubscribe?.();
    }
  }

  get currentPendingCount() {
    return [...(this.utterances?.jobs.values() ?? [])]
      .filter((job) => job.sessionId === this.currentSession?.id).length;
  }

  get latestPendingText() {
    return [...(this.utterances?.jobs.values() ?? [])]
      .filter((job) => job.sessionId === this.currentSession?.id)
      .sort((left, right) => right.createdAt - left.createdAt)[0]?.text ?? null;
  }

  async cancelLatestPending({ refresh = "all" } = {}) {
    const jobs = [...(this.utterances?.jobs.values() ?? [])]
      .filter((job) => job.sessionId === this.currentSession?.id)
      .sort((left, right) => right.createdAt - left.createdAt);
    const latest = jobs[0];
    if (!latest) return false;
    const cancelled = await this.utterances.cancel(latest.id);
    if (refresh === "pending") {
      const pending = await this.repository.listPending(this.currentSession.id);
      this.#renderPending(pending);
    } else if (refresh !== "none") {
      await this.refreshAll();
    }
    return cancelled;
  }

  async applyCorrectionFromComposer() {
    const session = await this.ensureCurrentConversation();
    const text = this.elements.composer.value;
    if (!text.trim()) throw new Error("訂正する文章を入力してください。");
    const pending = await this.repository.listPending(session.id);
    const revisions = planComposerRevisions(
      text,
      pending,
      (id) => this.utterances.isRevisionable(id)
    );
    if (revisions.length === 0) throw new Error("訂正差分がありません。");
    for (const revision of revisions) {
      await this.utterances.beginEdit(revision.pending.id);
      await this.utterances.edit(revision.pending.id, revision.text, this.#reasoningSeconds());
    }
    await this.refreshAll();
    this.#broadcast();
    this.focusComposer();
    return `${revisions.length}件の読み上げ待ちを訂正しました。`;
  }

  async forceQueueHead() {
    const session = await this.ensureCurrentConversation();
    const pending = await this.repository.listPending(session.id);
    const target = [...pending]
      .filter((item) => this.utterances.jobs.has(item.id))
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    if (!target) throw new Error("今すぐ読み上げできる文章がありません。");
    await this.utterances.forceReady(target.id);
    this.elements.status.textContent = "読み上げ待ち時間を終了しました。";
    await this.refreshAll();
  }

  async cancelCurrentPending() {
    const session = await this.ensureCurrentConversation();
    const pending = await this.repository.listPending(session.id);
    const target = [...pending].sort((left, right) => right.createdAt - left.createdAt)[0];
    if (!target) throw new Error("取り消せる読み上げ待ちがありません。");
    await this.utterances.cancel(target.id);
    this.elements.status.textContent = "読み上げ待ちを取り消しました。";
    await this.refreshAll();
    this.#broadcast();
    this.focusComposer();
  }

  
  async refreshAll({ resumePending = false } = {}) {
    if (this.refreshAllPromise) {
      this.refreshAllQueued = true;
      this.refreshAllResumePendingQueued ||= resumePending;
      return this.refreshAllPromise;
    }
    let resumePendingThisPass = resumePending;
    this.refreshAllPromise = (async () => {
      do {
        this.refreshAllQueued = false;
        const shouldResumePending = resumePendingThisPass || this.refreshAllResumePendingQueued;
        resumePendingThisPass = false;
        this.refreshAllResumePendingQueued = false;
        await this.ensureCurrentConversation();
        await Promise.all([
          this.refreshCurrentConversation({ resumePending: shouldResumePending }),
          this.refreshConversationList(),
          this.refreshStatistics(),
        ]);
      } while (this.refreshAllQueued);
    })();
    try {
      await this.refreshAllPromise;
    } finally {
      this.refreshAllPromise = null;
    }
  }
  

  
  async refreshCurrentConversation({ resumePending = false } = {}) {
    const session = await this.ensureCurrentConversation();
    this.currentSession = session;
    const [messages, pending] = await Promise.all([
      this.repository.listMessages(session.id),
      this.repository.listPending(session.id),
    ]);
    if (resumePending) {
      for (const item of pending) {
        await this.utterances.resume(item);
      }
    }
    this.#renderMessages(messages);
    this.#renderPending(pending);
    this.elements.conversationTitle.textContent = this.currentSession.firstMessagePreview || "新しい会話";

  }

  async refreshPending() {
    const session = await this.ensureCurrentConversation();
    const pending = await this.repository.listPending(session.id);
    this.#renderPending(pending);
  }
  

  async refreshConversationList() {
    const sessions = await this.repository.listSessions(100);
    const renderKey = JSON.stringify([
      this.currentSession?.id ?? null,
      sessions.map((session) => [session.id, session.firstMessagePreview, session.updatedAt, session.messageCount]),
    ]);
    if (renderKey === this.conversationRenderKey) return;
    this.conversationRenderKey = renderKey;
    const fragment = document.createDocumentFragment();
    for (const session of sessions) {
      const node = this.elements.conversationTemplate.content.firstElementChild.cloneNode(true);
      node.dataset.sessionId = session.id;
      node.setAttribute("aria-current", session.id === this.currentSession?.id ? "true" : "false");
      node.querySelector(".conversation-preview").textContent = session.firstMessagePreview || "新しい会話";
      node.querySelector(".conversation-meta").textContent = `${formatTime(session.updatedAt)} · ${session.messageCount}件`;
      node.addEventListener("click", () => void this.openConversation(session.id));
      fragment.append(node);
    }
    this.elements.conversationList.replaceChildren(fragment);
  }

  async refreshStatistics() {
    const statistics = await this.repository.getStatistics();
    const renderKey = `${statistics.messageCount}|${statistics.conversationCount}|${statistics.typedChars}|${statistics.activeDays}`;
    if (renderKey === this.statisticsRenderKey) return;
    this.statisticsRenderKey = renderKey;
    this.elements.statMessages.textContent = formatNumber(statistics.messageCount);
    this.elements.statConversations.textContent = formatNumber(statistics.conversationCount);
    this.elements.statTyped.textContent = formatNumber(statistics.typedChars);
    this.elements.statDays.textContent = formatNumber(statistics.activeDays);
  }

  #renderMessages(messages) {
    const renderKey = JSON.stringify([
      this.currentSession?.id ?? null,
      this.currentSession?.firstMessagePreview ?? null,
      messages.map((message) => [message.id, message.text, message.createdAt]),
    ]);
    if (renderKey === this.messageRenderKey) return;
    this.messageRenderKey = renderKey;
    const fragment = document.createDocumentFragment();
    for (const message of [...messages].reverse()) {
      const node = this.elements.messageTemplate.content.firstElementChild.cloneNode(true);
      node.querySelector(".message-text").textContent = message.text;
      const replay = node.querySelector(".message-replay-button");
      replay.addEventListener("click", () => {
        void this.#replayMessage(message, replay);
      });
      const time = node.querySelector(".message-time");
      time.dateTime = new Date(message.createdAt).toISOString();
      time.textContent = formatTime(message.createdAt);
      fragment.append(node);
    }
    this.elements.messageList.replaceChildren(fragment);
    this.elements.emptyTimeline.hidden = messages.length > 0;
  }

  #renderPending(pending) {
    const renderKey = JSON.stringify(pending.map((item) => [
      item.id,
      item.generation,
      item.text,
      item.state,
      item.error,
      item.reasoningDeadline,
    ]));
    if (renderKey !== this.pendingRenderKey) {
      this.pendingRenderKey = renderKey;
      const fragment = document.createDocumentFragment();
      for (const item of pending) {
        const node = this.elements.pendingTemplate.content.firstElementChild.cloneNode(true);
        node.dataset.pendingId = item.id;
        const cancel = node.querySelector(".pending-cancel");
        const error = node.querySelector(".pending-error");
        node.querySelector(".pending-text").textContent = item.text;
        if (item.error) {
          error.hidden = false;
          error.textContent = item.error;
        }
        cancel.addEventListener("click", async () => {
          await this.utterances.cancel(item.id);
          await this.refreshAll();
          this.#broadcast();
          this.focusComposer();
        });
        fragment.append(node);
      }
      this.elements.pendingList.replaceChildren(fragment);
    }
    this.elements.pendingCount.textContent = String(pending.length);
    this.elements.pendingEmpty.hidden = pending.length > 0;
    const pendingIds = new Set(pending.map((item) => item.id));
    for (const id of this.synthesisProgress.keys()) {
      if (!pendingIds.has(id)) this.synthesisProgress.delete(id);
    }
    const hasRevisionable = pending.some((item) => this.utterances.isRevisionable(item.id));
    this.elements.correctionButton.disabled = !hasRevisionable;
    this.elements.cancelCurrentButton.disabled = pending.length === 0;
    this.elements.forceSpeakButton.disabled = pending.length === 0;
    this.#updatePendingTimers();
  }

  #updatePendingTimers() {
    const currentTime = Date.now();
    for (const node of this.elements.pendingList.querySelectorAll(".pending-card")) {
      this.#updatePendingCard(node, currentTime);
    }
    this.#syncPendingTicker();
  }

  #updatePendingCard(node, currentTime = Date.now()) {
    const job = this.utterances.jobs.get(node.dataset.pendingId);
    if (!job) return;
    const remaining = Math.max(0, job.reasoningDeadline - currentTime) / 1000;
    const synthesis = this.synthesisProgress.get(job.id);
    const synthesisRunning = job.state === "reasoning"
      && (synthesis?.status === "running" || (Boolean(this.voiceRuntime?.ready) && !synthesis));
    const timer = node.querySelector(".pending-timer");
    const timerText = remaining > 0
      ? `あと ${remaining.toFixed(1)} 秒で読み上げ`
      : synthesis?.phase === "waiting-for-model"
        ? "モデルロード中のため遅延中"
        : synthesis?.phase === "waiting-for-audio"
          ? "音声の有効化待ち"
          : synthesisRunning
        ? "合成中のため遅延中"
        : "読み上げを開始します";
    if (timer.textContent !== timerText) timer.textContent = timerText;
    this.#renderSynthesisProgress(node, job, synthesis);
    if (job.state === "editing") {
      const state = node.querySelector(".pending-state");
      if (state.dataset.renderKey !== "editing") {
        state.textContent = "訂正中";
        state.dataset.renderKey = "editing";
      }
      if (timer.textContent !== "入力待ち") timer.textContent = "入力待ち";
    } else {
      const state = node.querySelector(".pending-state");
      if (job.state === "voice-error") {
        if (state.dataset.renderKey !== "voice-error") {
          state.textContent = "音声エラー";
          state.dataset.renderKey = "voice-error";
        }
      } else if (state.dataset.renderKey !== "submitted") {
        state.replaceChildren();
        const dot = document.createElement("i");
        dot.className = "pending-dot";
        dot.setAttribute("aria-hidden", "true");
        state.append(dot, document.createTextNode("送信済み"));
        state.dataset.renderKey = "submitted";
      }
    }
  }

  #updateReasoningCountdowns() {
    const currentTime = Date.now();
    let needsTicker = false;
    for (const node of this.elements.pendingList.querySelectorAll(".pending-card")) {
      const job = this.utterances.jobs.get(node.dataset.pendingId);
      if (!job || job.state !== "reasoning") continue;
      const remainingMs = job.reasoningDeadline - currentTime;
      if (remainingMs <= 0) continue;
      needsTicker = true;
      const timer = node.querySelector(".pending-timer");
      const timerText = `あと ${(remainingMs / 1000).toFixed(1)} 秒で読み上げ`;
      if (timer.textContent !== timerText) timer.textContent = timerText;
    }
    if (!needsTicker && this.pendingTicker) {
      clearInterval(this.pendingTicker);
      this.pendingTicker = null;
      this.#updatePendingTimers();
    }
  }

  #syncPendingTicker() {
    const now = Date.now();
    const needsTicker = [...this.elements.pendingList.querySelectorAll(".pending-card")].some((node) => {
      const job = this.utterances.jobs.get(node.dataset.pendingId);
      return job?.state === "reasoning" && job.reasoningDeadline > now;
    });
    if (needsTicker && !this.pendingTicker) {
      this.pendingTicker = setInterval(() => this.#updateReasoningCountdowns(), 250);
    } else if (!needsTicker && this.pendingTicker) {
      clearInterval(this.pendingTicker);
      this.pendingTicker = null;
    }
  }

  #handleVoiceProgress(message) {
    const utteranceId = message?.utteranceId;
    if (!utteranceId) return;
    if (this.replayUtteranceIds.has(utteranceId)) return;
    const job = this.utterances.jobs.get(utteranceId);
    const visible = Boolean(job && job.sessionId === this.currentSession?.id);
    if (message.stage === "synthesis-cancelled") {
      this.synthesisProgress.delete(utteranceId);
      if (visible) {
        const node = this.elements.pendingList.querySelector(`[data-pending-id="${utteranceId}"]`);
        if (node) this.#updatePendingCard(node);
      }
      return;
    }
    const previous = this.synthesisProgress.get(utteranceId) ?? {};
    if (message.stage === "synthesis-skipped") {
      this.synthesisProgress.set(utteranceId, { ...previous, status: "skipped", phase: "skipped", value: 0, total: 0 });
    } else if (message.stage === "synthesis-complete") {
      this.synthesisProgress.set(utteranceId, {
        ...previous,
        status: "done",
        value: Number(previous.total || previous.value || 0),
      });
    } else if (message.stage === "synthesis-deferred") {
      this.synthesisProgress.set(utteranceId, {
        generation: message.generation,
        status: "running",
        phase: message.phase || "waiting-for-model",
        value: 0,
        total: 1,
      });
    } else if (message.stage === "normalize") {
      const total = Math.max(1, Number(message.totalSteps || 1));
      const value = Math.max(0, Math.min(total, Number(message.completed || 0)));
      this.synthesisProgress.set(utteranceId, {
        generation: message.generation,
        status: "running",
        phase: "normalize",
        value,
        total,
      });
    } else if (message.stage === "generate") {
      const total = Math.max(0, Number(message.totalSteps || 0));
      const value = Math.max(0, Math.min(total || Number(message.completed || 0), Number(message.completed || 0)));
      this.synthesisProgress.set(utteranceId, {
        generation: message.generation,
        status: total > 0 && value >= total ? "done" : "running",
        phase: message.phase || "generate",
        value,
        total,
      });
    }
    if (visible) {
      const node = this.elements.pendingList.querySelector(`[data-pending-id="${utteranceId}"]`);
      if (node) this.#updatePendingCard(node);
    }
  }

  #renderSynthesisProgress(node, job, synthesis) {
    const label = node.querySelector(".pending-synthesis-label");
    const cells = node.querySelector(".pending-synthesis-cells");
    let labelText = "";
    if (synthesis?.phase === "waiting-for-model" || synthesis?.phase === "waiting-for-audio") {
      labelText = synthesis.phase === "waiting-for-audio" ? "音声の有効化待ち" : "モデルのロード完了待ち";
    } else if (!this.voiceRuntime?.ready || synthesis?.status === "skipped") {
      labelText = "音声モデル未準備";
      if (label.textContent !== labelText) label.textContent = labelText;
      if (cells.dataset.renderKey !== "empty") {
        cells.replaceChildren();
        cells.dataset.renderKey = "empty";
      }
      return;
    }
    const total = Math.max(0, Number(synthesis?.total || 0));
    const value = Math.max(0, Math.min(total, Number(synthesis?.value || 0)));
    if (total <= 0) {
      labelText = job.state === "reasoning" ? "合成を開始しています" : "開始待ち";
      if (label.textContent !== labelText) label.textContent = labelText;
      if (cells.dataset.renderKey !== "empty") {
        cells.replaceChildren();
        cells.dataset.renderKey = "empty";
      }
      return;
    }
    labelText = synthesis?.phase === "waiting-for-model" || synthesis?.phase === "waiting-for-audio"
      ? synthesis.phase === "waiting-for-audio" ? "音声の有効化待ち" : "モデルのロード完了待ち"
      : synthesis?.phase === "normalize"
      ? "英字を読み上げ用に変換中"
      : synthesis?.phase === "decode"
      ? `${value} / ${total} · 波形を作成中`
      : synthesis?.status === "done"
        ? `${total} / ${total} · 完了`
        : `${value} / ${total}`;
    if (label.textContent !== labelText) label.textContent = labelText;
    const renderKey = `${synthesis?.status || ""}|${synthesis?.phase || ""}|${value}|${total}`;
    if (cells.dataset.renderKey === renderKey && cells.childElementCount === total) return;
    if (cells.childElementCount !== total) {
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < total; index += 1) {
        const cell = document.createElement("i");
        cell.className = "pending-synthesis-cell";
        fragment.append(cell);
      }
      cells.replaceChildren(fragment);
    }
    const complete = synthesis?.status === "done";
    for (let index = 0; index < cells.children.length; index += 1) {
      const cell = cells.children[index];
      cell.classList.toggle("is-done", complete || index < value);
      cell.classList.toggle("is-running", !complete && index === value);
    }
    cells.dataset.renderKey = renderKey;
  }

  #bindEvents() {
    this.elements.correctionButton.addEventListener("click", () => {
      this.#unlockVoiceFromUserGesture();
      void this.#runUiTask(() => this.applyCorrectionFromComposer());
    });
    this.elements.cancelCurrentButton.addEventListener("click", () => void this.#runUiTask(() => this.cancelCurrentPending()));
    this.elements.forceSpeakButton.addEventListener("click", () => {
      this.#unlockVoiceFromUserGesture();
      void this.#runUiTask(() => this.forceQueueHead());
    });
    this.elements.newConversation.addEventListener("click", () => void this.#runUiTask(() => this.createConversation()));
    this.elements.focusComposer.addEventListener("click", () => this.focusComposer());
    this.elements.timelineView.addEventListener("click", () => this.#showSecondaryView("timeline"));
    this.elements.conversationView.addEventListener("click", () => this.#showSecondaryView("conversations"));
    this.elements.reasoningSeconds.addEventListener("change", () => {
      void this.setReasoningSeconds(this.elements.reasoningSeconds.value);
    });
    this.elements.speechSpeed.addEventListener("change", () => {
      try {
        const value = Number(this.elements.speechSpeed.value);
        this.voiceRuntime?.setSpeed(value);
        void this.repository.setSetting("speechSpeed", value);
      } catch (error) {
        this.elements.status.textContent = error instanceof Error ? error.message : String(error);
      }
    });
    this.elements.voiceLoadReplayAfterLoad.addEventListener("change", () => {
      this.setReplayAfterVoiceLoad(this.elements.voiceLoadReplayAfterLoad.checked);
    });

    this.elements.composer.addEventListener("beforeinput", (event) => {
      if (this.typingStartedAt == null) this.typingStartedAt = performance.now();
      if (event.inputType?.startsWith("delete")) this.deletedChars += 1;
    });
    this.elements.composer.addEventListener("input", (event) => {
      if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
        this.#unlockVoiceFromUserGesture();
        void this.#runUiTask(() => this.#finalizeComposerLineBreak());
      }
    });
    this.elements.composerPanel.addEventListener("click", (event) => {
      if (!isInteractiveTarget(event.target)) this.focusComposer();
    });
  }

  #unlockVoiceFromUserGesture() {
    if (!this.voiceRuntime || this.voiceRuntime.audioEnabled) return;
    void this.voiceRuntime.unlockAudio?.().catch(() => {});
  }

  async #replayMessage(message, button) {
    const text = String(message?.text || "").trim();
    if (!text) return;
    if (!this.voiceRuntime?.ready) {
      this.elements.status.textContent = "音声モデルの読み込みが終わってから再度読み上げできます。";
      return;
    }
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = "読み上げ中…";
    try {
      await this.voiceRuntime.unlockAudio?.();
      const utteranceId = crypto.randomUUID();
      const generation = 1;
      this.replayUtteranceIds.add(utteranceId);
      try {
        const synthesized = await this.voiceRuntime.synthesize({ utteranceId, generation, text });
        if (synthesized?.skipped) throw new Error("音声を再生できませんでした。");
        await this.voiceRuntime.play({ utteranceId, generation, ...synthesized });
      } finally {
        this.replayUtteranceIds.delete(utteranceId);
      }
      this.elements.status.textContent = "もう一度読み上げました。";
    } catch (error) {
      this.elements.status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }

  async #runUiTask(task) {
    try {
      const status = await task();
      this.elements.status.textContent = typeof status === "string" && status ? status : "入力できます。";
    } catch (error) {
      this.elements.status.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  #reasoningSeconds() {
    return this.getReasoningSeconds();
  }

  async #finalizeComposerLineBreak() {
    const composer = this.elements.composer;
    const completed = getCompletedLineFromLineBreak(composer.value, composer.selectionStart);
    if (!completed.trim()) return;
    const session = this.secondaryView === "conversations"
      ? await this.startConversationFromSubmittedText(completed)
      : await this.ensureCurrentConversation();
    const typingMs = this.typingStartedAt == null ? 0 : Math.max(0, performance.now() - this.typingStartedAt);
    await this.repository.recordInputStatistics({
      typedChars: completed.length,
      deletedChars: this.deletedChars,
      typingMs,
      sessionId: session.id,
    });
    const pending = await this.utterances.submit({
      sessionId: session.id,
      text: completed,
      reasoningSeconds: this.#reasoningSeconds(),
    });
    const retained = retainRecentSubmittedLines(composer.value, composer.selectionStart, 2);
    if (retained.value !== composer.value || retained.caret !== composer.selectionStart) {
      composer.value = retained.value;
      composer.setSelectionRange(retained.caret, retained.caret);
    }
    this.typingStartedAt = null;
    this.deletedChars = 0;
    await this.refreshAll();
    this.#broadcast();
    this.focusComposer();
    return `読み上げ待ちに追加しました。あと ${this.#reasoningSeconds()} 秒で読み上げます。`;
  }

  #showSecondaryView(view) {
    const showTimeline = view === "timeline";
    this.secondaryView = showTimeline ? "timeline" : "conversations";
    this.elements.timelinePanel.hidden = !showTimeline;
    this.elements.conversationPanel.hidden = showTimeline;
    this.elements.timelineView.setAttribute("aria-pressed", String(showTimeline));
    this.elements.conversationView.setAttribute("aria-pressed", String(!showTimeline));
  }

  #writeUrl(sessionId, replace) {
    const url = new URL(location.href);
    url.searchParams.set(CONVERSATION_PARAM, sessionId);
    history[replace ? "replaceState" : "pushState"]({ sessionId }, "", url);
  }

  async #cancelAllPendingJobs() {
    for (const id of [...(this.utterances?.jobs.keys() ?? [])]) {
      await this.utterances.cancel(id).catch(() => false);
    }
  }

  #restoreUiStateAfterImport() {
    let restored = null;
    try {
      const raw = sessionStorage.getItem(RESTORED_UI_SESSION_KEY);
      sessionStorage.removeItem(RESTORED_UI_SESSION_KEY);
      if (raw) restored = JSON.parse(raw);
    } catch {
      sessionStorage.removeItem(RESTORED_UI_SESSION_KEY);
    }
    if (!restored) return;
    const composerValue = typeof restored.composerValue === "string" ? restored.composerValue : "";
    this.elements.composer.value = composerValue;
    const start = Math.max(0, Math.min(composerValue.length, Number(restored.composerSelectionStart) || 0));
    const end = Math.max(start, Math.min(composerValue.length, Number(restored.composerSelectionEnd) || start));
    this.elements.composer.setSelectionRange(start, end);
    this.#showSecondaryView(restored.secondaryView === "conversations" ? "conversations" : "timeline");
  }

  #readBootstrapSession() {
    try {
      const raw = sessionStorage.getItem(BOOTSTRAP_SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const id = normalizeConversationId(parsed?.id);
      const createdAt = Number(parsed?.createdAt);
      if (!id || !Number.isFinite(createdAt) || Date.now() - createdAt > BOOTSTRAP_SESSION_MAX_AGE_MS) {
        sessionStorage.removeItem(BOOTSTRAP_SESSION_KEY);
        return null;
      }
      return { id, createdAt };
    } catch {
      sessionStorage.removeItem(BOOTSTRAP_SESSION_KEY);
      return null;
    }
  }

  #writeBootstrapSession(id) {
    try {
      sessionStorage.setItem(BOOTSTRAP_SESSION_KEY, JSON.stringify({ id, createdAt: Date.now() }));
    } catch {
      // The URL still remains the primary durable bootstrap identifier.
    }
  }

  async #openFromUrl() {
    const id = new URL(location.href).searchParams.get(CONVERSATION_PARAM);
    if (id === this.currentSession?.id) {
      await this.ensureCurrentConversation({ replaceUrl: true });
      return;
    }
    if (id && await this.repository.getSession(id)) {
      await this.openConversation(id, { replaceUrl: true });
      return;
    }
    await this.createConversation({ replaceUrl: true });
  }

  #broadcast() {
    this.channel?.postMessage({ type: "changed", sessionId: this.currentSession?.id, at: Date.now() });
  }

  #resolveElements() {
    const byId = (id) => {
      const element = this.document.getElementById(id);
      if (!element) throw new Error(`Required UI element is missing: ${id}`);
      return element;
    };
    return {
      composerPanel: byId("composer-panel"),
      composer: byId("composer"),
      reasoningSeconds: byId("reasoning-seconds"),
      speechSpeed: byId("speech-speed"),
      voiceLoadProgress: byId("voice-load-progress"),
      voiceLoadProgressBar: byId("voice-load-progress-bar"),
      voiceLoadStatus: byId("voice-load-status"),
      voiceLoadDetail: byId("voice-load-detail"),
      voiceLoadModelValue: byId("voice-load-model-value"),
      voiceLoadEngineProgress: byId("voice-load-engine-progress"),
      voiceLoadEngineValue: byId("voice-load-engine-value"),
      voiceLoadReplayAfterLoad: byId("voice-load-replay-after-load"),
      focusComposer: byId("focus-composer"),
      status: byId("app-status"),
      conversationTitle: byId("conversation-title"),

      pendingList: byId("pending-list"),
      pendingCount: byId("pending-count"),
      pendingEmpty: byId("pending-empty"),
      messageList: byId("message-list"),
      emptyTimeline: byId("empty-timeline"),
      conversationList: byId("conversation-list"),
      timelinePanel: byId("timeline-panel"),
      conversationPanel: byId("conversation-panel"),
      timelineView: byId("timeline-view"),
      conversationView: byId("conversation-view"),
      newConversation: byId("new-conversation"),
      correctionButton: byId("correction-button"),
      cancelCurrentButton: byId("cancel-current-button"),
      forceSpeakButton: byId("force-speak-button"),
      statMessages: byId("stat-messages"),
      statConversations: byId("stat-conversations"),
      statTyped: byId("stat-typed"),
      statDays: byId("stat-days"),
      conversationTemplate: byId("conversation-template"),
      messageTemplate: byId("message-template"),
      pendingTemplate: byId("pending-template"),
    };
  }
}
