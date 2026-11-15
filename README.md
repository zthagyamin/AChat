# AChat (AgentChat) v3.0

**AChat** 是一个面向 **Codex**、**Antigravity**、**Claude**、**OpenCode** 与 **Ollama** 的多智能体协同客户端（支持 **Windows Electron 桌面端**、**Web / PWA** 与 **Android 原生客户端**），让多个 AI Agent 在群聊中对齐方案、分工派发到各自真实 IDE 会话并行执行，并通过实时任务看板同步进度、在遇到分歧时自动回群沟通。

## 核心特性

- **群聊对齐 + IDE 双路并发协作**
  - 先在群聊中对齐目标与接口契约，再将任务路由到对应项目的真实 `Codex` / `Antigravity` IDE 会话并发执行。
  - **IDE 实时任务进度看板（#ideTaskBoard）**：集中展示每个 Agent 的当前阶段、步骤清单、心跳与最近动作；发生分歧、阻塞或关键节点时自动回群同步。
- **双可选界面皮肤（即时无刷新切换）**
  - **方案 A · 极简工作台（`workbench`，默认）**：Neutral Zinc 色板（`oklch` + `light-dark()`）、单色线框 SVG 图标、默认展开的双列 IDE 进度看板、`82ch` 阅读流与底部悬浮输入卡。
  - **方案 B · 沉浸阅读（`editorial`）**：暖纸白 / 暖炭黑 + 陶土橙配色、圆形头像、居中单行胶囊看板（可一键展开步骤）、`68ch` 无边框开放画布正文与大圆角悬浮输入卡。
- **零打扰待机网关 & 跨端唤醒**
  - 支持 `--standby` 静默待机网关（空闲后自动停止守护与活跃群组、不乱弹窗），收到本地界面或手机端请求时秒级自动唤醒。
  - 集成局域网二维码配对、AES-256-GCM 加密云信标（`tunnel-manager.mjs`）、Tailscale MagicDNS 发现与远端桌面实时画面预览。
- **群内决策卡片与 Git 闭环**
  - 支持群内审批/选项交互卡片（单次结算防重提交）、实时思维与工具轨迹面板，以及一键 Git 状态检视、Worktree 隔离与提交。
- **Android 伴侣客户端 (`android-app/`)**
  - 原生 Kotlin 客户端，支持系统双向分享、后台通知直达、主题色同步、加密信标自动换绑与 `achat://` / `agentwechat://` Deep Link。

## 快速开始

### 1. 环境准备

- **Node.js** `>= 22`（内置 `node:sqlite` 与 `node --test`）
- 可选协作引擎与 CLI：[`cccc`](https://github.com/chester-he/cccc)（多 Agent 群组编排）、`codex`、`agy`（Antigravity CLI）

### 2. 安装依赖与启动

```bash
git clone https://github.com/zthagyamin/AChat.git
cd AChat
npm install
```

- **启动 Web 服务（默认 `http://127.0.0.1:8866`）**：

  ```bash
  npm run web
  ```

- **启动静默待机网关**：

  ```bash
  node server/index.mjs --standby
  ```

- **启动 Electron 桌面客户端**：

  ```bash
  npm start
  ```

- **运行自动化测试**：

  ```bash
  npm test
  ```

## 常用环境变量

所有本机二进制与默认目录均支持通过环境变量覆盖，未配置时自动基于 `os.homedir()` 解析：

| 变量名 | 说明 | 默认解析逻辑 |
| :--- | :--- | :--- |
| `PORT` | Web / API 监听端口 | `8866` |
| `CCCC_BIN` | `cccc` 可执行文件路径 | `~/.local/bin/cccc(.exe)` |
| `AGY_BIN` | Antigravity CLI 路径 | `~/AppData/Local/agy/bin/agy.exe`（Windows）或 `agy` |
| `AGY_MCP_CONFIG_PATH` | MCP 配置文件路径 | `~/.gemini/config/mcp_config.json` |
| `ACHAT_DEFAULT_ROOM_DIR` | 新建群聊默认工作目录 | 同级 `../cccc-room`（若存在）或 `./data/workspace` |
| `ACHAT_UPLOADS_DIR` | 上传文件存储目录 | `../cccc-room/uploads`（若存在）或 `./data/uploads` |
| `ACHAT_EXTRA_PATH` | 追加子进程 `PATH` 目录 | 可选，多路径以系统分隔符拼接 |

## 目录结构

```text
AChat/
├── server/          # Node HTTP/SSE 网关、CCCC 桥接、IDE 路由、协作看板与隧道管理
├── public/          # Web / PWA 前端界面、双皮肤 CSS Token 与 Service Worker
├── electron/        # Electron 桌面壳、托盘与窗口控制
├── android-app/     # Android 原生伴侣客户端源码与单元测试
├── test/            # node:test 端到端与前端契约测试集（33 项）
├── scripts/         # 图标生成与辅助构建脚本
└── THIRD_PARTY_NOTICES.md
```

## 开源许可与致谢

本项目基于 [MIT License](LICENSE) 开源；借鉴与适配的第三方开源项目声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
