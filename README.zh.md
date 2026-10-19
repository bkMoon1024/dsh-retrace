<div align="center">

# 🧭 dsh-retrace · 会话时光机

**为 DeepSeek Harness 带来优雅的消息撤回、原地编辑、重新生成与代码产物版本化**

[![Version](https://img.shields.io/badge/version-0.4.55-blue.svg?style=flat-square)](https://github.com/daha1216/dsh-retrace/commits/main)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](https://github.com/daha1216/dsh-retrace/blob/main/LICENSE)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4A90D9.svg?style=flat-square)](https://github.com/topics/dsh-plugin)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://github.com/daha1216/dsh-retrace/pulls)

**简体中文** · [English](./README.md)

</div>

---

在使用 DeepSeek Harness 时，你是否也遇到过这些烦恼？
- **手抖按错回车** 或 **Prompt 漏了核心约束**，只能眼睁睁看着智能体洋洋洒洒跑偏，不得不新建会话重来？
- 智能体执行了一长串工具调用，结果把代码写坏了，**不仅想撤销对话，更想把改动的文件一并复原**？
- 想尝试不同的方案路线，却不敢轻易在当前会话中推倒重试？

**dsh-retrace** 让你的每一次探索都安全、可逆。它深度融入 DSH 原生交互，提供**整轮消息撤回、原地编辑重发、一键重新生成**，并配合**工作区产物快照与 Git 联动**，真正做到对话与代码「一同穿越」。

---

## 📸 实机体验

<div align="center">

| 原生级操作栏集成 | 撤回后整洁的会话状态 |
| :---: | :---: |
| <img src="./assets/action-bar.png" width="340" alt="消息底部原生操作栏：编辑与撤回" /> | <img src="./assets/recall-banner.png" width="520" alt="撤回后整洁的会话状态横幅" /> |
| *用户消息底部原生内嵌「编辑」与「撤回」操作胶囊，视觉高度统一* | *一键撤回整轮 Prompt、回复与工具执行；状态提示清晰，上下文干净如初* |

</div>

---

## ✨ 核心特性

### 1. ↩ 无痛整轮撤回（Recall）
- **一键抹去整轮交互**：不仅收起用户 Prompt，连同该轮生成的回复、执行的十多行 Tool Calls 工具过程一同从视图与模型上下文中彻底移除。
- **输入框智能回显**：撤回后，上一轮的 Prompt 原文会自动回显到输入框中，无需重新打字，微调即可再次发送。
- **防误触双重确认**：关键撤回操作带有两步防误触保护，避免手滑造成误操作。

### 2. ✎ 原地编辑重发（Edit & Resend）
- **Prompt 即时修改**：点击消息底部的「编辑」，支持在当前位置直接修改历史提问。
- **「原提问」对照块**：重发后，新提问下方可自动保留折叠的「原提问」对照，改了什么一目了然（仅作 UI 展示，不占用模型上下文）。
- **灵活的上下文模式**：默认仅替换被编辑的那一轮；也可在设置中选择「从新对话开始」，开启全新探索分支。

### 3. ↻ 一键重新生成（Regenerate）
- 悬停于任意助手回复，点击「重新生成」，即可保留提问、清空当前回答，让智能体换个思路重新作答。

### 4. ↩️ 对话与代码产物双重回退（Artifact Rollback）
- **告别手动找 Git Diff**：回退如果只退对话，改坏的代码依然留在工作区。dsh-retrace 在每次回退时自动为修改的文件记录快照。
- **三维回退选项**：支持 **「仅对话」**、**「仅产物代码」** 或 **「两者一同回退」**。
- **Git 深度联动 + 快照兜底**：若工作区为 Git 仓库，优先使用原生 Git 版本管理；非仓库环境则使用内部内容寻址快照存储（`~/.dsh/dsh-retrace/objects`）。
- **工作区未保存保护**：当工作区存在未提交的脏改动时，自动拒绝危险覆盖，杜绝代码丢失风险。

### 5. 🧭 版本时间线与分叉图（Timeline & Fork Map）
- **版本时间线**：会话面板内新增与官方「对话/轨迹」平级的「版本」Tab，实时展示每个版本的类型（撤回/编辑/恢复）、触发时间、消息数与文件变更徽标。
- **会话谱系树**：可视化展示多分支会话的 Branch Points 与 Parent-Session 继承链，多方案横向探索毫无心理负担。

### 6. 🎨 原生级设计与深色模式完美适配
- 完全对齐 DSH 官方设计规范与 Design Tokens，原生感拉满，绝无突兀的外挂感。
- 0.4.55 起全面修复深色主题配色，按钮与开关拥有完美的对比度表现。

---

## ⚡ 快速安装

> **前置条件**：已安装并配置带有 `dsh` CLI 的 DeepSeek Harness 环境。

### 方式一：推荐通过 Profile 安装（GitHub 源）

在终端中执行以下命令（以 Desktop 为例）：

```sh
# 安装到 DSH 桌面端 Profile
dsh plugin --profile desktop add github:daha1216/dsh-retrace

# 若在 Web 独立服务中使用
dsh plugin --profile web add github:daha1216/dsh-retrace
```

> 💡 **重要提示**：安装或更新完成后，**请完全退出并重新打开 DSH 桌面端**（独立 Web 部署请重启 `dsh` 进程并刷新浏览器）。正在运行的 DSH 宿主不会热加载新注入的 bundle 模块。
>
> 若系统中未将 `dsh` 注册到全局 PATH，可在命令前添加 `npx --yes -p @deepseek-ai/dsh`。

### 方式二：从本地目录安装（开发者推荐）

若想克隆本仓库到本地使用：

```sh
git clone https://github.com/daha1216/dsh-retrace.git ~/plugins/dsh-retrace
dsh plugin --profile desktop add ~/plugins/dsh-retrace
```

---

## 🛡️ 生产级安全与工程设计

为什么许多同类插件会导致会话损坏，而 **dsh-retrace** 能稳定运行在核心生产环境中？

```
 持久化事件日志（Append-only，只追加）               模型推理上下文与前端视图
 ┌───────────────────────────────────────┐          ┌───────────────────────┐
 │ … 历史消息                             │          │ … 历史消息            │
 │     ↓ 阴影区间                         │          │     ↓ 截断回退         │
 │ [目标消息 … 当前最新节点]              │   ───▶   │ (空 replace 节点生效) │
 │     ↳ 追加合法的空内容替换型事件       │          │                       │
 │       assistant/message (Empty)       │          │ 模型上下文完美重置    │
 └───────────────────────────────────────┘          └───────────────────────┘
```

1. **严格遵循 Append-only 事件模型**
   DSH 的底层通信与持久化基于事件日志流。传统的直接修改或截断日志文件会导致状态失步。dsh-retrace 通过**追加一条合法的空内容替换事件**（Shadowing）使指定区间失效，既让模型上下文与 UI 干净回退，又保留了不可篡改的审计追踪痕迹。
2. **写前三层契约拦截（Prewrite Guards）**
   回退事件在写入前通过 30+ 条契约规则严格校验，**绝对不会弄脏日志，也绝不会破坏 DSH 官方核心的 `/compact`（上下文压缩）机制**。
3. **并发写与运行时安全守护**
   - **智能空闲调度（Ensure Idle）**：当智能体正在流式输出时发起撤回，插件会自动安全取消推理并等待线程就绪（带 15 秒超时守护），杜绝并发写入冲突。
   - **有界存储回收（Bounded GC）**：文件快照默认保留最近 50 个版本（可在设置中 1–1000 范围自由调整），后台串行安全回收旧版本，带有宽限保护机制，绝不误删其他会话的数据。

---

## ⚙️ 设置项说明

在 DSH **设置 → 撤回** 面板中，你可以根据个人习惯调整以下选项：

| 设置项 | 默认值 | 详细说明 |
| :--- | :---: | :--- |
| **编辑后显示原提问对照** | **开** | 在重发的新消息下方保留折叠的「原输入」对照，方便查看修改差异（仅作 UI 展示，不进入模型上下文）。 |
| **按标记隐藏被编辑/撤回的消息** | **开** | 开启后，被撤回或重新生成替换的旧轮次在会话视图中自动收起，界面保持清爽；关闭则所有历史气泡均显示。*（注：当单次操作影响超过 40% 会话时会自动降级为不隐藏，防止内容静默消失）* |
| **编辑后从新对话开始** | **关** | 开启后，编辑旧消息时将连带隐藏其之前的历史，使会话从该处如同新对话般开始；默认关闭（仅替换当前轮）。 |
| **版本与产物快照** | **开** | 开启后，每次撤回与编辑均记录版本并备份变更的文件，提供时间线与产物回退；关闭后仅回退上下文（最节省空间）。 |
| **启用 Git 集成** | **开** | 当工作区为 Git 仓库时优先利用 Git 进行版本比对与还原；若非 Git 仓库，可在时间线中一键初始化（不影响日常分支）。 |
| **版本保留上限** | **50** | 文件快照保留的最大版本数（可设 1–1000），超出限制后自动平滑清理最旧快照。时间线文字记录始终完整保留。 |

---

## 🗂️ 会话考古 CLI（retrace）

安装插件后，配套的 `retrace` CLI 为开发者和审计人员提供了无需启动界面的纯命令行会话分析工具：

```sh
# 查看工具调用索引与调用统计
retrace index <sessionId|logPath>

# 正则查询某次命令调用的输入与输出
retrace query <sessionId> --cmd "npm run build"

# 导出特定模式的会话产出物
retrace extract <sessionId> --pattern "dist/.*" --out ./extracted

# 查看某文件在会话生命周期中的所有写入与编辑版本
retrace file-history <sessionId> src/index.ts

# 对比任意两个历史版本的行级 Diff
retrace file-diff <sessionId> src/index.ts 0 2

# 输出该会话的 Parent 派生链谱系
retrace lineage <sessionId>
```

---

## 🔄 更新日志（精选）

### v0.4.55
- **深色模式视觉与令牌深度重构**：全面对齐 DSH 官方 Design Tokens（`--dsw-alias-bg-layer-3`、`--dsw-alias-interactive-bg-hover` 等），修复深色模式下撤回编辑器、胶囊指示器与设置项开关的视觉失真问题。
- **高对比度无障碍提升**：调整主操作按钮的前景对比度（提升至 7.86:1 以上），设置开关旋钮对比度提升至 18:1。

### v0.4.54 & v0.4.53
- **沙箱安全写入修复**：修复 `git init` 在 `workspace-write` 沙箱模式下的写入权限与路径处理问题。

### v0.4.51 & v0.4.50
- **跨会话 GC 隔离与写并发守护**：加入串行化 GC 锁与 10 分钟写入宽限窗口，杜绝跨会话误删。
- **性能飞跃**：会话日志读取引入 Size+Mtime 缓存机制，客户端 Hook 改用索引查找，大对话下彻底消除逐行 O(N²) 开销。

---

## 👥 鸣谢与生态

- 核心架构灵感与原工程源自 [OfferKuai / Zhaofeng](https://github.com/yamingmou/dsh-retrace) 团队。
- 本仓库由 [daha1216](https://github.com/daha1216) 深度维护与维护更新，重点针对 DSH 0.2.x 运行时机制、深色模式适配、沙箱安全与日志健壮性进行生产级加固。
- 欢迎提交 [Issue](https://github.com/daha1216/dsh-retrace/issues) 与 [Pull Request](https://github.com/daha1216/dsh-retrace/pulls)！

---

## 📄 License

[MIT License](LICENSE) © 2026 OfferKuai & daha1216
