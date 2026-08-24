import test from "node:test";
import assert from "node:assert/strict";
import { chooseRevisionTarget, planComposerRevisions } from "../src/app/revision-target.js";

test("現在文と一致するpendingを自動選択する", () => {
  const pending = [
    { id: "old", text: "税関関税許可局", createdAt: 1 },
    { id: "new", text: "WebAssemblyをLLMでVibe Coding中", createdAt: 2 },
  ];
  assert.equal(chooseRevisionTarget("税関関税許可局", pending)?.id, "old");
});

test("本文を部分訂正しても直近2件から最も近いpendingを選択する", () => {
  const pending = [
    { id: "old", text: "税関関税許可局、関税許可を急遽却下", createdAt: 1 },
    { id: "new", text: "WebAssemblyをLLMでVibe Coding中", createdAt: 2 },
  ];
  assert.equal(chooseRevisionTarget("税関関税許可局、関税許可を急きょ却下", pending)?.id, "old");
});

test("修正対象外のpendingは自動選択しない", () => {
  const pending = [
    { id: "old", text: "古い文章", createdAt: 1 },
    { id: "new", text: "新しい文章", createdAt: 2 },
  ];
  assert.equal(chooseRevisionTarget("古い文章", pending, (id) => id === "new")?.id, "new");
});

test("2行表示はカーソル位置を使わず全体比較で変更行だけ訂正する", () => {
  const pending = [
    { id: "first", text: "税関関税許可局", createdAt: 1 },
    { id: "second", text: "WebAssemblyをLLMでVibe Coding中", createdAt: 2 },
  ];
  const revisions = planComposerRevisions(
    "税関関税許可局\nWebAssemblyをLLMでVibeコーディング中",
    pending
  );
  assert.deepEqual(revisions.map((item) => [item.pending.id, item.text]), [
    ["second", "WebAssemblyをLLMでVibeコーディング中"],
  ]);
});

test("2行とも変更されていれば2件とも訂正する", () => {
  const pending = [
    { id: "first", text: "一件目", createdAt: 1 },
    { id: "second", text: "二件目", createdAt: 2 },
  ];
  const revisions = planComposerRevisions("一件目修正\n二件目修正", pending);
  assert.deepEqual(revisions.map((item) => item.pending.id), ["first", "second"]);
});

test("pendingが1件の2行表示は現在入力中の2行目ではなく1行目で訂正する", () => {
  const pending = [{ id: "only", text: "訂正前", createdAt: 1 }];
  const revisions = planComposerRevisions("訂正後\n次の入力", pending);
  assert.deepEqual(revisions.map((item) => [item.pending.id, item.text]), [["only", "訂正後"]]);
});

test("pendingが1件の3行表示は現在入力中の3行目ではなく2行目で訂正する", () => {
  const pending = [{ id: "only", text: "二行目の訂正前", createdAt: 2 }];
  const revisions = planComposerRevisions("一行目\n二行目の訂正後\n次の入力", pending);
  assert.deepEqual(revisions.map((item) => [item.pending.id, item.text]), [["only", "二行目の訂正後"]]);
});

test("pendingが1件の1行表示は1行目で訂正する", () => {
  const pending = [{ id: "only", text: "訂正前", createdAt: 1 }];
  const revisions = planComposerRevisions("訂正後", pending);
  assert.deepEqual(revisions.map((item) => [item.pending.id, item.text]), [["only", "訂正後"]]);
});
