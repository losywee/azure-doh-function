import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { upstreamCache } from "./dnsQuery.js";

function authorized(request: HttpRequest): boolean {
  const key = process.env.DASHBOARD_KEY;
  return Boolean(key && request.headers.get("x-dashboard-key") === key);
}

export async function cache(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  if (!process.env.DASHBOARD_KEY || !authorized(request)) return { status: 401, jsonBody: { error: "Dashboard key required" } };
  if (request.method === "GET") return { status: 200, jsonBody: upstreamCache.stats() };
  if (request.method === "DELETE") {
    upstreamCache.clear();
    return { status: 200, jsonBody: upstreamCache.stats() };
  }
  return { status: 405, jsonBody: { error: "Only GET and DELETE are supported" } };
}

export async function purgeCache(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  if (!process.env.DASHBOARD_KEY || !authorized(request)) return { status: 401, jsonBody: { error: "Dashboard key required" } };
  upstreamCache.clear();
  return { status: 200, jsonBody: upstreamCache.stats() };
}

app.http("cache", { methods: ["GET", "DELETE"], authLevel: "anonymous", route: "cache", handler: cache });
app.http("purgeCache", { methods: ["POST"], authLevel: "anonymous", route: "cache/purge", handler: purgeCache });
