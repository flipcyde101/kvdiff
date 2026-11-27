import http from "node:http";
import https from "node:https";
import {
  brotliDecompressSync,
  createBrotliDecompress,
  createGunzip,
  createInflate,
  gunzipSync,
  inflateSync,
} from "node:zlib";
import type { Transform } from "node:stream";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { KvStore } from "../store.js";
import type { ProviderKind, TokenUsage, TurnRecord } from "../types.js";
import { detectProvider } from "../providers/detect.js";
import { parseAnthropicUsage } from "../providers/anthropic.js";
import { parseOpenAiUsage } from "../providers/openai.js";
import { extractGeminiModel, parseGeminiUsage } from "../providers/gemini.js";
import { diagnoseCacheBreak } from "../diff/diagnose.js";
import { healRequestPayload } from "../heal/canonicalize.js";
import { estimateCost } from "../pricing.js";
import { SseTeeParser } from "./sse.js";

export interface ProxyServerOptions {
  store: KvStore;
  port: number;
  host?: string;
  heal: boolean;
  defaultSessionId: string;
  upstreamAnthropic?: string;
  upstreamOpenAi?: string;
  upstreamOpenAiIsClientBase?: boolean;
  upstreamGemini?: string;
  upstreamLocal?: string;
  uiDir?: string;
  onTurnRecorded?: (turn: TurnRecord) => void;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const NON_GENERATION_PATH_RE = /(?:\/count_tokens|:countTokens|\/embeddings)\b/i;

function normalizeIncomingUrl(rawUrl: string): { pathname: string; search: string; normalized: string } {
  const qIdx = rawUrl.indexOf("?");
  const rawPath = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
  const search = qIdx >= 0 ? rawUrl.slice(qIdx) : "";
  // Collapse leading duplicate slashes so `//v1/messages` can never override upstream host
  let pathname = rawPath.replace(/^\/+/, "/");
  // Collapse accidental `/v1/v1/...` from OPENAI_BASE_URL=.../v1 + client `/v1/...`
  pathname = pathname.replace(/^\/v1\/v1(\/|$)/, "/v1$1");
  return { pathname, search, normalized: `${pathname}${search}` };
}

function buildUpstreamUrl(upstreamBase: string, pathname: string, search: string, isClientBase = false): URL {
  const base = new URL(upstreamBase);
  const basePath = base.pathname.replace(/\/+$/, "");
  let reqPath = pathname;

  // A captured client base already contains its complete API prefix; `/v1`
  // belongs to our injected localhost base, not necessarily the upstream.
  // Explicit upstream flags retain the existing overlapping-/v1 behavior.
  if ((isClientBase || basePath.endsWith("/v1")) && (reqPath === "/v1" || reqPath.startsWith("/v1/"))) {
    reqPath = reqPath.slice(3) || "/";
  }

  const joinedPath = `${basePath}${reqPath.startsWith("/") ? reqPath : `/${reqPath}`}`.replace(/\/{2,}/g, "/");
  base.pathname = joinedPath;
  base.search = search;
  return base;
}

function decompressIfNeeded(buf: Buffer, encodingHeader: string | string[] | undefined): Buffer {
  const enc = (Array.isArray(encodingHeader) ? encodingHeader[0] : encodingHeader ?? "").toLowerCase().trim();
  if (!enc || buf.length === 0) return buf;
  try {
    if (enc.includes("gzip")) return gunzipSync(buf);
    if (enc.includes("br")) return brotliDecompressSync(buf);
    if (enc.includes("deflate")) return inflateSync(buf);
  } catch {
    return buf;
  }
  return buf;
}

function createStreamingDecompressor(encodingHeader: string | string[] | undefined): Transform | null {
  const enc = (Array.isArray(encodingHeader) ? encodingHeader[0] : encodingHeader ?? "").toLowerCase().trim();
  if (!enc) return null;
  if (enc.includes("gzip")) return createGunzip();
  if (enc.includes("br")) return createBrotliDecompress();
  if (enc.includes("deflate")) return createInflate();
  return null;
}

function readStreamToBuffer(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBuf, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolveBuf(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function extractModelFromRequest(provider: ProviderKind, urlPath: string, bodyBuf: Buffer): string {
  if (provider === "gemini") {
    return extractGeminiModel(urlPath);
  }
  try {
    const parsed = JSON.parse(bodyBuf.toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.model === "string" && parsed.model.trim()) {
      return parsed.model.trim();
    }
  } catch {
    // ignore non-JSON body
  }
  return `${provider}-unknown`;
}

function parseProviderUsage(provider: ProviderKind, payload: unknown): TokenUsage {
  if (provider === "anthropic") return parseAnthropicUsage(payload);
  if (provider === "gemini") return parseGeminiUsage(payload);
  return parseOpenAiUsage(payload);
}

function resolveDefaultUiDir(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidateA = join(here, "ui");
  if (existsSync(candidateA)) return candidateA;
  return join(here, "..", "..", "dist", "ui");
}

function resolveUpstreamBase(provider: ProviderKind, opts: ProxyServerOptions): string {
  if (provider === "anthropic") return opts.upstreamAnthropic ?? "https://api.anthropic.com";
  if (provider === "gemini") return opts.upstreamGemini ?? "https://generativelanguage.googleapis.com";
  if (provider === "local-openai" && opts.upstreamLocal) return opts.upstreamLocal;
  return opts.upstreamOpenAi ?? "https://api.openai.com";
}

export async function createProxyServer(opts: ProxyServerOptions): Promise<{
  server: http.Server;
  url: string;
  port: number;
  close: () => Promise<void>;
}> {
  const host = opts.host ?? "127.0.0.1";
  const resolvedUiDir = resolve(opts.uiDir ?? resolveDefaultUiDir());
  const uiDirPrefix = resolvedUiDir.endsWith(sep) ? resolvedUiDir : `${resolvedUiDir}${sep}`;
  const sseClients = new Set<http.ServerResponse>();

  const broadcastEvent = (payload: unknown): void => {
    const msg = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
      if (client.writableEnded || client.destroyed) {
        sseClients.delete(client);
        continue;
      }
      client.write(msg);
    }
  };

  const serveUiAsset = (reqPath: string, res: http.ServerResponse): void => {
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(reqPath);
    } catch {
      res.writeHead(400);
      res.end("Bad Request");
      return;
    }

    const stripped = decodedPath.replace(/^\/__kvdiff\/?/, "/");
    const rel = stripped === "/" || stripped === "" ? "index.html" : stripped.replace(/^\/+/, "");
    const safePath = resolve(resolvedUiDir, rel);

    if (safePath !== resolvedUiDir && !safePath.startsWith(uiDirPrefix)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    const target = existsSync(safePath) && statSync(safePath).isFile()
      ? safePath
      : join(resolvedUiDir, "index.html");

    if (!existsSync(target)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><body style="font-family:monospace;background:#0d1117;color:#c9d1d9;padding:24px"><h2>kvdiff proxy running</h2><p>UI bundle not built yet. Run <code>npm run build</code>.</p></body></html>`
      );
      return;
    }

    const ext = extname(target).toLowerCase();
    res.writeHead(200, { "content-type": MIME_TYPES[ext] ?? "application/octet-stream" });
    res.end(readFileSync(target));
  };

  const server = http.createServer(async (req, res) => {
    res.on("error", () => {
      // swallow client socket reset errors safely
    });

    try {
      const { pathname, search, normalized } = normalizeIncomingUrl(req.url ?? "/");

      // Internal kvdiff API & UI routes
      if (pathname === "/__kvdiff/api/sessions" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(opts.store.listSessions()));
        return;
      }

      const turnsMatch = /^\/__kvdiff\/api\/sessions\/([^/]+)\/turns$/.exec(pathname);
      if (turnsMatch && req.method === "GET") {
        let sessionId: string;
        try {
          sessionId = decodeURIComponent(turnsMatch[1]);
        } catch {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "invalid_session_id" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(opts.store.getSessionTurns(sessionId)));
        return;
      }

      if (pathname === "/__kvdiff/api/events" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
        sseClients.add(res);
        const dropClient = () => sseClients.delete(res);
        req.on("close", dropClient);
        res.on("close", dropClient);
        res.on("error", dropClient);
        return;
      }

      if (
        req.method === "GET" &&
        (pathname === "/" || pathname.startsWith("/__kvdiff") || pathname.startsWith("/assets/"))
      ) {
        serveUiAsset(pathname, res);
        return;
      }

      // Reverse proxy LLM API traffic
      const startedAt = Date.now();
      const rawReqBuf = await readStreamToBuffer(req);
      const inspectReqBuf = decompressIfNeeded(rawReqBuf, req.headers["content-encoding"]);
      const provider = detectProvider(normalized, req.headers, Boolean(opts.upstreamLocal));
      const upstreamBase = resolveUpstreamBase(provider, opts);
      const upstreamUrl = buildUpstreamUrl(
        upstreamBase,
        pathname,
        search,
        provider === "openai" && Boolean(opts.upstreamOpenAiIsClientBase)
      );

      let forwardReqBuf = rawReqBuf;
      let healed = false;
      let healChanges: string[] = [];
      let recordedReqBuf = inspectReqBuf;

      if (opts.heal && inspectReqBuf.length > 0 && req.method === "POST") {
        const healRes = healRequestPayload(provider, inspectReqBuf);
        if (healRes.changes.length > 0) {
          forwardReqBuf = healRes.body;
          recordedReqBuf = healRes.body;
          healed = true;
          healChanges = healRes.changes;
        }
      }

      const forwardHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        const lower = k.toLowerCase();
        if (HOP_BY_HOP_HEADERS.has(lower)) continue;
        if (lower === "x-kvdiff-session") continue;
        if (healed && (lower === "content-encoding" || lower === "content-length")) continue;
        forwardHeaders[k] = v;
      }
      forwardHeaders["host"] = upstreamUrl.host;
      if (healed) {
        forwardHeaders["content-length"] = String(forwardReqBuf.length);
      }

      const sessionHeader = req.headers["x-kvdiff-session"];
      const sessionId =
        (typeof sessionHeader === "string" && sessionHeader.trim()) || opts.defaultSessionId;

      const transport = upstreamUrl.protocol === "https:" ? https : http;
      const upstreamReq = transport.request(
        upstreamUrl,
        {
          method: req.method,
          headers: forwardHeaders,
        },
        (upstreamRes) => {
          const respHeaders: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(upstreamRes.headers)) {
            if (v === undefined) continue;
            if (HOP_BY_HOP_HEADERS.has(k.toLowerCase())) continue;
            respHeaders[k] = v;
          }
          const statusCode = upstreamRes.statusCode ?? 502;
          res.writeHead(statusCode, respHeaders);

          const contentType = String(upstreamRes.headers["content-type"] ?? "").toLowerCase();
          const isSse = contentType.includes("text/event-stream");
          const sseParser = isSse ? new SseTeeParser() : null;
          const sseDecompressor = isSse ? createStreamingDecompressor(upstreamRes.headers["content-encoding"]) : null;
          let sseDecompressDone: Promise<void> | null = null;

          if (sseParser && sseDecompressor) {
            sseDecompressDone = new Promise<void>((resolveDone) => {
              sseDecompressor.on("data", (decChunk: Buffer) => sseParser.push(decChunk));
              sseDecompressor.on("end", () => resolveDone());
              sseDecompressor.on("error", () => resolveDone());
            });
          }

          const respChunks: Buffer[] = [];
          const maxBufferedBytes = 8 * 1024 * 1024;
          let respBytes = 0;

          upstreamRes.on("data", (chunk: Buffer) => {
            if (!res.writableEnded && !res.destroyed) {
              res.write(chunk);
            }
            if (sseParser) {
              if (sseDecompressor) {
                sseDecompressor.write(chunk);
              } else {
                sseParser.push(chunk);
              }
            } else if (respBytes < maxBufferedBytes) {
              respChunks.push(chunk);
              respBytes += chunk.length;
            }
          });

          upstreamRes.on("end", async () => {
            if (!res.writableEnded) res.end();
            try {
              if (sseDecompressor) {
                sseDecompressor.end();
                await sseDecompressDone;
              }

              // Skip non-generation endpoints (count_tokens, embeddings) and non-POST traffic
              if (req.method !== "POST" || recordedReqBuf.length === 0 || NON_GENERATION_PATH_RE.test(pathname)) {
                return;
              }
              // Skip failed upstream responses so 429/500 errors don't pollute turn baselines
              if (statusCode < 200 || statusCode >= 300) {
                return;
              }

              let parsedPayload: unknown = null;
              if (sseParser) {
                parsedPayload = sseParser.finish();
              } else {
                const rawResp = decompressIfNeeded(
                  Buffer.concat(respChunks),
                  upstreamRes.headers["content-encoding"]
                );
                try {
                  parsedPayload = JSON.parse(rawResp.toString("utf8"));
                } catch {
                  parsedPayload = null;
                }
              }

              const model = extractModelFromRequest(provider, normalized, recordedReqBuf);
              const usage = parseProviderUsage(provider, parsedPayload);
              const prevTurn = opts.store.getLastTurn(sessionId, model);
              const turnIndex = opts.store.getNextTurnIndex(sessionId);
              const nowMs = Date.now();
              const diagnosis = diagnoseCacheBreak({
                provider,
                prevTurn,
                currBody: recordedReqBuf,
                currModel: model,
                currTimestampMs: nowMs,
                currUsage: usage,
              });
              const { costUsd } = estimateCost(model, usage, prevTurn?.usage.totalPromptTokens ?? 0);

              const turn = opts.store.recordTurn({
                sessionId,
                turnIndex,
                timestampMs: nowMs,
                provider,
                endpoint: pathname,
                model,
                statusCode,
                latencyMs: nowMs - startedAt,
                healed,
                healChanges,
                usage,
                costUsd,
                diagnosis,
                rawRequestBody: recordedReqBuf.toString("utf8"),
              });

              opts.onTurnRecorded?.(turn);
              broadcastEvent({ type: "turn", sessionId, turnId: turn.id, turnIndex: turn.turnIndex });
            } catch (persistErr) {
              process.stderr.write(`[kvdiff] warning: failed to record turn: ${(persistErr as Error).message}\n`);
            }
          });

          upstreamRes.on("error", () => {
            if (!res.writableEnded) res.end();
          });
        }
      );

      // Abort upstream immediately if client cancels/disconnects mid-stream
      res.on("close", () => {
        if (!res.writableFinished) {
          upstreamReq.destroy();
        }
      });

      upstreamReq.on("error", (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
        }
        if (!res.writableEnded) {
          res.end(JSON.stringify({ error: "kvdiff_upstream_error", message: err.message }));
        }
      });

      if (forwardReqBuf.length > 0) {
        upstreamReq.write(forwardReqBuf);
      }
      upstreamReq.end();
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: "kvdiff_proxy_error", message: (err as Error).message }));
      }
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => resolveListen());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to resolve listening port");
  }

  return {
    server,
    port: addr.port,
    url: `http://${host}:${addr.port}`,
    close: async () => {
      for (const client of sseClients) {
        client.end();
      }
      sseClients.clear();
      server.closeIdleConnections?.();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}
