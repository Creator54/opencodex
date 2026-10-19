import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { PassThrough, Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  buildOpenCodeArgs,
  buildOpencodePrompt,
  createOpenCodeCliAdapter,
  clearOpenCodeCliBinaryCache,
  mapOpenCodeError,
  mapOpenCodeFrame,
  OPENCODE_AGENT_ID,
  type OpenCodeCliAdapterDeps,
} from "../../src/adapters/opencode-cli/adapter";
import { OPENCODE_CLI_PROFILE, clearOpenCodeCliBinaryCache as clearProfileBinaryCache } from "../../src/adapters/opencode-cli/profiles";
import { effectiveAdapterContract, getAdapterDefinition } from "../../src/adapters/registry";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { deriveProviderPresets, providerConfigSeed } from "../../src/providers/derive";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const enc = new TextEncoder();

beforeEach(() => {
  clearOpenCodeCliBinaryCache();
  clearProfileBinaryCache();
});

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  killed: boolean;
  exitCode: number | null;
  kill: (signal?: string) => boolean;
  written: string[];
}

function fakeChild(stdout: Uint8Array[], opts: { stderr?: string; exitCode?: number; delayMs?: number } = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = Readable.from(stdout);
  child.stderr = Readable.from(opts.stderr ? [enc.encode(opts.stderr)] : []);
  child.written = [];
  child.stdin = new Writable({ write(chunk, _enc, cb) { child.written.push(String(chunk)); cb(); } });
  child.killed = false;
  child.exitCode = null;
  child.kill = () => { child.killed = true; return true; };
  setTimeout(() => { child.exitCode = opts.exitCode ?? 0; child.emit("close", opts.exitCode ?? 0); }, opts.delayMs ?? 3);
  return child;
}

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "opencode-cli",
    baseUrl: OPENCODE_CLI_PROFILE.canonicalBaseUrl,
    ...overrides,
  } as OcxProviderConfig;
}

function parsed(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return {
    modelId: "glm-5.3-flash-free",
    stream: true,
    options: {},
    context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    ...overrides,
  } as OcxParsedRequest;
}

function incoming(abortSignal?: AbortSignal) {
  return { headers: new Headers(), translatorBudget: createTestTranslatorBudget(), ...(abortSignal ? { abortSignal } : {}) };
}

/** which() that finds a candidate so the turn proceeds to the (fake) spawn, not cli_not_found. */
const whichOk: OpenCodeCliAdapterDeps["which"] = candidate => `/usr/local/bin/${candidate}`;

async function run(adapter: ReturnType<typeof createOpenCodeCliAdapter>, req: OcxParsedRequest, deps: OpenCodeCliAdapterDeps = {}, abortSignal?: AbortSignal): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  await adapter.runTurn!(req, incoming(abortSignal), e => events.push(e));
  return events;
}

function depsFor(child: FakeChild, log: { stagingArgs?: string[] } = {}): OpenCodeCliAdapterDeps {
  return {
    which: whichOk,
    spawn: ((file: string, args: string[]) => {
      const dirArg = args.indexOf("--dir");
      if (dirArg !== -1) log.stagingArgs = args.slice(dirArg, dirArg + 2);
      // The staging agent must exist on disk before the "CLI" runs; capture it by reading.
      if (dirArg !== -1) {
        const agentPath = `${args[dirArg + 2] ?? args[dirArg + 1]}/.opencode/agent/${OPENCODE_AGENT_ID}.md`;
        (child as unknown as { agentFile?: string }).agentFile = `${args[dirArg + 1]}/.opencode/agent/${OPENCODE_AGENT_ID}.md`;
      }
      return child;
    }) as unknown as OpenCodeCliAdapterDeps["spawn"],
  };
}

describe("opencode-cli is an official-harness provider, not a free-tier request relay", () => {
  test("the registry row and the adapter agree on the one canonical destination", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.id === "opencode-cli");
    expect(entry).toBeDefined();
    expect(entry!.adapter).toBe("opencode-cli");
    expect(entry!.baseUrl).toBe(OPENCODE_CLI_PROFILE.canonicalBaseUrl);
    expect(entry!.defaultModel).toBe("glm-5.3-flash-free");
    expect(entry!.models).toContain(entry!.defaultModel!);
    expect(entry!.modelContextWindows?.[entry!.defaultModel!]).toBeGreaterThan(0);
    // Static roster: the CLI route never serves a model list, so discovery would be pure noise.
    expect(entry!.liveModels).toBe(false);
    // Text-only v1: `run` has no image input without `-f` paths, which the adapter never builds,
    // and the roster's attachment flags are unverified headless. Same posture as the claude-cli row.
    expect(entry!.noVisionModels).toEqual(entry!.models);
    expect(entry!.modelInputModalities).toBeUndefined();
  });

  test("the row is a keyless key provider, not a local runtime", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.id === "opencode-cli")!;
    // The CLI session is the free tier's anonymous account: no key exists to enforce, but the
    // traffic reaches opencode.ai, so "local" would misclassify it exactly like claude-cli.
    expect(entry!.authKind).toBe("key");
    expect(entry!.keyOptional).toBe(true);
    expect(providerConfigSeed(entry!)).toBeDefined();
  });

  test("the adapter is reachable from the default derivations, like every key-optional row", () => {
    const presets = deriveProviderPresets();
    expect(presets.some(p => p.id === "opencode-cli")).toBe(true);
  });

  test("the registry entry inherits the coding-agent lifecycle contract, not the codebuddy frames", () => {
    const definition = getAdapterDefinition("opencode-cli");
    expect(definition).toBeDefined();
    expect(effectiveAdapterContract("opencode-cli").mutation).toBe("codex-owned");
  });

  test("the adapter's runtime name matches its registry key", () => {
    expect(createOpenCodeCliAdapter(provider()).name).toBe("opencode-cli");
  });
});

describe("the turn is a staged, permission-denied CLI run", () => {
  test("headless args pin model, agent, json format and the staging dir", () => {
    const args = buildOpenCodeArgs(parsed(), "/tmp/staging");
    expect(args.slice(args.indexOf("run"), args.indexOf("run") + 1)).toEqual(["run"]);
    expect(args).toContain("--pure");
    expect(args[args.indexOf("-m") + 1]).toBe("opencode/glm-5.3-flash-free");
    expect(args[args.indexOf("--agent") + 1]).toBe(OPENCODE_AGENT_ID);
    expect(args[args.indexOf("--format") + 1]).toBe("json");
    expect(args[args.indexOf("--dir") + 1]).toBe("/tmp/staging");
  });

  test("the prompt folds system prompts, replayed history and the assistant cue over stdin", () => {
    const prompt = buildOpencodePrompt(parsed({
      context: {
        messages: [
          { role: "user", content: "question one", timestamp: 0 },
          { role: "assistant", content: [{ type: "text", text: "answer one" }], timestamp: 0 },
          { role: "user", content: "question two", timestamp: 0 },
        ],
        systemPrompt: ["Be terse."],
      },
    }));
    expect(prompt).toContain("<system_instructions>\nBe terse.");
    expect(prompt).toContain("User: question one");
    expect(prompt).toContain("Assistant: answer one");
    expect(prompt).toContain("User: question two");
    expect(prompt.trimEnd().endsWith("Assistant:")).toBe(true);
  });

  test("spawn receives the quiet scoped env and the model id is in argv, the long prompt is only ever on stdin", async () => {
    const longPrompt = "x".repeat(200);
    const frame = JSON.stringify({ type: "step_finish", part: { reason: "stop", tokens: { input: 5, output: 2 } } });
    const child = fakeChild([enc.encode(`${frame}\n`)]);
    let spawnedFile = "";
    let spawnedEnv: Record<string, string> | undefined;
    const adapter = createOpenCodeCliAdapter(provider(), {
      which: whichOk,
      spawn: ((file: string, _args: string[], options: Record<string, unknown>) => {
        spawnedFile = file;
        spawnedEnv = options.env as Record<string, string>;
        return child;
      }) as unknown as OpenCodeCliAdapterDeps["spawn"],
    } as OpenCodeCliAdapterDeps);
    const events = await run(adapter, parsed({ context: { messages: [{ role: "user", content: longPrompt, timestamp: 0 }] } }));
    expect(spawnedFile.endsWith("opencode") || spawnedFile.includes("opencode")).toBe(true);
    // The scoped env drops inherited provider credential variables; there is no token to
    // layer because the CLI owns its own session.
    expect(spawnedEnv?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(spawnedEnv?.OPENAI_API_KEY).toBeUndefined();
    // argv is world-readable through process listing: it carries flags only, never the prompt.
    expect(child.written[0]).toContain(longPrompt);
    expect(events.find(e => e.type === "done")).toBeDefined();
  });

  test("runTurn maps text frames to text deltas by diffing the snapshot, then step_finish closes the turn", async () => {
    const frames = [
      JSON.stringify({ type: "text", part: { id: "p1", type: "text", text: "Hel" } }),
      JSON.stringify({ type: "text", part: { id: "p1", type: "text", text: "Hello there" } }),
      JSON.stringify({ type: "reasoning", part: { id: "p2", type: "reasoning", text: "thinking…" } }),
      JSON.stringify({ type: "text", part: { id: "p1", type: "text", text: "Hello there!" } }),
      JSON.stringify({ type: "step_finish", part: { reason: "stop", tokens: { input: 10, output: 4, cache: { read: 0, write: 0 } } } }),
    ].map(f => enc.encode(`${f}\n`));
    const adapter = createOpenCodeCliAdapter(provider(), depsFor(fakeChild(frames)));
    const events = await run(adapter, parsed());
    const text = events.filter(e => e.type === "text_delta").map(e => e.text).join("");
    expect(text).toBe("Hello there!");
    const thinking = events.filter(e => e.type === "thinking_delta").map(e => e.thinking).join("");
    expect(thinking).toBe("thinking…");
    const done = events.find(e => e.type === "done");
    expect(done).toBeDefined();
    if (done?.type === "done") {
      expect(done.stopReason).toBe("stop");
      expect(done.endTurn).toBe(true);
      expect(done.usage?.inputTokens).toBe(10);
      expect(done.usage?.outputTokens).toBe(4);
    }
  });

  test("an upstream error frame maps to a structured error without ending as success", async () => {
    const frame = JSON.stringify({
      type: "error",
      error: { name: "APIError", data: { message: "upstream exploded", statusCode: 503 } },
    });
    const adapter = createOpenCodeCliAdapter(provider(), depsFor(fakeChild([enc.encode(`${frame}\n`)])));
    const events = await run(adapter, parsed());
    expect(events.some(e => e.type === "error" && e.status === 503 && !e.retryable)).toBe(true);
  });

  test("the free-tier gate error is legible and non-retryable", () => {
    const mapped = mapOpenCodeError({
      error: { name: "FreeTierError", data: { message: "OpenCode's free tier can only be used in OpenCode", statusCode: 403 } },
    });
    expect(mapped).toMatchObject({
      status: 403,
      code: "opencode_free_tier_gate",
      retryable: false,
    });
    expect(mapped.message).toContain("official");
    expect(mapped.errorType).toBe("upstream_error");
  });

  test("a native tool call fails the turn closed instead of surfacing an answer", async () => {
    const frames = [
      JSON.stringify({ type: "text", part: { id: "p1", type: "text", text: "attempting… " } }),
      JSON.stringify({ type: "tool_use", part: { id: "p2", type: "tool", tool: "read", input: { path: "/etc" } } }),
      JSON.stringify({ type: "step_finish", part: { reason: "stop", tokens: {} } }),
    ].map(f => enc.encode(`${f}\n`));
    const adapter = createOpenCodeCliAdapter(provider(), depsFor(fakeChild(frames)));
    const events = await run(adapter, parsed());
    expect(events).toHaveLength(2); // the text before the call, then the error; never a done
    expect(events[1]).toMatchObject({ type: "error", code: "opencode_native_tool_call", retryable: false });
  });

  test("a tool-call finish reason on a tools-disabled turn fails closed too", () => {
    const state = { lastText: "", lastThinking: "" };
    mapOpenCodeFrame(JSON.parse(JSON.stringify({ type: "step_finish", part: { reason: "tool-calls", tokens: {} } })), state, () => {});
    expect(state.nativeToolCall).toBeDefined();
    expect(state.terminal).toBeUndefined();
  });

  test("image input is refused with the shared invalid-request shape", async () => {
    const adapter = createOpenCodeCliAdapter(provider(), { which: whichOk });
    const events = await run(adapter, parsed({
      context: {
        messages: [{
          role: "user",
          timestamp: 0,
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", imageUrl: "data:image/png;base64,iVBOR" },
          ],
        }],
      },
    }));
    expect(events[0]).toMatchObject({ type: "error", status: 400, code: "unsupported_input_modality", retryable: false });
  });

  test("a missing CLI fails with the install hint before any spawn attempt", async () => {
    const adapter = createOpenCodeCliAdapter(provider(), { which: () => undefined });
    const events = await run(adapter, parsed());
    expect(events[0]).toMatchObject({ type: "error", status: 500, code: "cli_not_found", retryable: false });
    expect(events[0].message).toContain(OPENCODE_CLI_PROFILE.installHint);
  });

  test("pre-aborted turns never spawn", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await run(createOpenCodeCliAdapter(provider(), { which: whichOk }), parsed(), {}, controller.signal);
    expect(events[0]).toMatchObject({ type: "error" });
    expect(events[0].message).toContain("aborted");
  });

  test("abort during the stream terminates the child and reports the abortion", async () => {
    const controller = new AbortController();
    const child = fakeChild([enc.encode(`${JSON.stringify({ type: "step_start" })}\n`)], { delayMs: 50 });
    const adapter = createOpenCodeCliAdapter(provider(), { ...depsFor(child), timeoutMs: 5_000 } as OpenCodeCliAdapterDeps);
    const runPromise = run(adapter, parsed(), {}, controller.signal);
    setTimeout(() => controller.abort(), 5);
    const events = await runPromise;
    const tail = events[events.length - 1]!;
    expect(tail.type === "error" && tail.message.includes("aborted")).toBe(true);
  });

  test("a non-canonical destination fails closed with the credential untouched", async () => {
    const events = await run(createOpenCodeCliAdapter(provider({ baseUrl: "https://evil.example/v1" }), { which: whichOk }), parsed());
    expect(events[0]).toMatchObject({ type: "error", status: 400, code: "non_canonical_destination", retryable: false });
  });
});

describe("the staged turn directory is private and every-capability-denied", () => {
  test("the staged agent denies all native tools while keeping read declared for the gate", async () => {
    const frame = JSON.stringify({ type: "step_finish", part: { reason: "stop", tokens: {} } });
    const child = fakeChild([enc.encode(`${frame}\n`)]);
    const capture: { agentMarkdown?: string; dir?: string } = {};
    const adapter = createOpenCodeCliAdapter(provider(), {
      which: whichOk,
      spawn: ((_file: string, args: string[]) => {
        const dir = args[args.indexOf("--dir") + 1]!;
        capture.dir = dir;
        const path = `${dir}/.opencode/agent/${OPENCODE_AGENT_ID}.md`;
        capture.agentMarkdown = existsSync(path) ? readFileSync(path, "utf8") : undefined;
        return child;
      }) as unknown as OpenCodeCliAdapterDeps["spawn"],
    } as OpenCodeCliAdapterDeps);
    const events = await run(adapter, parsed());
    expect(events.some(e => e.type === "done")).toBe(true);
    expect(capture.agentMarkdown).toBeDefined();
    const markdown = capture.agentMarkdown!;
    // The gate keeps a read entry; the path can never resolve.
    expect(markdown).toContain("read:");
    expect(markdown).toContain('"/nonexistent/ocx-opencode": allow');
    expect(markdown).toContain('"*": deny');
    expect(markdown).toContain("mode: primary");
    // After the turn ends, the staged dir (agent, any state) is gone.
    expect(existsSync(capture.dir!)).toBe(false);
  });
});

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startOpenCodeToolBridge } from "../../src/adapters/opencode-cli/tool-bridge";

test("OpenCode MCP captures client tool intent without executing it", async () => {
  const req = parsed({ context: { messages: [], tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }] } });
  const bridge = startOpenCodeToolBridge(req)!;
  const client = new Client({ name: "test", version: "1" });
  try {
    expect((await fetch(bridge.url, { headers: { Origin: "http://example.com" } })).status).toBe(403);
    expect((await fetch(new URL("/wrong", bridge.url))).status).toBe(403);
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url)));
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["read"]);
    await expect(client.callTool({ name: "unknown", arguments: {} })).rejects.toThrow("Unknown tool");
    await client.callTool({ name: "read", arguments: { path: "/not-executed" } });
    expect(await bridge.captured).toMatchObject({ name: "read", arguments: '{"path":"/not-executed"}' });
    await expect(client.callTool({ name: "read", arguments: {} })).rejects.toThrow("already captured");
  } finally { await client.close(); await bridge.close(); }
});

test("OpenCode tool choice none opens no capture server", () => {
  expect(startOpenCodeToolBridge(parsed())).toBeUndefined();
});

test("OpenCode prompt preserves client tool history", () => {
  const req = parsed({ context: { messages: [
    { role: "assistant", content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "/client.txt" } }], timestamp: 0 },
    { role: "toolResult", toolCallId: "call_read", toolName: "read", content: [{ type: "text", text: "client file result" }], timestamp: 0, isError: false },
  ] } });
  expect(buildOpencodePrompt(req)).toContain('"name":"read"');
  expect(buildOpencodePrompt(req)).toContain("client file result");
});


test("OpenCode adapter relays captured call and removes its private catalog", async () => {
  const child = fakeChild([]);
  child.stdout = new PassThrough();
  let turnDir = "";
  let request: Promise<unknown> | undefined;
  const client = new Client({ name: "adapter-test", version: "1" });
  const req = parsed({ context: { messages: [], tools: [{ name: "read", description: "Read", parameters: { type: "object" } }] } });
  const adapter = createOpenCodeCliAdapter(provider(), {
    which: whichOk,
    timeoutMs: 3000,
    spawn: ((_file, args) => {
      turnDir = args[args.indexOf("--dir") + 1];
      const config = JSON.parse(readFileSync(`${turnDir}/opencode.json`, "utf8"));
      request = (async () => {
        await client.connect(new StreamableHTTPClientTransport(new URL(config.mcp.opencodex.url)));
        await client.callTool({ name: "read", arguments: { path: "/external-only" } });
      })().catch(() => undefined); // The adapter closes transport immediately after capture.
      return child as unknown as ChildProcess;
    }) as OpenCodeCliAdapterDeps["spawn"],
  });
  try {
    const events = await run(adapter, req);
    await request;
    expect(events.map(event => event.type)).toEqual(["tool_call_start", "tool_call_delta", "tool_call_end", "done"]);
    expect(events[0]).toMatchObject({ name: "read" });
    expect(events[1]).toMatchObject({ arguments: '{"path":"/external-only"}' });
    expect(events[3]).toMatchObject({ stopReason: "tool_use", endTurn: false });
    expect(child.killed).toBe(true);
    expect(existsSync(turnDir)).toBe(false);
  } finally { await client.close(); }
});

test("OpenCode required tool choice cannot silently return text", async () => {
  const child = fakeChild([enc.encode(JSON.stringify({ type: "step_finish", part: { reason: "stop" } }) + "\n")]);
  const req = parsed({ options: { toolChoice: "required" }, context: { messages: [], tools: [{ name: "read", description: "Read", parameters: { type: "object" } }] } });
  const events = await run(createOpenCodeCliAdapter(provider(), depsFor(child)), req);
  expect(events).toMatchObject([{ type: "error", code: "opencode_required_tool_missing" }]);
});
