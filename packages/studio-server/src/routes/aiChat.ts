import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { StudioApiAdapter } from "../types.js";

/**
 * AI bridge: runs an AI coding CLI that is already signed in on this machine
 * (Claude Code, Codex or Gemini CLI), inside the project folder, and streams
 * what it does back to Studio as server-sent events.
 *
 * Studio never sees a key or token. Each CLI uses its own login, so a Claude
 * Pro/Max subscription signed in with `claude` is what pays for the chat.
 */

export const AI_PROVIDER_IDS = ["claude", "codex", "gemini"] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export interface AiProviderInfo {
  id: AiProviderId;
  label: string;
  available: boolean;
  version: string | null;
  /** Claude keeps its own session; the others are given the recent transcript. */
  resumable: boolean;
  installHint: string;
}

export type AiChatEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; detail: string }
  | { type: "error"; message: string }
  | { type: "done"; sessionId: string | null; costUsd: number | null };

interface ProviderSpec {
  label: string;
  bin: string;
  installHint: string;
  resumable: boolean;
  args(options: { sessionId: string | null; model: string | null; fullAccess: boolean }): string[];
}

const PROVIDERS: Record<AiProviderId, ProviderSpec> = {
  claude: {
    label: "Claude (Claude Code)",
    bin: "claude",
    installHint: "npm install -g @anthropic-ai/claude-code แล้วรัน claude เพื่อล็อกอินด้วยบัญชี Pro/Max",
    resumable: true,
    args: ({ sessionId, model, fullAccess }) => [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      fullAccess ? "bypassPermissions" : "acceptEdits",
      ...claudeSettingsArgs(),
      ...(sessionId ? ["--resume", sessionId] : []),
      ...(model ? ["--model", model] : []),
    ],
  },
  codex: {
    label: "ChatGPT (Codex CLI)",
    bin: "codex",
    installHint: "npm install -g @openai/codex แล้วรัน codex เพื่อล็อกอินด้วยบัญชี ChatGPT",
    resumable: false,
    args: ({ model, fullAccess }) => [
      "exec",
      "--skip-git-repo-check",
      fullAccess ? "--dangerously-bypass-approvals-and-sandbox" : "--full-auto",
      ...(model ? ["--model", model] : []),
      "-",
    ],
  },
  gemini: {
    label: "Gemini (Gemini CLI)",
    bin: "gemini",
    installHint: "npm install -g @google/gemini-cli แล้วรัน gemini เพื่อล็อกอินด้วยบัญชี Google",
    resumable: false,
    args: ({ model, fullAccess }) => [
      fullAccess ? "--yolo" : "--approval-mode=auto_edit",
      ...(model ? ["--model", model] : []),
    ],
  },
};

/**
 * Commands Claude may run without asking, even when full access is off: the
 * HyperFrames CLI's own checks and renders. `-p` mode cannot ask the person, so
 * anything not listed here is refused unless Studio's full-access switch is on.
 */
const CLAUDE_ALLOWED_COMMANDS = [
  "npx hyperframes",
  "npx -y hyperframes",
  "hyperframes",
  "npm run check",
  "npm run lint",
  "npm run render",
  "ffprobe",
];

let claudeSettingsPath: string | null | undefined;

/** `--settings <file>` holding the allowlist above, written once per server. */
function claudeSettingsArgs(): string[] {
  if (claudeSettingsPath === undefined) {
    claudeSettingsPath = null;
    try {
      const path = join(tmpdir(), "hyperframes-studio-claude-settings.json");
      const allow = CLAUDE_ALLOWED_COMMANDS.flatMap((command) => [
        `Bash(${command}:*)`,
        `PowerShell(${command}:*)`,
      ]);
      writeFileSync(path, JSON.stringify({ permissions: { allow } }, null, 2), "utf8");
      if (isShellSafeArg(path)) claudeSettingsPath = path;
    } catch {
      /* no temp folder: Claude still edits files, it just cannot run commands */
    }
  }
  return claudeSettingsPath ? ["--settings", claudeSettingsPath] : [];
}

const MAX_RUN_MS = 20 * 60 * 1000;
const MAX_MESSAGE_CHARS = 40_000;
const PROVIDER_CACHE_MS = 30_000;

export function isAiProviderId(value: unknown): value is AiProviderId {
  return typeof value === "string" && (AI_PROVIDER_IDS as readonly string[]).includes(value);
}

function binFor(id: AiProviderId): string {
  const override = process.env[`HYPERFRAMES_AI_${id.toUpperCase()}_BIN`];
  return override && override.trim() ? override.trim() : PROVIDERS[id].bin;
}

/** Extra arguments from HYPERFRAMES_AI_<ID>_ARGS, split on whitespace. */
function extraArgsFor(id: AiProviderId): string[] {
  const raw = process.env[`HYPERFRAMES_AI_${id.toUpperCase()}_ARGS`];
  return raw ? raw.split(/\s+/).filter(Boolean) : [];
}

const isWindows = process.platform === "win32";

/** Arguments only ever hold flags, UUIDs and model names; refuse anything a shell would read. */
function isShellSafeArg(arg: string): boolean {
  return /^[\w@=:./\\+-]+$/.test(arg);
}

function assertShellSafe(args: string[]): void {
  for (const arg of args) {
    if (!isShellSafeArg(arg)) throw new Error(`unsafe argument: ${arg}`);
  }
}

function spawnCli(bin: string, args: string[], cwd: string): ChildProcess {
  assertShellSafe(args);
  // npm installs CLIs on Windows as .cmd shims, which Node only starts through a shell.
  return spawn(bin, args, {
    cwd,
    shell: isWindows,
    windowsHide: true,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (isWindows) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on(
      "error",
      () => child.kill(),
    );
  } else {
    child.kill("SIGTERM");
  }
}

function probeVersion(id: AiProviderId): Promise<string | null> {
  return new Promise((resolveProbe) => {
    let output = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolveProbe(value);
    };
    let child: ChildProcess;
    try {
      child = spawnCli(binFor(id), ["--version"], process.cwd());
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      killTree(child);
      finish(null);
    }, 10_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = output.trim().split(/\r?\n/)[0] ?? "";
      finish(code === 0 && line ? line.slice(0, 80) : null);
    });
    child.stdin?.end();
  });
}

let providerCache: { at: number; value: AiProviderInfo[] } | null = null;

export async function listAiProviders(force = false): Promise<AiProviderInfo[]> {
  if (!force && providerCache && Date.now() - providerCache.at < PROVIDER_CACHE_MS) {
    return providerCache.value;
  }
  const value = await Promise.all(
    AI_PROVIDER_IDS.map(async (id): Promise<AiProviderInfo> => {
      const version = await probeVersion(id);
      const spec = PROVIDERS[id];
      return {
        id,
        label: spec.label,
        available: version !== null,
        version,
        resumable: spec.resumable,
        installHint: spec.installHint,
      };
    }),
  );
  providerCache = { at: Date.now(), value };
  return value;
}

// ── Claude stream-json ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function describeToolInput(input: unknown): string {
  if (!isRecord(input)) return "";
  for (const key of ["file_path", "path", "command", "pattern", "url", "description"]) {
    const value = str(input[key]);
    if (value) return value.length > 160 ? `${value.slice(0, 157)}...` : value;
  }
  return "";
}

/** One stream-json line from `claude -p --output-format stream-json` → Studio events. */
export function claudeLineToEvents(line: string): AiChatEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const type = str(parsed.type);
  const sessionId = str(parsed.session_id);

  if (type === "system" && parsed.subtype === "init" && sessionId) {
    return [{ type: "session", sessionId }];
  }
  if (type === "assistant" && isRecord(parsed.message) && Array.isArray(parsed.message.content)) {
    const events: AiChatEvent[] = [];
    for (const block of parsed.message.content) {
      if (!isRecord(block)) continue;
      if (block.type === "text") {
        const text = str(block.text);
        if (text) events.push({ type: "text", text });
      } else if (block.type === "tool_use") {
        events.push({
          type: "tool",
          name: str(block.name) ?? "tool",
          detail: describeToolInput(block.input),
        });
      }
    }
    return events;
  }
  if (type === "result") {
    const events: AiChatEvent[] = [];
    if (parsed.is_error === true) {
      events.push({ type: "error", message: str(parsed.result) ?? "Claude reported an error" });
    }
    const cost = typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null;
    events.push({ type: "done", sessionId, costUsd: cost });
    return events;
  }
  return [];
}

// ── Prompt ───────────────────────────────────────────────────────────────────

export interface AiChatRequest {
  projectId: string;
  provider: AiProviderId;
  message: string;
  sessionId: string | null;
  model: string | null;
  /** Lets the CLI run any command without asking (Studio's full-access switch). */
  fullAccess: boolean;
  history: { role: "user" | "assistant"; text: string }[];
  context: {
    activeComposition: string | null;
    selection: string | null;
    attachments: string[];
  };
}

function asStringOrNull(value: unknown, max = 400): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

export function parseAiChatRequest(body: unknown): AiChatRequest | string {
  if (!isRecord(body)) return "body must be a JSON object";
  const projectId = asStringOrNull(body.projectId);
  if (!projectId) return "projectId is required";
  if (!isAiProviderId(body.provider)) return "unknown provider";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return "message is required";
  if (message.length > MAX_MESSAGE_CHARS) return "message is too long";
  const sessionId = asStringOrNull(body.sessionId, 100);
  if (sessionId && !/^[\w-]+$/.test(sessionId)) return "invalid sessionId";
  const model = asStringOrNull(body.model, 80);
  if (model && !/^[\w.:@/-]+$/.test(model)) return "invalid model";
  const context = isRecord(body.context) ? body.context : {};
  const history = Array.isArray(body.history)
    ? body.history
        .filter(
          (turn): turn is { role: "user" | "assistant"; text: string } =>
            isRecord(turn) &&
            (turn.role === "user" || turn.role === "assistant") &&
            typeof turn.text === "string",
        )
        .slice(-10)
        .map((turn) => ({ role: turn.role, text: turn.text.slice(0, 4000) }))
    : [];
  const attachments = Array.isArray(context.attachments)
    ? context.attachments
        .filter((item): item is string => typeof item === "string")
        .slice(0, 20)
        .map((item) => item.slice(0, 300))
    : [];
  return {
    projectId,
    provider: body.provider,
    message,
    sessionId,
    model,
    fullAccess: body.fullAccess === true,
    history,
    context: {
      activeComposition: asStringOrNull(context.activeComposition),
      selection: asStringOrNull(context.selection, 1200),
      attachments,
    },
  };
}

export function buildPrompt(
  request: AiChatRequest,
  projectDir: string,
  firstTurn: boolean,
): string {
  const lines: string[] = [];
  if (firstTurn) {
    lines.push(
      "You are the AI assistant inside HyperFrames Studio, a video editor where every video is an HTML composition rendered to MP4.",
      `The project folder is your working directory: ${projectDir}`,
      "Edit the project's files directly when the user asks for a change; Studio reloads the preview by itself when a file changes.",
      'Follow the HyperFrames conventions in the project\'s CLAUDE.md / AGENTS.md if present (clips need class="clip", one paused GSAP root timeline on window.__timelines, deterministic rendering).',
      "Media the user uploads lives under assets/. Reply in the user's language and keep replies short.",
      "You run non-interactively: never ask the user for permission in chat, because their reply cannot unblock a refused tool.",
      "You may always run the HyperFrames CLI (npx hyperframes check / lint / snapshot / render) to verify your work.",
      "",
    );
  }
  const notes: string[] = [];
  if (request.context.activeComposition)
    notes.push(`Composition open in Studio: ${request.context.activeComposition}`);
  if (request.context.selection) notes.push(`Selected element: ${request.context.selection}`);
  if (request.context.attachments.length)
    notes.push(`Attached project files: ${request.context.attachments.join(", ")}`);
  if (!request.fullAccess) {
    notes.push(
      "Full access is OFF: shell commands other than the HyperFrames CLI are refused. If one is essential, say so and ask the user to turn on the full-access switch in the AI panel.",
    );
  }
  if (notes.length) lines.push("[Studio context]", ...notes, "");
  if (!PROVIDERS[request.provider].resumable && request.history.length) {
    lines.push("[Conversation so far]");
    for (const turn of request.history) lines.push(`${turn.role}: ${turn.text}`);
    lines.push("");
  }
  lines.push(request.message);
  return lines.join("\n");
}

// ── Route ────────────────────────────────────────────────────────────────────

const running = new Map<string, ChildProcess>();

/** A browser on another site may reach localhost too; only Studio's own page may start a run. */
function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function sse(event: AiChatEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export function registerAiChatRoutes(api: Hono, adapter: StudioApiAdapter): void {
  api.get("/ai/providers", async (c) => {
    const providers = await listAiProviders(c.req.query("refresh") === "1");
    return c.json({ providers });
  });

  api.post("/ai/stop", async (c) => {
    if (!isSameOrigin(c.req.header("origin"), c.req.header("host"))) {
      return c.json({ error: "cross-origin request refused" }, 403);
    }
    const body: unknown = await c.req.json().catch(() => null);
    const projectId = isRecord(body) ? asStringOrNull(body.projectId) : null;
    const project = projectId ? await adapter.resolveProject(projectId) : null;
    const child = project ? running.get(project.dir) : undefined;
    if (child) killTree(child);
    return c.json({ stopped: Boolean(child) });
  });

  api.post("/ai/chat", async (c) => {
    if (!isSameOrigin(c.req.header("origin"), c.req.header("host"))) {
      return c.json({ error: "cross-origin request refused" }, 403);
    }
    if (!(c.req.header("content-type") ?? "").includes("application/json")) {
      return c.json({ error: "expected application/json" }, 415);
    }
    const parsed = parseAiChatRequest(await c.req.json().catch(() => null));
    if (typeof parsed === "string") return c.json({ error: parsed }, 400);

    const project = await adapter.resolveProject(parsed.projectId);
    if (!project) return c.json({ error: "project not found" }, 404);
    if (running.has(project.dir)) {
      return c.json({ error: "AI is still working on this project" }, 409);
    }

    const spec = PROVIDERS[parsed.provider];
    const resume = spec.resumable ? parsed.sessionId : null;
    const args = [
      ...spec.args({ sessionId: resume, model: parsed.model, fullAccess: parsed.fullAccess }),
      ...extraArgsFor(parsed.provider),
    ];
    const prompt = buildPrompt(parsed, project.dir, !resume);
    const abortSignal = c.req.raw.signal;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let sawDone = false;
        let stderr = "";
        let stdoutBuffer = "";
        const send = (event: AiChatEvent) => {
          if (closed) return;
          if (event.type === "done") sawDone = true;
          try {
            controller.enqueue(sse(event));
          } catch {
            closed = true;
          }
        };
        const close = () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };

        let child: ChildProcess;
        try {
          child = spawnCli(binFor(parsed.provider), args, project.dir);
        } catch (error) {
          send({ type: "error", message: error instanceof Error ? error.message : String(error) });
          send({ type: "done", sessionId: null, costUsd: null });
          close();
          return;
        }
        running.set(project.dir, child);
        const timer = setTimeout(() => killTree(child), MAX_RUN_MS);
        const onAbort = () => killTree(child);
        abortSignal.addEventListener("abort", onAbort, { once: true });

        const handleLine = (line: string) => {
          if (!line.trim()) return;
          if (parsed.provider === "claude") {
            for (const event of claudeLineToEvents(line)) send(event);
          } else {
            send({ type: "text", text: `${line}\n` });
          }
        };

        child.stdout?.on("data", (chunk: Buffer) => {
          stdoutBuffer += chunk.toString("utf8");
          const lines = stdoutBuffer.split(/\r?\n/);
          stdoutBuffer = lines.pop() ?? "";
          for (const line of lines) handleLine(line);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString("utf8")).slice(-4000);
        });
        child.on("error", (error) => {
          send({
            type: "error",
            message: `เปิด ${spec.bin} ไม่ได้ (${error.message}). ${spec.installHint}`,
          });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          abortSignal.removeEventListener("abort", onAbort);
          running.delete(project.dir);
          handleLine(stdoutBuffer);
          if (code !== 0 && !abortSignal.aborted) {
            const tail = stderr.trim().split(/\r?\n/).slice(-6).join("\n");
            send({
              type: "error",
              message: tail || `${spec.bin} exited with code ${code ?? "unknown"}`,
            });
          }
          if (!sawDone) send({ type: "done", sessionId: resume, costUsd: null });
          close();
        });

        child.stdin?.on("error", () => {
          /* the CLI exited before reading the prompt; close reports why */
        });
        child.stdin?.end(prompt, "utf8");
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });
}
