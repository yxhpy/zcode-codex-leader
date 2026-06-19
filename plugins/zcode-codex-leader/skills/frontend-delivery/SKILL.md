---
name: frontend-delivery
description: 前端交付质量保障。当任务涉及前端、UI、组件、页面、视觉、样式、layout、响应式、design token 时加载。教 leader 如何派发前端 packet 到 worker 并建立视觉反馈闭环,避免 AI 味,复用设计系统。不触发纯后端/纯逻辑任务。
---

# Frontend Delivery

## 何时加载本技能

当前任务涉及前端、UI、组件、页面、视觉、样式、layout、响应式、design token 时加载。

不要在纯后端、纯逻辑、无视觉改动任务中加载。

## 核心原则:绝盲写,建视觉闭环

单一最大杠杆:绝不盲写前端,必须闭环视觉反馈。

业界共识,Claude Code 官方:"If you cannot verify it, do not ship it"。

官方 prompt 模式:

1. 贴参考截图
2. 实现
3. 截图运行结果
4. 比对
5. 列差异
6. 修正

本插件可用工具串成闭环:

1. 设计稿/参考图(或 agy 读设计稿) -> `codex_bridge.ts ask` 派发前端实现 packet
2. 经 `mcp-tool` 调 puppeteer MCP 截图运行结果
3. `codex_bridge.ts vision <截图> "比对设计稿与截图,列出间距/字体/颜色/布局偏差"`
4. 偏差作为新 packet 回传 `ask` 修正 -> 再截图 -> 直到一致

诚实标注:半自动(leader 触发截图+vision,人工看诊断决定迭代)比全自动稳妥。复杂 SPA/带登录态场景全自动闭环易出错,仍在社区探索中,非完全成熟。

## 反"AI 味"硬规则

把以下 do 规则注入每个前端 packet:

- 消灭模糊形容词:禁用 modern/clean/beautiful/user-friendly,强制指定设计流派,例如 Bento Grid、Neobrutalism、Swiss 极简等具体流派。
- Design Token 强制令:禁止任意值,例如 `p-[13px]`、`bg-[#f0f3f8]`、`w-[287px]`;必须用语义化 token,例如 `p-4`、`bg-background`、`text-muted-foreground`。业界共识,可把不规范样式概率降到 5% 以下。
- 分层渐进:不要一次性生成整页。第一步语义化 HTML 骨架(Grid/Flexbox 不加样式) -> 第二步填组件绑定组件库 -> 第三步交互细节(hover/focus-visible/transition)。
- 状态完整:每个交互元素必须有 `:hover`、`:active`、`:focus-visible`;覆盖 loading、empty、error、disabled、long-content 状态。
- 复用优先:先查 `src/components/ui/` 再造新组件;禁止未经允许装新 UI 库。

## 组件复用感知

- 项目有 Storybook:建议装 `@storybook/addon-mcp`,agent 直连读组件 API。2026 业界共识,成熟。
- 无 Storybook:维护 `docs/ui-component-registry.json`,列组件导入路径和用法。
- 配置 ignore 排除 `src/legacy/`,防 AI "学坏"。

## Writer/Reviewer 双后端模式

本插件有 codex worker(`ask`) + agy 两个后端。

官方强调"实现者不能当评分者"。

做法:codex worker 写前端 -> 用干净上下文派 agy 或另起 `ask` 做对抗审查,检查 diff 是否符合设计系统、是否有 AI 味。

## 长上下文分工

agy(1M 上下文)读整库/设计稿出架构方案 -> codex worker 落地代码。

诚实标注:长上下文注意力 U 型衰减。别无脑塞几百文件,只读目标文件和其 import 的组件定义,执行 context pruning。

## 模型固有限制

- 像素级对齐是硬伤:多模态模型把图切成 14x14 patch,按钮偏 3px 看不出来,靠 CSS 检查工具或人工微调。
- 全自动视觉闭环在复杂场景不稳。
