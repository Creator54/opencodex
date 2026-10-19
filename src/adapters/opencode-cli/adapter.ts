import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../types";
import type { OcxTextContent } from "../../types";
import type { ProviderAdapter } from "../base";
import {
  baseScopedEnv,
  redactSecrets,
  type CodingAgentDeps,
} from "../coding-agent/turn";
import {
  buildSystemPrompt,
  projectedHistoryCharLimit,
  readJsonLines,
} from "../coding-agent/protocol";
import {
  commandInvocation,
} from "../../lib/win-exec";
import {
  resolveCodingAgentBinary,
  clearCodingAgentBinaryCache,
  resolveProfileByBaseUrl,
  type CodingAgentProviderProfile,
} from "../coding-agent/profile";
import { OPENCODE_CLI_PROFILE, OPENCODE_CLI_PROFILES } from "./profiles";
import { startOpenCodeToolBridge } from "./tool-bridge";

/** Per-turn deps follow the shared coding-agent seam; the lifecycle ladder is the same. */
export type OpenCodeCliAdapterDeps = Pick<
  CodingAgentDeps,
  "spawn" | "which" | "timeoutMs" | "killGraceMs" | "reapTimeoutMs" | "platform" | "killWindowsProcessTree"
> & { writeFile?: typeof writeFile };

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const MAX_STDERR_BYTES = 8_192;

/** The staged agent id; the free-tier gate sees it, the CLI runs headless as it. */
export const OPENCODE_AGENT_ID = "ocx-model";

/**
 * The agent the turn runs as, staged per turn under `{dir}/.opencode/agent/`.
 *
 * Every capability is denied so OpenCode's native tools can never act on
 * anything; the one distinction that keeps the free tier answering is that
 * `read` stays DECLARED (the gate refuses a turn from an agent that denies it —
 * PR #137/#139 evidence) but resolves only for a nonexistent path. There is
 * nothing to read, so nothing executes: the worst a model can produce here is a
 * file-not-found for a directory that does not exist.
 *
 * Tool ownership stays with the client harness: the staged instructions tell the
 * model to use only the request-scoped MCP capture catalog when supplied.
 */
const OPENCODE_AGENT_MARKDOWN = `---
description: OpenCodex stateless bridge agent (client owns tool execution)
mode: primary
temperature: 0.7
permission:
  "*": deny
  "opencodex_*": allow
  read:
    "*": deny
    "/nonexistent/ocx-opencode": allow
  edit: deny
  bash: deny
  webfetch: deny
  task: deny
  todowrite: deny
  question: deny
  skill: deny
  lsp: deny
  external_directory: deny
---
Stateless bridge. Only opencodex MCP tools may be called when present. These capture
intent only; the external client executes them. Never use built-in tools. Historical
tool results come from the client. Answer directly when no tool is needed.`;

/**
 * Fold the request into the single stdin prompt a headless `opencode run` turn
 * accepts: the system+developer prompt first, the replayed history below it, and
 * the assistant cue that starts the answer. The CLI owns the transport; there is
 * no claim of a wire-format match beyond ordinary text.
 */
export function buildOpencodePrompt(parsed: OcxParsedRequest): string {
  const sections: string[] = [];
  const system = buildSystemPrompt(parsed);
  if (system) sections.push(`<system_instructions>\n${system}\n</system_instructions>`);
  for (const message of parsed.context.messages) {
    const text = textOf(message);
    const calls = message.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter(part => part.type === "toolCall").map(part => JSON.stringify(part)).join("\n") : "";
    if (calls) sections.push(`Assistant tool calls: ${calls}`);
    if (!text) continue;
    if (message.role === "user") sections.push(`User: ${text}`);
    else if (message.role === "assistant") sections.push(`Assistant: ${text}`);
    else if (message.role === "toolResult") sections.push(`Tool result: ${text}`);
  }
  sections.push("Assistant:");
  return sections.join("\n\n");
}

function textOf(message: OcxParsedRequest["context"]["messages"][number]): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is OcxTextContent & { type: "text"; text: string } => part.type === "text")
    .map(part => part.text)
    .join("\n");
}

/**
 * Headless `opencode run` arguments. `--pure` keeps external plugins out,
 * `--agent` selects the staged permission posture, `--format json` streams NDJSON
 * frames, and `--dir` pins the turn to the private staging dir. The prompt
 * travels on stdin, not argv (argv is world-readable through process listing —
 * the same reason the CodeBuddy adapter stages its prompt).
 */
export function buildOpenCodeArgs(parsed: OcxParsedRequest, stagingDir: string): string[] {
  return [
    "run", "--pure",
    "-m", `opencode/${parsed.modelId}`,
    "--agent", OPENCODE_AGENT_ID,
    "--format", "json",
    "--dir", stagingDir,
  ];
}

/**
 * Refuse image input the way the claude-cli row does: the free models' attachment
 * capability is unverified on this route headless, and publishing an input the
 * route cannot honour is how a picture gets answered blind. The registry row
 * carries `noVisionModels`, and `run` itself has no image input without `-f`
 * paths, which this adapter never constructs.
 */
function hasImageInput(parsed: OcxParsedRequest): boolean {
  return parsed.context.messages.some(message =>
    Array.isArray(message.content) && message.content.some(part => part.type === "image"),
  );
}

/** Map an upstream error frame to the shared error shape, with the free-tier gate made legible. */
export function mapOpenCodeError(frame: Record<string, unknown>): AdapterEvent {
  const error = (frame.error !== null && typeof frame.error === "object" ? frame.error : frame) as Record<string, unknown>;
  const rawMessage = typeof error.message === "string" ? error.message : "OpenCode turn failed.";
  const name = typeof error.name === "string" ? error.name : "";
  const data = error.data !== null && typeof error.data === "object" ? error.data as Record<string, unknown> : undefined;
  const status = typeof error.statusCode === "number"
    ? error.statusCode
    : typeof data?.statusCode === "number" ? data.statusCode : undefined;
  const freeTier = name === "FreeTierError" || /free tier can only be used from within/i.test(rawMessage);
  if (freeTier) {
    return {
      type: "error",
      message:
        "OpenCode free tier refused this turn. This provider routes through the official `opencode` CLI, so free-tier eligibility is the CLI session's own property — not a proxy key. " +
        `CLI reported: ${rawMessage}`,
      status: status ?? 403,
      errorType: "upstream_error",
      code: "opencode_free_tier_gate",
      retryable: false,
    };
  }
  return {
    type: "error",
    message: rawMessage,
    ...(status !== undefined ? { status, errorType: "upstream_error" } : {}),
  };
}

const FINISH_REASONS: Record<string, { stopReason: string; endTurn: boolean }> = {
  stop: { stopReason: "stop", endTurn: true },
  length: { stopReason: "incomplete", endTurn: false },
  abort: { stopReason: "incomplete", endTurn: false },
};

interface OpenCodeTokens {
  input?: unknown;
  output?: unknown;
  total?: unknown;
  cache?: { read?: unknown; write?: unknown };
}

function mapUsage(tokens: OpenCodeTokens | undefined) {
  if (!tokens) return undefined;
  const input = typeof tokens.input === "number" ? tokens.input : 0;
  const output = typeof tokens.output === "number" ? tokens.output : 0;
  const read = typeof tokens.cache?.read === "number" ? tokens.cache.read : undefined;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    ...(read !== undefined && read > 0 ? { cachedInputTokens: read, cacheReadInputTokens: read } : {}),
  };
}

type EmitFn = (event: AdapterEvent) => void;

interface OpenCodeFrameState {
  lastText: string;
  lastThinking: string;
  terminal?: Extract<AdapterEvent, { type: "done" }> | Extract<AdapterEvent, { type: "incomplete" }>;
  nativeToolCall?: string;
}

/**
 * Map one `opencode run --format json` NDJSON frame.
 *
 * Frames are part snapshots (`{type:"text"…,"part":{id,text}}`), so text and
 * thinking deltas come from diffing each stream against what was already
 * emitted (a part id holds cumulative text in both `run` and serve mode). A
 * native tool call fails the turn closed: the client owns execution, and an
 * output produced inside the bridge must never leak as content.
 */
export function mapOpenCodeFrame(
  frame: Record<string, unknown>,
  state: OpenCodeFrameState,
  events: EmitFn,
): void {
  const part = (frame.part !== null && typeof frame.part === "object" ? frame.part : frame) as Record<string, unknown>;
  const partType = typeof part.type === "string" ? part.type : undefined;
  if (partType === "tool" || partType === "tool_use" || frame.type === "tool_use") {
    state.nativeToolCall = "OpenCode attempted a native tool call on a tools-disabled turn.";
    return;
  }
  if (partType === "reasoning" || partType === "thinking") {
    const text = typeof part.text === "string" ? part.text : "";
    if (text.length > state.lastThinking.length) {
      events({ type: "thinking_delta", thinking: text.slice(state.lastThinking.length) });
      state.lastThinking = text;
    }
    return;
  }
  if (partType === "text") {
    const text = typeof part.text === "string" ? part.text : "";
    if (text.length > state.lastText.length) {
      events({ type: "text_delta", text: text.slice(state.lastText.length) });
      state.lastText = text;
    }
    return;
  }
  if (frame.type === "error") {
    events(mapOpenCodeError(frame));
    return;
  }
  if (frame.type === "step_finish") {
    const reason = typeof part.reason === "string" ? part.reason : typeof frame.reason === "string" ? frame.reason : "stop";
    if (reason === "tool-calls" || reason === "tool_calls") {
      state.nativeToolCall = "OpenCode finished on a tool call on a tools-disabled turn.";
      return;
    }
    const mapped = FINISH_REASONS[reason] ?? { stopReason: "incomplete", endTurn: false };
    const usage = mapUsage((part.tokens !== null && typeof part.tokens === "object" ? part.tokens : frame.tokens) as OpenCodeTokens | undefined);
    state.terminal = mapped.endTurn
      ? { type: "done", stopReason: mapped.stopReason, endTurn: true, ...(usage ? { usage } : {}) }
      : { type: "incomplete", reason: mapped.stopReason, endTurn: false, ...(usage ? { usage } : {}) };
    return;
  }
  // step_start / message frames and any future frame kinds carry nothing this
  // frame contract needs; ignoring them is the forward-compatible reading.
}

/**
 * Create the OpenCode CLI adapter: one headless, permission-denied, stateless
 * turn per request. As with the claude-cli family, `runTurn` owns the turn and
 * the fetch/parseStream path is disabled — the official CLI performs the
 * transport to opencode.ai (free tier), and OpenCodex contributes the prompt
 * projection, the NDJSON mapping and the process lifecycle. No OpenCodex
 * credential exists for this provider: the CLI's own anonymous free-tier session
 * is the account, so there is nothing to pre-flight and nothing to store.
 */
export function createOpenCodeCliAdapter(provider: OcxProviderConfig, deps: OpenCodeCliAdapterDeps = {}): ProviderAdapter {
  return {
    name: "opencode-cli",

    buildRequest(): { url: string; method: string; headers: Record<string, string>; body: string } {
      return { url: provider.baseUrl, method: "POST", headers: {}, body: "" };
    },

    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield { type: "error", message: "OpenCode CLI adapter uses runTurn; the fetch/parseStream path is disabled." };
    },

    async runTurn(parsed, incoming, emit): Promise<void> {
      if (hasImageInput(parsed)) {
        emit({
          type: "error",
          message: "OpenCode CLI image input is not enabled because this route has no verified multimodal contract.",
          status: 400,
          errorType: "invalid_request_error",
          code: "unsupported_input_modality",
          retryable: false,
        });
        return;
      }
      const spawnFn = deps.spawn ?? nodeSpawn;
      const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
      const reapTimeoutMs = deps.reapTimeoutMs ?? (killGraceMs * 2 + 250);
      const platform = deps.platform ?? process.platform;
      const writeAgentFile = deps.writeFile ?? writeFile;

      if (incoming.abortSignal?.aborted) {
        emit({ type: "error", message: "OpenCode turn was aborted before start." });
        return;
      }

      // Fail closed on a non-canonical destination before anything is staged or spawned.
      const profile: CodingAgentProviderProfile | undefined = resolveProfileByBaseUrl(
        OPENCODE_CLI_PROFILES,
        provider.baseUrl,
      );
      if (!profile) {
        emit({
          type: "error",
          message: "Provider base URL is not a canonical region destination; the turn was not started.",
          status: 400,
          errorType: "invalid_request_error",
          code: "non_canonical_destination",
          retryable: false,
        });
        return;
      }
      // No credential pre-flight on purpose: the CLI owns the anonymous free-tier session.
      const binary = resolveCodingAgentBinary(profile, deps.which);
      if (!binary) {
        emit({
          type: "error",
          message: `${profile.label} CLI not found on PATH. Install it with: ${profile.installHint}`,
          status: 500,
          errorType: "upstream_error",
          code: "cli_not_found",
          retryable: false,
        });
        return;
      }

      let toolBridge: ReturnType<typeof startOpenCodeToolBridge>;
      try {
        toolBridge = startOpenCodeToolBridge(parsed);
      } catch (err) {
        emit({ type: "error", message: err instanceof Error ? err.message : String(err), status: 400, errorType: "invalid_request_error", code: "invalid_tool_catalog", retryable: false });
        return;
      }
      // Stage the private turn dir: every capability denied, `read` declared but
      // resolving to nothing, and no user .opencode state inherited.
      let stagingDir: string;
      try {
        stagingDir = await mkdtemp(join(tmpdir(), "ocx-opencode-cli-"));
      } catch {
        toolBridge?.close();
        emit({ type: "error", message: "OpenCode staging directory could not be created.", status: 500, code: "staging_setup_failed", retryable: false });
        return;
      }
      const agentDir = join(stagingDir, ".opencode", "agent");
      try {
        await mkdir(agentDir, { recursive: true });
        if (toolBridge) await writeAgentFile(join(stagingDir, "opencode.json"), JSON.stringify({ mcp: { opencodex: { type: "remote", url: toolBridge.url, enabled: true } } }), { encoding: "utf8", mode: 0o600, flag: "wx" });
        await writeAgentFile(join(agentDir, `${OPENCODE_AGENT_ID}.md`), OPENCODE_AGENT_MARKDOWN, { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch {
        toolBridge?.close();
        await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
        emit({
          type: "error",
          message: "OpenCode staging agent could not be staged securely.",
          status: 500,
          errorType: "upstream_error",
          code: "staging_setup_failed",
          retryable: false,
        });
        return;
      }

      const args = buildOpenCodeArgs(parsed, stagingDir);
      const env = baseScopedEnv();
      const invocation = commandInvocation(binary, args, platform, { env });

      let child: ChildProcess;
      try {
        child = spawnFn(invocation.file, invocation.args, {
          ...invocation.options,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (err) {
        toolBridge?.close();
        emit({
          type: "error",
          message: redactSecrets(err instanceof Error ? err.message : String(err), undefined, provider.apiKey),
          status: 500,
          errorType: "upstream_error",
          code: "cli_spawn_failed",
          retryable: false,
        });
        await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
        return;
      }

      let childProcessError: Error | undefined;
      const processLifecycle = new Promise<void>(resolve => {
        let settled = false;
        const settle = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };
        child.once("error", err => {
          childProcessError = err;
          if (child.pid === undefined) settle();
        });
        child.once("close", settle);
        if (child.exitCode !== null) settle();
      });

      let terminalEmitted = false;
      const emitOnce = (event: AdapterEvent): void => {
        if (event.type === "done" || event.type === "error" || event.type === "incomplete") {
          if (terminalEmitted) return;
          terminalEmitted = true;
        }
        emit(event);
      };

      const stderrChunks: string[] = [];
      let killed = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (): void => {
        if (killed || child.killed) return;
        killed = true;
        if (platform === "win32" && child.pid !== undefined && deps.killWindowsProcessTree) {
          try {
            deps.killWindowsProcessTree(child.pid);
            return;
          } catch { /* fall back to terminating the direct child */ }
        }
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        killTimer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
        }, killGraceMs);
      };

      const stopStream = (): void => {
        try { child.stdout?.destroy(); } catch { /* already closed */ }
      };
      void toolBridge?.captured.then(call => {
        if (terminalEmitted || incoming.abortSignal?.aborted) return;
        emitOnce({ type: "tool_call_start", id: call.id, name: call.name });
        emitOnce({ type: "tool_call_delta", arguments: call.arguments });
        emitOnce({ type: "tool_call_end" });
        emitOnce({ type: "done", stopReason: "tool_use", endTurn: false });
        kill();
        stopStream();
      });
      const onAbort = (): void => {
        kill();
        stopStream();
      };
      incoming.abortSignal?.addEventListener("abort", onAbort, { once: true });
      const timeoutTimer = setTimeout(() => {
        kill();
        stopStream();
        emitOnce({ type: "error", message: `${profile.label} turn timed out.`, status: 504, errorType: "upstream_error", code: "timeout", retryable: true });
      }, timeoutMs);

      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        if (stderrChunks.join("").length < MAX_STDERR_BYTES) stderrChunks.push(chunk);
      });

      const cleanup = (): void => {
        clearTimeout(timeoutTimer);
        incoming.abortSignal?.removeEventListener("abort", onAbort);
        try { child.stdin?.destroy(); } catch { /* ignore */ }
      };

      // The whole turn is stateless: per-stream snapshot diffs live only for this loop.
      const state: OpenCodeFrameState = { lastText: "", lastThinking: "" };
      let streamProtocolError: string | undefined;

      try {
        const stdin = child.stdin;
        if (stdin) {
          stdin.on("error", () => { /* EPIPE if the CLI exits early; surfaced via close/stderr */ });
          const historyCharLimit = projectedHistoryCharLimit(
            modelRecordValue(provider.modelContextWindows, parsed.modelId) ?? provider.contextWindow,
          );
          const prompt = buildOpencodePrompt(parsed);
          const bounded = prompt.length > historyCharLimit
            ? `${prompt.slice(0, historyCharLimit)}\n[earlier conversation trimmed]`
            : prompt;
          stdin.write(bounded);
          stdin.end();
        }
        const stdout = child.stdout;
        if (!stdout) throw new Error("OpenCode CLI produced no stdout stream");
        for await (const message of readJsonLines(stdout)) {
          if (incoming.abortSignal?.aborted || terminalEmitted) break;
          if (state.nativeToolCall) break;
          mapOpenCodeFrame(message, state, emitOnce);
          if (state.nativeToolCall) {
            emitOnce({
              type: "error",
              message: state.nativeToolCall,
              status: 502,
              errorType: "upstream_error",
              code: "opencode_native_tool_call",
              retryable: false,
            });
            kill();
            break;
          }
          if (state.terminal || terminalEmitted) break;
        }
        if (!terminalEmitted && state.terminal) {
          if (toolBridge?.requireToolCall) emitOnce({ type: "error", message: "OpenCode returned without the required client tool call.", status: 502, code: "opencode_required_tool_missing", retryable: false });
          else emitOnce(state.terminal);
        }
      } catch (err) {
        kill();
        if (!state.nativeToolCall) streamProtocolError = err instanceof Error ? err.message : String(err);
      } finally {
        cleanup();
        toolBridge?.close();
        // No part state leaves this turn: the staging dir (and everything inside) is gone.
        await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      }

      // Reap so no zombie is left behind; force-terminate if `close` lingers.
      const graceTimer = setTimeout(() => { kill(); }, killGraceMs);
      let reapTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        processLifecycle,
        new Promise<void>(resolve => {
          reapTimer = setTimeout(resolve, reapTimeoutMs);
        }),
      ]);
      clearTimeout(graceTimer);
      if (reapTimer) clearTimeout(reapTimer);
      if (killTimer) clearTimeout(killTimer);

      if (!terminalEmitted) {
        const stderr = redactSecrets(boundedStderr(stderrChunks), undefined, provider.apiKey);
        if (incoming.abortSignal?.aborted) {
          emitOnce({ type: "error", message: `${profile.label} turn was aborted.`, retryable: false });
        } else if (childProcessError) {
          emitOnce({
            type: "error",
            message: `${profile.label} CLI failed to start: ${redactSecrets(childProcessError.message, undefined, provider.apiKey)}`,
            status: 500,
            errorType: "upstream_error",
            code: "cli_spawn_failed",
            retryable: false,
          });
        } else if (streamProtocolError) {
          emitOnce({
            type: "error",
            message: redactSecrets(streamProtocolError, undefined, provider.apiKey),
            status: 502,
            errorType: "upstream_error",
            code: "protocol_error",
            retryable: false,
          });
        } else if (child.exitCode !== null && child.exitCode !== 0) {
          const exitMsg = stderr
            ? `${profile.label} CLI exited with code ${child.exitCode}: ${stderr}`
            : `${profile.label} CLI exited with non-zero exit code ${child.exitCode}`;
          emitOnce({
            type: "error",
            message: exitMsg,
            status: 502,
            errorType: "upstream_error",
            code: "process_exit_error",
            retryable: false,
          });
        } else {
          const msg = stderr
            ? `${profile.label} CLI ended without a terminal step_finish frame: ${stderr}`
            : `${profile.label} CLI ended without a terminal step_finish frame`;
          emitOnce({
            type: "error",
            message: msg,
            status: 502,
            errorType: "upstream_error",
            code: "protocol_error",
            retryable: false,
          });
        }
      }
    },
  };
}

function boundedStderr(chunks: string[]): string {
  let total = 0;
  const kept: string[] = [];
  for (const chunk of chunks) {
    if (total >= MAX_STDERR_BYTES) break;
    kept.push(chunk);
    total += chunk.length;
  }
  const joined = kept.join("");
  if (joined.length > MAX_STDERR_BYTES) return `${joined.slice(0, MAX_STDERR_BYTES)}…`;
  return joined;
}

function modelRecordValue(
  record: Record<string, unknown> | undefined,
  modelId: string,
): number | undefined {
  if (!record) return undefined;
  const value = record[modelId];
  return typeof value === "number" ? value : undefined;
}

/** Binary-discovery cache isolation for tests; the cache itself lives in the shared seam. */
export function clearOpenCodeCliBinaryCache(): void {
  clearCodingAgentBinaryCache();
}

export { OPENCODE_CLI_PROFILE };
