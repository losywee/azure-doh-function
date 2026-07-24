export type DnsMode = "doh" | "local" | "auto";

export interface RuntimeConfig {
  mode: DnsMode;
  upstreams: string[];
  customHosts: string;
  timeoutMs: number;
  maxBodyBytes: number;
  adBlockEnabled: boolean;
  adBlockSource: string;
  adBlockRefreshMs: number;
  queryAliases: string[];
}

export function getRuntimeConfig(): RuntimeConfig {
  const mode = process.env.DNS_QUERY_MODE?.toLowerCase();
  return {
    mode: mode === "local" || mode === "auto" ? mode : "doh",
    upstreams: (process.env.DOH_UPSTREAM_URLS ?? process.env.DOH_UPSTREAM_URL ?? "https://cloudflare-dns.com/dns-query")
      .split(/[\n,]+/).map((item) => item.trim()).filter(Boolean),
    customHosts: process.env.CUSTOM_HOSTS ?? "",
    timeoutMs: positiveNumber(process.env.DOH_TIMEOUT_MS, 5000, 30000),
    maxBodyBytes: positiveNumber(process.env.DOH_MAX_BODY_BYTES, 65535, 1048576)
    ,adBlockEnabled: process.env.AD_BLOCK_ENABLED === "true"
    ,adBlockSource: process.env.AD_BLOCK_SOURCE ?? "https://raw.githubusercontent.com/rentianyu/Ad-set-hosts/master/hosts"
    ,adBlockRefreshMs: positiveNumber(process.env.AD_BLOCK_REFRESH_MS, 21600000, 604800000)
    ,queryAliases: []
  };
}

function positiveNumber(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

export function applyRuntimeConfig(input: Partial<RuntimeConfig>): RuntimeConfig {
  if (input.mode !== undefined && !["doh", "local", "auto"].includes(input.mode)) throw new Error("Invalid mode");
  if (input.upstreams !== undefined && (!Array.isArray(input.upstreams) || input.upstreams.some((url) => typeof url !== "string" || !url.startsWith("https://")))) throw new Error("Upstreams must be HTTPS URLs");
  if (input.customHosts !== undefined && typeof input.customHosts !== "string") throw new Error("customHosts must be a string");
  if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 30000)) throw new Error("Invalid timeoutMs");
  if (input.maxBodyBytes !== undefined && (!Number.isInteger(input.maxBodyBytes) || input.maxBodyBytes < 1 || input.maxBodyBytes > 1048576)) throw new Error("Invalid maxBodyBytes");
  if (input.adBlockEnabled !== undefined && typeof input.adBlockEnabled !== "boolean") throw new Error("Invalid adBlockEnabled");
  if (input.adBlockSource !== undefined && (typeof input.adBlockSource !== "string" || !input.adBlockSource.startsWith("https://"))) throw new Error("Ad block source must be an HTTPS URL");
  if (input.adBlockRefreshMs !== undefined && (!Number.isInteger(input.adBlockRefreshMs) || input.adBlockRefreshMs < 60000 || input.adBlockRefreshMs > 604800000)) throw new Error("Invalid adBlockRefreshMs");
  if (input.queryAliases !== undefined && (!Array.isArray(input.queryAliases) || input.queryAliases.length > 20 || input.queryAliases.some((alias) => typeof alias !== "string" || !validQueryAlias(alias)) || new Set(input.queryAliases).size !== input.queryAliases.length)) throw new Error("Aliases must be unique lowercase path names");

  if (input.mode !== undefined) process.env.DNS_QUERY_MODE = input.mode;
  if (input.upstreams !== undefined) process.env.DOH_UPSTREAM_URLS = input.upstreams.join("\n");
  if (input.customHosts !== undefined) process.env.CUSTOM_HOSTS = input.customHosts;
  if (input.timeoutMs !== undefined) process.env.DOH_TIMEOUT_MS = String(input.timeoutMs);
  if (input.maxBodyBytes !== undefined) process.env.DOH_MAX_BODY_BYTES = String(input.maxBodyBytes);
  if (input.adBlockEnabled !== undefined) process.env.AD_BLOCK_ENABLED = String(input.adBlockEnabled);
  if (input.adBlockSource !== undefined) process.env.AD_BLOCK_SOURCE = input.adBlockSource;
  if (input.adBlockRefreshMs !== undefined) process.env.AD_BLOCK_REFRESH_MS = String(input.adBlockRefreshMs);
  const runtime = getRuntimeConfig();
  if (input.queryAliases !== undefined) runtime.queryAliases = input.queryAliases;
  return runtime;
}

const reservedQueryAliases = new Set(["admin", "cache", "config", "custom-query", "dashboard", "dns-query"]);

export function validQueryAlias(alias: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(alias) && !reservedQueryAliases.has(alias);
}
