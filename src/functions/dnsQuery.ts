import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import dns from "node:dns/promises";
import { isIP } from "node:net";
import { getRuntimeConfig } from "../config.js";

const DNS_MESSAGE_TYPE = "application/dns-message";
const DEFAULT_UPSTREAMS = ["https://cloudflare-dns.com/dns-query"];
let upstreamCursor = 0;
let adBlockCache: { source: string; loadedAt: number; hosts: Set<string> } | undefined;

function configNumber(name: string, fallback: number, max: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback;
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(Buffer.from(normalized, "base64"));
}

function errorResponse(status: number, message: string): HttpResponseInit {
  return { status, headers: { "content-type": "text/plain; charset=utf-8" }, body: message };
}

function upstreams(): string[] {
  const runtime = getRuntimeConfig();
  if (runtime.upstreams.length > 0) return runtime.upstreams;
  const configured = (process.env.DOH_UPSTREAM_URLS ?? process.env.DOH_UPSTREAM_URL ?? "")
    .split(/[\n,]+/)
    .map((url) => url.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_UPSTREAMS;
}

function readName(packet: Uint8Array, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let cursor = offset;
  while (cursor < packet.length) {
    const length = packet[cursor++];
    if (length === 0) return { name: labels.join(".").toLowerCase(), next: cursor };
    if ((length & 0xc0) !== 0 || length > 63 || cursor + length > packet.length) throw new Error("Invalid DNS name");
    labels.push(Buffer.from(packet.slice(cursor, cursor + length)).toString("ascii"));
    cursor += length;
  }
  throw new Error("Invalid DNS name");
}

function question(packet: Uint8Array): { name: string; type: number; classCode: number } {
  if (packet.length < 12 || (((packet[4] << 8) | packet[5]) !== 1)) throw new Error("Only one DNS question is supported");
  const parsed = readName(packet, 12);
  if (parsed.next + 4 > packet.length) throw new Error("Incomplete DNS question");
  return {
    name: parsed.name,
    type: (packet[parsed.next] << 8) | packet[parsed.next + 1],
    classCode: (packet[parsed.next + 2] << 8) | packet[parsed.next + 3]
  };
}

function customHosts(): Map<string, string[]> {
  const hosts = new Map<string, string[]>();
  const source = getRuntimeConfig().customHosts;
  for (const line of source.split(/\r?\n|,/)) {
    const fields = line.trim().split(/\s+/).filter(Boolean);
    if (fields.length < 2 || fields[0].startsWith("#")) continue;
    if (isIP(fields[0]) === 0) continue;
    for (const hostname of fields.slice(1)) {
      const key = hostname.replace(/\.$/, "").toLowerCase();
      hosts.set(key, [...(hosts.get(key) ?? []), fields[0]]);
    }
  }
  return hosts;
}

async function adBlockHosts(context: InvocationContext): Promise<Set<string>> {
  const config = getRuntimeConfig();
  if (!config.adBlockEnabled) return new Set();
  if (adBlockCache && adBlockCache.source === config.adBlockSource && Date.now() - adBlockCache.loadedAt < config.adBlockRefreshMs) return adBlockCache.hosts;
  try {
    const response = await fetch(config.adBlockSource, { headers: { "user-agent": "azure-doh-function/1.0" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const hosts = new Set<string>();
    for (const line of (await response.text()).split(/\r?\n/)) {
      const fields = line.replace(/#.*/, "").trim().split(/\s+/);
      if (fields.length >= 2 && (fields[0] === "0.0.0.0" || fields[0] === "127.0.0.1" || fields[0] === "::" || fields[0] === "::1")) {
        for (const hostname of fields.slice(1)) if (hostname.includes(".") && !hostname.includes("/")) hosts.add(hostname.replace(/\.$/, "").toLowerCase());
      }
    }
    adBlockCache = { source: config.adBlockSource, loadedAt: Date.now(), hosts };
    context.info(`Loaded ${hosts.size} ad-block hosts`);
    return hosts;
  } catch (error) {
    context.warn(`Unable to load ad-block source: ${config.adBlockSource}`);
    return adBlockCache?.hosts ?? new Set();
  }
}

function blockedResponse(query: Uint8Array): Buffer {
  const header = Buffer.from(query.slice(0, 12));
  header.writeUInt16BE(0x8183, 2);
  header.writeUInt16BE(0, 6);
  return Buffer.concat([header, Buffer.from(query.slice(12))]);
}

function localResponse(query: Uint8Array, name: string, type: number, addresses: string[]): Buffer {
  const answers = addresses.filter((address) => (type === 1 ? address.includes(".") : type === 28 && address.includes(":")));
  const header = Buffer.alloc(12);
  query.slice(0, 2).forEach((byte, index) => (header[index] = byte));
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answers.length, 6);
  const questionEnd = 12 + readName(query, 12).next - 12 + 4;
  const output = Buffer.concat([header, Buffer.from(query.slice(12, questionEnd))]);
  const records = answers.map((address) => {
    const data = type === 1 ? Buffer.from(address.split(".").map(Number)) : ipv6Bytes(address);
    const record = Buffer.alloc(12 + data.length);
    record.writeUInt16BE(0xc00c, 0);
    record.writeUInt16BE(type, 2);
    record.writeUInt16BE(1, 4);
    record.writeUInt32BE(60, 6);
    record.writeUInt16BE(data.length, 10);
    data.copy(record, 12);
    return record;
  });
  return Buffer.concat([output, ...records]);
}

function ipv6Bytes(address: string): Buffer {
  const halves = address.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return Buffer.from(groups.flatMap((part) => {
    const value = Number.parseInt(part || "0", 16);
    return [value >> 8, value & 255];
  }));
}

async function localLookup(query: Uint8Array, parsed: { name: string; type: number; classCode: number }): Promise<Buffer> {
  if (parsed.classCode !== 1 || (parsed.type !== 1 && parsed.type !== 28)) throw new Error("Local mode supports A and AAAA only");
  const custom = customHosts().get(parsed.name);
  const addresses = custom ?? (await dns.lookup(parsed.name, { all: true, verbatim: true })).map((item) => item.address);
  return localResponse(query, parsed.name, parsed.type, addresses);
}

async function dohLookup(query: Uint8Array, timeoutMs: number, maxBodyBytes: number, context: InvocationContext): Promise<Buffer> {
  const configured = upstreams();
  const ordered = configured.map((_, index) => configured[(upstreamCursor + index) % configured.length]);
  upstreamCursor = (upstreamCursor + 1) % configured.length;
  let lastError: unknown;
  for (const upstream of ordered) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(upstream, { method: "POST", headers: { accept: DNS_MESSAGE_TYPE, "content-type": DNS_MESSAGE_TYPE, "user-agent": "azure-doh-function/1.0" }, body: Buffer.from(query), signal: controller.signal });
      const responseType = response.headers.get("content-type")?.split(";", 1)[0].toLowerCase();
      if (!response.ok || responseType !== DNS_MESSAGE_TYPE) throw new Error(`Invalid upstream response (${response.status})`);
      const answer = Buffer.from(await response.arrayBuffer());
      if (answer.length > maxBodyBytes) throw new Error("Upstream response is too large");
      return answer;
    } catch (error) {
      lastError = error;
      context.warn(`DoH upstream failed: ${upstream}`);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError ?? new Error("No DoH upstream configured");
}

export async function dnsQuery(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  if (request.method !== "GET" && request.method !== "POST") {
    return errorResponse(405, "Only GET and POST are supported");
  }

  const maxBodyBytes = configNumber("DOH_MAX_BODY_BYTES", 65535, 1048576);
  let query: Uint8Array;

  if (request.method === "GET") {
    const encoded = request.query.get("dns");
    if (!encoded) return errorResponse(400, "Missing dns query parameter");
    try {
      query = base64UrlToBytes(encoded);
    } catch {
      return errorResponse(400, "Invalid base64url DNS message");
    }
  } else {
    const contentType = (request.headers.get("content-type") ?? "").split(";", 1)[0].toLowerCase();
    if (contentType !== DNS_MESSAGE_TYPE) return errorResponse(415, `Content-Type must be ${DNS_MESSAGE_TYPE}`);
    const body = await request.arrayBuffer();
    query = new Uint8Array(body);
  }

  if (query.length === 0 || query.length > maxBodyBytes) return errorResponse(413, "DNS message has an invalid size");

  let parsedQuestion: { name: string; type: number; classCode: number };
  try {
    parsedQuestion = question(query);
  } catch {
    return errorResponse(400, "Invalid DNS message");
  }

  const mode = (process.env.DNS_QUERY_MODE ?? "doh").toLowerCase();
  const timeoutMs = getRuntimeConfig().timeoutMs;

  try {
    if (mode !== "doh" && mode !== "local" && mode !== "auto") return errorResponse(500, "Invalid DNS_QUERY_MODE");
    let answer: Buffer;
    const hostOverride = customHosts().get(parsedQuestion.name);
    const blocked = await adBlockHosts(context);
    if (blocked.has(parsedQuestion.name)) answer = blockedResponse(query);
    else if (hostOverride) answer = localResponse(query, parsedQuestion.name, parsedQuestion.type, hostOverride);
    else if (mode === "local") answer = await localLookup(query, parsedQuestion);
    else {
      try {
        answer = await dohLookup(query, timeoutMs, maxBodyBytes, context);
      } catch (error) {
        if (mode !== "auto") throw error;
        context.warn("All DoH upstreams failed; falling back to local DNS");
        answer = await localLookup(query, parsedQuestion);
      }
    }
    return {
      status: 200,
      headers: { "content-type": DNS_MESSAGE_TYPE, "cache-control": "no-store" },
      body: answer
    };
  } catch (error) {
    context.error("DoH upstream request failed", error);
    return errorResponse(502, "DNS upstream request failed");
  }
}

app.http("dnsQuery", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  route: "dns-query",
  handler: dnsQuery
});
