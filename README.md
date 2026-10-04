# MyFigma

MyFigma is a Windows-first AI design workspace prototype. S0–S5 establish the local editor, bounded AI-generation runs and visual-review loop, a read-only MCP bridge, and the Windows trial package. S6 adds deterministic React project export, responsive preview reporting, and prototype interaction bindings.

## Prerequisites

- Node.js 22.12 or newer
- pnpm 10
- `pnpm install` downloads the Electron runtime through the root `postinstall` hook; the desktop POC is intended for Windows first
- Codex CLI is optional; the app uses a local Fake Provider unless `MIAOMA_PROVIDER=codex` is set

## Build and run

```powershell
pnpm install
pnpm build
pnpm poc
pnpm start:desktop
```

For the Windows MVP installable and the complete local acceptance path, see [Windows MVP trial guide](docs/windows-mvp-trial.md). The installer is built with `pnpm package:windows`; `pnpm poc:s5` exercises the create/generate/edit/save/read-only MCP path, and `pnpm poc:s6` verifies the isolated React preview and export with synthetic data.

`pnpm poc:cli` runs the generation contract in-process and prints the saved artifact paths. `pnpm poc` runs a hidden Electron window whose renderer invokes the allowlisted `frame:generateAndSave` IPC channel; it generates and validates a DSL v1 Frame, renders an SVG screenshot, persists `design.json`, `screenshot.svg`, and revision-bound `screenshot.json`, then writes the IPC outcome to `artifacts/s0-poc/poc-result.json`. Both use the local Fake Provider and save project artifacts under `artifacts/s0-poc`.

The desktop window uses a narrow context-isolated preload API, validates both DTO directions, checks the IPC sender, and writes under Electron's user-data directory. The S0 prototype screenshot is a deterministic SVG render; the current desktop editor also supports Canvas-backed 1×/2× PNG export.

The default generation provider is a local deterministic fake for safe demonstrations. The Codex CLI adapter is available only when explicitly selected, and prompt content may be processed by the user's configured provider. Visual review defaults to local rules; DeepSeek Flash is optional through the toolbar's “视觉模型” settings, where the API key is encrypted by Electron safeStorage in the main process and cloud review requires explicit consent. No model request runs by building or launching the app; only an explicit connection test or a generation run with DeepSeek visual review enabled sends data to DeepSeek.
