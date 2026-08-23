import { MODEL_PROFILES } from "./model-profile-ui.js";
import {
  readConversationPracticeCount,
  recordConversationPractice,
} from "./tutorial-persistence.js";
const SAMPLE_BRANCHES = Object.freeze({
  fp32: "main",
  fp16: "fp16",
  "mobile-int8": "mobile-int8",
  "mobile-int4": "mobile-int4",
});
const SAMPLE_PREVIEWS = Object.freeze({
  expression: Object.freeze({ filename: "03_found_me_waiting.wav", label: "①" }),
  articulation: Object.freeze({ filename: "01_customs_tariff_rejection.wav", label: "②" }),
});
const DEMO_TEXTS = Object.freeze([
  "こんにちは。今日は何を読み上げましょうか？",
  "お待たせしました。準備ができました。",
  "ちょっと休憩してから、続きを始めましょう。",
  "この文章は、読み上げの練習用です。",
  "うまく届いたら、そのまま次へ進めます。",
  "WebAssemblyの準備ができました。",
  "短い文章から、そのまま試してみましょう。",
  "あとから訂正できるので、気軽に入力してください。",
  "やっぱり違うと思ったら、取り消すこともできます。",
  "それでは、ひとつ読み上げてみますね。",
]);
const CORRECTION_TEXTS = Object.freeze([
  "こんにちは。今日はゆっくり読み上げてください。",
  "お待たせしました。準備はもうできています。",
  "少し休憩してから、続きを始めてください。",
  "この文章は、読み上げ確認のための例文です。",
  "うまく届いたので、そのまま次へ進みましょう。",
  "WebAssemblyの準備ができたので、試してみます。",
  "短い文章へ直して、もう一度試してみてください。",
  "あとから直せるので、気軽に書いて大丈夫です。",
  "やっぱり違うと思ったら、あとから取り消せます。",
  "それでは、もう一度読み上げてみますね。",
  "この一文だけ、少し短く言い直してみます。",
  "声の速度を変えて、もう一度確認してみましょう。",
  "次の文章は、訂正の動きを試すためのサンプルです。",
  "入力した内容を残したまま、最後の一文だけ直します。",
  "読み上げる直前なら、文章を差し替えられます。",
  "この部分だけ表現を変えて、自然な文章にします。",
  "さっきの文章を少しだけ分かりやすく直します。",
  "最後の言い回しだけ変えて、もう一度試します。",
  "訂正ボタンを使うと、送り直さずに変更できます。",
  "訂正したい文章を入力して、通常の訂正操作をそのまま試せます。",
]);
const CANCEL_DEMO_TEXT = "やっぱり違うと思ったら、取り消すこともできます。";
const WAIT_DEMO_TEXT = "この文章は、読み上げ待ち時間を確認するための例です。";

export function createTutorialProfileDefinition(name, definition, availableStepIds) {
  const profileName = String(name || "").trim();
  if (!profileName) throw new TypeError("Tutorial profile name is required.");
  if (!definition || typeof definition !== "object") throw new TypeError("Tutorial profile definition is required.");
  const availableSteps = new Set([...availableStepIds].map((stepId) => String(stepId)));
  const terminal = Boolean(definition.terminal);
  const requestedRoute = definition.route ?? definition.steps;
  if (terminal) {
    for (const key of [
      "route", "steps", "completeTo", "cancelTo",
      "onOpen", "onStageChange", "onEnterStep", "onComplete", "onCancel", "onClose",
    ]) {
      if (definition[key] != null) throw new Error(`Terminal tutorial profile must not define ${key}.`);
    }
  }
  const rawRoute = terminal
    ? []
    : requestedRoute === "all"
      ? [...availableSteps]
      : requestedRoute;
  if (!terminal && (!Array.isArray(rawRoute) || rawRoute.length === 0)) {
    throw new TypeError("Tutorial profile route must be 'all' or a non-empty array.");
  }
  const visitIds = new Set();
  const route = rawRoute.map((entry, index) => {
    const source = typeof entry === "string" ? { stepId: entry } : entry;
    if (!source || typeof source !== "object") throw new TypeError(`Tutorial route entry ${index} is invalid.`);
    const stepId = String(source.stepId ?? source.step ?? "").trim();
    if (!availableSteps.has(stepId)) throw new Error(`Unknown tutorial step ID: ${stepId}`);
    const visitId = String(source.visitId ?? source.id ?? `${stepId}@${index}`).trim();
    if (!visitId) throw new TypeError(`Tutorial route visit ID is required at index ${index}.`);
    if (visitIds.has(visitId)) throw new Error(`Duplicate tutorial route visit ID: ${visitId}`);
    visitIds.add(visitId);
    for (const hook of ["onEnter", "onLeave"]) {
      if (source[hook] != null && typeof source[hook] !== "function") {
        throw new TypeError(`Tutorial route ${hook} must be a function.`);
      }
    }
    return Object.freeze({
      visitId,
      stepId,
      nextLabel: source.nextLabel == null ? null : String(source.nextLabel),
      backLabel: source.backLabel == null ? null : String(source.backLabel),
      onEnter: source.onEnter ?? null,
      onLeave: source.onLeave ?? null,
    });
  });
  for (const hook of ["onOpen", "onStageChange", "onEnterStep", "onComplete", "onCancel", "onClose"]) {
    if (definition[hook] != null && typeof definition[hook] !== "function") {
      throw new TypeError(`Tutorial profile ${hook} must be a function.`);
    }
  }
  return Object.freeze({
    name: profileName,
    terminal,
    route: Object.freeze(route),
    headerBrand: String(definition.headerBrand || "はじめての typed-voice"),
    completionLabel: String(definition.completionLabel || "使い始める"),
    completeTo: definition.completeTo == null ? null : String(definition.completeTo),
    cancelTo: definition.cancelTo == null ? null : String(definition.cancelTo),
    closeOnBackAtStart: Boolean(definition.closeOnBackAtStart),
    lockBackDuringModelLoad: Boolean(definition.lockBackDuringModelLoad),
    onOpen: definition.onOpen ?? null,
    onStageChange: definition.onStageChange ?? null,
    onEnterStep: definition.onEnterStep ?? null,
    onComplete: definition.onComplete ?? null,
    onCancel: definition.onCancel ?? null,
    // onClose is a handoff hook. Only the orchestrator calls it while replacing
    // this profile; terminal profiles are never handed off/closed again.
    onClose: definition.onClose ?? null,
  });
}

export function resolveStartupTutorialProfile({
  tutorialComplete,
  selectedModelCached,
  sourceUpdateAvailable = false,
  sourceFetchBytes = 0,
}) {
  if (!tutorialComplete) return "full";
  if (sourceUpdateAvailable || Number(sourceFetchBytes || 0) > 0) return "source-update";
  return selectedModelCached ? "end" : "model-picker-required";
}

export class TutorialController {
  constructor(documentRef = document, {
    modelProfileUi = null,
    app = null,
    tutorialComplete = false,
    sourceUpdate = null,
  } = {}) {
    this.document = documentRef;
    this.modelProfileUi = modelProfileUi;
    this.app = app;
    this.sourceUpdate = sourceUpdate;
    this.tutorialComplete = Boolean(tutorialComplete);
    this.stepIndex = 0;
    this.activePages = [];
    this.activeVisits = [];
    this.visitStates = new Map();
    this.profiles = new Map();
    this.activeProfile = null;
    this.profileTransitioning = false;
    this.profileTransitionPromise = Promise.resolve();
    this.navigationBusy = false;
    this.enterStepPromise = Promise.resolve(null);
    this.profileState = Object.create(null);
    this.demoSnapshot = null;
    this.demoRunToken = 0;
    this.demoRunning = false;
    this.lastDemoText = null;
    this.lastCorrectionText = null;
    this.temporaryWaitOriginal = null;
    this.cancelExamplePreparing = false;
    this.downloadAcknowledged = false;
    this.sourceUpdateAcknowledged = false;
    this.sourceUpdateRunning = false;
    this.sourceUpdateProgressLast = null;
    this.sourceUpdateCompleted = !Boolean(sourceUpdate?.plan?.updateAvailable)
      && Number(sourceUpdate?.plan?.fetchBytes || 0) === 0;
    const voiceState = this.app?.voiceRuntimeState;
    this.downloadCompleted = Boolean(
      voiceState?.prepared
      && voiceState.profile === (this.modelProfileUi?.profile ?? "fp16")
      && this.sourceUpdateCompleted
    );
    this.downloadRunning = false;
    this.downloadModelCached = false;
    this.downloadAbortController = null;
    this.downloadTask = null;
    this.sampleAudioContext = null;
    this.sampleSource = null;
    this.sampleAssetBytes = new Map();
    this.sampleAssetPromises = new Map();
    this.sampleBuffers = new Map();
    this.downloadProgressUnsubscribe = null;
    this.downloadProgressLast = null;
    this.targetArrowTarget = null;
    this.summaryReturnIndex = null;
    this.conversationPracticeCount = readConversationPracticeCount();
    this.conversationTutorialCompleted = this.conversationPracticeCount > 0;
    this.conversationPracticeActive = false;
    this.conversationOpenCompleted = false;
    this.conversationOpenStartSessionId = null;
    this.deviceLabelPromise = null;
    this.liveWindowPosition = null;
    this.dragState = null;
    this.windowMinimized = false;
    this.windowMinimizeHintUsed = false;
    this.elements = this.#resolveElements();
  }

  initialize() {
    this.offscreenHand = null;
    this.elements.overlay.addEventListener("pointerdown", () => this.#acknowledgeStep());
    this.elements.overlay.addEventListener("keydown", () => this.#acknowledgeStep());
    this.document.addEventListener("click", (event) => this.#guardTutorialNavigation(event), true);
    globalThis.addEventListener?.("resize", () => this.#handleViewportResize(), { passive: true });
    this.document.addEventListener("scroll", () => this.#refreshTargetArrow(), { capture: true, passive: true });
    this.elements.dragHandle.addEventListener("pointerdown", (event) => this.#startWindowDrag(event));
    this.elements.dragHandle.addEventListener("pointermove", (event) => this.#moveWindowDrag(event));
    this.elements.dragHandle.addEventListener("pointerup", (event) => this.#endWindowDrag(event));
    this.elements.dragHandle.addEventListener("pointercancel", (event) => this.#endWindowDrag(event));
    this.elements.minimize.addEventListener("click", () => this.#setWindowMinimized(true));
    this.elements.expand.addEventListener("click", () => this.#setWindowMinimized(false));
    void this.#updateDeviceSynthesisCopy();
    this.elements.back.addEventListener("click", () => void this.previous());
    this.elements.next.addEventListener("click", () => void this.next());
    this.elements.linebreakDemo.addEventListener("click", () => void this.#runLinebreakDemo());
    this.elements.correctionDemo.addEventListener("click", () => void this.#runCorrectionDemo());
    this.elements.cancelDemo.addEventListener("click", () => void this.#runCancelDemo());
    for (const button of this.elements.sampleButtons) {
      button.addEventListener("click", () => void this.#runSamplePreview(button.dataset.tutorialSample));
    }
    this.elements.downloadAck.addEventListener("click", () => this.#acknowledgeDownload());
    this.elements.sourceUpdateAck.addEventListener("click", () => void this.#runSourceUpdate());
    this.elements.downloadButton.addEventListener("click", () => void this.#runVoiceDownload());
    this.elements.waitSeconds.addEventListener("change", () => void this.#applyWaitSetting());
    this.elements.waitDemo.addEventListener("click", () => void this.#runWaitDemo());
    this.elements.conversationView.addEventListener("click", () => {
      globalThis.setTimeout(() => this.#handleConversationListOpened(), 0);
    });
    this.elements.conversationRepeat.addEventListener("click", () => this.#repeatConversationTutorial());
    this.elements.modelLoadReplayAfterLoad.addEventListener("change", () => {
      this.app?.setReplayAfterVoiceLoad?.(this.elements.modelLoadReplayAfterLoad.checked);
    });
    this.elements.conversationList.addEventListener("click", (event) => {
      if (this.elements.overlay.dataset.step !== "conversation-open") return;
      const row = event.target.closest?.(".conversation-row");
      if (!row) return;
      globalThis.setTimeout(() => void this.#handleConversationOpened(row.dataset.sessionId), 0);
    });
    this.elements.composer.addEventListener("input", (event) => {
      if (this.elements.overlay.dataset.step !== "conversations") return;
      if (event.inputType !== "insertLineBreak" && event.inputType !== "insertParagraph") return;
      globalThis.setTimeout(() => void this.#handleConversationSubmission(), 0);
    });
    for (const button of this.elements.summaryJumpButtons) {
      button.addEventListener("click", () => void this.#jumpFromSummary(button.dataset.tutorialJump));
    }
    this.document.addEventListener("typed-voice:model-profile-ui-change", () => {
      this.#stopSample();
      for (const visit of this.activeVisits) {
        if (visit.stepId !== "model-load") continue;
        const state = this.visitStates.get(visit.visitId);
        if (!state) continue;
        state.modelLoadStarted = false;
        state.modelLoadComplete = false;
        state.modelLoadAudioUnlock = null;
      }
      const voiceState = this.app?.voiceRuntimeState;
      this.downloadModelCached = false;
      this.downloadCompleted = Boolean(
        voiceState?.prepared
        && voiceState.profile === (this.modelProfileUi?.profile ?? "fp16")
        && this.sourceUpdateCompleted
      );
      this.#resetDownloadAcknowledgement();
      this.#renderDownloadDisclosure();
      this.#resetDownloadProgress();
      const currentStep = this.activePages[this.stepIndex]?.dataset.tutorialStep ?? null;
      if (!this.profileTransitioning && !this.elements.overlay.hidden && currentStep === "download") {
        this.#showStep();
      }
    });

    return this;
  }

  start() {
    return this.openProfile("full");
  }

  registerProfile(name, definition) {
    const profileName = String(name || "").trim();
    if (!profileName) throw new TypeError("Tutorial profile name is required.");
    if (this.profiles.has(profileName)) throw new Error(`Tutorial profile is already registered: ${profileName}`);
    const profile = createTutorialProfileDefinition(
      profileName,
      definition,
      this.elements.pages.map((page) => page.dataset.tutorialStep)
    );
    this.profiles.set(profileName, profile);
    return this;
  }

  openProfile(name) {
    const profile = this.profiles.get(String(name));
    if (!profile) throw new Error(`Unknown tutorial profile: ${name}`);
    for (const [kind, target] of [["completeTo", profile.completeTo], ["cancelTo", profile.cancelTo]]) {
      if (target != null && !this.profiles.has(target)) {
        throw new Error(`Tutorial profile ${profile.name} has unknown ${kind}: ${target}`);
      }
    }
    if (!profile.terminal && profile.completeTo == null) {
      throw new Error(`Tutorial profile ${profile.name} must define completeTo.`);
    }
    if (profile.closeOnBackAtStart && profile.cancelTo == null) {
      throw new Error(`Tutorial profile ${profile.name} must define cancelTo when closeOnBackAtStart is enabled.`);
    }
    // Profile handoffs are serialized by the orchestrator. Hooks must request
    // their next destination through completeTo/cancelTo instead of recursively
    // opening another profile themselves.
    const transition = this.profileTransitionPromise.then(() => this.#openProfile(profile));
    this.profileTransitionPromise = transition.catch(() => {});
    return transition;
  }

  openSteps(stepIds) {
    if (!Array.isArray(stepIds) || stepIds.length === 0) {
      throw new TypeError("Tutorial step IDs must be a non-empty array.");
    }
    const name = `__adhoc_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    if (!this.profiles.has("end")) throw new Error("Tutorial terminal profile 'end' is not registered.");
    this.registerProfile(name, {
      route: stepIds,
      completeTo: "end",
      cancelTo: "end",
      closeOnBackAtStart: true,
    });
    return this.openProfile(name).finally(() => {
      this.profiles.delete(name);
    });
  }

  async #openProfile(profile) {
    const pagesById = new Map(this.elements.pages.map((page) => [page.dataset.tutorialStep, page]));
    const activeVisits = profile.route;
    const activePages = activeVisits.map((visit) => pagesById.get(visit.stepId));

    this.profileTransitioning = true;
    this.#cleanupDemo();
    try {
      // onClose is owned by the orchestrator and means "this profile is being
      // replaced". Completion/cancellation may cause that handoff, but profiles
      // never close themselves. A terminal profile is never closed again.
      if (this.activeProfile && !this.activeProfile.terminal) {
        await this.activeProfile.onClose?.(this.#profileContext({
          reason: "handoff",
          nextProfile: profile,
        }));
      }
      this.activePages = activePages;
      this.activeVisits = activeVisits;
      this.visitStates = new Map(activeVisits.map((visit) => [visit.visitId, Object.create(null)]));
      this.activeProfile = profile;
      this.elements.overlay.dataset.profile = profile.name;
      this.stepIndex = 0;
      // profileState/visitStates are runtime-only. Persistent resume data must
      // use a separate, explicitly serializable checkpoint contract.
      this.profileState = Object.create(null);
      if (profile.terminal) {
        this.stepIndex = 0;
        this.#hideFlowUi();
        return this;
      }
      await profile.onOpen?.(this.#profileContext({ reason: "open" }));
      const voiceState = this.app?.voiceRuntimeState;
      this.downloadModelCached = false;
      this.downloadCompleted = Boolean(
        voiceState?.prepared
        && voiceState.profile === (this.modelProfileUi?.profile ?? "fp16")
        && this.sourceUpdateCompleted
      );
      this.#resetDownloadAcknowledgement();
      this.#renderDownloadDisclosure();
      this.#resetDownloadProgress();
      this.summaryReturnIndex = null;
      this.conversationPracticeCount = readConversationPracticeCount();
      this.conversationTutorialCompleted = this.conversationPracticeCount > 0;
      this.conversationPracticeActive = false;
      this.conversationOpenCompleted = false;
      this.elements.modelLoadReplayAfterLoad.checked = true;
      this.app?.setReplayAfterVoiceLoad?.(true);
      this.dragState = null;
      this.#setWindowMinimized(false, { focus: false });
      this.document.body.classList.remove("tutorial-window-dragging");
      this.elements.dragHandle.classList.remove("is-dragging");
      this.#scrollPageToTop();
      this.elements.runtimeStatus.hidden = true;
      this.elements.runtimeStatus.textContent = "";
      this.elements.overlay.hidden = false;
      this.document.body.classList.add("tutorial-open");
      this.#showStep();
      return this;
    } finally {
      this.profileTransitioning = false;
    }
  }

  async previous() {
    if (this.navigationBusy) return;
    this.navigationBusy = true;
    try {
      await this.#awaitEnterStep({ allowError: true });
      const currentVisit = this.activeVisits[this.stepIndex] ?? null;
      const currentVisitState = this.#visitState();
      const currentStep = this.activePages[this.stepIndex]?.dataset.tutorialStep;
      if (
        this.activeProfile?.lockBackDuringModelLoad
        && currentStep === "model-load"
        && (currentVisitState.modelLoadStarted || currentVisitState.modelLoadComplete)
      ) return;
      if (currentStep === "model-load" || currentStep === "free") this.#cleanupDemo();
      else await this.#prepareStageChange();
      this.#scrollPageToTop();
      if (this.summaryReturnIndex != null && this.stepIndex !== this.summaryReturnIndex) {
        await this.#returnToSummary();
        return;
      }
      if (this.stepIndex === 0) {
        if (this.activeProfile?.closeOnBackAtStart) {
          await currentVisit?.onLeave?.(this.#profileContext({ reason: "leave", direction: "cancel" }));
          await this.activeProfile.onCancel?.(this.#profileContext({ reason: "cancel" }));
          const targetProfile = this.activeProfile.cancelTo;
          if (targetProfile) await this.openProfile(targetProfile);
        }
        return;
      }
      await currentVisit?.onLeave?.(this.#profileContext({ reason: "leave", direction: "back" }));
      this.stepIndex -= 1;
      this.#showStep();
    } finally {
      this.navigationBusy = false;
    }
  }

  async next() {
    if (this.navigationBusy) return;
    this.navigationBusy = true;
    try {
      if (!await this.#awaitEnterStep()) return;
      const currentVisit = this.activeVisits[this.stepIndex] ?? null;
      const currentStep = this.activePages[this.stepIndex]?.dataset.tutorialStep;
      const nextPage = this.activePages[this.stepIndex + 1];
      const nextVisitState = this.#visitState(this.stepIndex + 1);
      if (nextPage?.dataset.tutorialStep === "model-load" && !nextVisitState.modelLoadAudioUnlock) {
        nextVisitState.modelLoadAudioUnlock = Promise.resolve(this.app?.unlockVoiceAudio?.()).then(
          () => null,
          (error) => error
        );
      }
      if (currentStep === "model-load" || currentStep === "free") this.#cleanupDemo();
      else await this.#prepareStageChange();
      if (this.summaryReturnIndex != null && this.stepIndex !== this.summaryReturnIndex) {
        this.#scrollPageToTop();
        await this.#returnToSummary();
        return;
      }
      if (this.stepIndex >= this.activePages.length - 1) {
        void this.complete();
        return;
      }
      await currentVisit?.onLeave?.(this.#profileContext({ reason: "leave", direction: "next" }));
      this.#scrollPageToTop();
      this.stepIndex += 1;
      this.#showStep();
    } finally {
      this.navigationBusy = false;
    }
  }

  async complete() {
    if (this.completing) return;
    this.completing = true;
    this.elements.next.disabled = true;
    this.#cleanupDemo();
    try {
      if (!await this.#awaitEnterStep()) return;
      await this.activeVisits[this.stepIndex]?.onLeave?.(this.#profileContext({ reason: "leave", direction: "complete" }));
      await this.activeProfile?.onComplete?.(this.#profileContext({ reason: "complete" }));
      const targetProfile = this.activeProfile?.completeTo;
      if (targetProfile) await this.openProfile(targetProfile);
    } catch (error) {
      this.elements.downloadStatus.textContent = error instanceof Error ? error.message : String(error);
      this.elements.next.disabled = false;
    } finally {
      this.completing = false;
    }
  }

  #showStep() {
    if (this.summaryReturnIndex === this.stepIndex) this.summaryReturnIndex = null;
    const page = this.activePages[this.stepIndex];
    const visit = this.activeVisits[this.stepIndex];
    const visitState = this.#visitState();
    if (!page) throw new Error("Tutorial flow has no active page.");
    for (const candidate of this.elements.pages) candidate.hidden = candidate !== page;
    const freeInteraction = page.hasAttribute("data-tutorial-live") && page.dataset.tutorialStep !== "tsukuyomichan";
    this.elements.overlay.classList.toggle("tutorial-live", freeInteraction);
    if (!freeInteraction) this.#setWindowMinimized(false, { focus: false });
    this.elements.overlay.setAttribute("aria-modal", freeInteraction ? "false" : "true");
    this.elements.overlay.dataset.step = page.dataset.tutorialStep;
    this.#applyLiveWindowPosition();
    this.document.body.classList.toggle("tutorial-scrollable", freeInteraction);

    this.elements.progress.textContent = `${this.stepIndex + 1} / ${this.activePages.length}`;
    this.elements.headerBrand.textContent = page.dataset.tutorialStep === "model-load"
      ? "モデルロード中"
      : this.activeProfile?.headerBrand ?? "はじめての typed-voice";
    this.elements.overlay.classList.add("tutorial-needs-attention");
    const scopedModelLoadLocked = this.activeProfile?.lockBackDuringModelLoad
      && page.dataset.tutorialStep === "model-load"
      && (visitState.modelLoadStarted || visitState.modelLoadComplete);
    this.elements.back.disabled = (!this.activeProfile?.closeOnBackAtStart && this.stepIndex === 0) || scopedModelLoadLocked;
    this.elements.next.hidden = false;
    this.elements.back.textContent = this.summaryReturnIndex != null && this.stepIndex !== this.summaryReturnIndex
      ? `${this.summaryReturnIndex + 1} / ${this.activePages.length}へ戻る`
      : visit?.backLabel
        ?? (this.activeProfile?.closeOnBackAtStart && this.stepIndex === 0 ? "閉じる" : "戻る");
    this.elements.next.textContent = this.summaryReturnIndex != null && this.stepIndex !== this.summaryReturnIndex
      ? `${this.summaryReturnIndex + 1} / ${this.activePages.length}へ戻る`
      : page.dataset.tutorialStep === "model-load"
        ? visitState.modelLoadComplete
          ? visit?.nextLabel
            ?? (this.stepIndex === this.activePages.length - 1 ? this.activeProfile?.completionLabel ?? "使い始める" : "自由に使ってみる")
          : "読み込み中"
        : visit?.nextLabel
          ?? (this.stepIndex === this.activePages.length - 1 ? this.activeProfile?.completionLabel ?? "使い始める" : "次へ");
    this.elements.next.disabled = (page.dataset.tutorialStep === "download" && !this.downloadCompleted)
      || page.dataset.tutorialStep === "source-update"
      || page.dataset.tutorialStep === "memory-shortage"
      || (page.dataset.tutorialStep === "conversations" && !this.conversationTutorialCompleted && this.conversationPracticeCount === 0)
      || (page.dataset.tutorialStep === "conversation-open" && !this.conversationOpenCompleted)
      || (page.dataset.tutorialStep === "model-load" && !visitState.modelLoadComplete);
    this.#updateHighlights(page.dataset.tutorialStep);
    if (page.dataset.tutorialStep === "wait") this.#syncWaitSetting();
    if (page.dataset.tutorialStep === "cancel") void this.#prepareCancelExample();
    if (page.dataset.tutorialStep === "conversations") void this.#prepareConversationTutorial();
    if (page.dataset.tutorialStep === "conversation-open") void this.#prepareConversationOpenTutorial();
    if (page.dataset.tutorialStep === "download" && !this.downloadCompleted) void this.#loadActualDownloadPlan();
    if (page.dataset.tutorialStep === "source-update") this.#renderSourceUpdateDisclosure();
    this.#beginEnterStep(page);
    this.elements.pagesContainer.scrollTop = 0;
    if (page.dataset.tutorialStep === "source-update" && !this.sourceUpdateRunning) {
      this.elements.sourceUpdateAck.focus({ preventScroll: true });
    } else if (page.dataset.tutorialStep === "download" && !this.downloadCompleted && !this.downloadAcknowledged) {
      this.elements.downloadAck.focus({ preventScroll: true });
    } else if (page.dataset.tutorialStep === "download" && !this.downloadCompleted) {
      this.elements.downloadButton.focus({ preventScroll: true });
    } else if (page.dataset.tutorialStep === "linebreak") {
      this.elements.composer.focus({ preventScroll: true });
      this.#moveCaretToEnd();
    } else if (freeInteraction) {
      this.elements.focusAnchor.focus({ preventScroll: true });
    } else {
      this.elements.next.focus({ preventScroll: true });
    }
  }

  #acknowledgeStep() {
    this.elements.overlay.classList.remove("tutorial-needs-attention");
  }

  #renderSourceUpdateDisclosure() {
    if (this.sourceUpdateRunning || this.sourceUpdateCompleted) return;
    const plan = this.sourceUpdate?.plan;
    if (!plan) {
      this.elements.sourceUpdateSize.textContent = "取得できませんでした";
      this.elements.sourceUpdateAck.disabled = true;
      this.elements.sourceUpdateAck.textContent = "容量を確認できません";
      this.elements.sourceUpdateStatus.textContent = "更新容量を確認できませんでした。再読み込みしてからもう一度お試しください。";
      return;
    }
    const totalBytes = Math.max(0, Number(plan.fetchBytes || 0));
    const formatted = this.#formatBytes(totalBytes);
    this.elements.sourceUpdateSize.textContent = totalBytes > 0 ? formatted : "修復が必要です";
    this.elements.sourceUpdateProgress.value = 0;
    this.elements.sourceUpdatePercent.textContent = "0%";
    this.elements.sourceUpdateBytes.textContent = totalBytes > 0 ? `0 B / ${formatted}` : "保存済みデータを再利用";
    this.elements.sourceUpdateSpeed.textContent = "-- MB/s";
    this.elements.sourceUpdateStatus.textContent = totalBytes > 0
      ? `取得予定量は ${formatted} です。ボタンを押すまでダウンロードは始まりません。`
      : "再ダウンロードせず、保存済みデータを更新版へ切り替えます。";
    this.elements.sourceUpdateAck.disabled = false;
    this.elements.sourceUpdateAck.textContent = totalBytes > 0
      ? `${formatted} をダウンロードして更新することに同意して開始`
      : "保存済みデータで更新を開始";
  }

  async #runSourceUpdate() {
    if (this.sourceUpdateRunning || this.sourceUpdateCompleted || !this.sourceUpdate?.prepare) return;
    const expectedFetchBytes = Math.max(0, Number(this.sourceUpdate?.plan?.fetchBytes || 0));
    this.sourceUpdateAcknowledged = true;
    this.sourceUpdateRunning = true;
    this.sourceUpdateProgressLast = null;
    this.elements.sourceUpdateAck.disabled = true;
    this.elements.sourceUpdateAck.textContent = "更新中…";
    this.elements.sourceUpdateStatus.textContent = "typed-voiceのソースコードを更新しています。";
    this.elements.back.disabled = true;
    this.elements.next.disabled = true;
    this.elements.overlay.classList.remove("tutorial-needs-attention");
    this.#updateHighlights("source-update");
    try {
      await this.sourceUpdate.prepare({
        onProgress: (progress) => this.#handleSourceUpdateProgress(progress),
      });
      this.sourceUpdateCompleted = true;
      this.elements.sourceUpdateProgress.value = 100;
      this.elements.sourceUpdatePercent.textContent = "100%";
      this.elements.sourceUpdateBytes.textContent = expectedFetchBytes > 0
        ? `${this.#formatBytes(expectedFetchBytes)} / ${this.#formatBytes(expectedFetchBytes)}`
        : "修復が必要です";
      this.elements.sourceUpdateSpeed.textContent = "完了";
      this.elements.sourceUpdateAck.textContent = "更新完了";
      this.elements.sourceUpdateStatus.textContent = "更新が完了しました。自動で再読み込みします。";
      globalThis.location.reload();
    } catch (error) {
      this.sourceUpdateAcknowledged = false;
      this.elements.sourceUpdateAck.disabled = false;
      this.elements.sourceUpdateAck.textContent = "もう一度更新する";
      this.elements.sourceUpdateSpeed.textContent = "失敗";
      this.elements.sourceUpdateStatus.textContent = `更新に失敗しました: ${error instanceof Error ? error.message : String(error)}`;
      this.#updateHighlights("source-update");
    } finally {
      this.sourceUpdateRunning = false;
      if (!this.sourceUpdateCompleted) {
        this.elements.back.disabled = !this.activeProfile?.closeOnBackAtStart && this.stepIndex === 0;
      }
    }
  }

  #handleSourceUpdateProgress(progress) {
    const loaded = Math.max(0, Number(progress?.loadedBytes || 0));
    const plannedTotal = Math.max(0, Number(this.sourceUpdate?.plan?.fetchBytes || 0));
    const total = Math.max(0, Number(progress?.totalBytes || plannedTotal));
    if (total > 0) {
      const percent = Math.max(0, Math.min(100, loaded / total * 100));
      this.elements.sourceUpdateProgress.value = percent;
      this.elements.sourceUpdatePercent.textContent = `${percent.toFixed(1)}%`;
      this.elements.sourceUpdateBytes.textContent = `${this.#formatBytes(loaded)} / ${this.#formatBytes(total)}`;
    }
    const now = performance.now();
    if (this.sourceUpdateProgressLast && loaded >= this.sourceUpdateProgressLast.loaded) {
      const elapsedSeconds = (now - this.sourceUpdateProgressLast.at) / 1000;
      const deltaBytes = loaded - this.sourceUpdateProgressLast.loaded;
      if (elapsedSeconds >= 0.08 && deltaBytes > 0) {
        this.elements.sourceUpdateSpeed.textContent = `${(deltaBytes / elapsedSeconds / 1_000_000).toFixed(1)} MB/s`;
      }
    } else if (loaded > 0) {
      this.elements.sourceUpdateSpeed.textContent = "計測中…";
    }
    this.sourceUpdateProgressLast = { loaded, at: now };
  }

  async #updateDeviceSynthesisCopy() {
    const device = await this.#getDeviceLabel();
    this.elements.deviceSynthesisCopy.textContent = `あなたの${device}で、あなたのために音声が合成されます。そのため、読み上げが想定外に遅延することがあります。`;
  }

  async #getDeviceLabel() {
    if (this.deviceLabelPromise) return this.deviceLabelPromise;
    this.deviceLabelPromise = (async () => {
      const uaData = globalThis.navigator?.userAgentData;
      if (!uaData?.getHighEntropyValues) return "端末";
      try {
        const values = await uaData.getHighEntropyValues(["platform", "model", "formFactors"]);
        const formFactors = Array.isArray(values.formFactors)
          ? values.formFactors.map((value) => String(value).toLowerCase())
          : [];
        if (formFactors.some((value) => value.includes("tablet"))) return "タブレット";
        if (formFactors.some((value) => value.includes("mobile")) || (uaData.mobile && values.model)) return "スマートフォン";
        if (formFactors.some((value) => value.includes("desktop")) || /windows|macos|linux|chrome os/i.test(String(values.platform || ""))) {
          return "コンピューター";
        }
      } catch {
        // UA Client Hints are optional; keep the generic wording when unavailable.
      }
      return "端末";
    })();
    return this.deviceLabelPromise;
  }

  #scrollPageToTop() {
    this.elements.pagesContainer.scrollTop = 0;
  }

  #startWindowDrag(event) {
    if (!this.elements.overlay.classList.contains("tutorial-live") || (event.pointerType === "mouse" && event.button !== 0)) return;
    const rect = this.elements.shell.getBoundingClientRect();
    this.dragState = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    this.elements.dragHandle.classList.add("is-dragging");
    this.document.body.classList.add("tutorial-window-dragging");
    this.elements.dragHandle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  #setWindowMinimized(minimized, { focus = true } = {}) {
    const next = Boolean(minimized);
    if (next && !this.elements.overlay.classList.contains("tutorial-live")) return;
    this.windowMinimized = next;
    this.elements.overlay.classList.toggle("tutorial-minimized", next);
    const showMinimizeHint = next && !this.windowMinimizeHintUsed;
    if (showMinimizeHint) {
      this.windowMinimizeHintUsed = true;
    }
    this.elements.overlay.classList.toggle("tutorial-minimize-attention", showMinimizeHint);
    this.#applyLiveWindowPosition();
    if (focus) {
      (next ? this.elements.expand : this.elements.minimize).focus({ preventScroll: true });
    }
    this.#refreshTargetArrow();
  }

  #moveWindowDrag(event) {
    if (!this.dragState || event.pointerId !== this.dragState.pointerId) return;
    const position = this.#clampLiveWindowPosition(
      event.clientX - this.dragState.offsetX,
      event.clientY - this.dragState.offsetY
    );
    this.liveWindowPosition = position;
    this.#applyLiveWindowPosition();
    this.#refreshTargetArrow();
    event.preventDefault();
  }

  #endWindowDrag(event) {
    if (!this.dragState || event.pointerId !== this.dragState.pointerId) return;
    this.elements.dragHandle.releasePointerCapture?.(event.pointerId);
    this.elements.dragHandle.classList.remove("is-dragging");
    this.document.body.classList.remove("tutorial-window-dragging");
    this.dragState = null;
  }

  #applyLiveWindowPosition() {
    const shell = this.elements.shell;
    if (!this.elements.overlay.classList.contains("tutorial-live")) {
      shell.style.removeProperty("left");
      shell.style.removeProperty("top");
      shell.style.removeProperty("right");
      shell.style.removeProperty("bottom");
      return;
    }
    if (!this.liveWindowPosition) {
      const viewportWidth = globalThis.innerWidth || this.document.documentElement.clientWidth;
      const viewportHeight = globalThis.innerHeight || this.document.documentElement.clientHeight;
      if (viewportWidth <= 600 && viewportHeight <= 1000 && !this.windowMinimized) {
        shell.style.left = "auto";
        shell.style.top = "10px";
        shell.style.right = "10px";
        shell.style.bottom = "auto";
        return;
      }
      shell.style.removeProperty("left");
      shell.style.removeProperty("top");
      shell.style.removeProperty("right");
      shell.style.removeProperty("bottom");
      return;
    }
    const position = this.#clampLiveWindowPosition(this.liveWindowPosition.x, this.liveWindowPosition.y);
    this.liveWindowPosition = position;
    shell.style.left = `${Math.round(position.x)}px`;
    shell.style.top = `${Math.round(position.y)}px`;
    shell.style.right = "auto";
    shell.style.bottom = "auto";
  }

  #clampLiveWindowPosition(x, y) {
    const rect = this.elements.shell.getBoundingClientRect();
    const viewportWidth = globalThis.innerWidth || this.document.documentElement.clientWidth;
    const viewportHeight = globalThis.innerHeight || this.document.documentElement.clientHeight;
    const margin = 8;
    return {
      x: Math.max(margin, Math.min(viewportWidth - rect.width - margin, x)),
      y: Math.max(margin, Math.min(viewportHeight - rect.height - margin, y)),
    };
  }

  #handleViewportResize() {
    if (this.liveWindowPosition && !this.windowMinimized) this.#applyLiveWindowPosition();
    this.#refreshTargetArrow();
  }

  #guardTutorialNavigation(event) {
    if (this.elements.overlay.hidden) return;
    const link = event.target.closest?.("a[href]");
    if (link && !this.elements.overlay.contains(link)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const status = this.elements.overlay.dataset.step === "free"
        ? this.elements.freeStatus
        : this.elements.conversationStatus;
      if (status) status.textContent = "外部ページはチュートリアルが終わってから開けます。";
      return;
    }

  }

  async #prepareConversationTutorial() {
    if (this.elements.overlay.dataset.step !== "conversations") return;
    this.elements.conversationRepeat.hidden = this.conversationPracticeCount === 0;
    this.elements.conversationStatus.textContent = this.conversationPracticeCount > 0 && !this.conversationPracticeActive
      ? `この操作は ${this.conversationPracticeCount} 回できています。もう一度試しても、そのまま次へ進んでも大丈夫です。`
      : "まずは上の「会話一覧」を押してみましょう。";
    this.#updateHighlights("conversations");
  }

  #handleConversationListOpened() {
    if (this.elements.overlay.dataset.step === "conversation-open") {
      this.elements.conversationOpenStatus.textContent = "一覧から、いま表示しているものとは別の会話を1つ選んでください。";
      this.#updateHighlights("conversation-open");
      return;
    }
    if (this.elements.overlay.dataset.step !== "conversations") return;
    if (this.conversationTutorialCompleted && !this.conversationPracticeActive) return;
    this.conversationStartSessionId = this.app?.currentSession?.id ?? null;
    this.elements.conversationStatus.textContent = "一覧を開いたまま、左の入力欄へ文章を書いて改行してください。新しい会話を自動で作ります。";
    this.#updateHighlights("conversations");
  }

  async #handleConversationSubmission() {
    if (this.elements.overlay.dataset.step !== "conversations") return;
    await this.#waitFor(
      () => Boolean(this.app?.currentSession?.id && this.app.currentSession.id !== this.conversationStartSessionId),
      this.demoRunToken,
      2500
    );
    if (!this.app?.currentSession?.id || this.app.currentSession.id === this.conversationStartSessionId) return;
    this.conversationTutorialCompleted = true;
    this.conversationPracticeActive = false;
    this.conversationPracticeCount = recordConversationPractice();
    this.elements.next.disabled = false;
    this.elements.conversationRepeat.hidden = false;
    this.elements.conversationStatus.textContent = `新しい会話へ切り替わりました。これで ${this.conversationPracticeCount} 回目です。最初に送った文章が会話一覧のプレビューになります。`;
    this.#updateHighlights("conversations");
  }

  #repeatConversationTutorial() {
    if (this.elements.overlay.dataset.step !== "conversations") return;
    this.conversationTutorialCompleted = false;
    this.conversationPracticeActive = true;
    this.elements.next.disabled = true;
    this.elements.conversationRepeat.hidden = true;
    this.conversationStartSessionId = this.app?.currentSession?.id ?? null;
    this.elements.conversationStatus.textContent = "もう一度試せます。上の「会話一覧」を押し、左の入力欄へ新しい文章を書いて改行してください。";
    this.elements.timelineView.click();
    this.#updateHighlights("conversations");
  }

  async #prepareConversationOpenTutorial() {
    if (this.elements.overlay.dataset.step !== "conversation-open") return;
    this.conversationOpenCompleted = false;
    this.conversationOpenStartSessionId = this.app?.currentSession?.id ?? null;
    this.elements.next.disabled = true;
    this.elements.conversationOpenStatus.textContent = "まずは上の「会話一覧」を押してください。別の会話があれば、1つ選んで開きます。";
    const storedSessions = await this.app?.repository?.listSessions?.(1);
    if (Array.isArray(storedSessions) && storedSessions.length === 0) {
      // A tutorial can reach this step without ever submitting text. In that
      // case create a real IndexedDB session now, rather than rendering an
      // empty selector that has nothing the user can click.
      this.app.currentSession = null;
      await this.app?.ensureCurrentConversation?.({ replaceUrl: true });
    }
    await this.app?.refreshAll?.();
    const availableOtherConversation = [...this.elements.conversationList.querySelectorAll(".conversation-row")]
      .some((row) => row.dataset.sessionId && row.dataset.sessionId !== this.conversationOpenStartSessionId);
    if (!availableOtherConversation) {
      this.conversationOpenCompleted = true;
      this.elements.next.disabled = false;
      this.elements.conversationOpenStatus.textContent = "ほかに保存されている会話がないため、この確認は今回はスキップできます。";
      this.#updateHighlights("conversation-open");
      return;
    }
    this.elements.timelineView.click();
    this.#updateHighlights("conversation-open");
  }

  async #handleConversationOpened(requestedSessionId) {
    if (this.elements.overlay.dataset.step !== "conversation-open") return;
    if (!requestedSessionId || requestedSessionId === this.conversationOpenStartSessionId) return;
    await this.#waitForWithoutRunToken(() => this.app?.currentSession?.id === requestedSessionId, 2500);
    if (this.app?.currentSession?.id !== requestedSessionId) return;
    this.conversationOpenCompleted = true;
    this.elements.next.disabled = false;
    this.elements.conversationOpenStatus.textContent = "別の会話を履歴ごと開けました。ページの再読み込みはしていません。";
    this.#updateHighlights("conversation-open");
  }

  async #startModelLoad() {
    const visitState = this.#visitState();
    if (visitState.modelLoadStarted || visitState.modelLoadComplete || this.elements.overlay.dataset.step !== "model-load") return;
    visitState.modelLoadStarted = true;
    this.elements.next.disabled = true;
    this.elements.back.disabled = Boolean(this.activeProfile?.lockBackDuringModelLoad);
    this.elements.modelLoadStatus.textContent = "保存済みモデルを確認しています。";
    this.elements.modelLoadPrimaryValue.textContent = "確認中…";
    this.elements.modelLoadSecondaryValue.textContent = "開始待ち";
    this.#renderModelLoadCells(this.elements.modelLoadPrimaryCells, 0, 12);
    this.#renderModelLoadCells(this.elements.modelLoadSecondaryCells, 0, 1);
    try {
      const profile = this.modelProfileUi?.profile ?? "fp16";
      if (this.app?.isVoiceProfileCached && !await this.app.isVoiceProfileCached(profile)) {
        visitState.modelLoadStarted = false;
        if (this.activeProfile?.name !== "model-picker-required") {
          await this.openProfile("model-picker-required");
          return;
        }
        throw new Error("保存済みモデルが見つかりません。ダウンロードへ戻ってください");
      }
      if (visitState.modelLoadAudioUnlock) {
        const audioUnlockError = await visitState.modelLoadAudioUnlock;
        if (audioUnlockError) throw audioUnlockError;
      } else {
        await this.app?.unlockVoiceAudio?.();
      }
      await this.app?.initializePreparedVoice?.(profile, {
        enableAudio: true,
        showPanel: false,
        onBlockingProgress: (update) => this.#renderModelLoadProgress(update),
      });
      visitState.modelLoadComplete = true;
      this.#completeModelLoadCells(this.elements.modelLoadPrimaryCells);
      this.#completeModelLoadCells(this.elements.modelLoadSecondaryCells);
      this.elements.modelLoadPrimaryValue.textContent = "準備済み";
      this.elements.modelLoadSecondaryValue.textContent = "完了";
      this.elements.modelLoadStatus.textContent = "読み込みが終わりました。音声も有効です。";
      this.elements.next.disabled = false;
      this.elements.next.textContent = this.activeVisits[this.stepIndex]?.nextLabel
        ?? (this.stepIndex === this.activePages.length - 1
          ? this.activeProfile?.completionLabel ?? "使い始める"
          : "自由に使ってみる");
    } catch (error) {
      visitState.modelLoadStarted = false;
      if (this.activeProfile?.lockBackDuringModelLoad) this.elements.back.disabled = false;
      this.elements.modelLoadStatus.textContent = `読み込みに失敗しました: ${error instanceof Error ? error.message : String(error)}。戻ってからもう一度進むと再試行できます。`;
    }
  }

  #renderModelLoadProgress(update = {}) {
    if (update.primary) {
      const value = Number(update.primary.value || 0);
      const total = Number(update.primary.total || 0);
      this.#renderModelLoadCells(this.elements.modelLoadPrimaryCells, value, total);
      this.elements.modelLoadPrimaryValue.textContent = update.primary.text || `${Math.min(value, total)} / ${total}`;
    }
    if (update.secondary) {
      const value = Number(update.secondary.value || 0);
      const total = Number(update.secondary.total || 0);
      this.#renderModelLoadCells(this.elements.modelLoadSecondaryCells, value, total);
      this.elements.modelLoadSecondaryValue.textContent = update.secondary.text || `${Math.min(value, total)} / ${total}`;
    }
    if (update.detail) this.elements.modelLoadStatus.textContent = update.detail;
  }

  #renderModelLoadCells(container, value, total) {
    const denominator = Math.max(1, Number(total) || 1);
    const numerator = Math.max(0, Math.min(denominator, Number(value) || 0));
    const count = denominator <= 16 ? Math.max(1, Math.round(denominator)) : 12;
    const completed = Math.max(0, Math.min(count, Math.floor(numerator / denominator * count)));
    const fragment = this.document.createDocumentFragment();
    for (let index = 0; index < count; index += 1) {
      const cell = this.document.createElement("i");
      cell.className = "tutorial-model-load-cell";
      if (index < completed) cell.classList.add("is-done");
      else if (index === completed && numerator < denominator) cell.classList.add("is-running");
      fragment.append(cell);
    }
    container.replaceChildren(fragment);
  }

  #completeModelLoadCells(container) {
    if (!container.children.length) this.#renderModelLoadCells(container, 1, 1);
    for (const cell of container.children) {
      cell.classList.remove("is-running");
      cell.classList.add("is-done");
    }
  }

  async #jumpFromSummary(targetRef) {
    if (this.navigationBusy) return;
    this.navigationBusy = true;
    try {
      if (!await this.#awaitEnterStep()) return;
      const summaryIndex = this.#findVisitIndex("finish");
      const targetIndex = this.#findVisitIndex(targetRef);
      if (summaryIndex < 0 || targetIndex < 0) return;
      await this.activeVisits[this.stepIndex]?.onLeave?.(
        this.#profileContext({ reason: "leave", direction: "jump" })
      );
      await this.#prepareStageChange();
      this.summaryReturnIndex = summaryIndex;
      this.stepIndex = targetIndex;
      this.#showStep();
    } finally {
      this.navigationBusy = false;
    }
  }

  async #returnToSummary() {
    if (this.summaryReturnIndex == null) return;
    await this.activeVisits[this.stepIndex]?.onLeave?.(
      this.#profileContext({ reason: "leave", direction: "summary-return" })
    );
    const target = this.summaryReturnIndex;
    this.summaryReturnIndex = null;
    this.stepIndex = target;
    this.#showStep();
  }

  #findVisitIndex(reference) {
    const normalized = String(reference || "").trim();
    if (!normalized) return -1;
    const byVisitId = this.activeVisits.findIndex((visit) => visit.visitId === normalized);
    if (byVisitId >= 0) return byVisitId;
    const matches = [];
    for (let index = 0; index < this.activeVisits.length; index += 1) {
      if (this.activeVisits[index].stepId === normalized) matches.push(index);
    }
    return matches.length === 1 ? matches[0] : -1;
  }

  async #enterStep(page) {
    const profile = this.activeProfile;
    const visit = this.activeVisits[this.stepIndex] ?? null;
    const stepId = page?.dataset.tutorialStep ?? null;
    await profile?.onEnterStep?.(this.#profileContext({ reason: "enter-step", stepId }));
    if (this.activeProfile !== profile || this.elements.overlay.dataset.step !== stepId) return;
    await visit?.onEnter?.(this.#profileContext({ reason: "enter-visit", stepId }));
    if (this.activeProfile !== profile || this.elements.overlay.dataset.step !== stepId) return;
    if (stepId === "model-load") await this.#startModelLoad();
  }

  #beginEnterStep(page) {
    const profile = this.activeProfile;
    const visitId = this.activeVisits[this.stepIndex]?.visitId ?? null;
    this.elements.runtimeStatus.hidden = true;
    this.elements.runtimeStatus.textContent = "";
    this.enterStepPromise = this.#enterStep(page).then(
      () => null,
      (error) => {
        const stillCurrent = this.activeProfile === profile
          && this.activeVisits[this.stepIndex]?.visitId === visitId;
        if (stillCurrent) {
          this.elements.runtimeStatus.textContent = `この画面の準備に失敗しました: ${error instanceof Error ? error.message : String(error)}`;
          this.elements.runtimeStatus.hidden = false;
          this.elements.next.disabled = true;
        }
        return error;
      }
    );
  }

  async #awaitEnterStep({ allowError = false } = {}) {
    const promise = this.enterStepPromise;
    const error = await promise;
    if (promise !== this.enterStepPromise) return this.#awaitEnterStep({ allowError });
    return error == null || allowError;
  }

  #profileContext(extra = {}) {
    return Object.freeze({
      controller: this,
      app: this.app,
      modelProfileUi: this.modelProfileUi,
      profile: this.activeProfile,
      state: this.profileState,
      visitState: this.#visitState(),
      visit: this.activeVisits[this.stepIndex] ?? null,
      visitId: this.activeVisits[this.stepIndex]?.visitId ?? null,
      stepId: this.activePages[this.stepIndex]?.dataset.tutorialStep ?? null,
      discardPending: () => this.#discardPendingViaNormalUi(),
      restoreCommittedModel: () => this.#restoreCommittedModel(),
      ...extra,
    });
  }

  #visitState(index = this.stepIndex) {
    const visit = this.activeVisits[index];
    if (!visit) return Object.create(null);
    let state = this.visitStates.get(visit.visitId);
    if (!state) {
      state = Object.create(null);
      this.visitStates.set(visit.visitId, state);
    }
    return state;
  }

  async #restoreCommittedModel() {
    const profile = this.modelProfileUi?.restoreCommittedSelection?.()
      ?? this.modelProfileUi?.committedProfile
      ?? "fp16";
    const voiceState = this.app?.voiceRuntimeState;
    if (voiceState?.profile === profile && voiceState?.ready) return true;
    if (!await this.app?.isVoiceProfileCached?.(profile)) return false;
    await this.app?.initializePreparedVoice?.(profile, {
      enableAudio: false,
      showPanel: false,
    });
    return true;
  }

  #hideFlowUi() {
    this.#cleanupDemo();
    this.elements.overlay.hidden = true;
    this.document.body.classList.remove("tutorial-open", "tutorial-scrollable", "tutorial-window-dragging");
    this.elements.overlay.classList.remove("tutorial-minimized", "tutorial-minimize-attention");
    this.windowMinimized = false;
    this.elements.dragHandle.classList.remove("is-dragging");
    this.dragState = null;
    this.targetArrowTarget = null;
    this.elements.targetArrow.hidden = true;
    this.offscreenHand?.remove();
    this.offscreenHand = null;
    this.#stopSample({ close: true });
    this.elements.composer.focus({ preventScroll: true });
  }

  async #prepareStageChange() {
    this.#cleanupDemo();
    await this.activeProfile?.onStageChange?.(this.#profileContext({
      reason: "stage-change",
      stepId: this.activePages[this.stepIndex]?.dataset.tutorialStep ?? null,
    }));
  }

  async #discardPendingViaNormalUi() {
    let attempts = 0;
    while ((this.app?.currentPendingCount ?? 0) > 0 && attempts < 64) {
      attempts += 1;
      const before = this.app?.currentPendingCount ?? 0;
      if (this.elements.cancelCurrentButton.disabled) await this.app?.refreshAll?.();
      if (this.elements.cancelCurrentButton.disabled) break;
      this.elements.cancelCurrentButton.click();
      const removed = await this.#waitForWithoutRunToken(
        () => (this.app?.currentPendingCount ?? 0) < before,
        1800
      );
      if (!removed) break;
    }
  }

  async #waitForWithoutRunToken(predicate, timeoutMs) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (predicate()) return true;
      await this.#sleep(30);
    }
    return false;
  }

  #syncWaitSetting() {
    const value = this.app?.getReasoningSeconds?.() ?? 2;
    this.elements.waitSeconds.value = String(value);
    this.elements.waitStatus.textContent = `いまは ${value} 秒待ちます。ここで変えると、本体の設定も同じ値になります。`;
  }

  async #applyWaitSetting() {
    const value = await this.app?.setReasoningSeconds?.(this.elements.waitSeconds.value);
    const normalized = Number.isFinite(Number(value)) ? Number(value) : 2;
    this.elements.waitSeconds.value = String(normalized);
    this.elements.waitStatus.textContent = normalized === 0
      ? "0秒にしました。Enterのあとすぐ読み上げる設定です。"
      : `${normalized} 秒にしました。この間なら訂正や取り消しが間に合います。`;
  }

  async #runWaitDemo() {
    if (this.demoRunning) return;
    this.demoRunning = true;
    const runToken = ++this.demoRunToken;
    this.elements.waitDemo.disabled = true;
    this.elements.back.disabled = true;
    this.elements.next.disabled = true;
    this.#rememberComposer();

    try {
      while ((this.app?.currentPendingCount ?? 0) > 0) {
        if (!await this.app?.cancelLatestPending?.()) break;
      }

      const composer = this.elements.composer;
      this.#moveCaretToEnd();
      if (composer.value && !composer.value.endsWith("\n")) {
        composer.setRangeText("\n", composer.selectionStart, composer.selectionEnd, "end");
      }
      this.elements.waitStatus.textContent = "待ち時間を見せるための文章を入力しています。";
      if (!await this.#typeText(WAIT_DEMO_TEXT, runToken)) return;
      if (runToken !== this.demoRunToken) return;

      const seconds = Math.max(0, Math.min(30, Number(this.app?.getReasoningSeconds?.() ?? 2)));
      const beforePending = this.app?.currentPendingCount ?? 0;
      if (!this.#insertLineBreakAtCaret()) return;
      if (seconds > 0 && !await this.#waitForPendingIncrease(beforePending, runToken)) return;
      const pending = [...this.elements.pendingList.querySelectorAll(".pending-card")]
        .find((node) => node.querySelector(".pending-text")?.textContent === WAIT_DEMO_TEXT);
      pending?.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      if (pending) {
        this.targetArrowTarget = pending;
        requestAnimationFrame(() => this.#refreshTargetArrow());
      }
      this.elements.waitStatus.textContent = seconds === 0
        ? "0秒なので、読み上げ待ちはすぐ終わります。"
        : `${seconds} 秒の読み上げ待ちに入りました。左のカードを見てください。`;
      if (!await this.#waitForHistoryText(WAIT_DEMO_TEXT, runToken, seconds * 1000 + 3500)) return;
      const newestHistory = [...this.elements.messageList.querySelectorAll(".message-card")]
        .find((node) => node.querySelector(".message-text")?.textContent === WAIT_DEMO_TEXT);
      newestHistory?.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
      this.#updateHighlights("wait");
      this.elements.waitStatus.textContent = "待ち時間が終わりました。文章は読み上げ履歴のいちばん上へ移ります。";
    } finally {
      if (runToken === this.demoRunToken) {
        this.demoRunning = false;
        this.elements.waitDemo.disabled = false;
        this.elements.back.disabled = this.stepIndex === 0;
        this.elements.next.disabled = false;
      }
    }
  }


  #resetDownloadAcknowledgement() {
    this.downloadAcknowledged = false;
    this.elements.downloadAck.disabled = true;
    this.elements.downloadAck.textContent = "容量を確認しています…";
    this.elements.downloadButton.disabled = true;
  }

  #renderDownloadDisclosure() {
    this.elements.downloadSize.textContent = this.downloadCompleted ? "保存済み" : "確認中…";
  }

  #acknowledgeDownload() {
    if (this.elements.downloadAck.disabled || this.downloadCompleted) return;
    this.downloadAcknowledged = true;
    this.elements.downloadAck.disabled = true;
    this.elements.downloadAck.textContent = "容量を確認しました";
    this.elements.downloadButton.disabled = false;
    this.elements.overlay.classList.remove("tutorial-needs-attention");
    this.#updateHighlights("download");
    this.elements.downloadButton.focus({ preventScroll: true });
  }

  async #runSamplePreview(sampleId) {
    const profileKey = this.modelProfileUi?.profile ?? "fp16";
    const profile = MODEL_PROFILES[profileKey] ?? MODEL_PROFILES.fp16;
    const sample = SAMPLE_PREVIEWS[sampleId] ?? SAMPLE_PREVIEWS.expression;
    const branch = SAMPLE_BRANCHES[profileKey] ?? SAMPLE_BRANCHES.fp16;
    const url = `https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/${branch}/samples/${sample.filename}`;
    const cacheKey = `${profileKey}:${sampleId}`;
    this.#stopSample();
    for (const button of this.elements.sampleButtons) button.disabled = true;
    this.elements.sampleStatus.textContent = this.sampleAssetBytes.has(cacheKey)
      ? `${profile.title} の試聴 ${sample.label} をメモリから再生します。`
      : `${profile.title} の試聴 ${sample.label} を取得しています。`;

    try {
      const view = this.document.defaultView ?? globalThis;
      const AudioContextCtor = view.AudioContext ?? view.webkitAudioContext;
      if (!AudioContextCtor) throw new Error("このブラウザでは試聴を再生できません。");
      this.sampleAudioContext ??= new AudioContextCtor();
      await this.sampleAudioContext.resume();
      const bytes = await this.#getSampleAsset(cacheKey, url);
      let buffer = this.sampleBuffers.get(cacheKey);
      if (!buffer) {
        buffer = await this.sampleAudioContext.decodeAudioData(bytes.slice(0));
        this.sampleBuffers.set(cacheKey, buffer);
      }
      const source = this.sampleAudioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(this.sampleAudioContext.destination);
      this.sampleSource = source;
      this.elements.sampleStatus.textContent = `${profile.title} の試聴 ${sample.label} を再生中です（${this.#formatBytes(bytes.byteLength)}）。`;
      source.onended = () => {
        if (this.sampleSource === source) {
          this.sampleSource = null;
          this.elements.sampleStatus.textContent = `試聴 ${sample.label} が終わりました。どちらも何度でも再生できます。`;
        }
      };
      source.start();
    } catch (error) {
      this.elements.sampleStatus.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      for (const button of this.elements.sampleButtons) button.disabled = false;
    }
  }

  #stopSample({ close = false } = {}) {
    if (this.sampleSource) {
      try {
        this.sampleSource.stop();
      } catch {
        // It may already have finished naturally.
      }
      this.sampleSource = null;
    }
    if (close && this.sampleAudioContext) {
      void this.sampleAudioContext.close();
      this.sampleAudioContext = null;
      this.sampleBuffers.clear();
    }
  }

  async #getSampleAsset(cacheKey, url) {
    const cached = this.sampleAssetBytes.get(cacheKey);
    if (cached) return cached;
    const existing = this.sampleAssetPromises.get(cacheKey);
    if (existing) return existing;
    const request = (async () => {
      const response = await fetch(url, { cache: "force-cache" });
      if (!response.ok) throw new Error(`試聴WAVの取得に失敗しました (${response.status})`);
      const bytes = await response.arrayBuffer();
      this.sampleAssetBytes.set(cacheKey, bytes);
      return bytes;
    })();
    this.sampleAssetPromises.set(cacheKey, request);
    try {
      return await request;
    } finally {
      this.sampleAssetPromises.delete(cacheKey);
    }
  }

  #resetDownloadProgress() {
    this.downloadProgressLast = null;
    this.downloadProgressUnsubscribe?.();
    this.downloadProgressUnsubscribe = null;
    this.elements.downloadProgress.value = this.downloadCompleted ? 100 : 0;
    this.elements.downloadPercent.textContent = this.downloadCompleted ? "100%" : "0%";
    this.elements.downloadBytes.textContent = this.downloadCompleted ? "準備済み" : "開始前";
    this.elements.downloadSpeed.textContent = this.downloadCompleted ? "キャッシュ済み" : "-- MB/s";
    this.elements.downloadStatus.textContent = this.downloadCompleted
      ? "音声データはすでに利用できます。"
      : "実際の容量を確認してから、ダウンロードを開始できます。";
    this.elements.downloadAck.disabled = true;
    this.elements.downloadAck.textContent = this.downloadCompleted ? "保存済み" : this.downloadAcknowledged ? "容量を確認しました" : "容量を確認しています…";
    this.elements.downloadButton.disabled = this.downloadCompleted || !this.downloadAcknowledged;
    this.elements.downloadButton.textContent = this.downloadCompleted ? "音声データは準備済み" : "音声データをダウンロード";
  }

  async #loadActualDownloadPlan() {
    if (!this.app?.getVoiceProfilePlan || this.downloadRunning || this.downloadCompleted) return;
    try {
      const profile = this.modelProfileUi?.profile ?? "fp16";
      const modelCached = Boolean(await this.app?.isVoiceProfileCached?.(profile));
      this.downloadModelCached = modelCached;
      const sourcePlan = this.sourceUpdate?.plan ?? null;
      const sourcePending = !this.sourceUpdateCompleted
        && (Boolean(sourcePlan?.updateAvailable) || Number(sourcePlan?.fetchBytes || 0) > 0);
      if (modelCached && !sourcePending) {
        this.downloadCompleted = true;
        this.downloadAcknowledged = true;
        this.#renderDownloadDisclosure();
        this.#resetDownloadProgress();
        this.elements.next.disabled = false;
        this.#updateHighlights("download");
        return;
      }
      const modelPlan = modelCached ? null : await this.app.getVoiceProfilePlan(profile);
      const modelBytes = modelCached ? 0 : Number(modelPlan?.totalBytes || 0);
      const sourceBytes = sourcePending ? Number(sourcePlan?.fetchBytes || 0) : 0;
      const totalBytes = modelBytes + sourceBytes;
      if ((totalBytes > 0 || sourcePending) && !this.downloadRunning && !this.downloadCompleted) {
        const formatted = this.#formatBytes(totalBytes);
        const device = await this.#getDeviceLabel();
        this.elements.downloadSize.textContent = totalBytes > 0 ? formatted : "修復が必要です";
        this.elements.downloadBytes.textContent = totalBytes > 0 ? `予定 ${formatted}` : "保存済みデータを再利用";
        this.elements.downloadAck.disabled = false;
        this.elements.downloadAck.textContent = totalBytes > 0
          ? `私は ${formatted} をダウンロードして私の${device}に保存し、必要な更新を適用することに同意する。了解した`
          : "保存済みデータを再利用して必要な更新を適用することに同意する。了解した";
        this.elements.downloadStatus.textContent = totalBytes > 0
          ? `モデルとアプリ更新を合わせた取得予定量は ${formatted} です。確認するまでダウンロードは始まりません。`
          : "必要なファイルは保存済みです。同意後、再ダウンロードせず更新へ切り替えます。";
        this.#updateHighlights("download");
      }
    } catch {
      if (!this.downloadRunning && !this.downloadCompleted) {
        this.elements.downloadSize.textContent = "取得できませんでした";
        this.elements.downloadAck.disabled = true;
        this.elements.downloadAck.textContent = "容量を確認できません";
        this.elements.downloadStatus.textContent = "実際の容量を確認できませんでした。再読み込みしてからもう一度お試しください。";
      }
    }
  }

  async #runVoiceDownload() {
    if (this.downloadRunning) {
      await this.#cancelVoiceDownload();
      return;
    }
    if (this.downloadCompleted || !this.downloadAcknowledged) return;
    const voiceRuntime = this.app?.voiceRuntime;
    if (!voiceRuntime?.subscribeProgress || !this.app?.prepareOfflineVoice) {
      this.elements.downloadStatus.textContent = "音声ダウンロードを開始できません。";
      return;
    }

    this.downloadRunning = true;
    this.downloadAbortController = new AbortController();
    this.downloadProgressLast = null;
    this.elements.downloadButton.disabled = false;
    this.elements.downloadButton.textContent = "ダウンロードを中止";
    this.elements.downloadButton.classList.add("tutorial-download-cancel");
    this.elements.back.disabled = true;
    this.elements.next.disabled = true;
    this.elements.downloadStatus.textContent = "音声データと必要なアプリ更新を準備しています。中止すると進行中の通信も止まります。";
    this.downloadProgressUnsubscribe?.();
    this.downloadProgressUnsubscribe = voiceRuntime.subscribeProgress((message) => this.#handleDownloadProgress(message));

    try {
      const profile = this.modelProfileUi?.profile ?? "fp16";
      const task = (async () => {
        if (!this.sourceUpdateCompleted && this.sourceUpdate?.prepare) {
          await this.sourceUpdate.prepare({ signal: this.downloadAbortController.signal });
          this.sourceUpdateCompleted = true;
        }
        if (!this.downloadModelCached) {
          await this.app.prepareOfflineVoice(profile, {
            onKanalizerStatus: () => {
              this.elements.downloadStatus.textContent = "オフラインで使うための仕上げをしています。";
            },
            signal: this.downloadAbortController.signal,
          });
        }
      })();
      this.downloadTask = task;
      await task;
      this.downloadCompleted = true;
      this.elements.downloadProgress.value = 100;
      this.elements.downloadPercent.textContent = "100%";
      this.elements.downloadButton.textContent = "ダウンロード完了";
      this.elements.downloadButton.classList.remove("tutorial-download-cancel");
      this.elements.downloadStatus.textContent = "保存が終わりました。これでオフラインでも使えます。「使い始める」のあとに音声を読み込みます。";
      this.elements.downloadSpeed.textContent = "完了";
      this.elements.next.disabled = false;
      this.#updateHighlights("download");
      this.elements.next.focus({ preventScroll: true });
    } catch (error) {
      if (error?.name === "AbortError") {
        this.elements.downloadStatus.textContent = "ダウンロードを中止しました。進行中の通信も停止しました。";
        this.elements.downloadSpeed.textContent = "中止";
      } else {
        this.elements.downloadStatus.textContent = `ダウンロードに失敗しました: ${error instanceof Error ? error.message : String(error)}`;
      }
    } finally {
      this.downloadProgressUnsubscribe?.();
      this.downloadProgressUnsubscribe = null;
      this.downloadTask = null;
      this.downloadAbortController = null;
      this.downloadRunning = false;
      this.elements.back.disabled = this.stepIndex === 0;
      if (!this.downloadCompleted) {
        this.elements.downloadButton.disabled = false;
        this.elements.downloadButton.textContent = "音声データをダウンロード";
        this.elements.downloadButton.classList.remove("tutorial-download-cancel");
      }
    }
  }

  async #cancelVoiceDownload() {
    const controller = this.downloadAbortController;
    const task = this.downloadTask;
    if (!controller || controller.signal.aborted) return;
    this.elements.downloadButton.disabled = true;
    this.elements.downloadButton.textContent = "中止しています…";
    controller.abort(new DOMException("Download cancelled by user", "AbortError"));
    try {
      await task;
    } catch {
      // The active download path reports the final cancelled state.
    }
  }

  #handleDownloadProgress(message) {
    if (message.stage !== "download") return;
    const loaded = Number(message.loadedBytes || 0);
    const total = Number(message.totalBytes || 0);
    if (total > 0) {
      const percent = Math.max(0, Math.min(100, loaded / total * 100));
      this.elements.downloadProgress.value = percent;
      this.elements.downloadPercent.textContent = `${percent.toFixed(1)}%`;
      this.elements.downloadBytes.textContent = `${this.#formatBytes(loaded)} / ${this.#formatBytes(total)}`;
    }

    const now = performance.now();
    if (message.phase === "downloading") {
      if (this.downloadProgressLast && loaded >= this.downloadProgressLast.loaded) {
        const elapsedSeconds = (now - this.downloadProgressLast.at) / 1000;
        const deltaBytes = loaded - this.downloadProgressLast.loaded;
        if (elapsedSeconds >= 0.08 && deltaBytes > 0) {
          const megabytesPerSecond = deltaBytes / elapsedSeconds / 1_000_000;
          this.elements.downloadSpeed.textContent = `${megabytesPerSecond.toFixed(1)} MB/s`;
        }
      } else {
        this.elements.downloadSpeed.textContent = "計測中…";
      }
      this.downloadProgressLast = { loaded, at: now };
      this.elements.downloadStatus.textContent = "ダウンロード中です。";
      return;
    }

    this.downloadProgressLast = null;
    if (message.phase === "verifying-cache") {
      this.elements.downloadSpeed.textContent = "キャッシュ確認中";
      this.elements.downloadStatus.textContent = "保存済みデータを確認しています。";
    } else if (message.phase === "verified-cache") {
      this.elements.downloadSpeed.textContent = "キャッシュ済み";
      this.elements.downloadStatus.textContent = "しばらくお待ちください。動作中です。";
    } else if (message.phase === "verified") {
      this.elements.downloadStatus.textContent = "検証中です。";
    }
  }

  #formatBytes(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`;
    if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${Math.round(value)} B`;
  }

  async #runLinebreakDemo() {
    if (this.demoRunning) return;
    this.demoRunning = true;
    const runToken = ++this.demoRunToken;
    this.elements.linebreakDemo.disabled = true;
    this.elements.back.disabled = true;
    this.elements.next.disabled = true;

    const composer = this.elements.composer;
    this.#rememberComposer();
    const text = this.#pickDemoText();
    composer.classList.add("tutorial-target", "tutorial-demo-active");
    this.elements.demoStatus.textContent = "文字を少しずつ入力してみます。";

    try {
      await this.#beginTemporaryWait();
      this.#moveCaretToEnd();
      if (composer.value && !composer.value.endsWith("\n")) {
        composer.setRangeText("\n", composer.selectionStart, composer.selectionEnd, "end");
      }
      if (!await this.#typeText(text, runToken)) return;

      if (runToken !== this.demoRunToken) return;
      this.elements.demoStatus.textContent = "入力できました。ここで改行します。";
      await this.#sleep(260);
      if (runToken !== this.demoRunToken) return;

      const beforePending = this.app?.currentPendingCount ?? 0;
      this.#insertLineBreakAtCaret();
      if (!await this.#waitForPendingIncrease(beforePending, runToken)) return;
      this.elements.demoStatus.textContent = "読み上げ待ちに入りました。";

      await this.#sleep(420);
      if (runToken !== this.demoRunToken) return;
      await this.#pressRealButton(this.elements.forceSpeakButton, runToken);
      if (!await this.#waitForPendingDecrease(beforePending + 1, runToken)) return;
      if (!await this.#waitForHistoryText(text, runToken)) return;
      this.elements.demoStatus.textContent = "本物の読み上げ履歴に追加されました。3行を超えると、いちばん古い行は入力欄から消えます。もう一度試せます。";
    } finally {
      await this.#restoreTemporaryWait();
      if (runToken === this.demoRunToken) {
        this.demoRunning = false;
        this.elements.linebreakDemo.disabled = false;
        this.elements.back.disabled = this.stepIndex === 0;
        this.elements.next.disabled = false;
      }
    }
  }

  async #runCorrectionDemo() {
    if (this.demoRunning) return;
    this.demoRunning = true;
    const runToken = ++this.demoRunToken;
    this.elements.correctionDemo.disabled = true;
    this.elements.back.disabled = true;
    this.elements.next.disabled = true;
    this.#rememberComposer();

    try {
      await this.#beginTemporaryWait();
      while ((this.app?.currentPendingCount ?? 0) > 0) {
        if (!await this.app?.cancelLatestPending?.()) break;
      }

      const currentLines = this.elements.composer.value
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-2);
      const first = currentLines[0] ?? this.#pickDemoText();
      let second = currentLines[1] ?? this.#pickDemoText();
      if (second === first) second = DEMO_TEXTS.find((text) => text !== first) ?? DEMO_TEXTS[0];
      if (!await this.#seedCorrectionPendingPair(first, second, runToken)) return;

      const correction = this.#pickCorrectionText(first);
      this.elements.correctionStatus.textContent = "1行目の差分だけを、1文字ずつ直しています。";
      if (!await this.#replaceFirstSubmittedLine(correction, runToken)) return;

      this.elements.correctionStatus.textContent = "1行目を直した状態で、実際の「現在の文章で訂正する」を押します。";
      await this.#pressRealButton(this.elements.correctionButton, runToken);
      if (!await this.#waitForAnyPendingText(correction, runToken)) return;
      this.elements.correctionStatus.textContent = "1行目だけ訂正されました。本物の読み上げ待ちをそのまま訂正しています。";
    } finally {
      await this.#restoreTemporaryWait();
      if (runToken === this.demoRunToken) {
        this.demoRunning = false;
        this.elements.correctionDemo.disabled = false;
        this.elements.back.disabled = this.stepIndex === 0;
        this.elements.next.disabled = false;
      }
    }
  }

  async #prepareCancelExample() {
    if (this.cancelExamplePreparing || this.demoRunning) return;
    if (this.app?.latestPendingText === CANCEL_DEMO_TEXT) return;
    this.cancelExamplePreparing = true;
    this.demoRunning = true;
    const runToken = ++this.demoRunToken;
    this.elements.cancelDemo.disabled = true;
    this.elements.back.disabled = true;
    this.elements.next.disabled = true;
    this.#rememberComposer();

    try {
      await this.#beginTemporaryWait();
      await this.app?.cancelLatestPending?.();
      const composer = this.elements.composer;
      this.#moveCaretToEnd();
      if (composer.value && !composer.value.endsWith("\n")) {
        composer.setRangeText("\n", composer.selectionStart, composer.selectionEnd, "end");
      }
      this.elements.cancelStatus.textContent = "取り消すための文章を、1文字ずつ入力しています。";
      if (!await this.#typeText(CANCEL_DEMO_TEXT, runToken)) return;
      const beforePending = this.app?.currentPendingCount ?? 0;
      this.#insertLineBreakAtCaret();
      if (!await this.#waitForPendingIncrease(beforePending, runToken)) return;
      this.#updateHighlights("cancel");
      this.elements.cancelStatus.textContent = "読み上げ待ちに入りました。オレンジで囲まれた「取り消す」を見てください。";
    } finally {
      await this.#restoreTemporaryWait();
      if (runToken === this.demoRunToken) {
        this.demoRunning = false;
        this.cancelExamplePreparing = false;
        this.elements.cancelDemo.disabled = false;
        this.elements.back.disabled = this.stepIndex === 0;
        this.elements.next.disabled = false;
      }
    }
  }

  async #runCancelDemo() {
    if (this.demoRunning) return;
    if ((this.app?.currentPendingCount ?? 0) === 0) await this.#prepareCancelExample();
    if ((this.app?.currentPendingCount ?? 0) === 0) return;
    this.demoRunning = true;
    const runToken = ++this.demoRunToken;
    this.elements.cancelDemo.disabled = true;
    this.elements.back.disabled = true;
    this.elements.next.disabled = true;
    const beforePending = this.app?.currentPendingCount ?? 0;
    try {
      this.elements.cancelStatus.textContent = "「取り消す」を押します。";
      await this.#pressRealButton(this.elements.cancelCurrentButton, runToken);
      if (!await this.#waitForPendingDecrease(beforePending, runToken)) return;
      this.elements.cancelStatus.textContent = "取り消しました。読み上げ待ちから文章が消えました。";
    } finally {
      if (runToken === this.demoRunToken) {
        this.demoRunning = false;
        this.elements.cancelDemo.disabled = false;
        this.elements.back.disabled = this.stepIndex === 0;
        this.elements.next.disabled = false;
      }
    }
  }



  #pickDemoText() {
    const candidates = DEMO_TEXTS.filter((text) => text !== this.lastDemoText);
    const text = candidates[Math.floor(Math.random() * candidates.length)] ?? DEMO_TEXTS[0];
    this.lastDemoText = text;
    return text;
  }

  #pickCorrectionText(current) {
    const candidates = CORRECTION_TEXTS.filter((text) => text !== current && text !== this.lastCorrectionText);
    const text = candidates[Math.floor(Math.random() * candidates.length)] ?? CORRECTION_TEXTS[0];
    this.lastCorrectionText = text;
    return text;
  }

  #moveCaretToEnd() {
    const composer = this.elements.composer;
    composer.focus({ preventScroll: true });
    composer.setSelectionRange(composer.value.length, composer.value.length);
  }

  #createInputEvent(type, inputType, data = null) {
    const view = this.document.defaultView ?? globalThis;
    try {
      return new view.InputEvent(type, {
        bubbles: true,
        cancelable: type === "beforeinput",
        inputType,
        data,
      });
    } catch {
      const event = new view.Event(type, { bubbles: true, cancelable: type === "beforeinput" });
      Object.defineProperty(event, "inputType", { value: inputType });
      Object.defineProperty(event, "data", { value: data });
      return event;
    }
  }

  #insertTextAtCaret(text) {
    const composer = this.elements.composer;
    const before = this.#createInputEvent("beforeinput", "insertText", text);
    if (!composer.dispatchEvent(before)) return false;
    composer.setRangeText(text, composer.selectionStart, composer.selectionEnd, "end");
    composer.dispatchEvent(this.#createInputEvent("input", "insertText", text));
    return true;
  }

  #deleteBeforeCaret() {
    const composer = this.elements.composer;
    const start = composer.selectionStart;
    const end = composer.selectionEnd;
    if (start == null || end == null || (start === 0 && end === 0)) return false;
    const before = this.#createInputEvent("beforeinput", "deleteContentBackward");
    if (!composer.dispatchEvent(before)) return false;
    if (start !== end) composer.setRangeText("", start, end, "end");
    else composer.setRangeText("", start - 1, start, "end");
    composer.dispatchEvent(this.#createInputEvent("input", "deleteContentBackward"));
    return true;
  }

  #insertLineBreakAtCaret() {
    const composer = this.elements.composer;
    const before = this.#createInputEvent("beforeinput", "insertLineBreak");
    if (!composer.dispatchEvent(before)) return false;
    composer.setRangeText("\n", composer.selectionStart, composer.selectionEnd, "end");
    composer.dispatchEvent(this.#createInputEvent("input", "insertLineBreak"));
    return true;
  }

  async #typeText(text, runToken, delay = 38) {
    for (const character of [...text]) {
      if (runToken !== this.demoRunToken) return false;
      if (!this.#insertTextAtCaret(character)) return false;
      await this.#sleep(delay);
    }
    return runToken === this.demoRunToken;
  }

  async #waitFor(predicate, runToken, timeoutMs = 2500) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (runToken !== this.demoRunToken) return false;
      if (predicate()) return true;
      await this.#sleep(40);
    }
    return false;
  }

  #waitForPendingIncrease(previousCount, runToken) {
    return this.#waitFor(() => (this.app?.currentPendingCount ?? 0) > previousCount, runToken);
  }

  #waitForPendingDecrease(previousCount, runToken) {
    return this.#waitFor(() => (this.app?.currentPendingCount ?? 0) < previousCount, runToken);
  }

  #waitForPendingText(text, runToken) {
    return this.#waitFor(() => this.app?.latestPendingText === text, runToken);
  }

  #waitForHistoryText(text, runToken, timeoutMs = 2500) {
    return this.#waitFor(
      () => [...this.elements.messageList.querySelectorAll(".message-text")].some((node) => node.textContent === text),
      runToken,
      timeoutMs
    );
  }

  #waitForAnyPendingText(text, runToken) {
    return this.#waitFor(
      () => [...this.elements.pendingList.querySelectorAll(".pending-text")]
        .some((node) => node.textContent === text),
      runToken
    );
  }

  async #seedCorrectionPendingPair(first, second, runToken) {
    const composer = this.elements.composer;
    composer.focus({ preventScroll: true });
    if (composer.value.length > 0) {
      composer.setSelectionRange(0, composer.value.length);
      if (!this.#deleteBeforeCaret()) return false;
    }

    this.elements.correctionStatus.textContent = "まず、訂正前の2行を読み上げ待ちへ送ります。";
    if (!await this.#typeText(first, runToken, 22)) return false;
    let beforePending = this.app?.currentPendingCount ?? 0;
    if (!this.#insertLineBreakAtCaret()) return false;
    if (!await this.#waitForPendingIncrease(beforePending, runToken)) return false;

    if (!await this.#typeText(second, runToken, 22)) return false;
    beforePending = this.app?.currentPendingCount ?? 0;
    if (!this.#insertLineBreakAtCaret()) return false;
    if (!await this.#waitForPendingIncrease(beforePending, runToken)) return false;
    return runToken === this.demoRunToken;
  }

  #lastSubmittedLineRange() {
    const value = this.elements.composer.value;
    let end = value.length;
    while (end > 0 && value[end - 1] === "\n") end -= 1;
    const start = value.lastIndexOf("\n", Math.max(0, end - 1)) + 1;
    return { start, end, text: value.slice(start, end) };
  }

  #lastSubmittedLine() {
    return this.#lastSubmittedLineRange().text;
  }

  #firstSubmittedLineRange() {
    const value = this.elements.composer.value;
    let start = 0;
    while (start < value.length && value[start] === "\n") start += 1;
    const newline = value.indexOf("\n", start);
    const end = newline === -1 ? value.length : newline;
    return { start, end, text: value.slice(start, end) };
  }

  async #replaceFirstSubmittedLine(nextText, runToken) {
    const composer = this.elements.composer;
    const range = this.#firstSubmittedLineRange();
    let prefixLength = 0;
    while (
      prefixLength < range.text.length
      && prefixLength < nextText.length
      && range.text[prefixLength] === nextText[prefixLength]
    ) prefixLength += 1;

    composer.focus({ preventScroll: true });
    composer.setSelectionRange(range.end, range.end);
    for (let index = range.text.length; index > prefixLength; index -= 1) {
      if (runToken !== this.demoRunToken) return false;
      if (!this.#deleteBeforeCaret()) return false;
      await this.#sleep(34);
    }
    return this.#typeText(nextText.slice(prefixLength), runToken, 34);
  }

  async #replaceLastSubmittedLine(nextText, runToken) {
    const composer = this.elements.composer;
    const range = this.#lastSubmittedLineRange();
    let prefixLength = 0;
    while (
      prefixLength < range.text.length
      && prefixLength < nextText.length
      && range.text[prefixLength] === nextText[prefixLength]
    ) prefixLength += 1;

    composer.focus({ preventScroll: true });
    composer.setSelectionRange(range.end, range.end);
    for (let index = range.text.length; index > prefixLength; index -= 1) {
      if (runToken !== this.demoRunToken) return false;
      if (!this.#deleteBeforeCaret()) return false;
      await this.#sleep(34);
    }
    return this.#typeText(nextText.slice(prefixLength), runToken, 34);
  }

  async #pressRealButton(button, runToken) {
    if (runToken !== this.demoRunToken || button.disabled) return false;
    button.classList.add("tutorial-demo-press");
    button.focus({ preventScroll: true });
    await this.#sleep(120);
    if (runToken !== this.demoRunToken) return false;
    button.click();
    await this.#sleep(220);
    button.classList.remove("tutorial-demo-press");
    return runToken === this.demoRunToken;
  }

  #sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async #beginTemporaryWait(seconds = 30) {
    if (this.temporaryWaitOriginal == null) {
      this.temporaryWaitOriginal = Number(this.app?.getReasoningSeconds?.() ?? 2);
    }
    await this.app?.setReasoningSeconds?.(seconds);
  }

  async #restoreTemporaryWait() {
    if (this.temporaryWaitOriginal == null) return;
    const value = this.temporaryWaitOriginal;
    this.temporaryWaitOriginal = null;
    await this.app?.setReasoningSeconds?.(value);
  }

  #rememberComposer() {
    if (this.demoSnapshot) return;
    const composer = this.elements.composer;
    this.demoSnapshot = {
      value: composer.value,
      start: composer.selectionStart,
      end: composer.selectionEnd,
    };
  }

  #cleanupDemo() {
    this.demoRunToken += 1;
    this.demoRunning = false;
    this.elements.linebreakDemo.disabled = false;
    this.elements.correctionDemo.disabled = false;
    this.elements.waitDemo.disabled = false;
    this.elements.cancelDemo.disabled = false;
    this.cancelExamplePreparing = false;
    void this.#restoreTemporaryWait();
    if (this.demoSnapshot) {
      const composer = this.elements.composer;
      composer.value = this.demoSnapshot.value;
      composer.setSelectionRange(this.demoSnapshot.start, this.demoSnapshot.end);
      this.demoSnapshot = null;
    }
    for (const target of this.document.querySelectorAll(".tutorial-target, .tutorial-demo-active")) {
      target.classList.remove("tutorial-target", "tutorial-demo-active");
    }
    this.elements.demoStatus.textContent = "音声はまだ読み込みません。何度でも試せます。";
    this.elements.correctionStatus.textContent = "例文を1文字ずつ直して、実際の訂正ボタンを押します。";
    this.elements.waitStatus.textContent = "ここで変えた値は、そのまま本体の設定にも反映されます。";
    this.elements.cancelStatus.textContent = "まず、取り消すための文章を送ります。";
  }


  #updateHighlights(step) {
    for (const target of this.document.querySelectorAll(".tutorial-target")) target.classList.remove("tutorial-target");
    let primaryTarget = null;
    if (step === "linebreak") {
      this.elements.composer.classList.add("tutorial-target");
      primaryTarget = this.elements.composer;
    }

    if (step === "correction") {
      this.elements.correctionButton.classList.add("tutorial-target");
      primaryTarget = this.elements.correctionButton;
    }
    if (step === "wait") {
      this.elements.reasoningSeconds.classList.add("tutorial-target");
      primaryTarget = this.elements.reasoningSeconds;
    }
    if (step === "cancel") {
      this.elements.cancelCurrentButton.classList.add("tutorial-target");
      primaryTarget = this.elements.cancelCurrentButton;
    }
    if (step === "conversations") {
      if (!this.conversationTutorialCompleted) {
        const conversationPanelVisible = !this.elements.conversationPanel.hidden;
        const target = conversationPanelVisible ? this.elements.composer : this.elements.conversationView;
        target.classList.add("tutorial-target");
        primaryTarget = target;
      }
    }
    if (step === "conversation-open" && !this.conversationOpenCompleted) {
      const conversationPanelVisible = !this.elements.conversationPanel.hidden;
      const target = conversationPanelVisible ? this.elements.conversationList : this.elements.conversationView;
      target.classList.add("tutorial-target");
      primaryTarget = target;
    }
    if (step === "free") {
      this.elements.next.classList.add("tutorial-target");
      primaryTarget = null;
    }
    if (step === "download" && !this.downloadCompleted) {
      if (!this.downloadAcknowledged) {
        this.elements.downloadAck.classList.add("tutorial-target");
        primaryTarget = this.elements.downloadAck;
      } else {
        this.elements.downloadButton.classList.add("tutorial-target");
        primaryTarget = this.elements.downloadButton;
      }
    }
    if (step === "source-update" && !this.sourceUpdateAcknowledged) {
      this.elements.sourceUpdateAck.classList.add("tutorial-target");
      primaryTarget = this.elements.sourceUpdateAck;
    }
    this.targetArrowTarget = primaryTarget;
    requestAnimationFrame(() => this.#refreshTargetArrow());
  }

  #refreshTargetArrow() {
    const arrow = this.elements.targetArrow;
    const target = this.targetArrowTarget;
    this.#refreshOffscreenHand(target ?? this.document.querySelector(".tutorial-target"));
    if (!target || !target.isConnected || this.elements.overlay.hidden) {
      arrow.hidden = true;
      return;
    }

    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom < 0 || rect.top > globalThis.innerHeight) {
      arrow.hidden = true;
      return;
    }

    // Position the whole "<" arrow-head box beside the target. The head is
    // 38x38px at (16, 11) inside the 112x210 arrow shape.
    const arrowHeadLeft = 16;
    const arrowHeadTop = 11;
    const arrowHeadHeight = 38;
    const headGap = 8;
    const desiredX = rect.right + headGap - arrowHeadLeft;
    const desiredY = rect.top + rect.height / 2 - arrowHeadTop - arrowHeadHeight / 2;
    const viewportWidth = globalThis.innerWidth || this.document.documentElement.clientWidth;
    const viewportHeight = globalThis.innerHeight || this.document.documentElement.clientHeight;
    const x = Math.max(8, Math.min(viewportWidth - 112, desiredX));
    const y = Math.max(8, Math.min(viewportHeight - 210, desiredY));
    arrow.style.setProperty("--tutorial-target-arrow-x", `${Math.round(x)}px`);
    arrow.style.setProperty("--tutorial-target-arrow-y", `${Math.round(y)}px`);
    arrow.hidden = false;
  }

  #refreshOffscreenHand(target) {
    if (
      !target ||
      !target.isConnected ||
      this.elements.overlay.hidden ||
      !this.elements.overlay.classList.contains("tutorial-live")
    ) {
      this.offscreenHand?.remove();
      this.offscreenHand = null;
      return;
    }
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      this.offscreenHand?.remove();
      this.offscreenHand = null;
      return;
    }
    const viewportWidth = globalThis.innerWidth || this.document.documentElement.clientWidth;
    const viewportHeight = globalThis.innerHeight || this.document.documentElement.clientHeight;
    const overflow = {
      up: Math.max(0, -rect.bottom),
      down: Math.max(0, rect.top - viewportHeight),
      left: Math.max(0, -rect.right),
      right: Math.max(0, rect.left - viewportWidth),
    };
    const [direction, distance] = Object.entries(overflow).sort((a, b) => b[1] - a[1])[0];
    if (distance <= 0) {
      this.offscreenHand?.remove();
      this.offscreenHand = null;
      return;
    }
    let hand = this.offscreenHand;
    if (!hand) {
      hand = this.elements.scrollHand.cloneNode(true);
      hand.classList.add("tutorial-offscreen-hand");
      hand.querySelector("defs")?.remove();
      this.document.body.append(hand);
      this.offscreenHand = hand;
    }
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const margin = 18;
    const edgeInset = 72;
    const handWidth = 48;
    const handHeight = 62;
    const positions = {
      up: [Math.max(margin, Math.min(viewportWidth - handWidth - margin, centerX - handWidth / 2)), edgeInset, 0, 84],
      down: [Math.max(margin, Math.min(viewportWidth - handWidth - margin, centerX - handWidth / 2)), viewportHeight - handHeight - edgeInset, 0, -84],
      left: [edgeInset, Math.max(margin, Math.min(viewportHeight - handHeight - margin, centerY - handHeight / 2)), -84, 0],
      right: [viewportWidth - handWidth - edgeInset, Math.max(margin, Math.min(viewportHeight - handHeight - margin, centerY - handHeight / 2)), 84, 0],
    };
    const [x, y, dx, dy] = positions[direction];
    hand.style.setProperty("--tutorial-offscreen-hand-x", `${Math.round(x)}px`);
    hand.style.setProperty("--tutorial-offscreen-hand-y", `${Math.round(y)}px`);
    hand.style.setProperty("--tutorial-offscreen-hand-dx", `${dx}px`);
    hand.style.setProperty("--tutorial-offscreen-hand-dy", `${dy}px`);
  }

  #resolveElements() {
    const byId = (id) => {
      const element = this.document.getElementById(id);
      if (!element) throw new Error(`Required tutorial element is missing: ${id}`);
      return element;
    };
    const overlay = byId("tutorial-overlay");
    return {
      overlay,
      focusAnchor: byId("tutorial-focus-anchor"),
      shell: overlay.querySelector(".tutorial-shell"),
      headerBrand: overlay.querySelector(".tutorial-header-brand"),
      minimize: byId("tutorial-minimize"),
      expand: byId("tutorial-expand"),
      dragHandle: byId("tutorial-drag-handle"),
      scrollHand: overlay.querySelector(".tutorial-scroll-hand"),
      pages: [...overlay.querySelectorAll("[data-tutorial-step]")],
      summaryJumpButtons: [...overlay.querySelectorAll("[data-tutorial-jump]")],
      pagesContainer: overlay.querySelector(".tutorial-pages"),
      progress: byId("tutorial-progress"),
      runtimeStatus: byId("tutorial-runtime-status"),
      back: byId("tutorial-back"),
      next: byId("tutorial-next"),
      linebreakDemo: byId("tutorial-linebreak-demo"),
      correctionDemo: byId("tutorial-correction-demo"),
      waitDemo: byId("tutorial-wait-demo"),
      cancelDemo: byId("tutorial-cancel-demo"),
      conversationStatus: byId("tutorial-conversation-status"),
      conversationRepeat: byId("tutorial-conversation-repeat"),
      conversationOpenStatus: byId("tutorial-conversation-open-status"),
      freeStatus: byId("tutorial-free-status"),
      sampleButtons: [...this.document.querySelectorAll("[data-tutorial-sample]")],
      sampleStatus: byId("tutorial-sample-status"),
      downloadSize: byId("tutorial-download-size"),
      sourceUpdateSize: byId("tutorial-source-update-size"),
      sourceUpdateAck: byId("tutorial-source-update-ack"),
      sourceUpdateProgress: byId("tutorial-source-update-progress"),
      sourceUpdatePercent: byId("tutorial-source-update-percent"),
      sourceUpdateBytes: byId("tutorial-source-update-bytes"),
      sourceUpdateSpeed: byId("tutorial-source-update-speed"),
      sourceUpdateStatus: byId("tutorial-source-update-status"),
      downloadAck: byId("tutorial-download-ack"),
      downloadButton: byId("tutorial-download-button"),
      downloadProgress: byId("tutorial-download-progress"),
      downloadPercent: byId("tutorial-download-percent"),
      downloadBytes: byId("tutorial-download-bytes"),
      downloadSpeed: byId("tutorial-download-speed"),
      downloadStatus: byId("tutorial-download-status"),
      modelLoadPrimaryValue: byId("tutorial-model-load-primary-value"),
      modelLoadPrimaryCells: byId("tutorial-model-load-primary-cells"),
      modelLoadSecondaryValue: byId("tutorial-model-load-secondary-value"),
      modelLoadSecondaryCells: byId("tutorial-model-load-secondary-cells"),
      modelLoadStatus: byId("tutorial-model-load-status"),
      modelLoadReplayAfterLoad: byId("tutorial-model-load-replay-after-load"),
      demoStatus: byId("tutorial-demo-status"),
      correctionStatus: byId("tutorial-correction-status"),
      waitSeconds: byId("tutorial-reasoning-seconds"),
      waitStatus: byId("tutorial-wait-status"),
      deviceSynthesisCopy: byId("tutorial-device-synthesis-copy"),
      cancelStatus: byId("tutorial-cancel-status"),
      composer: byId("composer"),
      correctionButton: byId("correction-button"),
      forceSpeakButton: byId("force-speak-button"),
      reasoningSeconds: byId("reasoning-seconds"),
      cancelCurrentButton: byId("cancel-current-button"),
      timelineView: byId("timeline-view"),
      conversationView: byId("conversation-view"),
      conversationPanel: byId("conversation-panel"),
      conversationList: byId("conversation-list"),
      pendingList: byId("pending-list"),
      messageList: byId("message-list"),
      targetArrow: byId("tutorial-target-arrow"),
    };
  }
}
