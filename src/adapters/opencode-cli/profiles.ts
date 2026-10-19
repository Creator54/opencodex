import { clearCodingAgentBinaryCache, type CodingAgentProviderProfile } from "../coding-agent/profile";

/**
 * Profile for the official OpenCode CLI free-tier transport (§三十一).
 *
 * Like the Claude Code CLI row, the CLI owns the account: OpenCodex stores no
 * token, reads none, and injects none. The free tier is anonymous, so there is no
 * credential to pre-flight and no `tokenEnv` — the turn fails or succeeds on the
 * CLI's own session alone.
 *
 * `canonicalBaseUrl` is the destination the traffic actually reaches
 * (`https://opencode.ai`); OpenCodex never sends anything there itself. The row
 * fails closed if the base URL is overridden, exactly like the claude-cli family.
 *
 * Gate evidence (verified 2026-10-17 against the installed CLI 1.19.3): the
 * free tier answers `403 {"type":"FreeTierError","status":403}` for any turn whose
 * agent denies `read` (#139), while a turn from an agent that keeps `read`
 * declared passes. The adapter's staging agent therefore keeps a path-scoped
 * `read` allow on a nonexistent directory — the permission is present for the
 * gate but resolves to nothing, so OpenCode's native tools can never produce
 * anything meaningful. Evidence for the transport contract itself:
 *
 * - `opencode run --pure -m <id> --agent <agent> --format json --dir <dir>`
 *   streams NDJSON frames on stdout: `{type:"text"…,"part":{…}}`,
 *   `{type:"step_finish",…}` and `{type:"error",…}`.
 * - `echo prompt | opencode run …` feeds the turn from stdin.
 * - A plain hand-rolled HTTP request to the free-tier endpoint is refused with
 *   the same 403 regardless of headers, which is why the official binary is the
 *   only legitimate transport — this adapter never crafts upstream requests.
 */
export interface OpenCodeCliProfile extends CodingAgentProviderProfile {
  family: "opencode";
}

export const OPENCODE_CLI_PROFILE: OpenCodeCliProfile = {
  providerId: "opencode-cli",
  family: "opencode",
  // Not a vendor region switch: OpenCode has one destination, and the shared
  // seam's region slot carries the neutral value. The profile stays the single
  // authority either way.
  region: "global",
  label: "OpenCode CLI",
  canonicalBaseUrl: "https://opencode.ai",
  binaryCandidates: ["opencode"],
  installHint: "curl -fsSL https://opencode.ai/install | bash",
  documentationUrl: "https://opencode.ai/docs/cli/",
};

export const OPENCODE_CLI_PROFILES: readonly OpenCodeCliProfile[] = [OPENCODE_CLI_PROFILE];

/** Binary-discovery cache is shared across coding-agent families; re-exported for test isolation. */
export const clearOpenCodeCliBinaryCache = clearCodingAgentBinaryCache;
