import type { IncomingMessage, ServerResponse } from "node:http";
import { access, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type WorkerModule = {
  default: {
    fetch(
      request: Request,
      env: { ASSETS: { fetch(request: Request): Promise<Response> } },
      context: { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void },
    ): Promise<Response>;
  };
};

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export class WebAppHandler {
  private readonly clientRoot: string;
  private readonly serverEntry: string;
  private worker: Promise<WorkerModule | undefined> | undefined;

  constructor(packageRoot: string) {
    this.clientRoot = resolve(packageRoot, "dist", "client");
    this.serverEntry = resolve(packageRoot, "dist", "server", "index.js");
  }

  async respond(request: IncomingMessage, response: ServerResponse, publicUrl: URL): Promise<void> {
    const url = new URL(request.url ?? "/", publicUrl);
    const staticResponse = await this.assetResponse(url.pathname);
    const result = staticResponse ?? (await this.render(request, url));
    response.statusCode = result.status;
    result.headers.forEach((value, key) => response.setHeader(key, value));
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    response.end(Buffer.from(await result.arrayBuffer()));
  }

  private async render(request: IncomingMessage, url: URL): Promise<Response> {
    const worker = await this.getWorker();
    if (!worker) {
      return new Response(
        "<!doctype html><title>Raft hub</title><h1>Raft hub is running</h1><p>Build the bundled web application to enable the workspace UI.</p>",
        { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(key, item);
      else if (value !== undefined) headers.set(key, value);
    }
    return worker.default.fetch(
      new Request(url, { method: request.method ?? "GET", headers }),
      { ASSETS: { fetch: async (assetRequest) => (await this.assetResponse(new URL(assetRequest.url).pathname)) ?? new Response("Not found", { status: 404 }) } },
      { waitUntil() {}, passThroughOnException() {} },
    );
  }

  private async getWorker(): Promise<WorkerModule | undefined> {
    this.worker ??= (async () => {
      try {
        await access(this.serverEntry);
        return (await import(pathToFileURL(this.serverEntry).href)) as WorkerModule;
      } catch {
        return undefined;
      }
    })();
    return this.worker;
  }

  private async assetResponse(pathname: string): Promise<Response | undefined> {
    const normalized = pathname === "/" ? "" : pathname.replace(/^\/+/, "");
    if (!normalized || normalized.includes("..")) return undefined;
    const path = resolve(this.clientRoot, normalized);
    if (!path.startsWith(`${this.clientRoot}/`)) return undefined;
    try {
      const body = await readFile(path);
      return new Response(body, {
        headers: {
          "Content-Type": mimeTypes[extname(path)] ?? "application/octet-stream",
          "Cache-Control": pathname.includes("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=300",
        },
      });
    } catch {
      return undefined;
    }
  }
}
