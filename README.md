# Miaoma Studio S0

S0 establishes the versioned design document contract, package dependency direction, a Codex CLI adapter, a screenshot/render artifact, and a secure Main/preload/renderer request path.

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

`pnpm poc:cli` runs the generation contract in-process and prints the saved artifact paths. `pnpm poc` runs a hidden Electron window whose renderer invokes the allowlisted `frame:generateAndSave` IPC channel; it generates and validates a DSL v1 Frame, renders an SVG screenshot, persists `design.json`, `screenshot.svg`, and revision-bound `screenshot.json`, then writes the IPC outcome to `artifacts/s0-poc/poc-result.json`. Both use the local Fake Provider and save project artifacts under `artifacts/s0-poc`.

The desktop window uses a narrow context-isolated preload API, validates both DTO directions, checks the IPC sender, and writes under Electron's user-data directory. The screenshot proof is a deterministic SVG render so this S0 does not add a browser automation runtime. Raster PNG export remains a later Canvas implementation task.

When `MIAOMA_PROVIDER=codex` is set, the provider invokes the already-installed local Codex CLI in read-only, ephemeral mode. Prompt content is sent to that CLI and may be processed by its configured remote or local model provider. No Codex request runs just by building or launching the default POC.
