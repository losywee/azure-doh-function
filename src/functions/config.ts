import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getPersistentRuntimeConfig, savePersistentRuntimeConfig } from "../persistentState.js";
import { applyRuntimeConfig, getRuntimeConfig, RuntimeConfig } from "../config.js";

function authorized(request: HttpRequest): boolean {
  const key = process.env.DASHBOARD_KEY;
  return Boolean(key && request.headers.get("x-dashboard-key") === key);
}

export async function config(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  if (!process.env.DASHBOARD_KEY || !authorized(request)) return { status: 401, jsonBody: { error: "Dashboard key required" } };
  if (request.method === "GET") return { status: 200, jsonBody: await getPersistentRuntimeConfig() };
  if (request.method !== "PUT") return { status: 405, jsonBody: { error: "Only GET and PUT are supported" } };
  try {
    const input = await request.json() as Partial<RuntimeConfig>;
    const current = await getPersistentRuntimeConfig();
    const runtime = applyRuntimeConfig({ ...current, ...input });
    return { status: 200, jsonBody: await savePersistentRuntimeConfig(runtime) };
  } catch (error) {
    return { status: 400, jsonBody: { error: error instanceof Error ? error.message : "Invalid configuration" } };
  }
}

app.http("config", { methods: ["GET", "PUT"], authLevel: "anonymous", route: "config", handler: config });
