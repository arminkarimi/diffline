import { spawn } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the process after this many milliseconds. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with each chunk of stderr, for progress logs. */
  onStderr?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
}

export interface RunResult {
  code: number;
  stdout: string;
  /** stdout as bytes, for binary output such as git cat-file --batch. */
  stdoutBytes?: Buffer;
  stderr: string;
  /** True when the process was stopped by the timeout or the abort signal. */
  killed: boolean;
}

export class CommandError extends Error {
  readonly result: RunResult;
  constructor(message: string, result: RunResult) {
    super(message);
    this.result = result;
  }
}

/** Git never prompts, and SSH fails fast instead of hanging on a host key or password. */
export const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes -o ConnectTimeout=20",
};

/**
 * The environment for agent CLIs: what they need to run and sign in, and nothing else, so tokens and keys in the
 * user's environment (GH_TOKEN, AWS_*, ...) aren't there for a prompt-injected agent to read.
 */
export function agentEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_\w+|TZ|TMPDIR|TEMP|TMP|TERM|COLORTERM|NO_COLOR|XDG_\w+|SystemRoot|APPDATA|LOCALAPPDATA|USERPROFILE|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|ANTHROPIC_\w+|CLAUDE_\w+|CLAUDE_CODE_\w+|AWS_BEARER_TOKEN_BEDROCK|CODEX_\w+|OPENAI_\w+)$/;
  return Object.fromEntries(Object.entries(base).filter(([k, v]) => v !== undefined && keep.test(k)));
}

/**
 * The environment for Pi: agentEnv, plus Pi's own settings and the variables Pi's built-in providers read (Pi 0.73,
 * packages/ai env-api-keys.ts), named one by one so other keys in the user's environment stay out. Never GitHub's
 * tokens, so Pi's GitHub Copilot provider signs in with /login only. Pi runs offline (no package installs, update checks
 * or tool downloads) and without telemetry, whatever the user's environment says.
 */
export function piEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = /^(PI_\w+|AWS_\w+|AZURE_OPENAI_\w+|CLOUDFLARE_(API_KEY|ACCOUNT_ID|GATEWAY_ID)|GOOGLE_CLOUD_(API_KEY|PROJECT|LOCATION)|GOOGLE_APPLICATION_CREDENTIALS|GCLOUD_PROJECT|HF_TOKEN|XIAOMI_\w*API_KEY|(DEEPSEEK|GEMINI|GROQ|CEREBRAS|XAI|OPENROUTER|AI_GATEWAY|ZAI|MISTRAL|MINIMAX|MINIMAX_CN|MOONSHOT|FIREWORKS|OPENCODE|KIMI)_API_KEY)$/;
  const extra = Object.entries(base).filter(([k, v]) => v !== undefined && keep.test(k));
  return { ...agentEnv(base), ...Object.fromEntries(extra), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
}

/** Run a command without a shell and collect its output. Never throws for a non-zero exit. */
export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let killed = false;
    const kill = () => {
      if (child.exitCode === null && !child.killed) {
        killed = true;
        child.kill("SIGTERM");
        setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 5000).unref();
      }
    };
    const timer = options.timeoutMs ? setTimeout(kill, options.timeoutMs) : null;
    timer?.unref();
    if (options.signal) {
      if (options.signal.aborted) kill();
      else options.signal.addEventListener("abort", kill, { once: true });
    }
    child.stdout.on("data", (b: Buffer) => {
      out.push(b);
      options.onStdout?.(b.toString("utf8"));
    });
    child.stderr.on("data", (b: Buffer) => {
      err.push(b);
      options.onStderr?.(b.toString("utf8"));
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", kill);
      const bytes = Buffer.concat(out);
      resolve({
        code: code ?? (killed ? 143 : 1),
        stdout: bytes.toString("utf8"),
        stdoutBytes: bytes,
        stderr: Buffer.concat(err).toString("utf8"),
        killed,
      });
    });
    child.stdin.on("error", () => {
      /* the process may exit before reading its input */
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/** Like run, but throws CommandError with the command's own message on a non-zero exit. */
export async function runOrThrow(command: string, args: readonly string[], options: RunOptions = {}): Promise<string> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const detail = result.stderr.trim().split("\n").slice(-6).join("\n") || `exit code ${result.code}`;
    throw new CommandError(`${command} ${args.slice(0, 3).join(" ")} failed: ${detail}`, result);
  }
  return result.stdout;
}

/** Run up to `limit` tasks at once and return their results in order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
