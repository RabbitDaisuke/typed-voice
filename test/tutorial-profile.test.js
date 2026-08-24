import test from "node:test";
import assert from "node:assert/strict";
import { createTutorialProfileDefinition, resolveStartupTutorialProfile } from "../src/app/tutorial.js";

test("同じtutorial stepを別visitとして何度でもrouteに置ける", () => {
  const profile = createTutorialProfileDefinition("repeat", {
    route: [
      { step: "model-load", id: "first-load", nextLabel: "次へ" },
      { step: "scroll", id: "middle" },
      { step: "model-load", id: "second-load", backLabel: "戻る" },
    ],
    completeTo: "end",
  }, ["model-load", "scroll"]);

  assert.deepEqual(profile.route.map((visit) => visit.stepId), ["model-load", "scroll", "model-load"]);
  assert.deepEqual(profile.route.map((visit) => visit.visitId), ["first-load", "middle", "second-load"]);
  assert.equal(profile.route[0].nextLabel, "次へ");
  assert.equal(profile.route[2].backLabel, "戻る");
  assert.equal(Object.isFrozen(profile), true);
  assert.equal(Object.isFrozen(profile.route), true);
  assert.equal(Object.isFrozen(profile.route[0]), true);
});

test("visit IDだけはroute内で一意でなければならない", () => {
  assert.throws(() => createTutorialProfileDefinition("duplicate-visit", {
    route: [
      { step: "model-load", id: "same" },
      { step: "scroll", id: "same" },
    ],
    completeTo: "end",
  }, ["model-load", "scroll"]), /Duplicate tutorial route visit ID/);
});

test("文字列routeのstep重複にも自動で別visit IDを割り当てる", () => {
  const profile = createTutorialProfileDefinition("automatic-visits", {
    route: ["model-load", "scroll", "model-load"],
    completeTo: "end",
  }, ["model-load", "scroll"]);

  assert.deepEqual(profile.route.map((visit) => visit.visitId), [
    "model-load@0",
    "scroll@1",
    "model-load@2",
  ]);
});

test("terminal profileは画面routeを持たない", () => {
  const profile = createTutorialProfileDefinition("end", { terminal: true }, ["model-load"]);
  assert.equal(profile.terminal, true);
  assert.deepEqual(profile.route, []);
});

test("terminal profileには処理を登録できない", () => {
  assert.throws(() => createTutorialProfileDefinition("bad-end", {
    terminal: true,
    onClose() {},
  }, ["model-load"]), /Terminal tutorial profile must not define onClose/);
});

test("初回チュートリアル中のソース更新はチュートリアル内のダウンロードにまとめる", () => {
  assert.equal(resolveStartupTutorialProfile({ tutorialComplete: false, selectedModelCached: false, sourceUpdateAvailable: true }), "full");
  assert.equal(resolveStartupTutorialProfile({ tutorialComplete: false, selectedModelCached: true, sourceUpdateAvailable: true }), "full");
  assert.equal(resolveStartupTutorialProfile({ tutorialComplete: true, selectedModelCached: false, sourceUpdateAvailable: true }), "source-update");
  assert.equal(resolveStartupTutorialProfile({ tutorialComplete: true, selectedModelCached: true, sourceUpdateAvailable: true }), "source-update");
  assert.equal(resolveStartupTutorialProfile({ tutorialComplete: true, selectedModelCached: false, sourceFetchBytes: 1 }), "source-update");
  assert.equal(resolveStartupTutorialProfile({ tutorialComplete: true, selectedModelCached: true, sourceFetchBytes: 1 }), "source-update");
  assert.equal(resolveStartupTutorialProfile({ tutorialComplete: true, selectedModelCached: true, offlineRuntimePending: true }), "runtime-required");
  assert.equal(resolveStartupTutorialProfile({ tutorialComplete: true, selectedModelCached: false, offlineRuntimePending: true }), "model-picker-required");
  assert.equal(resolveStartupTutorialProfile({ tutorialComplete: true, selectedModelCached: false }), "model-picker-required");
  assert.equal(resolveStartupTutorialProfile({ tutorialComplete: true, selectedModelCached: true }), "end");
});

