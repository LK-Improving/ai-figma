# Miaoma Studio Windows MVP 试用说明

本文面向 Windows x64 本地试用。当前版本为开发阶段的 0.1.0，不含代码签名；Windows SmartScreen 可能显示未知发布者提示。请只从可信的项目构建产物运行。

## 安装与启动

从项目构建产物目录 `output/release/` 获取 `Miaoma-Studio-<version>-win-x64.exe`，运行安装程序并按向导完成安装。应用数据保存在当前 Windows 用户的 Electron `userData` 目录中；卸载应用不会自动清除这些设计文件。备份或迁移时，请从应用数据目录复制 `projects` 文件夹，并另行保存便携导出包。

开发者也可在仓库根目录执行 `pnpm install`、`pnpm build`、`pnpm build:desktop`，然后用 `pnpm start:desktop` 启动开发版。`pnpm package:windows` 构建 Windows x64 NSIS 安装包；安装包写入 `output/release/`。Node.js 22.12+ 和 pnpm 10 是构建要求，普通安装后的桌面编辑不需要 Node.js。

## 第一次设计

应用启动后会打开一个本地演示设计。点击“新建项目”创建独立项目；在画布上可选择 Frame、矩形、椭圆、图标和文本节点，通过图层面板、属性面板、拖动、缩放和撤销/重做编辑。设计自动保存，也可使用工具栏的保存操作立即写入快照。

导入 PNG 时，当前单张限制为 25 MiB，项目图片压缩数据总量限制为 100 MiB，解码像素总数限制为 32 Mi。使用“打开设计”可将支持的 JSON 或 Miaoma 便携导出包导入为新项目；PNG 导出支持 1×/2×，受 4096 像素边长限制。便携导出包可在另一份 Miaoma 项目中重新打开。

## AI 生成与审查

在生成面板输入需求并选择执行配置。默认 `local-fake` 是不联网的确定性演示 Provider，用于验证编辑与 Run 流程；它不代表真实模型生成质量。当前仓库还没有 DeepSeek 多模态 Provider，也没有可填写的 DeepSeek key 设置入口。请勿把 `DEEPSEEK_API_KEY` 写入项目文件或启动脚本；待 Provider 与 OS 凭据存储接通后再配置。

生成结果先进入候选方案，不会静默覆盖正式设计。检查 Run 事件、候选画面和校验报告后，再选择应用、保留当前内容或复制为新项目。内置自审目前由本地规则执行，最多 3 次检查、2 轮修复；它不调用视觉模型，也不等同于真实像素级人工审查。字体环境在正式环境默认标记为未核验。

## MCP 只读连接

打开“外部连接 / MCP”，选 VS Code、Cursor 或 Claude Desktop，阅读数据范围后明确授权当前项目与文档，再复制向导生成的配置到外部客户端要求的位置。应用不会替用户修改外部配置文件。撤销授权会让已启动 Sidecar 的后续读取失败；切换到其他项目或文档也会撤销原授权。

MCP 提供 `get_app_state`、`get_selected_node`、`get_nodes`、`get_screenshot`、`get_assets` 五个只读工具。需要在本机安装 Node.js，并使用支持 MCP 的客户端版本。客户端可能把读取的节点、截图或资产继续发送给其配置的云模型；试用时使用合成数据，并确认客户端的数据处理方式。MCP 不提供创建、修改或删除设计的工具。

VS Code 工作区配置使用 `.vscode/mcp.json` 的 `servers` 字段；Cursor 使用 `.cursor/mcp.json` 的 `mcpServers` 字段。连接后在客户端 Agent/Chat 实际调用五个工具，再用 S4/A10 步骤核对 revision、截图、资产和撤销授权。自动化 S5 回归验证了真实桌面 Bridge 与官方 MCP SDK 客户端；两个客户端中的人工 GUI 兼容验收仍需单独记录。

## 回归与性能基线

从仓库根目录执行：

```powershell
pnpm build
pnpm build:desktop
pnpm -r --if-present test
pnpm poc:s1
pnpm poc:s2
pnpm poc:s5
pnpm perf:s5
```

`poc:s5` 使用隔离的 S2 运行目录，创建项目并生成候选、编辑和保存，再启动真实 Sidecar 和独立 MCP SDK 客户端读取同一 revision。验收摘要写到 `artifacts/s5-poc/run-*`，其生成阶段还会在 `artifacts/s2-poc/run-*` 留下配套支持数据。性能 smoke 使用合成文档并写到 `artifacts/s5-perf/run-*`；它用于比较当前机器与后续构建，不是跨硬件 SLA，也不调用模型。

## 当前试用边界

- 首发打包目标是 Windows x64；当前没有代码签名、自动更新器、macOS 安装包或企业部署策略。
- 默认模型是本地 Fake Provider；Codex CLI 仅在显式选择且本机已登录时可用。DeepSeek 多模态 Provider 尚未实现。
- 视觉审核使用 DSL 与确定性 SVG 规则，不检查浏览器像素，也无法确认用户实际看过证据。
- MCP 是本机只读集成；VS Code/Cursor 的真实 GUI 验收要按 A10 流程在安装后的试用机上完成。
- 关闭应用会保存设计快照；S5 回归、MCP 和安装包试用只能对合成/可丢弃项目执行。
