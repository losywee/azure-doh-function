import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { readFile } from "node:fs/promises";
import path from "node:path";

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

export async function dashboard(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const dist = path.join(process.cwd(), "dashboard", "dist");
  const requested = request.params.path || "index.html";
  const relative = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
  const filePath = path.resolve(dist, relative);
  const insideDist = filePath === dist || filePath.startsWith(`${dist}${path.sep}`);
  if (!insideDist) return { status: 400, body: "Invalid dashboard path" };

  try {
    const body = await readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    return {
      status: 200,
      headers: {
        "content-type": contentTypes[extension] ?? "application/octet-stream",
        "cache-control": extension === ".html" ? "no-cache" : "public, max-age=31536000, immutable"
      },
      body
    };
  } catch {
    if (path.extname(relative)) return { status: 404, body: "Dashboard asset not found" };
    try {
      return {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
        body: await readFile(path.join(dist, "index.html"))
      };
    } catch (error) {
      context.error("Dashboard build is missing", error);
      return { status: 503, body: "Dashboard is not built. Run npm run dashboard:build." };
    }
  }
}

app.http("dashboard", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "dashboard/{*path}",
  handler: dashboard
});
