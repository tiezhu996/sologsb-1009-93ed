import "@shoelace-style/shoelace/dist/shoelace.js";
import {
  applyReceipt,
  completeBatchIfReady,
  createSampleReceipt,
  FIELD_LABELS,
  invalidateChecksForTerm,
  parseReceipt,
  ReceiptValidationError,
  resolveConflict,
  type ConflictSide,
  type MergeReport,
  type PendingConflict,
  type ReceiptGlossaryChange,
  type ReconcileStore,
  type ReconItem,
  type RectField,
} from "./reconcile.js";

type BlockType = "heading" | "paragraph" | "image" | "link";
type ReviewStatus = "pending" | "approved" | "needs-work";
type Severity = "error" | "warning" | "info";

interface CommentReply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

interface CommentItem {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
  replies: CommentReply[];
  /** 离线回执批注号，重试/重传合入时据此去重。 */
  receiptAnnotationId?: string;
}

interface StaleCheckNotice {
  id: string;
  termId: string;
  source: string;
  blockIds: string[];
  createdAt: string;
  acknowledged: boolean;
}

interface MergeBatchRecord {
  batchId: string;
  receiptId: string;
  mergedAt: string;
  annotationIds: string[];
  status: "pending-arbitration" | "completed";
  finishedAt?: string;
}

interface ContentBlock {
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
  comments: CommentItem[];
}

interface GlossaryTerm {
  id: string;
  source: string;
  preferred: string;
  note: string;
}

interface VersionSnapshot {
  id: string;
  label: string;
  createdAt: string;
  blocks: ContentBlock[];
  glossary: GlossaryTerm[];
}

interface ChapterProject {
  id: string;
  title: string;
  subject: string;
  grade: string;
  blocks: ContentBlock[];
  glossary: GlossaryTerm[];
  versions: VersionSnapshot[];
  updatedAt: string;
  /** 回执对账：两边都改过、并排待裁的字段级冲突。 */
  pendingConflicts?: PendingConflict[];
  /** 已合入回执批次登记，保证重试不重复增加批注和版本。 */
  mergeBatches?: MergeBatchRecord[];
  /** 最近一次合批的回传回执（含未匹配、待裁条目明细）。 */
  lastMergeReport?: MergeReport;
  /** 术语调整后作废、需要重算的旧检查结果。 */
  staleCheckNotices?: StaleCheckNotice[];
}

interface AccessibilityIssue {
  id: string;
  blockId: string;
  type: "heading" | "link" | "image" | "glossary" | "sentence";
  severity: Severity;
  title: string;
  detail: string;
  suggestion: string;
}

const STORAGE_KEY = "sologsb-1009-accessible-textbook-v1";
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function createSeedProject(): ChapterProject {
  const blocks: ContentBlock[] = [
    {
      id: "block-h1",
      type: "heading",
      headingLevel: 1,
      text: "第三章 水循环与城市",
      accessibleText: "第三章 水循环与城市",
      changeReason: "",
      reviewStatus: "approved",
      comments: [],
    },
    {
      id: "block-p1",
      type: "paragraph",
      text: "城市中的水并非取之不尽，由于其会通过蒸发、降水以及地表径流等若干复杂过程在自然界中持续循环，因此理解这些过程对于建设具有韧性的城市具有十分重要的意义。",
      accessibleText: "城市里的水会不断循环。水经过蒸发、降水，还会沿地面流动。了解这些过程，可以帮助我们建设更能适应暴雨的城市。",
      changeReason: "拆分长句，把抽象表述改为更直接的说明；本地复核时补入“暴雨”场景。",
      reviewStatus: "pending",
      comments: [],
    },
    {
      id: "block-h2",
      type: "heading",
      headingLevel: 2,
      text: "一、水从哪里来",
      accessibleText: "一、水从哪里来",
      changeReason: "保留原章节结构。",
      reviewStatus: "approved",
      comments: [],
    },
    {
      id: "block-img",
      type: "image",
      text: "图 3-1 城市水循环示意",
      imageSrc: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='420'%3E%3Crect width='800' height='420' fill='%23dcecf3'/%3E%3Ccircle cx='650' cy='85' r='45' fill='%23f4c95d'/%3E%3Cpath d='M0 300 Q180 240 340 300 T800 280 V420 H0Z' fill='%2389b7d0'/%3E%3Cpath d='M130 285 Q220 170 330 285' fill='none' stroke='%233a7c9e' stroke-width='12'/%3E%3C/svg%3E",
      imageAlt: "",
      accessibleText: "",
      changeReason: "",
      reviewStatus: "needs-work",
      comments: [],
    },
    {
      id: "block-p2",
      type: "paragraph",
      text: "当太阳照射到水面时，水会受热变成水蒸气升到空中。水蒸气冷却后形成云，再以雨或雪的形式落回地面。",
      accessibleText: "太阳照在水面上，水会变成水蒸气升到空中。水蒸气冷却后变成云，最后以雨或雪落回地面。",
      changeReason: "使用较短句子，并明确每个步骤的先后顺序。",
      reviewStatus: "approved",
      comments: [],
    },
    {
      id: "block-link",
      type: "link",
      text: "点击这里",
      linkHref: "/resources/water-cycle",
      accessibleText: "打开水循环互动实验",
      changeReason: "改为说明链接目标的独立文案。",
      reviewStatus: "pending",
      comments: [],
    },
    {
      id: "block-h3",
      type: "heading",
      headingLevel: 3,
      text: "雨水花园怎样工作",
      accessibleText: "雨水花园怎样工作",
      changeReason: "",
      reviewStatus: "approved",
      comments: [],
    },
    {
      id: "block-p3",
      type: "paragraph",
      text: "雨水花园利用土壤和植物的共同作用暂时储存雨水，同时通过下渗补给地下水，并在降雨较集中时减轻城市排水管道所承受的压力。",
      accessibleText: "雨水花园用土壤和植物暂时存住雨水。雨水还会慢慢渗入地下，补充地下水。雨很大时，它可以减轻排水管的压力。",
      changeReason: "把并列成分拆成短句，减少专业术语密度。",
      reviewStatus: "pending",
      comments: [],
    },
  ];

  return {
    id: "accessible-textbook-1009",
    title: "科学（五年级下册）·无障碍改写稿",
    subject: "科学",
    grade: "五年级",
    blocks,
    glossary: [
      { id: "term-1", source: "水循环", preferred: "水循环", note: "全书统一使用" },
      { id: "term-2", source: "地表径流", preferred: "沿地面流动的水", note: "首次出现时使用通俗解释" },
      { id: "term-3", source: "下渗", preferred: "渗入地下", note: "避免单独使用专业词" },
    ],
    versions: [],
    pendingConflicts: [],
    mergeBatches: [],
    staleCheckNotices: [],
    updatedAt: new Date().toISOString(),
  };
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parseImportedChapter(input: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push(blankBlock("heading", heading[2], { headingLevel: heading[1].length }));
      continue;
    }
    const image = /^!\[([^\]]*)\]\(([^)]+)\)(?:\s+(.+))?$/.exec(line);
    if (image) {
      blocks.push(blankBlock("image", image[3] || "未命名图片", { imageSrc: image[2], imageAlt: image[1] }));
      continue;
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(line);
    if (link) {
      blocks.push(blankBlock("link", link[1], { linkHref: link[2] }));
      continue;
    }
    blocks.push(blankBlock("paragraph", line));
  }
  return blocks.length ? blocks : [blankBlock("paragraph", input.trim() || "请输入章节内容")];
}

function blankBlock(type: BlockType, text: string, extra: Partial<ContentBlock> = {}): ContentBlock {
  return {
    id: uid("block"),
    type,
    text,
    accessibleText: type === "image" ? extra.imageAlt ?? "" : text,
    changeReason: "",
    reviewStatus: "pending",
    comments: [],
    ...extra,
  };
}

function sentenceLength(text: string) {
  const normalized = text.replace(/\s+/g, "");
  return /[A-Za-z]/.test(text) ? text.trim().split(/\s+/).length : normalized.length;
}

function analyze(project: ChapterProject): AccessibilityIssue[] {
  const issues: AccessibilityIssue[] = [];
  let lastHeading = 0;
  for (const block of project.blocks) {
    if (block.type === "heading") {
      const level = block.headingLevel ?? 2;
      if (lastHeading && level > lastHeading + 1) {
        issues.push({
          id: `heading-${block.id}`,
          blockId: block.id,
          type: "heading",
          severity: "error",
          title: "标题层级跳跃",
          detail: `从 H${lastHeading} 直接到 H${level}，读屏用户会失去清晰的章节结构。`,
          suggestion: `改为 H${lastHeading + 1}，或补上中间的上级标题。`,
        });
      }
      lastHeading = level;
    }
    if (block.type === "image" && !(block.imageAlt ?? block.accessibleText).trim()) {
      issues.push({
        id: `image-${block.id}`,
        blockId: block.id,
        type: "image",
        severity: "error",
        title: "图片缺少替代文本",
        detail: "视觉用户能看到的图表信息，读屏用户目前无法获得。",
        suggestion: "说明图中主体、变化和结论；纯装饰图片应标记为空替代文本。",
      });
    }
    if (block.type === "link") {
      const label = block.accessibleText || block.text;
      if (/^(点击这里|这里|链接|更多|here|click here|read more)$/i.test(label.trim())) {
        issues.push({
          id: `link-${block.id}`,
          blockId: block.id,
          type: "link",
          severity: "error",
          title: "链接文案缺少目的",
          detail: `“${label}”单独朗读时无法说明会前往哪里。`,
          suggestion: "改成“打开水循环互动实验”等可独立理解的文案。",
        });
      }
    }
    const text = block.type === "image" ? block.text : block.text;
    const sentences = text.split(/(?<=[。！？!?])\s*/).filter(Boolean);
    for (const [index, sentence] of sentences.entries()) {
      if (sentenceLength(sentence) > (/[A-Za-z]/.test(sentence) ? 28 : 42)) {
        issues.push({
          id: `sentence-${block.id}-${index}`,
          blockId: block.id,
          type: "sentence",
          severity: "warning",
          title: "句子过长",
          detail: `该句约 ${sentenceLength(sentence)} ${/[A-Za-z]/.test(sentence) ? "个词" : "个字"}，一次理解的信息较多。`,
          suggestion: "按动作或因果关系拆成 2—3 个短句。",
        });
      }
    }
    const source = `${block.text} ${block.accessibleText}`;
    for (const term of project.glossary) {
      if (source.includes(term.source) && block.accessibleText && !block.accessibleText.includes(term.preferred)) {
        issues.push({
          id: `term-${block.id}-${term.id}`,
          blockId: block.id,
          type: "glossary",
          severity: "info",
          title: `术语“${term.source}”尚未统一`,
          detail: `全书建议表述为“${term.preferred}”。${term.note}`,
          suggestion: `将无障碍文本调整为“${term.preferred}”。`,
        });
      }
    }
  }
  return issues;
}

function simplifyText(input: string, glossary: GlossaryTerm[]) {
  let result = input
    .replaceAll("由于其", "因为")
    .replaceAll("因此", "所以")
    .replaceAll("具有十分重要的意义", "很重要")
    .replaceAll("利用", "使用")
    .replaceAll("共同作用", "一起作用")
    .replaceAll("暂时储存", "暂时存住")
    .replaceAll("所承受的压力", "受到的压力")
    .replace(/([^。！？]{38,}?)[，、]([^。！？]{12,}?[。！？])/g, "$1。$2");
  for (const term of glossary) {
    if (result.includes(term.source)) result = result.replaceAll(term.source, term.preferred);
  }
  result = result
    .split(/(?<=[。！？!?])\s*/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .join("\n");
  return result;
}

function blockRole(block: ContentBlock) {
  if (block.type === "heading") return `H${block.headingLevel ?? 2} 标题`;
  if (block.type === "image") return "图片 / 替代文本";
  if (block.type === "link") return "链接";
  return "正文段落";
}

function statusLabel(status: ReviewStatus) {
  if (status === "approved") return "已通过";
  if (status === "needs-work") return "需修改";
  return "待审核";
}

function severityLabel(severity: Severity) {
  if (severity === "error") return "必须修复";
  if (severity === "warning") return "建议优化";
  return "一致性提醒";
}

function exportHtml(project: ChapterProject) {
  const body = project.blocks.map((block) => {
    if (block.type === "heading") {
      const level = Math.min(6, Math.max(1, block.headingLevel ?? 2));
      return `<h${level}>${escapeHtml(block.accessibleText || block.text)}</h${level}>`;
    }
    if (block.type === "image") {
      return `<figure><img src="${escapeHtml(block.imageSrc ?? "")}" alt="${escapeHtml(block.imageAlt || block.accessibleText)}"><figcaption>${escapeHtml(block.text)}</figcaption></figure>`;
    }
    if (block.type === "link") {
      return `<p><a href="${escapeHtml(block.linkHref ?? "#")}">${escapeHtml(block.accessibleText || block.text)}</a></p>`;
    }
    return `<p>${escapeHtml(block.accessibleText || block.text)}</p>`;
  }).join("\n      ");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(project.title)} · 无障碍版本</title>
  <style>
    :root { font-family: "Noto Sans SC", sans-serif; font-size: 20px; line-height: 1.85; color: #17231f; background: #fffdf7; }
    body { max-width: 760px; margin: 0 auto; padding: 32px 24px 80px; }
    a { color: #075c9d; text-decoration-thickness: 2px; text-underline-offset: 3px; }
    a:focus-visible, [tabindex]:focus-visible { outline: 4px solid #d08a00; outline-offset: 3px; }
    h1, h2, h3, h4, h5, h6 { line-height: 1.4; margin-top: 1.8em; }
    figure { margin: 2em 0; } img { max-width: 100%; height: auto; } figcaption { font-size: .86em; color: #46554f; }
    .skip { position: absolute; left: -9999px; } .skip:focus { position: static; display: inline-block; padding: .5em; background: #fff; }
  </style>
</head>
<body>
  <a class="skip" href="#main">跳到正文</a>
  <main id="main" tabindex="-1">
      ${body}
  </main>
</body>
</html>`;
}

function download(filename: string, content: string, type = "text/html;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function normalizeProject(loaded: ChapterProject): ChapterProject {
  return {
    ...loaded,
    blocks: loaded.blocks.map((block) => ({ ...block, comments: block.comments ?? [] })),
    glossary: loaded.glossary ?? [],
    versions: loaded.versions ?? [],
    pendingConflicts: loaded.pendingConflicts ?? [],
    mergeBatches: loaded.mergeBatches ?? [],
    staleCheckNotices: loaded.staleCheckNotices ?? [],
  };
}

function loadProject(): ChapterProject {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "") as { schema: number; project: ChapterProject };
    if (stored.schema === 1 && stored.project?.blocks?.length) return normalizeProject(stored.project);
  } catch {
    // Fall back to the bundled sample.
  }
  return createSeedProject();
}

const rootElement = document.querySelector<HTMLDivElement>("#app");
if (!rootElement) throw new Error("Application root was not found");
const app: HTMLDivElement = rootElement;

let project = loadProject();
let activeBlockId = project.blocks[0]?.id ?? "";
let activeIssueId = "";
let previewMode: "normal" | "assisted" = "normal";
let selectedVersionId = "";
let showGlossary = false;
let undoStack: ChapterProject[] = [];
let redoStack: ChapterProject[] = [];
let saveTimer = 0;
let showReceipts = false;
let receiptMessage: { tone: "success" | "error" | "info"; text: string } | null = null;

const pendingConflictCount = (blockId?: string) =>
  (project.pendingConflicts ?? []).filter(
    (conflict) => !conflict.resolved && (blockId === undefined || conflict.blockId === blockId),
  ).length;

/** 未裁决前：有冲突的块不能审核通过；全文也不能导出。 */
function blockHasConflict(blockId: string) {
  return pendingConflictCount(blockId) > 0;
}

function hasPendingConflictsGlobal() {
  return pendingConflictCount() > 0;
}

function conflictsForBlock(blockId: string): PendingConflict[] {
  return (project.pendingConflicts ?? []).filter((conflict) => !conflict.resolved && conflict.blockId === blockId);
}

function pushStaleChecks(entries: MergeReport["staleChecks"], draft: ChapterProject) {
  const notices = draft.staleCheckNotices ?? [];
  const now = new Date().toISOString();
  for (const entry of entries) {
    if (!entry.blockIds.length) continue;
    notices.unshift({ id: uid("stale"), termId: entry.termId, source: entry.source, blockIds: entry.blockIds, createdAt: now, acknowledged: false });
  }
  draft.staleCheckNotices = notices.slice(0, 30);
}

/** 编辑室内增删改术语时，同样让相关旧检查结果失效并触发重算。 */
function invalidateGlossaryChecks(draft: ChapterProject, term: GlossaryTerm) {
  pushStaleChecks([invalidateChecksForTerm(draft.blocks, term)], draft);
}

/** 合批完成：保存新快照（回执自动合入不额外占用手动版本名额）。 */
function appendMergedSnapshot(draft: ChapterProject, label: string) {
  const version = {
    id: uid("version"),
    label,
    createdAt: new Date().toISOString(),
    blocks: structuredClone(draft.blocks),
    glossary: structuredClone(draft.glossary),
  };
  draft.versions.unshift(version);
  draft.versions = draft.versions.slice(0, 10);
  return version.id;
}

const activeBlock = () => project.blocks.find((block) => block.id === activeBlockId) ?? project.blocks[0];
const issues = () => analyze(project);

function writeStorage(label: string, target: ChapterProject = project) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ schema: 1, project: target }));
    return true;
  } catch (error) {
    // 持久化失败不能破坏内存态；回执合入路径会先在副本上验证再换入。
    document.documentElement.dataset.lastAction = `${label}失败：${error instanceof Error ? error.message : "无法写入本地存储"}`;
    return false;
  }
}

function saveSoon() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => { writeStorage("自动保存"); }, 320);
}

function commit(label: string, update: (draft: ChapterProject) => void, renderAfter = true) {
  undoStack = [...undoStack.slice(-49), structuredClone(project)];
  redoStack = [];
  const draft = structuredClone(project);
  update(draft);
  draft.updatedAt = new Date().toISOString();
  project = draft;
  document.documentElement.dataset.lastAction = label;
  saveSoon();
  if (renderAfter) render();
}

function undo() {
  const previous = undoStack.pop();
  if (!previous) return;
  redoStack = [structuredClone(project), ...redoStack].slice(0, 50);
  project = previous;
  if (!project.blocks.some((block) => block.id === activeBlockId)) activeBlockId = project.blocks[0]?.id ?? "";
  saveSoon();
  render();
}

function redo() {
  const next = redoStack.shift();
  if (!next) return;
  undoStack = [...undoStack.slice(-49), structuredClone(project)];
  project = next;
  saveSoon();
  render();
}

function updateActiveBlock(update: (block: ContentBlock, draft: ChapterProject) => void, label = "修改无障碍文本", renderAfter = true) {
  commit(label, (draft) => {
    const block = draft.blocks.find((item) => item.id === activeBlockId);
    if (block) update(block, draft);
  }, renderAfter);
}

function outcomeLabel(outcome: ReconItem["outcome"]) {
  if (outcome === "merged-auto") return { label: "自动合入", tone: "ok" as const };
  if (outcome === "conflict") return { label: "并排待裁", tone: "conflict" as const };
  if (outcome === "comment-merged") return { label: "批注合入", tone: "ok" as const };
  if (outcome === "duplicate") return { label: "重复跳过", tone: "muted" as const };
  return { label: "未能定位", tone: "warn" as const };
}

function importReceiptText(raw: string, simulateWriteFailure = false) {
  let receipt;
  try {
    receipt = parseReceipt(raw);
  } catch (error) {
    const message = error instanceof ReceiptValidationError ? error.message : "回执解析失败。";
    receiptMessage = { tone: "error", text: message };
    render();
    return;
  }

  // 取消可能挂起的旧自动保存，避免回滚后被旧内容覆盖落库。
  window.clearTimeout(saveTimer);

  // 在 draft 上对账；applyReceipt 内部失败会自行回滚，persist 失败则整体放弃，不进入提交。
  const draft = structuredClone(project);
  const store: ReconcileStore = {
    get project() { return draft as never; },
    set project(value) { Object.assign(draft, value); },
    get pendingConflicts() { return draft.pendingConflicts ?? []; },
    set pendingConflicts(value: PendingConflict[]) { draft.pendingConflicts = value; },
    get mergeBatches() { return draft.mergeBatches ?? []; },
    set mergeBatches(value: MergeBatchRecord[]) { draft.mergeBatches = value; },
    get lastReport() { return draft.lastMergeReport; },
    set lastReport(value: MergeReport | undefined) { draft.lastMergeReport = value; },
  };

  // 先在暂存键上验证可写性：applyReceipt 失败即回滚、不换入内存态。
  const stagingKey = `${STORAGE_KEY}.staging`;
  let report: MergeReport;
  try {
    report = applyReceipt(store, receipt, {
      simulateWriteFailure,
      persist: (serialized) => localStorage.setItem(stagingKey, serialized),
      serialize: () => JSON.stringify({ schema: 1, project: draft }),
    });
  } catch (error) {
    try { localStorage.removeItem(stagingKey); } catch { /* 忽略清理失败 */ }
    receiptMessage = {
      tone: "error",
      text: `写入失败，已恢复合并前状态，批注与版本均未落库：${error instanceof Error ? error.message : String(error)}。可直接重试，不会重复增加批注。`,
    };
    render();
    return;
  }

  // 整份回执此前已合入：不生成新快照、不入撤销栈，重试零副作用。
  const allDuplicate = report.items.length > 0 && report.items.every((item) => item.outcome === "duplicate");
  if (allDuplicate) {
    try { localStorage.removeItem(stagingKey); } catch { /* 忽略清理失败 */ }
    receiptMessage = { tone: "info", text: `回执 ${report.receiptId} 此前已合入，本次重试未重复添加批注、术语或版本快照。` };
    render();
    return;
  }

  // 术语调整 → 相关旧检查结果标明失效、触发重算。
  pushStaleChecks(report.staleChecks, draft);

  const autoSnapshot = report.status === "completed"
    ? appendMergedSnapshot(draft, `回执合批快照 · ${report.school}`)
    : undefined;
  if (autoSnapshot) report.snapshotId = autoSnapshot;

  const autoCount = report.items.filter((item) => item.outcome === "merged-auto").length;
  const commentCount = report.items.filter((item) => item.outcome === "comment-merged").length;
  draft.updatedAt = new Date().toISOString();

  // 最终态落盘：先写暂存键再替换正式键；失败则合并前状态不被破坏，内存态不换入。
  const serialized = JSON.stringify({ schema: 1, project: draft });
  try {
    localStorage.setItem(stagingKey, serialized);
  } catch {
    receiptMessage = {
      tone: "error",
      text: "写入失败（本地存储不可用或空间不足），已恢复合并前状态，批注与版本均未落库，可直接重试。",
    };
    render();
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, serialized);
    localStorage.removeItem(stagingKey);
  } catch (error) {
    try { localStorage.removeItem(stagingKey); } catch { /* 忽略清理失败 */ }
    receiptMessage = {
      tone: "error",
      text: `写入失败，已恢复合并前状态，批注与版本均未落库：${error instanceof Error ? error.message : String(error)}。可直接重试，不会重复增加批注。`,
    };
    render();
    return;
  }

  undoStack = [...undoStack.slice(-49), structuredClone(project)];
  redoStack = [];
  project = draft;
  document.documentElement.dataset.lastAction = "合入离线回执";

  receiptMessage = {
    tone: report.conflictCount ? "info" : "success",
    text: report.conflictCount
      ? `回执 ${report.receiptId} 已对账：${autoCount} 条自动合入、${commentCount} 条批注合入，${report.conflictCount} 条两边都改过并排待裁；裁决前相关块不能通过、全文不能导出。`
      : `回执 ${report.receiptId} 合批完成（${autoCount} 条整改、${commentCount} 条批注），已生成新快照${autoSnapshot ? `（${autoSnapshot}）` : ""}，回传回执可下载。`,
  };
  render();
}

function arbitrateConflict(conflictId: string, resolutions: Record<RectField, ConflictSide | "">) {
  const conflict = (project.pendingConflicts ?? []).find((item) => item.id === conflictId);
  if (!conflict) return;
  window.clearTimeout(saveTimer);
  const draft = structuredClone(project);
  const store: ReconcileStore = {
    get project() { return draft as never; },
    set project(value) { Object.assign(draft, value); },
    get pendingConflicts() { return draft.pendingConflicts ?? []; },
    set pendingConflicts(value: PendingConflict[]) { draft.pendingConflicts = value; },
    get mergeBatches() { return draft.mergeBatches ?? []; },
    set mergeBatches(value: MergeBatchRecord[]) { draft.mergeBatches = value; },
    get lastReport() { return draft.lastMergeReport; },
    set lastReport(value: MergeReport | undefined) { draft.lastMergeReport = value; },
  };
  try {
    resolveConflict(store, conflictId, resolutions as Record<string, ConflictSide>);
  } catch (error) {
    receiptMessage = { tone: "error", text: error instanceof Error ? error.message : "裁决失败。" };
    render();
    return;
  }

  // 全部裁决完 → 收尾批次、生成新快照与最终回传回执。
  const finished = completeBatchIfReady(store, (label) => appendMergedSnapshot(draft, label));
  draft.updatedAt = new Date().toISOString();

  // 落库成功后再换入内存态；失败则保留裁决前状态。
  if (!writeStorage("裁决写入", draft)) {
    receiptMessage = { tone: "error", text: "裁决结果写入本地存储失败，已保持裁决前状态，请重试。" };
    render();
    return;
  }

  undoStack = [...undoStack.slice(-49), structuredClone(project)];
  redoStack = [];
  project = draft;
  document.documentElement.dataset.lastAction = "裁决回执冲突";
  if (finished) {
    receiptMessage = { tone: "success", text: `全部冲突已裁决，批次 ${finished.batchId} 完成，已生成新快照（${finished.snapshotId ?? ""}），请下载回传回执。` };
  } else {
    receiptMessage = { tone: "info", text: "已记录该条裁决，仍有其他并排冲突待处理。" };
  }
  render();
}

function downloadReturnReceipt() {
  const report = project.lastMergeReport;
  if (!report) return;
  download(`${report.receiptId}-回传回执.json`, JSON.stringify(report, null, 2), "application/json;charset=utf-8");
  receiptMessage = { tone: "success", text: `回传回执 ${report.receiptId}.json 已下载。` };
  render();
}

function dismissStaleNotices() {
  commit("确认检查已重算", (draft) => {
    for (const notice of draft.staleCheckNotices ?? []) notice.acknowledged = true;
  });
}

function render() {
  const list = issues();
  const active = activeBlock();
  const activeIssues = list.filter((issue) => issue.blockId === active.id);
  const approved = project.blocks.filter((block) => block.reviewStatus === "approved").length;
  const version = project.versions.find((item) => item.id === selectedVersionId) ?? project.versions[0];
  const totalConflicts = pendingConflictCount();
  const activeConflicts = conflictsForBlock(active.id);
  const staleNotices = (project.staleCheckNotices ?? []).filter((notice) => !notice.acknowledged);
  const exportBlocked = totalConflicts > 0;

  app.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand"><span>无障碍</span><b>1009</b></div>
        <div class="title-block">
          <input id="project-title" aria-label="教材名称" value="${escapeHtml(project.title)}" />
          <div class="meta"><span>${escapeHtml(project.subject)}</span><span>${escapeHtml(project.grade)}</span><span class="save-dot">本地自动保存</span></div>
        </div>
        <div class="top-actions">
          <span class="online-pill">${navigator.onLine ? "在线" : "离线可编辑"}</span>
          <sl-button size="small" variant="default" ${undoStack.length ? "" : "disabled"} data-action="undo">撤销</sl-button>
          <sl-button size="small" variant="default" ${redoStack.length ? "" : "disabled"} data-action="redo">重做</sl-button>
          <sl-button size="small" variant="default" data-action="glossary">术语表</sl-button>
          <sl-button size="small" variant="warning" outline data-action="receipts">回执对账${totalConflicts ? `<sl-badge variant="danger" pill>${totalConflicts}</sl-badge>` : ""}</sl-button>
          <sl-button size="small" variant="primary" data-action="save-version">保存版本</sl-button>
          <sl-tooltip content="${exportBlocked ? "回执冲突裁决完成前不能导出" : "导出完整无障碍 HTML"}">
            <sl-button size="small" variant="success" ${exportBlocked ? "disabled" : ""} data-action="export">导出无障碍 HTML</sl-button>
          </sl-tooltip>
        </div>
      </header>

      <div class="progress-strip">
        <div class="progress-copy"><b>${approved}/${project.blocks.length}</b><span>内容块已审核通过</span></div>
        <div class="progress-bar"><i style="width:${Math.round((approved / Math.max(1, project.blocks.length)) * 100)}%"></i></div>
        <div class="issue-counts">
          <span class="error">${list.filter((issue) => issue.severity === "error").length} 必须修复</span>
          <span class="warning">${list.filter((issue) => issue.severity === "warning").length} 建议优化</span>
          <span class="info">${list.filter((issue) => issue.severity === "info").length} 术语提醒</span>
        </div>
      </div>

      ${totalConflicts ? `<div class="conflict-banner" role="alert">
        <b>回执对账有 ${totalConflicts} 处并排待裁</b>
        <span>学校回执与本地稿修改了同一处内容。裁决完成前，相关内容块不能审核通过，全文也不能导出。</span>
        <sl-button size="small" variant="warning" data-action="receipts">前往裁决</sl-button>
      </div>` : ""}
      ${staleNotices.length ? `<div class="stale-banner" role="status">
        <b>术语已调整，${staleNotices.reduce((total, notice) => total + notice.blockIds.length, 0)} 项旧检查结果已失效</b>
        <span>下列检查已按新术语表重算：${staleNotices.flatMap((notice) => notice.blockIds.map((blockId) => `#${project.blocks.findIndex((block) => block.id === blockId) + 1}`)).filter((position, index, arr) => position !== "0" && arr.indexOf(position) === index).slice(0, 8).join("、")} 块的术语一致性检查。<em>（旧结果已标记为失效）</em></span>
        <sl-button size="small" variant="default" data-action="dismiss-stale">知道了</sl-button>
      </div>` : ""}
      ${receiptMessage ? `<div class="receipt-message ${receiptMessage.tone}" role="status">
        <span>${escapeHtml(receiptMessage.text)}</span>
        <button data-action="clear-receipt-message" aria-label="关闭提示">×</button>
      </div>` : ""}

      <div class="workspace">
        <aside class="outline-panel">
          <div class="panel-title"><span>章节结构</span><sl-badge>${project.blocks.length} 块</sl-badge></div>
          <div class="block-list">
            ${project.blocks.map((block, index) => {
              const blockIssues = list.filter((issue) => issue.blockId === block.id);
              const conflicted = blockHasConflict(block.id);
              return `<button class="block-item ${block.id === active.id ? "active" : ""}" data-action="select-block" data-block-id="${block.id}">
                <span class="block-order">${index + 1}</span>
                <span class="block-copy"><b>${block.type === "heading" ? `H${block.headingLevel}` : blockRole(block)}${conflicted ? ` · <em class="conflict-flag">待裁</em>` : ""}</b><span>${escapeHtml(block.accessibleText || block.text || "（空）")}</span></span>
                <i class="status-${block.reviewStatus}" title="${statusLabel(block.reviewStatus)}"></i>
                ${conflicted ? `<em class="conflict-dot" title="回执冲突待裁">!</em>` : blockIssues.length ? `<em>${blockIssues.length}</em>` : ""}
              </button>`;
            }).join("")}
          </div>
          <input id="chapter-file" type="file" accept=".txt,.md,.markdown" hidden />
          <sl-button class="import-button" variant="default" data-action="import">导入章节文本</sl-button>
          <div class="keyboard-note"><b>键盘</b><span><kbd>J</kbd><kbd>K</kbd> 跳转问题</span><span><kbd>E</kbd> 自动改写</span><span><kbd>⌘ Z</kbd> 撤销</span><span><kbd>1</kbd><kbd>2</kbd> 预览模式</span></div>
        </aside>

        <main class="editor-panel">
          <div class="editor-head">
            <div><span class="eyebrow">当前内容块</span><h1>${blockRole(active)}</h1></div>
            <div class="review-actions">
              <sl-tooltip content="${activeConflicts.length ? "该块有回执冲突，裁决完成前不能通过" : "审核通过"}">
                <sl-button size="small" variant="${active.reviewStatus === "approved" ? "success" : "default"}" ${activeConflicts.length ? "disabled" : ""} data-action="approve">${active.reviewStatus === "approved" ? "✓ 已通过" : "审核通过"}</sl-button>
              </sl-tooltip>
              <sl-button size="small" variant="${active.reviewStatus === "needs-work" ? "danger" : "default"}" data-action="needs-work">需修改</sl-button>
            </div>
          </div>

          ${activeConflicts.length ? `<div class="conflict-strip" role="alert">
            <div><b>⚠ ${activeConflicts.length} 处回执冲突并排待裁</b><span>学校离线稿与本地稿都修改了这一块，按字段选择保留哪一侧后才能审核通过。</span></div>
            <sl-button size="small" variant="warning" data-action="receipts">去裁决</sl-button>
          </div>` : ""}

          ${activeIssues.length ? `<div class="active-issues">${activeIssues.map((issue) => {
            const recomputed = staleNotices.some((notice) => notice.blockIds.includes(active.id) && issue.type === "glossary");
            return `
            <div class="issue-card ${issue.severity}">
              <div><sl-badge variant="${issue.severity === "error" ? "danger" : issue.severity === "warning" ? "warning" : "primary"}">${severityLabel(issue.severity)}</sl-badge><strong>${escapeHtml(issue.title)}</strong>${recomputed ? `<sl-badge variant="neutral" class="recomputed-badge">术语调整后已重算（旧结果失效）</sl-badge>` : ""}</div>
              <p>${escapeHtml(issue.detail)}</p><small>${escapeHtml(issue.suggestion)}</small>
            </div>`;
          }).join("")}</div>` : `<div class="issue-clear">✓ 当前内容块没有新的无障碍问题${staleNotices.some((notice) => notice.blockIds.includes(active.id)) ? "（术语相关检查已按新术语表重算）" : ""}</div>`}

          <section class="edit-card source-card">
            <div class="section-heading"><div><span class="eyebrow">原教材</span><h2>${active.type === "image" ? "图片信息" : active.type === "link" ? "链接信息" : "原文"}</h2></div><sl-badge variant="neutral">${active.type}</sl-badge></div>
            ${renderSourceEditor(active)}
          </section>

          <section class="edit-card rewrite-card">
            <div class="section-heading">
              <div><span class="eyebrow">Accessible rewrite</span><h2>无障碍表达</h2></div>
              <sl-button size="small" variant="primary" outline data-action="generate">生成易读版本</sl-button>
            </div>
            ${renderAccessibleEditor(active)}
            <label class="field-label" for="reason-${active.id}">改写原因（每处改写必须记录）</label>
            <sl-textarea id="reason-${active.id}" data-field="reason" rows="2" value="${escapeHtml(active.changeReason)}" placeholder="例如：拆分长句、替换专业表达、补充链接目的"></sl-textarea>
          </section>

          <section class="edit-card">
            <div class="section-heading"><div><span class="eyebrow">Review discussion</span><h2>批注与回复</h2></div><sl-badge variant="warning">${active.comments.length} 条</sl-badge></div>
            <div class="comment-compose"><sl-textarea id="new-comment" rows="2" placeholder="记录改写依据、审核意见或术语讨论…"></sl-textarea><sl-button size="small" variant="primary" data-action="add-comment">添加批注</sl-button></div>
            <div class="comment-list">
              ${active.comments.length ? active.comments.map((comment) => `
                <article class="comment ${comment.resolved ? "resolved" : ""}">
                  <header><b>${escapeHtml(comment.author)}</b><time>${new Date(comment.createdAt).toLocaleString()}</time></header>
                  <p>${escapeHtml(comment.body)}</p>
                  ${comment.replies.map((reply) => `<div class="reply"><b>${escapeHtml(reply.author)}</b><span>${escapeHtml(reply.body)}</span></div>`).join("")}
                  <div class="reply-row"><sl-input size="small" id="reply-${comment.id}" placeholder="回复…"></sl-input><sl-button size="small" data-action="reply" data-comment-id="${comment.id}">回复</sl-button><sl-button size="small" variant="text" data-action="resolve-comment" data-comment-id="${comment.id}">${comment.resolved ? "重新打开" : "解决"}</sl-button></div>
                </article>`).join("") : `<div class="empty-note">当前内容块还没有批注。</div>`}
            </div>
          </section>
        </main>

        <aside class="review-panel">
          <section class="preview-card">
            <div class="section-heading"><div><span class="eyebrow">Reader preview</span><h2>阅读预览</h2></div><div class="mode-switch"><button class="${previewMode === "normal" ? "active" : ""}" data-action="preview-normal">普通</button><button class="${previewMode === "assisted" ? "active" : ""}" data-action="preview-assisted">辅助</button></div></div>
            <div class="reader-preview mode-${previewMode}">${renderPreview()}</div>
          </section>

          <section class="order-card">
            <div class="section-heading"><div><span class="eyebrow">Screen reader order</span><h2>读屏阅读顺序</h2></div><sl-badge>从上到下</sl-badge></div>
            <ol class="reading-order">
              ${project.blocks.map((block, index) => `<li class="${block.id === active.id ? "active" : ""}"><b>${index + 1}</b><div><strong>${blockRole(block)}</strong><span>${escapeHtml(block.accessibleText || block.text || "（无内容）")}</span></div></li>`).join("")}
            </ol>
          </section>

          <section class="issues-panel">
            <div class="section-heading"><div><span class="eyebrow">All checks</span><h2>全章问题</h2></div><sl-tooltip content="${exportBlocked ? "存在未裁决的回执冲突，不能批量通过" : "将所有内容块标记为已通过"}"><sl-button size="small" variant="default" outline ${exportBlocked ? "disabled" : ""} data-action="approve-all">全部通过</sl-button></sl-tooltip></div>
            <div class="issue-list">
              ${list.length ? list.map((issue) => `<button class="${issue.id === activeIssueId ? "active" : ""} ${issue.severity}" data-action="jump-issue" data-issue-id="${issue.id}" data-block-id="${issue.blockId}"><span>${severityLabel(issue.severity)}</span><b>${escapeHtml(issue.title)}</b><small>段 ${project.blocks.findIndex((block) => block.id === issue.blockId) + 1} · ${escapeHtml(issue.suggestion)}</small></button>`).join("") : `<div class="issue-clear">✓ 全章检查通过</div>`}
            </div>
          </section>

          <section class="version-card">
            <div class="section-heading"><div><span class="eyebrow">Version compare</span><h2>版本比较</h2></div><sl-badge>${project.versions.length} 版</sl-badge></div>
            ${project.versions.length ? `
              <sl-select id="version-select" size="small" value="${version?.id ?? ""}">${project.versions.map((item) => `<sl-option value="${item.id}">${escapeHtml(item.label)} · ${new Date(item.createdAt).toLocaleTimeString()}</sl-option>`).join("")}</sl-select>
              <div class="version-diff">${version ? renderVersionDiff(version, active) : ""}</div>
            ` : `<div class="empty-note">保存版本后，可比较改写前后的无障碍文本。</div>`}
          </section>
        </aside>
      </div>

      <footer class="statusbar"><span>最近操作：${escapeHtml(document.documentElement.dataset.lastAction || "示例章节已载入")}</span><span>${project.blocks.length} 个内容块 · ${list.length} 个待处理问题</span></footer>
    </div>

    <sl-dialog label="全书术语表" ${showGlossary ? "open" : ""} data-dialog="glossary">
      <div class="glossary-editor">
        ${project.glossary.map((term) => `<div class="term-row"><div><b>${escapeHtml(term.source)}</b><sl-input size="small" value="${escapeHtml(term.preferred)}" data-term-id="${term.id}"></sl-input><small>${escapeHtml(term.note)}</small></div><sl-button size="small" variant="danger" outline data-action="remove-term" data-term-id="${term.id}">删除</sl-button></div>`).join("")}
      </div>
      <div class="term-add"><sl-input id="new-term-source" placeholder="原文术语"></sl-input><sl-input id="new-term-preferred" placeholder="统一表达"></sl-input><sl-button variant="primary" data-action="add-term">添加术语</sl-button></div>
      <sl-button slot="footer" variant="primary" data-action="close-glossary">完成</sl-button>
    </sl-dialog>
    ${renderReceiptsDialog()}`;

  wireLiveFields();
}

function fieldDisplay(value: string | number, field: RectField) {
  if (field === "reviewStatus") return statusLabel(value as ReviewStatus);
  if (field === "headingLevel") return `H${value}`;
  return String(value || "（空）");
}

function renderConflictPanel(conflict: PendingConflict) {
  const block = project.blocks.find((item) => item.id === conflict.blockId);
  const position = project.blocks.findIndex((item) => item.id === conflict.blockId) + 1;
  return `<article class="conflict-card">
    <header>
      <div><b>第 ${position} 块 · ${block ? blockRole(block) : "内容块已删除"}</b><span>批注号 ${escapeHtml(conflict.annotationId)} · 定位方式：${conflict.matchedBy === "block-id" ? "块标识" : "摘录与邻块"}</span></div>
      <sl-badge variant="danger">待裁 ${conflict.conflicts.length} 项</sl-badge>
    </header>
    ${conflict.conflicts.map((fieldConflict) => `
      <div class="conflict-field">
        <div class="conflict-field-head"><b>${FIELD_LABELS[fieldConflict.field]}</b>${fieldConflict.base !== undefined ? `<small>离线底稿：${escapeHtml(fieldDisplay(fieldConflict.base, fieldConflict.field))}</small>` : `<small>回执未提供底稿，按仅远端改动处理</small>`}</div>
        <div class="conflict-sides">
          <label class="conflict-side local">
            <input type="radio" name="${conflict.id}-${fieldConflict.field}" value="local" checked />
            <div><span>本地稿${!sameFieldHelper(fieldConflict.local, fieldConflict.base) ? "（已改）" : ""}</span><p>${escapeHtml(fieldDisplay(fieldConflict.local, fieldConflict.field))}</p></div>
          </label>
          <label class="conflict-side receipt">
            <input type="radio" name="${conflict.id}-${fieldConflict.field}" value="receipt" />
            <div><span>学校回执</span><p>${escapeHtml(fieldDisplay(fieldConflict.receipt, fieldConflict.field))}</p></div>
          </label>
        </div>
      </div>`).join("")}
    <div class="conflict-actions">
      <sl-button size="small" variant="default" data-action="conflict-pick-all" data-conflict-id="${conflict.id}" data-side="local">全选本地</sl-button>
      <sl-button size="small" variant="default" data-action="conflict-pick-all" data-conflict-id="${conflict.id}" data-side="receipt">全选回执</sl-button>
      <sl-button size="small" variant="primary" data-action="resolve-conflict" data-conflict-id="${conflict.id}">按所选裁决</sl-button>
    </div>
  </article>`;
}

function sameFieldHelper(a: unknown, b: unknown) {
  if (a === b) return true;
  if (typeof a === "string" && typeof b === "string") return a.replace(/\s+/g, "") === b.replace(/\s+/g, "");
  return false;
}

function renderReceiptsDialog() {
  const report = project.lastMergeReport;
  const conflicts = (project.pendingConflicts ?? []).filter((conflict) => !conflict.resolved);
  const batches = project.mergeBatches ?? [];
  return `
    <sl-dialog label="离线回执对账" class="receipt-dialog" ${showReceipts ? "open" : ""} data-dialog="receipts">
      <div class="receipt-dialog-body">
        <section class="receipt-import-card">
          <div class="section-heading"><div><span class="eyebrow">Import receipt</span><h2>导入学校结构化回执</h2></div></div>
          <p class="receipt-hint">先按块标识认块；块被拆分或移动时，再按摘录与邻块定位。只有一侧变化自动合入，两边都改过会进入下方并排待裁。</p>
          <sl-textarea id="receipt-input" rows="6" placeholder='{"receiptId":"RCV-…","school":"…","annotations":[…]}'></sl-textarea>
          <div class="receipt-import-actions">
            <sl-button size="small" variant="default" data-action="load-sample-receipt">载入示例回执</sl-button>
            <sl-button size="small" variant="default" outline data-action="simulate-fail-receipt">模拟写入失败（验证回滚）</sl-button>
            <sl-button size="small" variant="primary" data-action="apply-receipt">解析并对账合入</sl-button>
            <input id="receipt-file" type="file" accept=".json,application/json" hidden />
            <sl-button size="small" variant="default" data-action="pick-receipt-file">选择回执文件</sl-button>
          </div>
        </section>

        ${conflicts.length ? `<section class="conflict-arbitration">
          <div class="section-heading"><div><span class="eyebrow">Arbitration</span><h2>并排待裁（${conflicts.length} 处）</h2></div><sl-badge variant="danger">未裁决前不能通过/导出</sl-badge></div>
          <div class="conflict-list">${conflicts.map(renderConflictPanel).join("")}</div>
        </section>` : ""}

        ${report ? `<section class="report-card">
          <div class="section-heading">
            <div><span class="eyebrow">Return receipt</span><h2>回传回执 · ${escapeHtml(report.receiptId)}</h2></div>
            <sl-badge variant="${report.status === "completed" ? "success" : "warning"}">${report.status === "completed" ? "合批完成" : "待裁决"}</sl-badge>
          </div>
          <div class="report-meta">
            <span>学校：${escapeHtml(report.school)}</span>
            <span>合入：${new Date(report.mergedAt).toLocaleString()}</span>
            ${report.finishedAt ? `<span>收尾：${new Date(report.finishedAt).toLocaleString()}</span>` : ""}
            ${report.snapshotId ? `<span>新快照：${escapeHtml(report.snapshotId)}</span>` : ""}
          </div>
          <div class="report-items">
            ${report.items.map((item) => {
              const tone = outcomeLabel(item.outcome);
              return `<div class="report-item ${tone.tone}">
                <span class="report-outcome">${tone.label}</span>
                <div><b>${escapeHtml(item.annotationId)}</b><small>${item.matchedBy ? `定位：${item.matchedBy === "block-id" ? "块标识" : "摘录邻块"}${item.matchedBlockId ? ` → ${escapeHtml(item.matchedBlockId)}` : ""}` : escapeHtml(item.blockId ?? "")}</small><p>${escapeHtml(item.detail)}</p></div>
              </div>`;
            }).join("")}
          </div>
          ${report.glossaryApplied.length ? `<div class="report-glossary"><b>术语调整（相关检查已重算，旧结果失效）</b>${report.glossaryApplied.map((change: ReceiptGlossaryChange) => `<span>${change.action === "add" ? "新增" : change.action === "remove" ? "删除" : "改首选词"}：${escapeHtml(change.source ?? change.termId ?? "")}${change.preferred ? ` → ${escapeHtml(change.preferred)}` : ""}</span>`).join("")}</div>` : ""}
          <div class="report-actions">
            <sl-button size="small" variant="${report.status === "completed" ? "success" : "default"}" ${report.status === "completed" ? "" : "disabled"} data-action="download-report">下载回传回执 JSON</sl-button>
            ${report.status === "completed" ? "" : `<small>全部冲突裁决后批次收尾，届时可下载最终回执。</small>`}
          </div>
        </section>` : ""}

        ${batches.length ? `<section class="batch-history">
          <div class="section-heading"><span class="eyebrow">Batch history</span></div>
          ${batches.map((batch) => `<div class="batch-row"><b>${escapeHtml(batch.receiptId)}</b><span>${batch.annotationIds.length} 条 · ${new Date(batch.mergedAt).toLocaleString()}</span><sl-badge variant="${batch.status === "completed" ? "success" : "warning"}">${batch.status === "completed" ? "已完成" : "待裁决"}</sl-badge></div>`).join("")}
        </section>` : ""}
      </div>
      <sl-button slot="footer" variant="primary" data-action="close-receipts">完成</sl-button>
    </sl-dialog>`;
}

function renderSourceEditor(block: ContentBlock) {
  if (block.type === "image") {
    return `<div class="image-source"><img src="${escapeHtml(block.imageSrc ?? "")}" alt="" /><div><b>图注</b><p>${escapeHtml(block.text)}</p><b>现有替代文本</b><p>${escapeHtml(block.imageAlt || "（空）")}</p></div></div>
      <sl-input id="source-${block.id}" data-field="source" label="图注" value="${escapeHtml(block.text)}"></sl-input>
      <sl-input id="image-alt-${block.id}" data-field="image-alt" label="替代文本" value="${escapeHtml(block.imageAlt ?? "")}" help-text="描述图片传达的信息，不写“图片”二字。"></sl-input>`;
  }
  if (block.type === "link") {
    return `<sl-input id="source-${block.id}" data-field="source" label="原链接文案" value="${escapeHtml(block.text)}"></sl-input><sl-input id="link-href-${block.id}" data-field="link-href" label="链接地址" value="${escapeHtml(block.linkHref ?? "")}"></sl-input>`;
  }
  if (block.type === "heading") {
    return `<div class="heading-edit"><sl-select id="heading-level-${block.id}" data-field="heading-level" label="标题层级" value="${String(block.headingLevel ?? 2)}"><sl-option value="1">H1</sl-option><sl-option value="2">H2</sl-option><sl-option value="3">H3</sl-option><sl-option value="4">H4</sl-option></sl-select><sl-input id="source-${block.id}" data-field="source" label="标题文本" value="${escapeHtml(block.text)}"></sl-input></div>`;
  }
  return `<sl-textarea id="source-${block.id}" data-field="source" rows="4" value="${escapeHtml(block.text)}"></sl-textarea>`;
}

function renderAccessibleEditor(block: ContentBlock) {
  if (block.type === "image") {
    return `<sl-textarea id="accessible-${block.id}" data-field="accessible" rows="3" label="图片替代文本" value="${escapeHtml(block.imageAlt || block.accessibleText)}" help-text="读屏软件会朗读这里的内容。"></sl-textarea>`;
  }
  return `<sl-textarea id="accessible-${block.id}" data-field="accessible" rows="6" value="${escapeHtml(block.accessibleText)}"></sl-textarea>`;
}

function renderPreview() {
  return project.blocks.map((block, index) => {
    const content = escapeHtml(block.accessibleText || block.text);
    if (block.type === "heading") {
      const tag = `h${Math.min(6, Math.max(1, block.headingLevel ?? 2))}`;
      return `<${tag} class="${block.id === activeBlockId ? "active-block" : ""}"><span class="order-marker">${index + 1}</span>${content}</${tag}>`;
    }
    if (block.type === "image") {
      return `<figure class="${block.id === activeBlockId ? "active-block" : ""}"><img src="${escapeHtml(block.imageSrc ?? "")}" alt="${escapeHtml(block.imageAlt || block.accessibleText)}"><figcaption><span class="order-marker">${index + 1}</span>${escapeHtml(block.text)}</figcaption></figure>`;
    }
    if (block.type === "link") {
      return `<p class="${block.id === activeBlockId ? "active-block" : ""}"><span class="order-marker">${index + 1}</span><a href="${escapeHtml(block.linkHref ?? "#")}" onclick="return false">${content}</a><span class="link-role">链接</span></p>`;
    }
    return `<p class="${block.id === activeBlockId ? "active-block" : ""}"><span class="order-marker">${index + 1}</span>${content}</p>`;
  }).join("");
}

function renderVersionDiff(version: VersionSnapshot, current: ContentBlock) {
  const oldBlock = version.blocks.find((block) => block.id === current.id);
  if (!oldBlock) return `<div class="empty-note">当前内容块不在该版本中。</div>`;
  return `<div class="diff-column"><span>旧版</span><p>${escapeHtml(oldBlock.accessibleText || oldBlock.text)}</p></div><div class="diff-column current"><span>当前</span><p>${escapeHtml(current.accessibleText || current.text)}</p></div>`;
}

function wireLiveFields() {
  app.querySelectorAll<HTMLElement>("sl-input[data-field], sl-textarea[data-field], sl-select[data-field]").forEach((element) => {
    element.addEventListener("sl-input", () => {
      const value = (element as HTMLElement & { value: string }).value;
      updateActiveBlock((block) => {
        const field = element.dataset.field;
        if (field === "source") block.text = value;
        if (field === "accessible") {
          block.accessibleText = value;
          if (block.type === "image") block.imageAlt = value;
        }
        if (field === "image-alt") {
          block.imageAlt = value;
          block.accessibleText = value;
        }
        if (field === "link-href") block.linkHref = value;
        if (field === "reason") block.changeReason = value;
        block.reviewStatus = "pending";
      }, "编辑无障碍文本", false);
    });
    element.addEventListener("sl-change", () => render());
  });
}

app.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "undo") undo();
  if (action === "redo") redo();
  if (action === "select-block") {
    activeBlockId = target.dataset.blockId ?? activeBlockId;
    activeIssueId = "";
    render();
  }
  if (action === "jump-issue") {
    activeIssueId = target.dataset.issueId ?? "";
    activeBlockId = target.dataset.blockId ?? activeBlockId;
    render();
    requestAnimationFrame(() => app.querySelector<HTMLElement>(".editor-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
  if (action === "generate") {
    const block = activeBlock();
    const suggestion = block.type === "link"
      ? "打开水循环互动实验"
      : simplifyText(block.type === "image" ? block.imageAlt || block.text : block.text, project.glossary);
    updateActiveBlock((current) => {
      if (current.type === "image") current.imageAlt = suggestion;
      current.accessibleText = suggestion;
      current.changeReason ||= "拆分长句并替换复杂表达，保留原有知识信息。";
      current.reviewStatus = "pending";
    }, "生成易读版本");
  }
  if (action === "approve") {
    if (blockHasConflict(activeBlock().id)) return; // 未裁决前不能通过
    updateActiveBlock((block) => { block.reviewStatus = "approved"; }, "审核通过");
  }
  if (action === "needs-work") updateActiveBlock((block) => { block.reviewStatus = "needs-work"; }, "标记需修改");
  if (action === "add-comment") {
    const input = app.querySelector<HTMLElement & { value: string }>("#new-comment");
    const body = input?.value.trim();
    if (body) updateActiveBlock((block) => {
      block.comments.unshift({ id: uid("comment"), author: "当前编辑", body, createdAt: new Date().toISOString(), resolved: false, replies: [] });
    }, "添加批注");
  }
  if (action === "reply") {
    const commentId = target.dataset.commentId ?? "";
    const input = app.querySelector<HTMLElement & { value: string }>(`#reply-${CSS.escape(commentId)}`);
    const body = input?.value.trim();
    if (body) updateActiveBlock((block) => {
      block.comments.find((comment) => comment.id === commentId)?.replies.push({ id: uid("reply"), author: "当前编辑", body, createdAt: new Date().toISOString() });
    }, "回复批注");
  }
  if (action === "resolve-comment") {
    const commentId = target.dataset.commentId ?? "";
    updateActiveBlock((block) => {
      const comment = block.comments.find((item) => item.id === commentId);
      if (comment) comment.resolved = !comment.resolved;
    }, "更新批注状态");
  }
  if (action === "preview-normal") { previewMode = "normal"; render(); }
  if (action === "preview-assisted") { previewMode = "assisted"; render(); }
  if (action === "glossary") { showGlossary = true; render(); }
  if (action === "close-glossary") { showGlossary = false; render(); }
  if (action === "receipts") { showReceipts = true; receiptMessage = null; render(); }
  if (action === "close-receipts") { showReceipts = false; render(); }
  if (action === "clear-receipt-message") { receiptMessage = null; render(); }
  if (action === "dismiss-stale") dismissStaleNotices();
  if (action === "load-sample-receipt") {
    const input = app.querySelector<HTMLElement & { value: string }>("#receipt-input");
    if (input) input.value = JSON.stringify(createSampleReceipt(), null, 2);
  }
  if (action === "pick-receipt-file") app.querySelector<HTMLInputElement>("#receipt-file")?.click();
  if (action === "apply-receipt") {
    const input = app.querySelector<HTMLElement & { value: string }>("#receipt-input");
    if (input?.value.trim()) importReceiptText(input.value);
  }
  if (action === "simulate-fail-receipt") {
    const input = app.querySelector<HTMLElement & { value: string }>("#receipt-input");
    const raw = input?.value.trim() || JSON.stringify(createSampleReceipt());
    importReceiptText(raw, true);
  }
  if (action === "resolve-conflict") {
    const conflictId = target.dataset.conflictId ?? "";
    const conflict = (project.pendingConflicts ?? []).find((item) => item.id === conflictId);
    if (!conflict) return;
    const resolutions = {} as Record<RectField, ConflictSide | "">;
    for (const fieldConflict of conflict.conflicts) {
      const checked = app.querySelector<HTMLInputElement>(`input[name="${conflictId}-${fieldConflict.field}"]:checked`);
      resolutions[fieldConflict.field] = (checked?.value as ConflictSide) ?? "";
    }
    arbitrateConflict(conflictId, resolutions);
  }
  if (action === "conflict-pick-all") {
    const conflictId = target.dataset.conflictId ?? "";
    const side = (target.dataset.side ?? "local") as ConflictSide;
    app.querySelectorAll<HTMLInputElement>(`input[name^="${conflictId}-"]`).forEach((radio) => {
      if (radio.value === side) radio.checked = true;
    });
  }
  if (action === "download-report") downloadReturnReceipt();
  if (action === "add-term") {
    const source = app.querySelector<HTMLElement & { value: string }>("#new-term-source");
    const preferred = app.querySelector<HTMLElement & { value: string }>("#new-term-preferred");
    if (source?.value.trim() && preferred?.value.trim()) {
      commit("添加术语", (draft) => {
        const term = { id: uid("term"), source: source.value.trim(), preferred: preferred.value.trim(), note: "编辑新增术语" };
        draft.glossary.push(term);
        invalidateGlossaryChecks(draft, term);
      });
    }
  }
  if (action === "remove-term") {
    const termId = target.dataset.termId;
    commit("删除术语", (draft) => {
      const term = draft.glossary.find((item) => item.id === termId);
      if (term) invalidateGlossaryChecks(draft, term);
      draft.glossary = draft.glossary.filter((term) => term.id !== termId);
    });
  }
  if (action === "save-version") {
    const versionId = uid("version");
    commit("保存版本快照", (draft) => {
      draft.versions.unshift({ id: versionId, label: `版本 ${draft.versions.length + 1}`, createdAt: new Date().toISOString(), blocks: structuredClone(draft.blocks), glossary: structuredClone(draft.glossary) });
      draft.versions = draft.versions.slice(0, 10);
    });
    selectedVersionId = versionId;
    render();
  }
  if (action === "approve-all") {
    if (hasPendingConflictsGlobal()) return;
    commit("全部审核通过", (draft) => { draft.blocks.forEach((block) => { block.reviewStatus = "approved"; }); });
  }
  if (action === "export") {
    if (hasPendingConflictsGlobal()) {
      showReceipts = true;
      receiptMessage = { tone: "error", text: "仍有回执冲突未裁决，未裁决前不能导出无障碍 HTML。" };
      render();
      return;
    }
    download(`${project.title}-无障碍版.html`, exportHtml(project));
    document.documentElement.dataset.lastAction = "已导出无障碍 HTML";
    render();
  }
  if (action === "import") app.querySelector<HTMLInputElement>("#chapter-file")?.click();
});

app.addEventListener("sl-change", (event) => {
  const element = event.target as HTMLElement;
  if (element.id === "chapter-file") return;
  if (element.id.startsWith("heading-level-")) {
    const level = Number((element as HTMLElement & { value: string }).value);
    updateActiveBlock((block) => { block.headingLevel = level; block.reviewStatus = "pending"; }, "修改标题层级");
  }
  if (element.id === "version-select") {
    selectedVersionId = (element as HTMLElement & { value: string }).value;
    render();
  }
  if (element.matches("[data-term-id]")) {
    const termId = element.dataset.termId;
    const value = (element as HTMLElement & { value: string }).value;
    commit("修改术语表", (draft) => {
      const term = draft.glossary.find((item) => item.id === termId);
      if (term && term.preferred !== value) {
        term.preferred = value;
        invalidateGlossaryChecks(draft, term);
      }
    });
  }
});

app.addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id === "chapter-file" && input.files?.[0]) {
    void input.files[0].text().then((text) => {
      commit("导入章节文本", (draft) => {
        draft.blocks = parseImportedChapter(text);
        activeBlockId = draft.blocks[0]?.id ?? "";
        activeIssueId = "";
      });
    });
    return;
  }
  if (input.id === "receipt-file" && input.files?.[0]) {
    void input.files[0].text().then((text) => {
      const target = app.querySelector<HTMLElement & { value: string }>("#receipt-input");
      if (target) target.value = text;
    });
  }
});

app.addEventListener("input", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id === "project-title") {
    project.title = input.value;
    saveSoon();
  }
});

window.addEventListener("online", render);
window.addEventListener("offline", render);
window.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  if (target.matches("input, textarea, sl-input, sl-textarea, [contenteditable='true']")) return;
  const command = event.metaKey || event.ctrlKey;
  if (command && event.key.toLowerCase() === "z") {
    event.preventDefault();
    event.shiftKey ? redo() : undo();
    return;
  }
  if (command && event.key.toLowerCase() === "s") {
    event.preventDefault();
    const versionId = uid("version");
    commit("键盘保存版本", (draft) => { draft.versions.unshift({ id: versionId, label: `版本 ${draft.versions.length + 1}`, createdAt: new Date().toISOString(), blocks: structuredClone(draft.blocks), glossary: structuredClone(draft.glossary) }); });
    selectedVersionId = versionId;
    return;
  }
  if (event.key.toLowerCase() === "j" || event.key.toLowerCase() === "k") {
    const list = issues();
    if (!list.length) return;
    const current = Math.max(0, list.findIndex((issue) => issue.id === activeIssueId));
    const next = (current + (event.key.toLowerCase() === "j" ? 1 : -1) + list.length) % list.length;
    activeIssueId = list[next].id;
    activeBlockId = list[next].blockId;
    render();
  }
  if (event.key.toLowerCase() === "e") {
    const button = app.querySelector<HTMLElement>('[data-action="generate"]');
    button?.click();
  }
  if (event.key === "1") { previewMode = "normal"; render(); }
  if (event.key === "2") { previewMode = "assisted"; render(); }
});

render();
