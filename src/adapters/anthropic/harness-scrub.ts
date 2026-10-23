/**
 * Third-party harness scrub for Claude OAuth system prompts.
 *
 * A Claude Pro/Max OAuth request whose system prompt carries a third-party coding-agent
 * harness's self-documentation block (pi's `<docs>…</docs>` section, which names the harness
 * and its install paths) is classed as a third-party app: Anthropic answers 400
 * "Third-party apps now draw from your extra usage, not your plan limits" even though the
 * Claude Code identity block and header fingerprint are present. Measured 2026-10-23: the same
 * request passes once that block is removed, and removing only its paths or rewording only
 * part of it does not help, so the whole block is cut.
 *
 * Applied to Claude OAuth requests only; an API-key lane has no plan limits to misclassify.
 *
 * LEAF MODULE: no runtime import.
 */

const HARNESS_DOCS_BLOCK = /[ \t]*<docs>[\s\S]*?<\/docs>[ \t]*\n?/g;

/** Remove each `<docs>…</docs>` block from a system prompt; text without one is returned as-is. */
export function stripHarnessDocsBlock(text: string): string {
  if (!text.includes("<docs>")) return text;
  return text.replace(HARNESS_DOCS_BLOCK, "");
}
