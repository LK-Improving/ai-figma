# `@miaoma/codex-provider`

S0 adapter for generating one `GeneratedFrameContent` value through a locally installed Codex CLI. Creating the provider is opt-in; it does not check the CLI or contact a model until `checkAvailability()` or `generateFrame()` is called.

```ts
import { CodexCliFrameProvider } from '@miaoma/codex-provider';

const provider = new CodexCliFrameProvider({
  executablePath: 'C:/path/to/codex.exe', // optional; omit to discover the installed CLI automatically
  timeoutMs: 180_000,      // optional, 1 second–10 minutes
  maxOutputBytes: 1_048_576
});

const content = await provider.generateFrame({
  title: 'Travel landing page',
  prompt: 'A calm, editorial travel homepage with a clear booking action.'
}, { signal: abortController.signal });
```

The adapter starts `codex exec --json` with `shell: false`, pipes the prompt through stdin, and requests the strict `{ frameName, headline, description }` JSON contract using `--output-schema` and `--output-last-message`. It runs from a fresh temporary directory, uses Codex's `read-only` sandbox and ephemeral session mode, enforces time/output/response limits, and removes the temporary files when the call ends. It never writes prompt, stderr, or JSONL events to application logs; errors expose a fixed message, stable code, retryability, and (for a nonzero exit) the exit code, without returning CLI output.

The local CLI uses its existing Codex configuration and authentication. A generation request sends the title and prompt to whichever model/provider that CLI is configured to use, so this adapter requires network access for cloud models. Local file storage does not make inference offline. `checkAvailability()` only runs `codex --version` and does not make a model request. The application should call either method only after an explicit user action and show the configured data destination before generation.

On Windows, automatic discovery checks PATH, the native binary inside npm's global Codex package, and `%LOCALAPPDATA%/OpenAI/Codex/bin`. It works when an Explorer-launched application inherits a stale PATH and never executes `.cmd` or `.ps1` shims through a shell. `MIAOMA_CODEX_PATH` can specify an absolute `codex.exe` path; an explicit `executablePath` takes precedence. Discovery runs on each request so a CLI installed while MyFigma is open can be found on the next attempt.

Build with `pnpm --filter @miaoma/codex-provider build` after workspace dependencies have been installed and built.
