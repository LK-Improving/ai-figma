# MyFigma Windows MVP 试用说明

本文面向 Windows x64 本地试用。当前版本为开发阶段的 0.1.0，不含代码签名；Windows SmartScreen 可能显示未知发布者提示。请只从可信的项目构建产物运行。

## 安装与启动

从项目构建产物目录 `output/release/` 获取 `MyFigma-<version>-win-x64.exe`，运行安装程序并按向导完成安装。应用数据保存在当前 Windows 用户的 Electron `userData` 目录中；卸载应用不会自动清除这些设计文件。MyFigma 会继续读取已有的 `Miaoma Studio` 或 `miaoma-studio` 用户数据目录，改名不会迁移或删除设计文件。备份或迁移时，请从应用数据目录复制 `projects` 文件夹，并另行保存便携导出包。

开发者也可在仓库根目录执行 `pnpm install`、`pnpm build`、`pnpm build:desktop`，然后用 `pnpm start:desktop` 启动开发版。`pnpm package:windows` 构建 Windows x64 NSIS 安装包；安装包写入 `output/release/`。Node.js 22.12+ 和 pnpm 10 是构建要求，普通安装后的桌面编辑不需要 Node.js。

## 第一次设计

应用启动后会打开项目中心，列出本机已保存的项目并支持按名称搜索、继续编辑和导入设计。填写需求并点击“创建项目并规划设计”会创建独立项目，将需求带入 AI 生成面板；选择生成服务后可查看区域计划再开始执行。在编辑器中点击“项目中心”可切换已有项目，点击“新建设计”可直接创建独立设计。在画布上可选择 Frame、矩形、椭圆、图标和文本节点，通过图层面板、属性面板、拖动、缩放和撤销/重做编辑。设计自动保存，也可使用工具栏的保存操作立即写入快照。

导入 PNG 时，当前单张限制为 25 MiB，项目图片压缩数据总量限制为 100 MiB，解码像素总数限制为 32 Mi。使用“打开设计”可将支持的 JSON 或 MyFigma 便携导出包导入为新项目；PNG 导出支持 1×/2×，受 4096 像素边长限制。便携导出包可在另一份 MyFigma 项目中重新打开。

## AI 生成与审查

在生成面板输入需求并选择执行配置。默认 `local-fake` 是不联网的确定性演示 Provider，用于验证编辑与 Run 流程；它不代表真实模型生成质量。视觉审查默认使用本地规则。需要 DeepSeek 多模态审查时，点击工具栏“视觉模型”，在设置中粘贴 API Key 并保存；应用会在 Electron 主进程通过 `safeStorage` 加密保存，不会在设置界面回显，也不会写入项目、导出包或日志。连接测试会单独向 DeepSeek 发送一段短文本，不包含当前设计。

要启用云端视觉审查，勾选“同意将当前设计截图和页面结构摘要发送到 DeepSeek”，再选择 DeepSeek Flash。之后每次生成的视觉检查会把当前目标页截图和可见图层摘要（包括图层文字）发给 DeepSeek；设计内容可能含有敏感信息，启用前请先确认外发范围。取消授权会切回本地规则并中止未完成请求；已经发出的数据无法撤回。若截图缺少图片资产，本轮会改用本地审查并保留资产阻断问题，不会将不完整截图发送到 DeepSeek。也可删除 API Key，删除后同样回到本地规则。Provider 的调用只用于视觉审查，设计生成仍使用所选生成 Provider，自动修复继续由本地规则执行。

生成结果先进入候选方案，不会静默覆盖正式设计。检查 Run 事件、候选画面和校验报告后，再选择应用、保留当前内容或复制为新项目。质量闭环最多执行 3 次检查、2 轮修复；DeepSeek 审查请求失败、超时或返回无效结果时会失败关闭并要求人工复核，不会把模型错误当作通过。字体环境在正式环境默认标记为未核验。

Codex CLI 模式会自动查找 PATH、npm 全局安装中的原生可执行文件及 Codex 桌面应用目录。如果仍显示 `CLI_NOT_FOUND`，可在启动应用前设置 `MIAOMA_CODEX_PATH` 为本机 `codex.exe` 的完整路径并重启。CLI 使用本机已有的登录与模型配置；未找到 CLI 时会显示中文修复提示。

## React 预览与工程导出（S6）

在“代码交付”面板选择 1440、768 或 390 像素视口，可查看当前设计生成的静态预览、代码文件清单、DSL/资源校验、响应式检查和交互绑定报告。预览绑定当前文档 revision 和所选页面，切换项目或修改设计后需重新生成；较大的图片可能为控制预览数据量而省略，但完整资源会随 React 项目导出。预览文件由应用的只读本地协议提供，受严格 CSP 保护，并运行在无同源权限的 sandbox iframe 中。绑定只支持点击跳转、打开模拟弹窗、切换节点可见状态和显示模拟提交结果，这些操作不连接真实路由、服务端或业务 API。

填写项目名并选择保存目录后，应用会把 React + TypeScript + Vite 工程输出到新子目录。不会覆盖已存在的目标目录，也不会自动安装依赖或运行生成项目；开发者可在导出目录自行执行 `npm install` 和 `npm run build`。导出前请先检查画面与验证报告，代码生成不会替代人工审查。

回归入口为 `pnpm poc:s6`，会在 `artifacts/s6-poc/run-*` 中运行隔离的 Electron 验收并生成结果摘要；测试会实际加载隔离 iframe 并执行 mock 交互，验证 opaque origin、预览 CSP、revision 冲突、三种视口报告、目录碰撞与路径校验。开发验收还在干净临时目录执行 `pnpm --filter @miaoma/codegen test:generated-build`，确认生成工程可以安装依赖并由 Vite 构建；桌面应用不会代用户执行这两步。

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
pnpm poc:s6
pnpm perf:s5
```

`poc:s5` 使用隔离的 S2 运行目录，创建项目并生成候选、编辑和保存，再启动真实 Sidecar 和独立 MCP SDK 客户端读取同一 revision。验收摘要写到 `artifacts/s5-poc/run-*`，其生成阶段还会在 `artifacts/s2-poc/run-*` 留下配套支持数据。`poc:s6` 使用新的隔离用户数据与导出目录，实际打开 Renderer 并验收交互更新、静态预览、三视口报告和 React 工程导出。性能 smoke 使用合成文档并写到 `artifacts/s5-perf/run-*`；它用于比较当前机器与后续构建，不是跨硬件 SLA，也不调用模型。

## 当前试用边界

- 首发打包目标是 Windows x64；当前没有代码签名、自动更新器、macOS 安装包或企业部署策略。
- S6 React 导出不会在桌面应用内执行 npm install/build；项目包含静态 viewport 检查与 mock 交互，未接真实 API、后端路由或业务提交。
- 默认设计生成模型是本地 Fake Provider；Codex CLI 仅在显式选择且本机已登录时可用。DeepSeek Flash 仅用于用户显式启用的视觉审查，不负责生成和修复设计。
- 本地视觉审核使用 DSL 与确定性规则；DeepSeek 模式会发送当前页截图和可见节点摘要，不检查浏览器像素，也无法确认用户实际看过证据。
- MCP 是本机只读集成；VS Code/Cursor 的真实 GUI 验收要按 A10 流程在安装后的试用机上完成。
- 关闭应用会保存设计快照；S5 回归、MCP 和安装包试用只能对合成/可丢弃项目执行。
