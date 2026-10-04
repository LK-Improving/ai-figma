import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

type DiscoveryOptions = {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
};

/** Resolve native binaries without executing npm's .cmd/.ps1 wrappers through a shell. */
export function resolveCodexExecutable(explicitPath?: string, options: DiscoveryOptions = {}): string {
  const env = options.env ?? process.env;
  const override = explicitPath ?? env.MIAOMA_CODEX_PATH;
  if (override !== undefined) return override;
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return 'codex';
  const home = options.home ?? homedir();
  const arch = options.arch ?? process.arch;
  const target = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const packageName = arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64';
  const npmBinary = (directory: string): string[] => [
    path.join(directory, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', packageName, 'vendor', target, 'codex', 'codex.exe'),
    path.join(directory, 'node_modules', '@openai', 'codex', 'vendor', target, 'codex', 'codex.exe')
  ];
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const pathDirectories = pathValue.split(';').map((value) => value.trim().replace(/^"|"$/g, '')).filter(Boolean);
  // Prefer the user's installed CLI. An app launched from Explorer may have a stale PATH.
  const candidates = pathDirectories.flatMap((directory) => [path.join(directory, 'codex.exe'), ...npmBinary(directory)]);
  const localAppData = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  const desktopBin = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  candidates.push(path.join(desktopBin, 'codex.exe'));
  candidates.push(...npmBinary(path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm')));
  try {
    const versions = readdirSync(desktopBin, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    for (const version of versions) candidates.push(path.join(desktopBin, version, 'codex.exe'));
  } catch { /* The desktop app is optional. */ }
  return candidates.find((candidate) => {
    try { return statSync(candidate).isFile(); } catch { return false; }
  }) ?? 'codex.exe';
}
