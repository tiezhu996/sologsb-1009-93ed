# 教材无障碍改写工作台

面向教材编辑和特殊教育内容团队的无障碍改写、自动检查、审校与导出工具。项目预置科学教材章节示例并包含真实的待处理问题。

## 功能

- 导入 TXT、Markdown 章节文本；识别 Markdown 标题、图片和单行链接。
- 检查标题层级跳跃、图片替代文本缺失、链接文案不明确、长句和术语不一致。
- 将复杂段落按标点和语义拆为较短的易读表达，并统一术语表中的固定表达。
- 为每个内容块记录改写原因及待审核、已通过、需修改状态。
- 添加批注、回复和解决批注。
- 阅读预览可在普通模式和高对比、大字号辅助模式间切换。
- 以编号列表展示读屏软件从 H1 到正文、图片和链接的阅读顺序。
- 保存最多 10 个版本快照，并并排比较旧版和当前无障碍文本。
- 撤销/重做、自动保存、离线继续编辑。
- 离线回执按内容块对账：先认块标识；块被拆分或移动后，按摘录和邻块定位。只有一侧变化自动合入，两边都改过则字段级并排待裁，未裁决前相关块不能通过、全文不能导出。
- 写入失败自动恢复合并前状态；失败重试不重复增加批注和版本快照；合批完成后生成新快照并可下载回传回执。
- 术语（含随回执的术语调整）改动后，相关一致性检查立即标记“已重算（旧结果失效）”。
- 导出完整无障碍 HTML：包含 `lang`、跳转正文链接、语义标题、图片 `alt`、描述性链接、键盘焦点样式和屏幕阅读器可读结构。
- 键盘操作：`J`/`K` 跳转问题，`E` 生成易读版本，`1`/`2` 切换预览模式，`Ctrl/Cmd+Z` 撤销，`Ctrl/Cmd+Shift+Z` 重做，`Ctrl/Cmd+S` 保存版本。

## 技术栈

- Astro 7 + TypeScript
- Shoelace Web Components
- 原生 DOM/CSS 与浏览器 `localStorage`
- 静态 HTML 构建、nginx 容器部署

## 开发

需要 Node.js 22.12 或更高版本。

```bash
npm install
npm run dev
```

## 检查与构建

```bash
npm run check
npm run build
npm run preview
npm test            # 回执对账纯函数测试（Node ≥ 22.6，原生执行 TS）
```

`npm run build` 会先执行 Astro 类型/内容检查，再生成 `dist/` 静态产物。

## 离线回执对账

顶栏「回执对账」打开对账面板，可直接粘贴或选择学校结构化回执（JSON），也可载入内置示例回执走完整流程。

### 回执结构

```json
{
  "receiptId": "RCV-2026-1004-01",
  "school": "启明特教学校",
  "issuedAt": "2026-10-04T09:30:00.000Z",
  "baseSnapshotId": "offline-base",
  "annotations": [
    {
      "annotationId": "ann-1",
      "blockId": "block-p1",
      "excerpt": "雨水花园利用土壤和植物",
      "prevExcerpt": "雨水花园怎样工作",
      "nextExcerpt": "减轻排水管的压力",
      "comment": { "author": "王老师", "body": "建议…" },
      "resolveCommentId": "comment-3",
      "rectification": {
        "base": { "accessibleText": "离线时编辑室原稿的内容" },
        "changes": { "accessibleText": "学校改后的内容", "reviewStatus": "approved" }
      }
    }
  ],
  "glossaryChanges": [
    { "termId": "term-2", "action": "update-preferred", "preferred": "顺着地面流动的水" },
    { "action": "add", "source": "韧性", "preferred": "不怕变化" },
    { "termId": "term-9", "action": "remove" }
  ]
}
```

对账规则：

1. **先认块标识**：`blockId` 命中即用；块被删除、拆分或移动后，退到 `excerpt` 摘录匹配，多个候选再用 `prevExcerpt` / `nextExcerpt` 邻块消歧；仍不唯一则列为「未能定位」，不改动内容。
2. **三方字段对账**：整改条目的 `rectification.base` 是学校离线时依据的编辑室版本。字段在本地与 base 一致（只有学校一侧改）即自动合入；两边都与 base 不同则并排待裁。未提供 base 的字段按“仅远端改动”自动合入。
3. **并排待裁闸门**：每个冲突字段并排展示本地稿和学校回执，可选「全选本地/全选回执」或逐字段选择。存在未裁决冲突时，对应块「审核通过」按钮禁用、「全部通过」禁用、「导出无障碍 HTML」禁用。
4. **失败安全**：合入先在副本上完成并写入暂存键，再替换正式存储；任一步失败恢复合并前状态。同一条批注按 `annotationId`/作者+内容去重，同一回执重传整体跳过，重试不会重复增加批注、术语或版本。
5. **收尾**：无冲突时合入即生成「回执合批快照」；有冲突时所有裁决完成后自动生成新快照，批次状态变为「合批完成」，即可下载回传回执（JSON，含每条 annotation 的定位方式、合入字段、冲突与快照号）。
6. **术语联动**：`glossaryChanges` 或编辑室内修改术语后，命中该术语的内容块的术语一致性检查标记为「术语调整后已重算（旧结果失效）」，问题计数按新术语实时计算。

## Docker

容器内 nginx 监听 `80`，宿主端口按根端口映射为 `10009`。

```bash
docker build -t sologsb-1009 .
docker run --rm -p 10009:80 sologsb-1009
```

访问 `http://localhost:10009`。

## 数据说明

章节、改写原因、批注、术语和版本均保存在当前浏览器 `localStorage`。导出的 HTML 是独立文件，不依赖后端，但演示图片使用内嵌 SVG；接入真实教材时应替换为可访问的正式图片地址并复核替代文本。
