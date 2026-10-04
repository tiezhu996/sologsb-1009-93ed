import assert from "node:assert/strict";
import {
  applyReceipt,
  blocksAffectedByTerm,
  completeBatchIfReady,
  hasPendingConflicts,
  invalidateChecksForTerm,
  locateBlock,
  parseReceipt,
  pendingConflictsForBlock,
  ReceiptValidationError,
  resolveConflict,
  type ReconProject,
  type ReconcileStore,
  type StructuredReceipt,
} from "../src/scripts/reconcile.ts";

declare const process: { exitCode?: number };

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

function makeProject(): ReconProject {
  return {
    id: "proj-1",
    blocks: [
      {
        id: "b-h1",
        type: "heading",
        headingLevel: 1,
        text: "水循环",
        accessibleText: "水循环",
        changeReason: "",
        reviewStatus: "approved",
        comments: [],
      },
      {
        id: "b-p1",
        type: "paragraph",
        text: "水会蒸发并形成降水，地表径流最终回到海洋，因此城市建设必须考虑这些循环环节。",
        accessibleText: "水会蒸发，然后变成降水。水沿地面流动，最后回到海里。",
        changeReason: "拆成短句",
        reviewStatus: "pending",
        comments: [
          { id: "c1", author: "本地编辑", body: "已有批注", createdAt: "2026-10-01T00:00:00.000Z", resolved: false, replies: [] },
        ],
      },
      {
        id: "b-img",
        type: "image",
        text: "图1",
        accessibleText: "",
        imageAlt: "",
        changeReason: "",
        reviewStatus: "needs-work",
        comments: [],
      },
      {
        id: "b-p2",
        type: "paragraph",
        text: "雨水花园减轻排水管道压力并补给地下水。",
        accessibleText: "雨水花园能减轻排水管的压力，还能补充地下水。",
        changeReason: "",
        reviewStatus: "pending",
        comments: [],
      },
    ],
    glossary: [
      { id: "t1", source: "地表径流", preferred: "沿地面流动的水", note: "" },
    ],
  };
}

function makeStore(): ReconcileStore {
  return { project: makeProject(), pendingConflicts: [], mergeBatches: [], };
}

function receipt(partial: Partial<StructuredReceipt> = {}): StructuredReceipt {
  return {
    receiptId: "R-1",
    school: "测试学校",
    issuedAt: "2026-10-04T00:00:00.000Z",
    annotations: [],
    ...partial,
  };
}

const fixedNow = () => "2026-10-04T10:00:00.000Z";

/* ------------------------- 解析校验 ------------------------- */

test("parseReceipt 拒绝非法 JSON 与缺少标识的回执", () => {
  assert.throws(() => parseReceipt("not json"), ReceiptValidationError);
  assert.throws(() => parseReceipt(JSON.stringify({})), /receiptId/);
  assert.throws(() => parseReceipt(JSON.stringify({ receiptId: "R", annotations: [{}] })), /annotationId/);
  const ok = parseReceipt(JSON.stringify(receipt()));
  assert.equal(ok.receiptId, "R-1");
});

/* ------------------------- 块定位 ------------------------- */

test("块定位优先认块标识", () => {
  const project = makeProject();
  assert.equal(locateBlock(project.blocks, { blockId: "b-p2" }).block?.id, "b-p2");
  assert.equal(locateBlock(project.blocks, { blockId: "b-p2" }).method, "block-id");
});

test("块标识失效后按摘录唯一定位（移动场景）", () => {
  const project = makeProject();
  const result = locateBlock(project.blocks, { blockId: "b-removed", excerpt: "雨水花园减轻排水管道压力" });
  assert.equal(result.block?.id, "b-p2");
  assert.equal(result.method, "excerpt-neighbor");
});

test("摘录命中多块时按邻块消歧（拆分场景）", () => {
  const project = makeProject();
  // “水”在多个块中出现，必须靠邻块定位。
  const result = locateBlock(project.blocks, {
    blockId: "b-moved",
    excerpt: "回到海里",
    nextExcerpt: "图1",
  });
  assert.equal(result.block?.id, "b-p1");
});

test("摘录无法唯一定位时返回未匹配", () => {
  const project = makeProject();
  const result = locateBlock(project.blocks, { blockId: "missing", excerpt: "水" });
  assert.equal(result.block, undefined);
});

/* ------------------------- 自动合入 ------------------------- */

test("仅回执一侧变化：自动合入整改内容（本地=base）", () => {
  const store = makeStore();
  const r = receipt({
    annotations: [{
      annotationId: "a1",
      blockId: "b-img",
      rectification: { changes: { imageAlt: "水在太阳、云和地面之间循环", accessibleText: "水在太阳、云和地面之间循环" } },
    }],
  });
  const report = applyReceipt(store, r, { now: fixedNow });
  assert.equal(report.items[0].outcome, "merged-auto");
  assert.equal(store.project.blocks[2].imageAlt, "水在太阳、云和地面之间循环");
  assert.equal(report.status, "completed");
});

test("本地已包含回执改动时不产生冲突", () => {
  const store = makeStore();
  const r = receipt({
    annotations: [{
      annotationId: "a1",
      blockId: "b-p1",
      rectification: { base: { accessibleText: "旧文本" }, changes: { accessibleText: store.project.blocks[1].accessibleText } },
    }],
  });
  const report = applyReceipt(store, r);
  assert.equal(report.items[0].outcome, "merged-auto");
  assert.deepEqual(report.items[0].fieldsApplied, []);
});

/* ------------------------- 冲突并排待裁 ------------------------- */

test("两边都改过：字段级并排待裁，未裁决前保留本地", () => {
  const store = makeStore();
  const r = receipt({
    annotations: [{
      annotationId: "a2",
      blockId: "b-p1",
      rectification: {
        base: { accessibleText: "拆成短句", changeReason: "拆成短句" },
        changes: { accessibleText: "学校改的版本", changeReason: "学校改的版本" },
      },
    }],
  });
  const report = applyReceipt(store, r, { now: fixedNow });
  assert.equal(report.status, "pending-arbitration");
  assert.equal(report.items[0].outcome, "conflict");
  assert.equal(hasPendingConflicts(store, "b-p1"), true);
  const conflict = store.pendingConflicts[0];
  assert.deepEqual(conflict.conflicts.map((c) => c.field), ["accessibleText"]);
  assert.equal(conflict.local.accessibleText, makeProject().blocks[1].accessibleText);
  assert.equal(conflict.receipt.accessibleText, "学校改的版本");
  // 未裁决：本地内容不变
  assert.equal(store.project.blocks[1].accessibleText, makeProject().blocks[1].accessibleText);
});

test("同一整改中无冲突字段自动合入、冲突字段待裁", () => {
  const store = makeStore();
  const r = receipt({
    annotations: [{
      annotationId: "a3",
      blockId: "b-p1",
      rectification: {
        base: { accessibleText: "拆成短句", changeReason: "拆成短句", reviewStatus: "pending" },
        changes: { accessibleText: "学校改的版本", changeReason: "拆成短句", reviewStatus: "approved" },
      },
    }],
  });
  const report = applyReceipt(store, r);
  assert.equal(report.items[0].outcome, "conflict");
  // reviewStatus 本地未动 → 自动合入；accessibleText 两边都改 → 待裁；changeReason 三方一致跳过
  assert.equal(store.project.blocks[1].reviewStatus, "approved");
  assert.deepEqual(report.items[0].fieldsApplied, ["reviewStatus"]);
});

test("裁决选择回执一侧后写回；选本地则保留本地", () => {
  const store = makeStore();
  const r = receipt({
    annotations: [{
      annotationId: "a4",
      blockId: "b-p1",
      rectification: { base: { accessibleText: "拆成短句" }, changes: { accessibleText: "学校版" } },
    }],
  });
  const report = applyReceipt(store, r, { now: fixedNow });
  const conflictId = report.items[0].conflictId!;
  resolveConflict(store, conflictId, { accessibleText: "receipt" });
  assert.equal(store.project.blocks[1].accessibleText, "学校版");
  assert.equal(hasPendingConflicts(store), false);

  const store2 = makeStore();
  const r2 = receipt({ receiptId: "R-2", annotations: r.annotations });
  const report2 = applyReceipt(store2, r2);
  resolveConflict(store2, report2.items[0].conflictId!, { accessibleText: "local" });
  assert.equal(store2.project.blocks[1].accessibleText, makeProject().blocks[1].accessibleText);
});

test("漏裁字段会被拒绝", () => {
  const store = makeStore();
  const r = receipt({
    annotations: [{
      annotationId: "a5",
      blockId: "b-p1",
      rectification: { base: { accessibleText: "拆成短句" }, changes: { accessibleText: "学校版" } },
    }],
  });
  const report = applyReceipt(store, r);
  assert.throws(() => resolveConflict(store, report.items[0].conflictId!, {}), /尚未裁决/);
});

/* ------------------------- 批注合入与去重 ------------------------- */

test("批注合入并带来源标记", () => {
  const store = makeStore();
  const r = receipt({
    annotations: [{
      annotationId: "a6",
      blockId: "b-p1",
      comment: { author: "学校老师", body: "这句还可以更短" },
    }],
  });
  const report = applyReceipt(store, r);
  assert.equal(report.items[0].outcome, "comment-merged");
  assert.equal(store.project.blocks[1].comments.length, 2);
  assert.equal(store.project.blocks[1].comments[0].receiptAnnotationId, "a6");
});

test("重试整份回执不重复增加批注、术语或批次", () => {
  const store = makeStore();
  const r = receipt({
    annotations: [{
      annotationId: "a7",
      blockId: "b-img",
      comment: { author: "学校老师", body: "补替代文本" },
      rectification: { changes: { imageAlt: "第一版替代文本", accessibleText: "第一版替代文本" } },
    }],
    glossaryChanges: [{ action: "add", source: "海洋", preferred: "大海" }],
  });
  applyReceipt(store, r);
  assert.equal(store.mergeBatches.length, 1);
  assert.equal(store.project.glossary.length, 2);
  // 学校修订后重传同一回执（失败重试场景）
  const second = applyReceipt(store, parseReceipt(JSON.stringify(r)));
  assert.equal(second.items[0].outcome, "duplicate");
  assert.equal(second.batchId, store.mergeBatches[0].batchId);
  assert.equal(store.mergeBatches.length, 1);
  assert.equal(store.project.glossary.length, 2);
  assert.equal(store.project.blocks[2].comments.length, 1);
  assert.equal(store.project.blocks[2].imageAlt, "第一版替代文本");
});

test("同作者同内容但无来源标记的批注也不重复", () => {
  const store = makeStore();
  store.project.blocks[1].comments.push({
    id: "c2", author: "学校老师", body: "重复内容", createdAt: "", resolved: false, replies: [], receiptAnnotationId: "a8",
  });
  const r = receipt({
    annotations: [{ annotationId: "a8", blockId: "b-p1", comment: { author: "学校老师", body: "重复内容" } }],
  });
  applyReceipt(store, r);
  assert.equal(store.project.blocks[1].comments.filter((c) => c.body === "重复内容").length, 1);
});

test("resolveCommentId 可解决本地批注", () => {
  const store = makeStore();
  const r = receipt({
    annotations: [{ annotationId: "a9", blockId: "b-p1", resolveCommentId: "c1" }],
  });
  applyReceipt(store, r);
  assert.equal(store.project.blocks[1].comments.find((c) => c.id === "c1")?.resolved, true);
});

/* ------------------------- 未匹配 ------------------------- */

test("定位失败的条目标记 unmatched 且不改动内容", () => {
  const store = makeStore();
  const before = JSON.stringify(store.project);
  const r = receipt({
    annotations: [{ annotationId: "a10", blockId: "nope", excerpt: "完全不存在的文字", rectification: { changes: { accessibleText: "x" } } }],
  });
  const report = applyReceipt(store, r);
  assert.equal(report.items[0].outcome, "unmatched");
  assert.equal(JSON.stringify(store.project), before);
});

/* ------------------------- 术语调整与检查失效 ------------------------- */

test("术语 preferred 调整后受影响块的旧检查标记失效", () => {
  const store = makeStore();
  const r = receipt({
    glossaryChanges: [{ termId: "t1", action: "update-preferred", preferred: "顺着地面流的水" }],
  });
  const report = applyReceipt(store, r);
  assert.equal(store.project.glossary[0].preferred, "顺着地面流的水");
  assert.deepEqual(report.staleChecks.map((s) => s.termId), ["t1"]);
  assert.deepEqual(report.staleChecks[0].blockIds, ["b-p1"]);
});

test("新增术语同样登记需重算的块；无变化的 preferred 不登记", () => {
  const store = makeStore();
  const r = receipt({
    glossaryChanges: [
      { termId: "t1", action: "update-preferred", preferred: "沿地面流动的水" }, // 值未变（忽略空白差异）
      { action: "add", source: "降水", preferred: "雨和雪" },
    ],
  });
  const report = applyReceipt(store, r);
  assert.equal(report.staleChecks.length, 1);
  assert.equal(report.staleChecks[0].source, "降水");
  assert.deepEqual(report.staleChecks[0].blockIds, ["b-p1"]);
});

test("invalidateChecksForTerm 供编辑室术语修改复用", () => {
  const project = makeProject();
  const stale = invalidateChecksForTerm(project.blocks, project.glossary[0]);
  assert.deepEqual(stale.blockIds, ["b-p1"]);
  assert.deepEqual(blocksAffectedByTerm(project.blocks, project.glossary[0]), stale.blockIds);
});

/* ------------------------- 写入失败回滚 ------------------------- */

test("persist 抛错后恢复合并前状态", () => {
  const store = makeStore();
  const before = JSON.stringify({ p: store.project, c: store.pendingConflicts, b: store.mergeBatches });
  const r = receipt({
    annotations: [
      { annotationId: "a11", blockId: "b-img", rectification: { changes: { imageAlt: "应被回滚", accessibleText: "应被回滚" } } },
      { annotationId: "a12", blockId: "b-p1", comment: { author: "x", body: "也应被回滚" } },
    ],
    glossaryChanges: [{ action: "add", source: "海洋", preferred: "大海" }],
  });
  assert.throws(() => applyReceipt(store, r, {
    persist: () => { throw new Error("QuotaExceededError"); },
  }), /QuotaExceededError/);
  assert.equal(JSON.stringify({ p: store.project, c: store.pendingConflicts, b: store.mergeBatches }), before);
});

test("simulateWriteFailure 同样整体回滚", () => {
  const store = makeStore();
  const before = JSON.stringify(store.project);
  assert.throws(() => applyReceipt(store, receipt({
    annotations: [{ annotationId: "a13", blockId: "b-img", rectification: { changes: { imageAlt: "x", accessibleText: "x" } } }],
  }), { simulateWriteFailure: true }));
  assert.equal(JSON.stringify(store.project), before);
  assert.equal(store.mergeBatches.length, 0);
});

/* ------------------------- 批次收尾与快照 ------------------------- */

test("所有冲突裁决后 completeBatchIfReady 生成快照并完成回执", () => {
  const store = makeStore();
  const r = receipt({
    annotations: [
      { annotationId: "a14", blockId: "b-p1", rectification: { base: { accessibleText: "拆成短句" }, changes: { accessibleText: "学校版1" } } },
      { annotationId: "a15", blockId: "b-p2", rectification: { base: { accessibleText: "" }, changes: { accessibleText: "学校版2" } } },
    ],
  });
  const report = applyReceipt(store, r, { now: fixedNow });
  assert.equal(report.conflictCount, 2);
  let snapshots = 0;
  const finish = () => completeBatchIfReady(store, () => `snap-${++snapshots}`, { now: fixedNow });
  assert.equal(finish(), undefined); // 还有未裁决冲突
  for (const conflict of store.pendingConflicts) {
    resolveConflict(store, conflict.id, Object.fromEntries(conflict.conflicts.map((c) => [c.field, "receipt"])));
  }
  const finalReport = finish();
  assert.ok(finalReport);
  assert.equal(finalReport?.status, "completed");
  assert.equal(finalReport?.snapshotId, "snap-1");
  assert.equal(finalReport?.resolvedCount, 2);
  assert.equal(finalReport?.finishedAt, fixedNow());
});

test("无冲突合入即时 completed，completeBatchIfReady 不再重复生成快照", () => {
  const store = makeStore();
  const report = applyReceipt(store, receipt({
    annotations: [{ annotationId: "a16", blockId: "b-img", rectification: { changes: { imageAlt: "直接合入", accessibleText: "直接合入" } } }],
  }), { now: fixedNow });
  assert.equal(report.status, "completed");
  let snapshots = 0;
  const again = completeBatchIfReady(store, () => `snap-${++snapshots}`);
  assert.equal(again?.status, "completed");
  assert.equal(snapshots, 0);
});

/* ------------------------- 闸门辅助 ------------------------- */

test("pendingConflictsForBlock 只返回指定块的未决冲突", () => {
  const store = makeStore();
  applyReceipt(store, receipt({
    annotations: [{ annotationId: "a17", blockId: "b-p1", rectification: { base: { accessibleText: "拆成短句" }, changes: { accessibleText: "v" } } }],
  }));
  assert.equal(pendingConflictsForBlock(store, "b-p1").length, 1);
  assert.equal(pendingConflictsForBlock(store, "b-p2").length, 0);
});

console.log(`\n${passed} 个测试通过`);
