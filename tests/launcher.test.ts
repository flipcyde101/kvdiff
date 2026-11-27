import { describe, it, expect } from "vitest";
import { runWrappedCommand } from "../src/launcher/spawn.js";
import { formatExitSummary } from "../src/launcher/hud.js";
import { parseArgs } from "../src/cli.js";
import type { TurnRecord } from "../src/types.js";

describe("launcher & terminal HUD", () => {
  it("injects Anthropic, OpenAI, and Gemini/Antigravity base URLs and preserves child exit code", async () => {
    const script = `
      const ok =
        process.env.ANTHROPIC_BASE_URL === "http://127.0.0.1:4318" &&
        process.env.OPENAI_BASE_URL === "http://127.0.0.1:4318/v1" &&
        process.env.GOOGLE_GEMINI_BASE_URL === "http://127.0.0.1:4318";
      process.exit(ok ? 42 : 1);
    `;
    const code = await runWrappedCommand({
      command: [process.execPath, "-e", script],
      proxyUrl: "http://127.0.0.1:4318",
      sessionId: "sess-1",
    });
    expect(code).toBe(42);
  });

  it.each([
    {
      name: "captures OPENAI_BASE_URL before localhost injection",
      flags: [],
      env: { OPENAI_BASE_URL: "https://relay.example/api/v1", OPENAI_API_BASE: "https://alias.example/v1" },
      expected: "https://relay.example/api/v1",
    },
    {
      name: "falls back to OPENAI_API_BASE",
      flags: [],
      env: { OPENAI_BASE_URL: "", OPENAI_API_BASE: "https://alias.example/v1" },
      expected: "https://alias.example/v1",
    },
    {
      name: "keeps an explicit upstream flag ahead of inherited destinations",
      flags: ["--upstream-openai", "https://explicit.example/v1"],
      env: { OPENAI_BASE_URL: "https://relay.example/api/v1", OPENAI_API_BASE: "https://alias.example/v1" },
      expected: "https://explicit.example/v1",
    },
    {
      name: "retains the OpenAI default when no destination is inherited",
      flags: [],
      env: {},
      expected: undefined,
    },
  ])("wrap mode $name", ({ flags, env, expected }) => {
    const args = parseArgs([...flags, "--", "codex"], env);
    expect(args.upstreamOpenAi).toBe(expected);
    expect(Boolean(args.upstreamOpenAiIsClientBase)).toBe(expected !== undefined && flags.length === 0);
  });

  it("captures the analogous Anthropic destination only in wrap mode, with explicit flags taking priority", () => {
    const env = { ANTHROPIC_BASE_URL: "https://anthropic-relay.example" };
    expect(parseArgs(["--", "claude"], env).upstreamAnthropic).toBe(env.ANTHROPIC_BASE_URL);
    expect(parseArgs(["--upstream-anthropic", "https://explicit.example", "--", "claude"], env).upstreamAnthropic)
      .toBe("https://explicit.example");
    expect(parseArgs(["serve"], env).upstreamAnthropic).toBeUndefined();
    expect(parseArgs(["serve"], { OPENAI_BASE_URL: "https://relay.example/v1" }).upstreamOpenAi).toBeUndefined();
  });

  it.each([
    {
      name: "prefers the Google Gemini base over the legacy alias",
      flags: [],
      env: { GOOGLE_GEMINI_BASE_URL: "https://primary.example/relay", GEMINI_API_BASE_URL: "https://alias.example" },
      expected: "https://primary.example/relay",
    },
    {
      name: "uses the legacy alias when the primary base is empty",
      flags: [],
      env: { GOOGLE_GEMINI_BASE_URL: "", GEMINI_API_BASE_URL: "https://alias.example/relay" },
      expected: "https://alias.example/relay",
    },
    {
      name: "keeps an explicit Gemini upstream ahead of inherited bases",
      flags: ["--upstream-gemini", "https://explicit.example/relay"],
      env: { GOOGLE_GEMINI_BASE_URL: "https://primary.example", GEMINI_API_BASE_URL: "https://alias.example" },
      expected: "https://explicit.example/relay",
    },
    { name: "keeps the default when neither base is set", flags: [], env: {}, expected: undefined },
  ])("wrap mode $name", ({ flags, env, expected }) => {
    expect(parseArgs([...flags, "--", "gemini"], env).upstreamGemini).toBe(expected);
  });

  it("does not inherit Gemini base URLs in standalone modes", () => {
    const env = { GOOGLE_GEMINI_BASE_URL: "https://primary.example", GEMINI_API_BASE_URL: "https://alias.example" };
    expect(parseArgs(["serve"], env).upstreamGemini).toBeUndefined();
    expect(parseArgs(["ui"], env).upstreamGemini).toBeUndefined();
  });

  it("formats exit summary cleanly for both empty and cache-broken sessions", () => {
    const empty = formatExitSummary([], "http://127.0.0.1:4318");
    expect(empty).toContain("0 turns");
    expect(empty).toContain("http://127.0.0.1:4318");

    const turns: TurnRecord[] = [
      {
        id: 1,
        sessionId: "s1",
        turnIndex: 1,
        timestampMs: 1000,
        provider: "anthropic",
        endpoint: "/v1/messages",
        model: "claude-sonnet-4-5",
        statusCode: 200,
        latencyMs: 500,
        healed: false,
        healChanges: [],
        usage: { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 80_000, outputTokens: 200, totalPromptTokens: 81_000 },
        costUsd: 0.3,
        diagnosis: {
          kind: "FIRST_TURN",
          byteOffset: null,
          jsonPath: null,
          prevSnippet: "",
          currSnippet: "",
          summary: "Initial",
          wastedUsd: 0,
          cacheHitRate: 0,
        },
        rawRequestBody: "{}",
      },
      {
        id: 2,
        sessionId: "s1",
        turnIndex: 2,
        timestampMs: 5000,
        provider: "anthropic",
        endpoint: "/v1/messages",
        model: "claude-sonnet-4-5",
        statusCode: 200,
        latencyMs: 800,
        healed: false,
        healChanges: [],
        usage: { inputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 80_000, outputTokens: 200, totalPromptTokens: 82_000 },
        costUsd: 0.35,
        diagnosis: {
          kind: "TOOL_REORDER",
          byteOffset: 18412,
          jsonPath: "$.tools[14].description",
          prevSnippet: "",
          currSnippet: "",
          summary: "Tool reordered",
          wastedUsd: 0.28,
          cacheHitRate: 0,
        },
        rawRequestBody: "{}",
      },
    ];

    const summary = formatExitSummary(turns, "http://127.0.0.1:4318");
    expect(summary).toContain("2 turns");
    expect(summary).toContain("TOOL_REORDER");
    expect(summary).toContain("$.tools[14].description");
    expect(summary).toContain("$0.28");
  });

  it("Fix #3: handles bare `node` command with `&` and spaces cleanly on Windows", async () => {
    const code = await runWrappedCommand({
      command: ["node", "-e", 'process.exit("hello & world".includes("&") ? 21 : 1)'],
      proxyUrl: "http://127.0.0.1:4318",
      sessionId: "sess-win",
    });
    expect(code).toBe(21);
  });

  it("Fix #11: preserves explicit --port 4318 in wrap mode", () => {
    const explicit = parseArgs(["--port", "4318", "--", "claude"]);
    expect(explicit.port).toBe(4318);
    expect(explicit.portProvided).toBe(true);

    const implicit = parseArgs(["--", "claude"]);
    expect(implicit.portProvided).toBe(false);
  });

  it("validates --port strictly and rejects NaN, non-integers, negative, >65535, or missing values", () => {
    expect(parseArgs(["serve", "--port", "0"]).port).toBe(0);
    expect(parseArgs(["serve", "--port", "65535"]).port).toBe(65535);

    for (const bad of ["abc", "3.14", "-1", "65536", ""]) {
      expect(() => parseArgs(["serve", "--port", bad])).toThrow(/--port/i);
    }
    expect(() => parseArgs(["serve", "--port"])).toThrow(/--port/i);
  });

  it("rejects unknown --flags before -- while forwarding child flags after --", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown option.*--bogus/i);
    expect(() => parseArgs(["serve", "--unknown-flag", "--", "claude"])).toThrow(/unknown option.*--unknown-flag/i);

    const forwarded = parseArgs(["--", "claude", "--unknown-child-flag"]);
    expect(forwarded.mode).toBe("wrap");
    expect(forwarded.wrappedCommand).toEqual(["claude", "--unknown-child-flag"]);
  });
});
