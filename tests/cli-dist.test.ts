import { describe, it, expect } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

describe("built dist/cli.js smoke check", () => {
  it("runs node dist/cli.js --help cleanly under Node 24 without node:sqlite resolution errors", () => {
    const cliPath = resolve(process.cwd(), "dist", "cli.js");
    const out = execFileSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" });
    expect(out).toContain("kvdiff v0.1.0");
    expect(out).toContain("--demo");
    expect(out).toContain("--heal");
    expect(out).toContain("--upstream-gemini");
  });

  it("keeps an inherited Gemini relay when the built CLI wraps a client", async () => {
    const requests: Array<{ path: string; key: string | undefined; body: string }> = [];
    const upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        requests.push({
          path: req.url ?? "",
          key: req.headers["x-goog-api-key"] as string | undefined,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"candidates":[]}');
      });
    });
    await new Promise<void>((resolveListen) => upstream.listen(0, "127.0.0.1", resolveListen));
    try {
      const address = upstream.address();
      if (!address || typeof address === "string") throw new Error("No mock upstream address");
      const inheritedBase = `http://127.0.0.1:${address.port}/relay`;
      const cliPath = resolve(process.cwd(), "dist", "cli.js");
      const builtCli = await import(pathToFileURL(cliPath).href) as typeof import("../src/cli.js");
      expect(builtCli.parseArgs(["--", "gemini"], { GOOGLE_GEMINI_BASE_URL: inheritedBase }).upstreamGemini)
        .toBe(inheritedBase);
      const client = `
        (async () => {
          const base = new URL(process.env.GOOGLE_GEMINI_BASE_URL);
          if (base.protocol !== "http:" || base.hostname !== "127.0.0.1") {
            process.exitCode = 1;
            return;
          }
          const response = await fetch(
            base.href.replace(/\\/$/, "") + "/v1beta/models/gemini-2.5-pro:generateContent",
            { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": "synthetic-only" },
              body: '{"contents":[]}', signal: AbortSignal.timeout(5000) }
          );
          if (response.status !== 200 || await response.text() !== '{"candidates":[]}') process.exitCode = 1;
        })().catch(() => { process.exitCode = 1; });
      `;
      const child = spawn(process.execPath, [
        "--require", resolve(process.cwd(), "tests", "fixtures", "loopback-only.cjs"),
        cliPath, "--db", ":memory:", "--", process.execPath, "-e", client,
      ], {
        env: { ...process.env, GOOGLE_GEMINI_BASE_URL: inheritedBase, GEMINI_API_BASE_URL: "" },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      const timer = setTimeout(() => child.kill(), 10_000);
      const code = await new Promise<number | null>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("close", resolveExit);
      }).finally(() => clearTimeout(timer));
      expect(code, stderr).toBe(0);
      expect(requests).toEqual([{
        path: "/relay/v1beta/models/gemini-2.5-pro:generateContent",
        key: "synthetic-only",
        body: '{"contents":[]}',
      }]);
    } finally {
      await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
    }
  });
});
