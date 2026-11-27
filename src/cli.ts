import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { KvStore } from "./store.js";
import { createProxyServer } from "./proxy/server.js";
import { seedDemoSession } from "./demo/fixture.js";
import { runWrappedCommand } from "./launcher/spawn.js";
import { formatExitSummary } from "./launcher/hud.js";

export interface ParsedArgs {
  mode: "help" | "demo" | "serve" | "ui" | "wrap";
  port: number;
  portProvided: boolean;
  host: string;
  heal: boolean;
  dbPath: string;
  upstreamAnthropic?: string;
  upstreamOpenAi?: string;
  upstreamOpenAiIsClientBase?: boolean;
  upstreamGemini?: string;
  upstreamLocal?: string;
  wrappedCommand: string[];
}

const DEFAULT_DB = join(homedir(), ".kvdiff", "kvdiff.db");

function printHelp(): void {
  console.log(`kvdiff v0.1.0 — Local prompt-cache byte-diff proxy & prefix healer

Usage:
  kvdiff -- <command...>       Wrap an agent CLI (claude, codex, gemini, opencode)
  kvdiff serve [options]       Run standalone local proxy + waterfall UI
  kvdiff ui [options]          Open waterfall UI for existing ~/.kvdiff/kvdiff.db
  kvdiff --demo [options]      Launch pre-baked 16-turn Claude+MCP & Antigravity/Gemini demo

Options:
  --port <n>                   Local port (default: 4318)
  --host <addr>                Bind host (default: 127.0.0.1)
  --heal                       Opt-in deterministic tool/schema canonicalizer
  --db <path>                  SQLite DB path (default: ~/.kvdiff/kvdiff.db)
  --upstream-anthropic <url>   Override Anthropic API base URL
  --upstream-openai <url>      Override OpenAI API base URL
  --upstream-gemini <url>      Override Google Gemini / Antigravity API base URL
  --upstream-local <url>       Route OpenAI-compatible traffic to local llama.cpp/vLLM
  -h, --help                   Show this help`);
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedArgs {
  const sepIdx = argv.indexOf("--");
  const kvArgs = sepIdx >= 0 ? argv.slice(0, sepIdx) : argv;
  const wrappedCommand = sepIdx >= 0 ? argv.slice(sepIdx + 1) : [];

  const parsed: ParsedArgs = {
    mode: wrappedCommand.length > 0 ? "wrap" : "help",
    port: 4318,
    portProvided: false,
    host: "127.0.0.1",
    heal: false,
    dbPath: DEFAULT_DB,
    wrappedCommand,
  };

  const requireValue = (flag: string, nextIdx: number): string => {
    if (nextIdx >= kvArgs.length) {
      throw new Error(`Missing value for ${flag}`);
    }
    return kvArgs[nextIdx];
  };

  for (let i = 0; i < kvArgs.length; i++) {
    const arg = kvArgs[i];
    if (arg === "-h" || arg === "--help") {
      parsed.mode = "help";
      return parsed;
    } else if (arg === "--demo") {
      parsed.mode = "demo";
    } else if (arg === "serve") {
      parsed.mode = "serve";
    } else if (arg === "ui") {
      parsed.mode = "ui";
    } else if (arg === "--heal") {
      parsed.heal = true;
    } else if (arg === "--port") {
      const raw = requireValue("--port", ++i);
      const port = Number(raw);
      if (raw.trim() === "" || !Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`Invalid --port "${raw}": expected an integer between 0 and 65535`);
      }
      parsed.port = port;
      parsed.portProvided = true;
    } else if (arg === "--host") {
      parsed.host = requireValue("--host", ++i);
    } else if (arg === "--db") {
      parsed.dbPath = requireValue("--db", ++i);
    } else if (arg === "--upstream-anthropic") {
      parsed.upstreamAnthropic = requireValue("--upstream-anthropic", ++i);
    } else if (arg === "--upstream-openai") {
      parsed.upstreamOpenAi = requireValue("--upstream-openai", ++i);
    } else if (arg === "--upstream-gemini") {
      parsed.upstreamGemini = requireValue("--upstream-gemini", ++i);
    } else if (arg === "--upstream-local") {
      parsed.upstreamLocal = requireValue("--upstream-local", ++i);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}. Run "kvdiff --help" for usage.`);
    }
  }

  // Capture the child's current destinations before buildProxyEnv redirects it to
  // localhost. Explicit upstream flags retain priority; standalone serve/ui
  // keep their existing defaults.
  if (parsed.mode === "wrap") {
    if (parsed.upstreamOpenAi === undefined) {
      const inheritedOpenAi = env.OPENAI_BASE_URL || env.OPENAI_API_BASE;
      if (inheritedOpenAi) {
        parsed.upstreamOpenAi = inheritedOpenAi;
        parsed.upstreamOpenAiIsClientBase = true;
      }
    }
    parsed.upstreamAnthropic ??= env.ANTHROPIC_BASE_URL || undefined;
  }

  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "help") {
    printHelp();
    return;
  }

  if (args.mode === "demo") {
    const store = new KvStore(":memory:");
    seedDemoSession(store);
    const proxy = await createProxyServer({
      store,
      port: args.port,
      host: args.host,
      heal: args.heal,
      defaultSessionId: "demo-claude-mcp",
    });
    console.log(`[kvdiff] Demo mode ready -> ${proxy.url}`);
    console.log(`[kvdiff] Seeded 16-turn Claude Code + MCP session (Turn 14 cache bust + Turn 15 --heal) & Antigravity/Gemini session.`);
    console.log(`[kvdiff] Press Ctrl+C to stop.`);
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await proxy.close();
    store.close();
    return;
  }

  const store = new KvStore(args.dbPath);

  if (args.mode === "serve" || args.mode === "ui") {
    const sessionId = `serve-${randomUUID().slice(0, 8)}`;
    const proxy = await createProxyServer({
      store,
      port: args.port,
      host: args.host,
      heal: args.heal,
      defaultSessionId: sessionId,
      upstreamAnthropic: args.upstreamAnthropic,
      upstreamOpenAi: args.upstreamOpenAi,
      upstreamGemini: args.upstreamGemini,
      upstreamLocal: args.upstreamLocal,
      onTurnRecorded: (turn) => {
        const hitPct = Math.round(turn.diagnosis.cacheHitRate * 100);
        const tag = turn.diagnosis.kind !== "NONE" && turn.diagnosis.kind !== "FIRST_TURN" ? ` ⚠ ${turn.diagnosis.kind}` : "";
        process.stderr.write(
          `[kvdiff] Turn #${turn.turnIndex} (${turn.provider}/${turn.model}) | Hit ${hitPct}% | $${turn.costUsd.toFixed(4)}${tag}\n`
        );
      },
    });
    console.log(`[kvdiff] Listening on ${proxy.url} (${args.heal ? "HEAL ON" : "strict passthrough"})`);
    console.log(`[kvdiff] Waterfall UI: ${proxy.url}`);
    if (args.mode === "serve") {
      console.log(`[kvdiff] Point clients via ANTHROPIC_BASE_URL=${proxy.url} | OPENAI_BASE_URL=${proxy.url}/v1 | GOOGLE_GEMINI_BASE_URL=${proxy.url}`);
    }
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await proxy.close();
    store.close();
    return;
  }

  // Wrap mode: kvdiff -- <cmd...>
  const sessionId = `run-${randomUUID().slice(0, 8)}`;
  const cmdLabel = args.wrappedCommand.join(" ");
  store.createSession({
    id: sessionId,
    label: cmdLabel,
    command: cmdLabel,
    healed: args.heal,
  });

  const proxy = await createProxyServer({
    store,
    port: args.portProvided ? args.port : 0,
    host: args.host,
    heal: args.heal,
    defaultSessionId: sessionId,
    upstreamAnthropic: args.upstreamAnthropic,
    upstreamOpenAi: args.upstreamOpenAi,
    upstreamOpenAiIsClientBase: args.upstreamOpenAiIsClientBase,
    upstreamGemini: args.upstreamGemini,
    upstreamLocal: args.upstreamLocal,
  });

  process.stderr.write(
    `[kvdiff] Wrapping \`${cmdLabel}\` via ${proxy.url} (${args.heal ? "HEAL ON" : "passthrough"})\n`
  );

  let exitCode = 0;
  try {
    exitCode = await runWrappedCommand({
      command: args.wrappedCommand,
      proxyUrl: proxy.url,
      sessionId,
    });
  } finally {
    const turns = store.getSessionTurns(sessionId);
    process.stderr.write(`${formatExitSummary(turns, `kvdiff ui --db "${args.dbPath}"`)}\n`);
    await proxy.close();
    store.close();
  }

  process.exitCode = exitCode;
}

function isDirectEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)).toLowerCase() ===
      realpathSync(resolve(process.argv[1])).toLowerCase()
    );
  } catch {
    return resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase();
  }
}

if (isDirectEntry()) {
  main().catch((err) => {
    console.error(`[kvdiff] Fatal error: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
