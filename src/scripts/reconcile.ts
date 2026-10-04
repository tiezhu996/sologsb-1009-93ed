// 离线回执按内容块对账：纯函数模块，不依赖 DOM，便于单测与合入流程复用。

export type BlockType = "heading" | "paragraph" | "image" | "link";
export type ReviewStatus = "pending" | "approved" | "needs-work";
export type ConflictSide = "local" | "receipt";

export interface ReconComment {
  id?: string;
  author: string;
  body: string;
  createdAt?: string;
  resolved?: boolean;
  replies?: ReconComment[];
  /** 来源回执批注号，重试/重传时据此去重。 */
  receiptAnnotationId?: string;
}

export interface ReconBlock {
  id: string;
  type: BlockType;
  text: string;
  accessibleText: string;
  headingLevel?: number;
  imageSrc?: string;
  imageAlt?: string;
  linkHref?: string;
  changeReason: string;
  reviewStatus: ReviewStatus;
  comments: ReconComment[];
}

export interface ReconTerm {
  id: string;
  source: string;
  preferred: string;
  note: string;
}

export interface ReconProject {
  id: string;
  blocks: ReconBlock[];
  glossary: ReconTerm[];
}

/** 回执里单条批注/整改结论。base 字段为离线时依据的版本，缺省时按“仅远端改动”处理。 */
export interface ReceiptAnnotation {
  annotationId: string;
  blockId?: string;
  /** 拆分或移动后，按摘录内容定位（原文或无障碍文本片段）。 */
  excerpt?: string;
  /** 邻块定位：前一/后一块的摘录，进一步消歧。 */
  prevExcerpt?: string;
  nextExcerpt?: string;
  comment?: ReconComment & { annotationId?: string };
  resolveCommentId?: string;
  rectification?: {
    base?: Partial<RectificationPatch>;
    changes?: Partial<RectificationPatch>;
  };
}

export interface RectificationPatch {
  text: string;
  accessibleText: string;
  imageAlt: string;
  headingLevel: number;
  linkHref: string;
  changeReason: string;
  reviewStatus: ReviewStatus;
}

export type RectField = keyof RectificationPatch;
export type ReconMatchMethod = "block-id" | "excerpt-neighbor";

export interface FieldConflict {
  field: RectField;
  base: string | number | undefined;
  local: string | number;
  receipt: string | number;
  resolution?: ConflictSide;
}

export interface PendingConflict {
  id: string;
  batchId: string;
  annotationId: string;
  blockId: string;
  matchedBy: ReconMatchMethod;
  conflicts: FieldConflict[];
  // 裁决期间并排保留两侧内容；resolved 后采用 resolution 指定的一侧。
  local: Partial<RectificationPatch>;
  receipt: Partial<RectificationPatch>;
  resolved: boolean;
  resolvedAt?: string;
}

export type ItemOutcome =
  | "merged-auto"
  | "conflict"
  | "comment-merged"
  | "unmatched"
  | "duplicate";

export interface ReconItem {
  annotationId: string;
  blockId?: string;
  matchedBlockId?: string;
  matchedBy?: ReconMatchMethod;
  outcome: ItemOutcome;
  detail: string;
  fieldsApplied?: RectField[];
  conflictId?: string;
}

export interface ReceiptGlossaryChange {
  termId?: string;
  source?: string;
  preferred?: string;
  note?: string;
  action: "update-preferred" | "add" | "remove";
}

export interface StructuredReceipt {
  receiptId: string;
  school: string;
  issuedAt: string;
  baseSnapshotId?: string;
  annotations: ReceiptAnnotation[];
  glossaryChanges?: ReceiptGlossaryChange[];
}

export type MergeStatus = "pending-arbitration" | "completed";

export interface MergeReport {
  batchId: string;
  receiptId: string;
  school: string;
  mergedAt: string;
  finishedAt?: string;
  status: MergeStatus;
  items: ReconItem[];
  glossaryApplied: ReceiptGlossaryChange[];
  snapshotId?: string;
  conflictCount: number;
  resolvedCount: number;
  staleChecks: { termId: string; source: string; blockIds: string[] }[];
}

/** 已合入批次登记，重试/重复回执据此跳过，保证批注与版本不重复增加。 */
export interface MergeBatchRecord {
  batchId: string;
  receiptId: string;
  mergedAt: string;
  annotationIds: string[];
  status: MergeStatus;
  finishedAt?: string;
}

export interface ReconcileStore {
  project: ReconProject;
  pendingConflicts: PendingConflict[];
  mergeBatches: MergeBatchRecord[];
  lastReport?: MergeReport;
}

export const RECT_FIELDS: RectField[] = [
  "text",
  "accessibleText",
  "imageAlt",
  "headingLevel",
  "linkHref",
  "changeReason",
  "reviewStatus",
];

export const FIELD_LABELS: Record<RectField, string> = {
  text: "原文",
  accessibleText: "无障碍文本",
  imageAlt: "图片替代文本",
  headingLevel: "标题层级",
  linkHref: "链接地址",
  changeReason: "改写原因",
  reviewStatus: "审核状态",
};

let counter = 0;
const localId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function newBatchId() {
  return localId("batch");
}

function normalize(value: string) {
  return value.replace(/\s+/g, "").trim();
}

export function sameField(a: unknown, b: unknown) {
  if (a === b) return true;
  if (typeof a === "string" && typeof b === "string") return normalize(a) === normalize(b);
  return false;
}

function fieldGet(block: ReconBlock, field: RectField): string | number {
  if (field === "imageAlt") return block.imageAlt ?? "";
  if (field === "headingLevel") return block.headingLevel ?? 0;
  if (field === "linkHref") return block.linkHref ?? "";
  return block[field] as string | number;
}

function fieldSet(block: ReconBlock, field: RectField, value: string | number) {
  if (field === "imageAlt") {
    block.imageAlt = String(value);
    if (block.type === "image") block.accessibleText = String(value);
    return;
  }
  if (field === "headingLevel") {
    block.headingLevel = Number(value);
    return;
  }
  if (field === "accessibleText" && block.type === "image") {
    block.imageAlt = String(value);
  }
  (block as unknown as Record<string, unknown>)[field] = value;
}

/* ------------------------------------------------------------------ */
/* 块定位：先认块标识，找不到再按摘录 + 邻块定位（拆分/移动场景）。      */
/* ------------------------------------------------------------------ */

function blockContains(block: ReconBlock, excerpt: string) {
  const needle = normalize(excerpt);
  if (!needle) return false;
  return [block.text, block.accessibleText, block.imageAlt ?? "", block.changeReason]
    .some((value) => normalize(value).includes(needle));
}

export function locateBlock(
  blocks: ReconBlock[],
  annotation: Pick<ReceiptAnnotation, "blockId" | "excerpt" | "prevExcerpt" | "nextExcerpt">,
): { block?: ReconBlock; method: ReconMatchMethod } {
  if (annotation.blockId) {
    const byId = blocks.find((block) => block.id === annotation.blockId);
    if (byId) return { block: byId, method: "block-id" };
  }
  if (!annotation.excerpt) return { method: "excerpt-neighbor" };
  const excerpt = annotation.excerpt;
  const candidates = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => blockContains(block, excerpt));
  if (candidates.length === 1) return { block: candidates[0].block, method: "excerpt-neighbor" };
  if (candidates.length > 1) {
    const scored = candidates.map((candidate) => {
      let score = 0;
      const prev = blocks[candidate.index - 1];
      const next = blocks[candidate.index + 1];
      if (annotation.prevExcerpt && prev && blockContains(prev, annotation.prevExcerpt)) score += 2;
      if (annotation.nextExcerpt && next && blockContains(next, annotation.nextExcerpt)) score += 2;
      // 邻块定位即使只给一侧也可用于消歧。
      if (!annotation.prevExcerpt && !annotation.nextExcerpt) score += 1;
      return { ...candidate, score };
    });
    const best = Math.max(...scored.map((item) => item.score));
    const winners = scored.filter((item) => item.score === best && best > 0);
    if (winners.length === 1) return { block: winners[0].block, method: "excerpt-neighbor" };
  }
  return { method: "excerpt-neighbor" };
}

/* ------------------------------------------------------------------ */
/* 三方对账：base / 本地 / 回执，逐字段判定自动合入或并排待裁。         */
/* ------------------------------------------------------------------ */

interface ReconcileResult {
  conflicts: FieldConflict[];
  fieldsApplied: RectField[];
  localSide: Partial<RectificationPatch>;
  receiptSide: Partial<RectificationPatch>;
}

function reconcileFields(
  block: ReconBlock,
  rect: NonNullable<ReceiptAnnotation["rectification"]>,
): ReconcileResult {
  const changes = rect.changes ?? {};
  const base = rect.base ?? {};
  const conflicts: FieldConflict[] = [];
  const fieldsApplied: RectField[] = [];
  const localSide: Record<string, string | number> = {};
  const receiptSide: Record<string, string | number> = {};

  for (const field of RECT_FIELDS) {
    if (!(field in changes)) continue;
    const incoming = changes[field] as string | number;
    const current = fieldGet(block, field);
    if (sameField(current, incoming)) continue; // 回执改动本地已包含
    const baseValue = field in base ? (base[field] as string | number) : undefined;
    const localChanged = baseValue === undefined ? false : !sameField(current, baseValue);
    if (!localChanged) {
      // 只有一侧变化：直接合入回执。
      fieldsApplied.push(field);
      fieldSet(block, field, incoming);
    } else {
      // 两边都改过：并排待裁，未裁决前保持本地内容。
      conflicts.push({ field, base: baseValue, local: current, receipt: incoming });
      localSide[field] = current;
      receiptSide[field] = incoming;
    }
  }
  return { conflicts, fieldsApplied, localSide, receiptSide };
}

/* ------------------------------------------------------------------ */
/* 批注合入：按 annotationId/批注内容去重，重试不重复增加。              */
/* ------------------------------------------------------------------ */

function findComment(block: ReconBlock, comment: NonNullable<ReceiptAnnotation["comment"]> | undefined) {
  if (!comment) return undefined;
  const body = normalize(comment.body);
  return block.comments.find((item) => {
    if (comment.annotationId && item.receiptAnnotationId === comment.annotationId) return true;
    if (comment.id && item.id === comment.id) return true;
    return normalize(item.author) === normalize(comment.author) && normalize(item.body) === body;
  });
}

function mergeComment(block: ReconBlock, annotationId: string, comment: NonNullable<ReceiptAnnotation["comment"]>) {
  const existing = findComment(block, { ...comment, annotationId });
  if (existing) return false;
  block.comments.unshift({
    id: comment.id ?? localId("comment"),
    author: comment.author,
    body: comment.body,
    createdAt: comment.createdAt ?? new Date().toISOString(),
    resolved: comment.resolved ?? false,
    replies: (comment.replies ?? []).map((reply) => ({ ...reply, id: reply.id ?? localId("reply") })),
    receiptAnnotationId: annotationId,
  });
  return true;
}

/* ------------------------------------------------------------------ */
/* 术语调整：合入后相关检查作废（staleChecks 记录需重算的块）。          */
/* ------------------------------------------------------------------ */

export function blocksAffectedByTerm(blocks: ReconBlock[], term: ReconTerm) {
  return blocks
    .filter((block) => `${block.text} ${block.accessibleText}`.includes(term.source))
    .map((block) => block.id);
}

function applyGlossaryChanges(
  project: ReconProject,
  changes: ReceiptGlossaryChange[],
): { applied: ReceiptGlossaryChange[]; stale: MergeReport["staleChecks"] } {
  const applied: ReceiptGlossaryChange[] = [];
  const stale: MergeReport["staleChecks"] = [];
  for (const change of changes) {
    if (change.action === "update-preferred" && change.termId) {
      const term = project.glossary.find((item) => item.id === change.termId);
      if (term && change.preferred !== undefined && !sameField(term.preferred, change.preferred)) {
        term.preferred = change.preferred;
        if (change.note !== undefined) term.note = change.note;
        applied.push(change);
        stale.push({ termId: term.id, source: term.source, blockIds: blocksAffectedByTerm(project.blocks, term) });
      }
    }
    if (change.action === "add" && change.source && change.preferred) {
      const term = {
        id: change.termId ?? localId("term"),
        source: change.source,
        preferred: change.preferred,
        note: change.note ?? "随离线回执新增",
      };
      project.glossary.push(term);
      applied.push(change);
      stale.push({ termId: term.id, source: term.source, blockIds: blocksAffectedByTerm(project.blocks, term) });
    }
    if (change.action === "remove" && change.termId) {
      const term = project.glossary.find((item) => item.id === change.termId);
      if (term) {
        stale.push({ termId: term.id, source: term.source, blockIds: blocksAffectedByTerm(project.blocks, term) });
        project.glossary = project.glossary.filter((item) => item.id !== change.termId);
        applied.push(change);
      }
    }
  }
  return { applied, stale };
}

/* ------------------------------------------------------------------ */
/* 解析与合入整份回执。                                                 */
/* ------------------------------------------------------------------ */

export class ReceiptValidationError extends Error {}

export function parseReceipt(raw: string): StructuredReceipt {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ReceiptValidationError("回执不是合法的 JSON 文件。");
  }
  const receipt = data as Partial<StructuredReceipt>;
  if (!receipt || typeof receipt !== "object") throw new ReceiptValidationError("回执内容为空。");
  if (!receipt.receiptId || typeof receipt.receiptId !== "string") throw new ReceiptValidationError("回执缺少 receiptId。");
  if (!Array.isArray(receipt.annotations)) throw new ReceiptValidationError("回执缺少 annotations 列表。");
  for (const annotation of receipt.annotations) {
    if (!annotation?.annotationId) throw new ReceiptValidationError("存在缺少 annotationId 的批注/整改条目。");
  }
  return {
    receiptId: receipt.receiptId,
    school: receipt.school ?? "未标注学校",
    issuedAt: receipt.issuedAt ?? "",
    baseSnapshotId: receipt.baseSnapshotId,
    annotations: receipt.annotations,
    glossaryChanges: receipt.glossaryChanges ?? [],
  };
}

export interface ApplyReceiptOptions {
  batchId?: string;
  now?: () => string;
  /** 演示/测试用：在写入前抛出，验证恢复合入前状态。 */
  simulateWriteFailure?: boolean;
  /** 实际持久化（localStorage 等）；抛错即整体回滚。 */
  persist?: (serialized: string) => void;
  serialize?: (project: ReconProject, store: ReconcileStore) => string;
}

export function applyReceipt(
  store: ReconcileStore,
  receipt: StructuredReceipt,
  options: ApplyReceiptOptions = {},
): MergeReport {
  const now = options.now ?? (() => new Date().toISOString());
  const batchId = options.batchId ?? newBatchId();

  // 幂等：同一回执/同一批注重传，只登记为 duplicate，不重复增加批注与版本。
  const previousIds = new Set(store.mergeBatches.flatMap((batch) => batch.annotationIds));
  const sameReceipt = store.mergeBatches.find((batch) => batch.receiptId === receipt.receiptId);

  // 合入前完整快照，写入失败时恢复。
  const restore = structuredClone({ project: store.project, pendingConflicts: store.pendingConflicts, mergeBatches: store.mergeBatches });

  const items: ReconItem[] = [];
  const annotationIds: string[] = receipt.annotations.map((annotation) => annotation.annotationId);

  // 整份回执此前已合入：重试/重传不重复执行任何变更，直接返回可供回传的登记。
  if (sameReceipt) {
    for (const annotation of receipt.annotations) {
      items.push({ annotationId: annotation.annotationId, blockId: annotation.blockId, outcome: "duplicate", detail: "该回执此前已合入，重试不再重复添加批注、术语或版本快照。" });
    }
    return {
      batchId: sameReceipt.batchId,
      receiptId: receipt.receiptId,
      school: receipt.school,
      mergedAt: sameReceipt.mergedAt,
      finishedAt: sameReceipt.finishedAt,
      status: sameReceipt.status,
      items,
      glossaryApplied: [],
      staleChecks: [],
      conflictCount: 0,
      resolvedCount: 0,
    };
  }

  try {
    for (const annotation of receipt.annotations) {
      if (previousIds.has(annotation.annotationId)) {
        items.push({ annotationId: annotation.annotationId, blockId: annotation.blockId, outcome: "duplicate", detail: "该条目此前已合入，重试不再重复添加批注或版本。" });
        continue;
      }

      const located = locateBlock(store.project.blocks, annotation);
      if (!located.block) {
        items.push({
          annotationId: annotation.annotationId,
          blockId: annotation.blockId,
          outcome: "unmatched",
          detail: annotation.blockId
            ? "块标识在本地稿中不存在，且摘录/邻块未能唯一定位，需人工指认。"
            : "摘录与邻块信息未能唯一定位内容块，需人工指认。",
        });
        continue;
      }
      const block = located.block;

      let addedComment = false;
      if (annotation.comment) addedComment = mergeComment(block, annotation.annotationId, annotation.comment);
      if (annotation.resolveCommentId) {
        const target = block.comments.find((item) => item.id === annotation.resolveCommentId);
        if (target) target.resolved = true;
      }

      if (annotation.rectification?.changes) {
        const result = reconcileFields(block, annotation.rectification);
        if (result.conflicts.length) {
          const conflictId = `conflict-${batchId}-${annotation.annotationId}`;
          store.pendingConflicts.push({
            id: conflictId,
            batchId,
            annotationId: annotation.annotationId,
            blockId: block.id,
            matchedBy: located.method,
            conflicts: result.conflicts,
            local: result.localSide,
            receipt: result.receiptSide,
            resolved: false,
          });
          items.push({
            annotationId: annotation.annotationId,
            blockId: annotation.blockId,
            matchedBlockId: block.id,
            matchedBy: located.method,
            outcome: "conflict",
            detail: `两侧都改过 ${result.conflicts.length} 个字段，已并排待裁；裁决前该块不能通过、全文不能导出。`,
            fieldsApplied: result.fieldsApplied,
            conflictId,
          });
        } else {
          items.push({
            annotationId: annotation.annotationId,
            blockId: annotation.blockId,
            matchedBlockId: block.id,
            matchedBy: located.method,
            outcome: "merged-auto",
            detail: `仅回执一侧变化，已自动合入 ${result.fieldsApplied.length} 个字段。`,
            fieldsApplied: result.fieldsApplied,
          });
        }
      } else if (annotation.comment || annotation.resolveCommentId) {
        items.push({
          annotationId: annotation.annotationId,
          blockId: annotation.blockId,
          matchedBlockId: block.id,
          matchedBy: located.method,
          outcome: "comment-merged",
          detail: addedComment ? "批注已合入。" : "批注此前已存在，未重复添加；已同步解决状态。",
        });
      } else {
        items.push({ annotationId: annotation.annotationId, blockId: annotation.blockId, matchedBlockId: block.id, matchedBy: located.method, outcome: "comment-merged", detail: "条目无整改内容，已按定位确认。" });
      }
    }

    const { applied, stale } = applyGlossaryChanges(store.project, receipt.glossaryChanges ?? []);

    const conflictCount = items.filter((item) => item.outcome === "conflict").length;
    const report: MergeReport = {
      batchId,
      receiptId: receipt.receiptId,
      school: receipt.school,
      mergedAt: now(),
      status: conflictCount ? "pending-arbitration" : "completed",
      items,
      glossaryApplied: applied,
      staleChecks: stale,
      conflictCount,
      resolvedCount: 0,
    };
    if (!conflictCount) report.finishedAt = report.mergedAt;

    store.mergeBatches.push({
      batchId,
      receiptId: receipt.receiptId,
      mergedAt: report.mergedAt,
      annotationIds,
      status: report.status,
      finishedAt: report.finishedAt,
    });
    store.lastReport = report;

    if (options.simulateWriteFailure) throw new Error("模拟写入失败（用于验证回滚）。");
    if (options.persist) {
      options.persist(options.serialize ? options.serialize(store.project, store) : JSON.stringify(store.project));
    }
    return report;
  } catch (error) {
    // 恢复合并前状态：批注、整改、术语、待裁冲突与批次登记全部不落库。
    store.project = restore.project;
    store.pendingConflicts = restore.pendingConflicts;
    store.mergeBatches = restore.mergeBatches;
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* 裁决并排冲突：选定一侧写回，全部裁决完成后批次方可收尾。              */
/* ------------------------------------------------------------------ */

export function pendingConflictsForBlock(store: ReconcileStore, blockId: string) {
  return store.pendingConflicts.filter((conflict) => !conflict.resolved && conflict.blockId === blockId);
}

export function hasPendingConflicts(store: ReconcileStore, blockId?: string) {
  return store.pendingConflicts.some(
    (conflict) => !conflict.resolved && (blockId === undefined || conflict.blockId === blockId),
  );
}

export function resolveConflict(
  store: ReconcileStore,
  conflictId: string,
  resolutions: Record<string, ConflictSide>,
  options: { now?: () => string } = {},
): PendingConflict {
  const now = options.now ?? (() => new Date().toISOString());
  const conflict = store.pendingConflicts.find((item) => item.id === conflictId);
  if (!conflict) throw new Error("待裁冲突不存在。");
  const block = store.project.blocks.find((item) => item.id === conflict.blockId);
  if (!block) throw new Error("冲突对应内容块已不存在。");
  for (const fieldConflict of conflict.conflicts) {
    const side = resolutions[fieldConflict.field];
    if (!side) throw new Error(`字段 ${fieldConflict.field} 尚未裁决。`);
    fieldConflict.resolution = side;
    fieldSet(block, fieldConflict.field, side === "receipt" ? fieldConflict.receipt : fieldConflict.local);
  }
  conflict.resolved = true;
  conflict.resolvedAt = now();

  const batch = store.mergeBatches.find((item) => item.batchId === conflict.batchId);
  const remaining = store.pendingConflicts.filter((item) => item.batchId === conflict.batchId && !item.resolved).length;
  if (batch && remaining === 0) {
    batch.status = "completed";
    batch.finishedAt = conflict.resolvedAt;
  }
  return conflict;
}

/** 全部冲突裁决完后收尾：生成新快照登记，并产出最终回传回执。 */
export function completeBatchIfReady(
  store: ReconcileStore,
  createSnapshot: (label: string) => string,
  options: { now?: () => string } = {},
): MergeReport | undefined {
  const now = options.now ?? (() => new Date().toISOString());
  const report = store.lastReport;
  if (!report) return undefined;
  if (hasPendingConflicts(store)) return undefined;
  const batch = store.mergeBatches.find((item) => item.batchId === report.batchId);
  if (!batch || report.status === "completed") return report;

  const snapshotId = createSnapshot(`回执对账快照 · ${report.school}`);
  report.status = "completed";
  report.finishedAt = now();
  report.snapshotId = snapshotId;
  report.resolvedCount = report.conflictCount;
  batch.status = "completed";
  batch.finishedAt = report.finishedAt;
  return report;
}

/** 术语在编辑室内调整时同样让旧检查结果失效。 */
export function invalidateChecksForTerm(blocks: ReconBlock[], term: ReconTerm): MergeReport["staleChecks"][number] {
  return { termId: term.id, source: term.source, blockIds: blocksAffectedByTerm(blocks, term) };
}

/* ------------------------------------------------------------------ */
/* 演示回执：覆盖自动合入、并排待裁、摘录邻块定位与术语调整。            */
/* ------------------------------------------------------------------ */

export function createSampleReceipt(): StructuredReceipt {
  return {
    receiptId: "RCV-2026-1004-01",
    school: "启明特教学校",
    issuedAt: "2026-10-04T09:30:00.000Z",
    baseSnapshotId: "offline-base",
    annotations: [
      {
        annotationId: "ann-p1-conflict",
        blockId: "block-p1",
        rectification: {
          base: {
            accessibleText: "城市里的水会不断循环。它经过蒸发、降水并沿地面流动。了解这些过程，可以帮助我们建设更能适应变化的城市。",
            changeReason: "拆分长句，把抽象表述改为更直接的说明。",
            reviewStatus: "pending",
          },
          changes: {
            accessibleText: "城市里的水不是用不完的。它靠蒸发、降水和沿地面流动不断循环。搞懂水循环，才能建好不怕暴雨的城市。",
            changeReason: "学校复核：保留更口语的解释，并补上与暴雨的联系。",
            reviewStatus: "approved",
          },
        },
        comment: { annotationId: "ann-p1-conflict", author: "王老师（启明特教）", body: "“韧性城市”学生难理解，建议换成“不怕暴雨的城市”。" },
      },
      {
        annotationId: "ann-img-alt",
        blockId: "block-img",
        rectification: {
          changes: {
            imageAlt: "示意图：太阳使水蒸发，水蒸气成云后以雨雪落回地面，再沿地面流回河湖。",
            accessibleText: "示意图：太阳使水蒸发，水蒸气成云后以雨雪落回地面，再沿地面流回河湖。",
            changeReason: "学校补写图片替代文本，覆盖蒸发、降水与回流三个环节。",
          },
        },
      },
      {
        annotationId: "ann-link-note",
        blockId: "block-link",
        comment: { annotationId: "ann-link-note", author: "李老师（启明特教）", body: "链接文案已能独立说明目的，课堂试用通过。" },
      },
      {
        annotationId: "ann-p3-moved",
        blockId: "block-p3-old",
        excerpt: "雨水花园利用土壤和植物",
        prevExcerpt: "雨水花园怎样工作",
        rectification: {
          base: { changeReason: "把并列成分拆成短句，减少专业术语密度。" },
          changes: { changeReason: "学校确认：拆分为三个短句，并补充“补充地下水”的作用说明。" },
        },
      },
      {
        annotationId: "ann-split-fragment",
        blockId: "block-split-2",
        excerpt: "减轻排水管的压力",
        prevExcerpt: "雨水花园用土壤和植物暂时存住雨水",
        comment: { annotationId: "ann-split-fragment", author: "赵老师（启明特教）", body: "这一句是从原长段拆出的，定位到雨水花园段即可，建议保留。" },
      },
      {
        annotationId: "ann-missing-block",
        blockId: "block-p9",
        excerpt: "不存在的课堂活动安排",
        rectification: { changes: { accessibleText: "本地稿里没有这一块。" } },
      },
    ],
    glossaryChanges: [
      { termId: "term-2", action: "update-preferred", preferred: "顺着地面流动的水", note: "学校建议改用更口语的“顺着地面流动”。" },
      { action: "add", source: "韧性", preferred: "不怕变化", note: "首次出现时随文解释。" },
    ],
  };
}
