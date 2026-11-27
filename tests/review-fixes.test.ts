import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { KvStore } from "../src/store.js";
import { createProxyServer } from "../src/proxy/server.js";
import { parseArgs } from "../src/cli.js";
import { buildProxyEnv } from "../src/launcher/spawn.js";

function startMockUpstream(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("bad addr");
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("Review Fix Regression Suite", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it("Fix #1: normalizes // paths, preserves upstream subpaths (/api/v1), and collapses /v1/v1/", async () => {
    const seenPaths: string[] = [];
    const upstream = await startMockUpstream((req, res) => {
      seenPaths.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 10 } }));
    });
    cleanups.push(() => closeServer(upstream.server));

    const store = new KvStore(":memory:");
    cleanups.push(async () => store.close());
    const proxy = await createProxyServer({
      store,
      port: 0,
      heal: false,
      defaultSessionId: "s-url",
      upstreamAnthropic: `${upstream.url}/`,
      upstreamOpenAi: `${upstream.url}/api/v1`,
    });
    cleanups.push(() => proxy.close());

    // 1. Leading // must NOT become https://v1/messages host override
    const r1 = await fetch(`${proxy.url}//v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", messages: [] }),
    });
    expect(r1.status).toBe(200);

    // 2. Upstream subpath /api/v1 preserved + overlapping /v1 deduplicated
    const r2 = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4.1", messages: [] }),
    });
    expect(r2.status).toBe(200);

    // 3. Accidental /v1/v1/chat/completions collapsed
    const r3 = await fetch(`${proxy.url}/v1/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4.1", messages: [] }),
    });
    expect(r3.status).toBe(200);

    expect(seenPaths).toEqual([
      "/v1/messages",
      "/api/v1/chat/completions",
      "/api/v1/chat/completions",
    ]);
  });

  it.each(["/api/v1", "/api", "/codex"])("preserves an inherited OpenAI relay destination (%s), raw Responses body, synthetic auth/beta headers and SSE in wrap mode", async (basePath) => {
    let seenPath = "";
    let seenHeaders: http.IncomingHttpHeaders = {};
    let seenBody = Buffer.alloc(0);
    const sseText =
      `event: response.completed\n` +
      `data: {"type":"response.completed","response":{"usage":{"input_tokens":128,"input_tokens_details":{"cached_tokens":64},"output_tokens":3}}}\n\n`;
    const upstream = await startMockUpstream((req, res) => {
      seenPath = req.url ?? "";
      seenHeaders = req.headers;
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => {
        seenBody = Buffer.concat(chunks);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sseText);
      });
    });
    cleanups.push(() => closeServer(upstream.server));

    const inheritedUrl = `${upstream.url}${basePath}`;
    const parentEnv = { OPENAI_BASE_URL: inheritedUrl };
    const args = parseArgs(["--", "codex"], parentEnv);
    // Assert the destination before creating the proxy: the unpatched parser
    // fails here, so this regression never reaches the real OpenAI default.
    expect(args.upstreamOpenAi).toBe(inheritedUrl);
    expect(args.upstreamOpenAiIsClientBase).toBe(true);

    const store = new KvStore(":memory:");
    cleanups.push(async () => store.close());
    const proxy = await createProxyServer({
      store,
      port: 0,
      heal: false,
      defaultSessionId: "s-inherited-openai",
      upstreamOpenAi: args.upstreamOpenAi,
      upstreamOpenAiIsClientBase: args.upstreamOpenAiIsClientBase,
    });
    cleanups.push(() => proxy.close());

    const childEnv = buildProxyEnv(proxy.url, "s-inherited-openai", parentEnv);
    expect(childEnv.OPENAI_BASE_URL).toBe(`${proxy.url}/v1`);
    expect(parentEnv.OPENAI_BASE_URL).toBe(inheritedUrl);
    const rawBody = Buffer.from('{"model":"kvdiff-synthetic-route",  "stream":true, "input":"route-only"}');
    const response = await fetch(`${childEnv.OPENAI_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer kvdiff-synthetic-route-only",
        "openai-beta": "responses=v1",
      },
      body: rawBody,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(sseText);
    expect(seenPath).toBe(`${basePath}/responses`);
    expect(seenBody.equals(rawBody)).toBe(true);
    expect(seenHeaders.authorization).toBe("Bearer kvdiff-synthetic-route-only");
    expect(seenHeaders["openai-beta"]).toBe("responses=v1");

    await new Promise((r) => setTimeout(r, 40));
    const turns = store.getSessionTurns("s-inherited-openai");
    expect(turns).toHaveLength(1);
    expect(turns[0].usage.cacheReadTokens).toBe(64);
    expect(turns[0].usage.outputTokens).toBe(3);
  });

  it("keeps explicit non-v1 upstream flags on the original proxy-root path contract", async () => {
    let seenPath = "";
    const upstream = await startMockUpstream((req, res) => {
      seenPath = req.url ?? "";
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    cleanups.push(() => closeServer(upstream.server));

    const explicitUrl = `${upstream.url}/api`;
    const args = parseArgs(["--upstream-openai", explicitUrl, "--", "codex"], {
      OPENAI_BASE_URL: `${upstream.url}/codex`,
    });
    expect(args.upstreamOpenAi).toBe(explicitUrl);
    expect(args.upstreamOpenAiIsClientBase).toBeUndefined();

    const store = new KvStore(":memory:");
    cleanups.push(async () => store.close());
    const proxy = await createProxyServer({
      store,
      port: 0,
      heal: false,
      defaultSessionId: "s-explicit-openai-root",
      upstreamOpenAi: args.upstreamOpenAi,
      upstreamOpenAiIsClientBase: args.upstreamOpenAiIsClientBase,
    });
    cleanups.push(() => proxy.close());

    const childEnv = buildProxyEnv(proxy.url, "s-explicit-openai-root", {});
    const response = await fetch(`${childEnv.OPENAI_BASE_URL}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"kvdiff-synthetic-route","input":"route-only"}',
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(seenPath).toBe("/api/v1/responses");
  });

  it.each(["GOOGLE_GEMINI_BASE_URL", "GEMINI_API_BASE_URL"])(
    "routes a wrapped Gemini request through the inherited %s relay",
    async (baseKey) => {
      let seenPath = "";
      let seenHeaders: http.IncomingHttpHeaders = {};
      let seenBody = Buffer.alloc(0);
      const reply = '{"candidates":[],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":3}}';
      const upstream = await startMockUpstream((req, res) => {
        seenPath = req.url ?? "";
        seenHeaders = req.headers;
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => {
          seenBody = Buffer.concat(chunks);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(reply);
        });
      });
      cleanups.push(() => closeServer(upstream.server));

      const inheritedUrl = `${upstream.url}/gemini-relay`;
      const parentEnv = { [baseKey]: inheritedUrl };
      const args = parseArgs(["--", "gemini"], parentEnv);
      // Stop before starting the proxy if the inherited destination was lost.
      expect(args.upstreamGemini).toBe(inheritedUrl);

      const store = new KvStore(":memory:");
      cleanups.push(async () => store.close());
      const proxy = await createProxyServer({
        store,
        port: 0,
        heal: false,
        defaultSessionId: "s-inherited-gemini",
        upstreamGemini: args.upstreamGemini,
      });
      cleanups.push(() => proxy.close());

      const childEnv = buildProxyEnv(proxy.url, "s-inherited-gemini", parentEnv);
      expect(childEnv[baseKey]).toBe(proxy.url);
      const rawBody = Buffer.from('{"contents":[{"parts":[{"text":"synthetic"}]}]}');
      const response = await fetch(
        `${childEnv[baseKey]}/v1beta/models/gemini-2.5-pro:generateContent?alt=json`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": "synthetic-only" },
          body: rawBody,
        }
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(reply);
      expect(seenPath).toBe("/gemini-relay/v1beta/models/gemini-2.5-pro:generateContent?alt=json");
      expect(seenHeaders["x-goog-api-key"]).toBe("synthetic-only");
      expect(seenBody.equals(rawBody)).toBe(true);
    }
  );

  it("Fix #2: decompresses gzip SSE streams in tee parser without losing token usage", async () => {
    const sseText =
      `event: message_start\n` +
      `data: {"type":"message_start","message":{"usage":{"input_tokens":400,"cache_read_input_tokens":51000,"cache_creation_input_tokens":0,"output_tokens":5}}}\n\n` +
      `event: message_delta\n` +
      `data: {"type":"message_delta","usage":{"output_tokens":210}}\n\n`;

    const upstream = await startMockUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" });
      res.end(gzipSync(Buffer.from(sseText, "utf8")));
    });
    cleanups.push(() => closeServer(upstream.server));

    const store = new KvStore(":memory:");
    cleanups.push(async () => store.close());
    const proxy = await createProxyServer({
      store,
      port: 0,
      heal: false,
      defaultSessionId: "s-gz-sse",
      upstreamAnthropic: upstream.url,
    });
    cleanups.push(() => proxy.close());

    const resp = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", stream: true, messages: [] }),
    });
    expect(resp.status).toBe(200);
    await resp.text();
    await new Promise((r) => setTimeout(r, 40));

    const turns = store.getSessionTurns("s-gz-sse");
    expect(turns).toHaveLength(1);
    expect(turns[0].usage.cacheReadTokens).toBe(51_000);
    expect(turns[0].usage.outputTokens).toBe(210);
  });

  it("Fix #5 & #7: returns 400 on malformed session URI and blocks sibling-prefix static escape", async () => {
    const store = new KvStore(":memory:");
    cleanups.push(async () => store.close());
    const proxy = await createProxyServer({
      store,
      port: 0,
      heal: false,
      defaultSessionId: "s-sec",
      uiDir: "D:\\Codex\\Projects\\kvdiff\\dist\\ui",
    });
    cleanups.push(() => proxy.close());

    const badUri = await fetch(`${proxy.url}/__kvdiff/api/sessions/%E0/turns`);
    expect(badUri.status).toBe(400);

    // Raw HTTP request to bypass fetch URL normalization for ../ui-secret
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.get(`${proxy.url}/__kvdiff/..%2fui-secret/secret.txt`, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
    });
    expect(status).toBe(403);
  });

  it("Fix #8: skips count_tokens/500 errors and isolates concurrent background models from prevTurn baseline", async () => {
    let callNum = 0;
    const upstream = await startMockUpstream((req, res) => {
      callNum++;
      if (req.url === "/v1/messages/count_tokens") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 9000 }));
        return;
      }
      if (callNum === 3) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "overloaded" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          usage: { input_tokens: 1000, cache_read_input_tokens: 80000, cache_creation_input_tokens: 0, output_tokens: 50 },
        })
      );
    });
    cleanups.push(() => closeServer(upstream.server));

    const store = new KvStore(":memory:");
    cleanups.push(async () => store.close());
    const proxy = await createProxyServer({
      store,
      port: 0,
      heal: false,
      defaultSessionId: "s-iso",
      upstreamAnthropic: upstream.url,
    });
    cleanups.push(() => proxy.close());

    // Turn 1: Main Sonnet
    await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "1" }] }),
    });
    // Non-generation count_tokens (should be skipped)
    await fetch(`${proxy.url}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", messages: [] }),
    });
    // 500 error (should NOT pollute baseline)
    await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "fail" }] }),
    });
    // Concurrent background Haiku title request
    await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "title" }] }),
    });
    // Turn 2: Main Sonnet continues -> must compare against Turn 1 Sonnet, NOT Haiku or 500!
    await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "1" }, { role: "user", content: "2" }],
      }),
    });

    await new Promise((r) => setTimeout(r, 40));
    const turns = store.getSessionTurns("s-iso");
    expect(turns.some((t) => t.endpoint.includes("count_tokens"))).toBe(false);
    const sonnetTurns = turns.filter((t) => t.model === "claude-sonnet-4-5" && t.statusCode === 200);
    expect(sonnetTurns).toHaveLength(2);
    expect(sonnetTurns[1].diagnosis.kind).toBe("NONE");
  });
});
