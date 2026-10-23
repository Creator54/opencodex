/**
 * Claude OAuth requests must not carry a third-party harness's `<docs>` self-documentation
 * block: Anthropic classes such a request as a third-party app and answers 400 "Third-party
 * apps now draw from your extra usage". The scrub runs on the OAuth system prompt only.
 */
import { describe, expect, test } from "bun:test";
import { stripHarnessDocsBlock } from "../../../src/adapters/anthropic/harness-scrub";
import { anthropicOAuthWireBody } from "../../../src/adapters/anthropic/passthrough";
import { CLAUDE_CODE_SYSTEM_INSTRUCTION } from "../../../src/oauth/anthropic";

const DOCS = [
  "<docs>",
  "Harness documentation (read only when the user asks about the harness itself):",
  "- Main documentation: /home/user/.harness/agent/README.md",
  "- Always read .md files completely",
  "</docs>",
].join("\n");

const PROMPT = `You are an expert coding assistant.\n\n${DOCS}\n\n<project_context>\nkeep me\n</project_context>`;

describe("stripHarnessDocsBlock", () => {
  test("removes the docs block and keeps the rest", () => {
    const out = stripHarnessDocsBlock(PROMPT);
    expect(out).not.toContain("<docs>");
    expect(out).not.toContain("Main documentation");
    expect(out).toContain("You are an expert coding assistant.");
    expect(out).toContain("<project_context>\nkeep me\n</project_context>");
  });

  test("removes every block when several are present", () => {
    const out = stripHarnessDocsBlock(`a\n${DOCS}\nb\n${DOCS}\nc`);
    expect(out).not.toContain("docs>");
    expect(out).toContain("a\n");
    expect(out).toContain("b\n");
    expect(out).toContain("c");
  });

  test("returns text without a docs block unchanged", () => {
    const text = "plain system prompt, no block";
    expect(stripHarnessDocsBlock(text)).toBe(text);
  });

  test("an unterminated block is left alone", () => {
    const text = "before <docs> never closed";
    expect(stripHarnessDocsBlock(text)).toBe(text);
  });
});

describe("anthropicOAuthWireBody system scrub", () => {
  test("string system: identity first, docs block removed", () => {
    const { body } = anthropicOAuthWireBody({ model: "m", system: PROMPT, messages: [] });
    const system = body.system as Array<{ type: string; text: string }>;
    expect(system[0]).toEqual({ type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION });
    expect(system[1]!.text).not.toContain("<docs>");
    expect(system[1]!.text).toContain("keep me");
  });

  test("block-array system: every text block is scrubbed, other fields kept", () => {
    const { body } = anthropicOAuthWireBody({
      model: "m",
      system: [{ type: "text", text: PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [],
    });
    const system = body.system as Array<Record<string, unknown>>;
    expect(system[0]).toEqual({ type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION });
    expect(system[1]!.text).not.toContain("<docs>");
    expect(system[1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  test("the caller's body is not mutated", () => {
    const source = { model: "m", system: [{ type: "text", text: PROMPT }], messages: [] };
    anthropicOAuthWireBody(source);
    expect(source.system[0]!.text).toBe(PROMPT);
  });
});
