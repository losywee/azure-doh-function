import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import dns from "node:dns/promises";
import { isIP } from "node:net";
import { getRuntimeConfig } from "../config.js";
import { getPersistentCache, getPersistentRuntimeConfig, PersistedCacheEntry, savePersistentCache } from "../persistentState.js";

const DNS_MESSAGE_TYPE = "application/dns-message";
const DEFAULT_UPSTREAMS = ["https://cloudflare-dns.com/dns-query"];
const UPSTREAM_CACHE_SIZE = 1024;
const UPSTREAM_CACHE_MAX_TTL_MS = 3600000;
let upstreamCursor = 0;
let adBlockCache: { source: string; loadedAt: number; hosts: Set<string> } | undefined;

interface CachedDnsResponse {
  expiresAt: number;
  packet: Buffer;
  storedAt: number;
}

function skipDnsName(packet: Uint8Array, offset: number): number {
  let cursor = offset;
  while (cursor < packet.length) {
    const length = packet[cursor++];
    if (length === 0) return cursor;
    if ((length & 0xc0) === 0xc0) {
      if (cursor >= packet.length) throw new Error("Invalid DNS name");
      return cursor + 1;
    }
    if ((length & 0xc0) !== 0 || length > 63 || cursor + length > packet.length) throw new Error("Invalid DNS name");
    cursor += length;
  }
  throw new Error("Invalid DNS name");
}

function responseTtlOffsets(packet: Uint8Array): { answerTtls: number[]; ttls: number[] } | undefined {
  if (packet.length < 12 || (packet[2] & 0x80) === 0 || (packet[2] & 0x02) !== 0 || (packet[3] & 0x0f) !== 0) return undefined;
  const questions = (packet[4] << 8) | packet[5];
  const answers = (packet[6] << 8) | packet[7];
  const authorities = (packet[8] << 8) | packet[9];
  const additionals = (packet[10] << 8) | packet[11];
  let cursor = 12;
  try {
    for (let index = 0; index < questions; index += 1) {
      cursor = skipDnsName(packet, cursor);
      if (cursor + 4 > packet.length) return undefined;
      cursor += 4;
    }
    const answerTtls: number[] = [];
    const ttls: number[] = [];
    for (let index = 0; index < answers + authorities + additionals; index += 1) {
      cursor = skipDnsName(packet, cursor);
      if (cursor + 10 > packet.length) return undefined;
      const ttlOffset = cursor + 4;
      const dataLength = (packet[cursor + 8] << 8) | packet[cursor + 9];
      if (cursor + 10 + dataLength > packet.length) return undefined;
      ttls.push(ttlOffset);
      if (index < answers) answerTtls.push(ttlOffset);
      cursor += 10 + dataLength;
    }
    return cursor === packet.length ? { answerTtls, ttls } : undefined;
  } catch {
    return undefined;
  }
}

function cacheKey(query: Uint8Array): string {
  return Buffer.from(query.slice(2)).toString("base64");
}

export class UpstreamDnsCache {
  private readonly entries = new Map<string, CachedDnsResponse>();
  private hits = 0;
  private misses = 0;

  constructor(private readonly maxEntries = UPSTREAM_CACHE_SIZE, private readonly maxTtlMs = UPSTREAM_CACHE_MAX_TTL_MS) {}

  get(query: Uint8Array, now = Date.now()): Buffer | undefined {
    const key = cacheKey(query);
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      this.misses += 1;
      return undefined;
    }
    const offsets = responseTtlOffsets(entry.packet);
    if (!offsets) {
      this.entries.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    const answer = Buffer.from(entry.packet);
    answer[0] = query[0];
    answer[1] = query[1];
    const elapsedSeconds = Math.floor((now - entry.storedAt) / 1000);
    for (const offset of offsets.ttls) answer.writeUInt32BE(Math.max(0, answer.readUInt32BE(offset) - elapsedSeconds), offset);
    this.hits += 1;
    return answer;
  }

  set(query: Uint8Array, response: Buffer, now = Date.now()): void {
    const offsets = responseTtlOffsets(response);
    if (!offsets || offsets.answerTtls.length === 0) return;
    const ttlSeconds = Math.min(...offsets.answerTtls.map((offset) => response.readUInt32BE(offset)));
    if (ttlSeconds === 0) return;
    const key = cacheKey(query);
    this.entries.delete(key);
    this.entries.set(key, { packet: Buffer.from(response), storedAt: now, expiresAt: now + Math.min(ttlSeconds * 1000, this.maxTtlMs) });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value as string);
  }

  clear(): void {
    this.entries.clear();
  }

  stats(): { capacity: number; entries: number; hits: number; misses: number } {
    return { capacity: this.maxEntries, entries: this.entries.size, hits: this.hits, misses: this.misses };
  }

  snapshot(now = Date.now()): PersistedCacheEntry[] {
    return [...this.entries].flatMap(([key, entry]) => entry.expiresAt > now ? [{ key, packet: entry.packet.toString("base64"), storedAt: entry.storedAt, expiresAt: entry.expiresAt }] : []);
  }

  restore(entries: PersistedCacheEntry[], now = Date.now()): void {
    for (const entry of entries) {
      if (entry.expiresAt > now && typeof entry.key === "string" && typeof entry.packet === "string" && Number.isFinite(entry.storedAt)) {
        this.entries.set(entry.key, { packet: Buffer.from(entry.packet, "base64"), storedAt: entry.storedAt, expiresAt: entry.expiresAt });
      }
    }
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value as string);
  }
}

export const upstreamCache = new UpstreamDnsCache();
let cacheRestored: Promise<void> | undefined;

export async function restoreUpstreamCache(): Promise<void> {
  cacheRestored ??= getPersistentCache().then((entries) => upstreamCache.restore(entries));
  await cacheRestored;
}

export async function persistUpstreamCache(): Promise<void> {
  await savePersistentCache(upstreamCache.snapshot());
}

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

function upstreams(runtime: ReturnType<typeof getRuntimeConfig>): string[] {
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

function customHosts(source: string): Map<string, string[]> {
  const hosts = new Map<string, string[]>();
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

async function adBlockHosts(config: ReturnType<typeof getRuntimeConfig>, context: InvocationContext): Promise<Set<string>> {
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

async function localLookup(query: Uint8Array, parsed: { name: string; type: number; classCode: number }, custom: Map<string, string[]>): Promise<Buffer> {
  if (parsed.classCode !== 1 || (parsed.type !== 1 && parsed.type !== 28)) throw new Error("Local mode supports A and AAAA only");
  const addresses = custom.get(parsed.name) ?? (await dns.lookup(parsed.name, { all: true, verbatim: true })).map((item) => item.address);
  return localResponse(query, parsed.name, parsed.type, addresses);
}

async function dohLookup(query: Uint8Array, runtime: ReturnType<typeof getRuntimeConfig>, context: InvocationContext): Promise<Buffer> {
  const configured = upstreams(runtime);
  const ordered = configured.map((_, index) => configured[(upstreamCursor + index) % configured.length]);
  upstreamCursor = (upstreamCursor + 1) % configured.length;
  let lastError: unknown;
  for (const upstream of ordered) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), runtime.timeoutMs);
    try {
      const response = await fetch(upstream, { method: "POST", headers: { accept: DNS_MESSAGE_TYPE, "content-type": DNS_MESSAGE_TYPE, "user-agent": "azure-doh-function/1.0" }, body: Buffer.from(query), signal: controller.signal });
      const responseType = response.headers.get("content-type")?.split(";", 1)[0].toLowerCase();
      if (!response.ok || responseType !== DNS_MESSAGE_TYPE) throw new Error(`Invalid upstream response (${response.status})`);
      const answer = Buffer.from(await response.arrayBuffer());
       if (answer.length > runtime.maxBodyBytes) throw new Error("Upstream response is too large");
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

  const runtime = await getPersistentRuntimeConfig();
  const maxBodyBytes = runtime.maxBodyBytes;
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

  const mode = runtime.mode;

  try {
    if (mode !== "doh" && mode !== "local" && mode !== "auto") return errorResponse(500, "Invalid DNS_QUERY_MODE");
    let answer: Buffer;
    const hosts = customHosts(runtime.customHosts);
    const hostOverride = hosts.get(parsedQuestion.name);
    const blocked = await adBlockHosts(runtime, context);
    if (blocked.has(parsedQuestion.name)) answer = blockedResponse(query);
    else if (hostOverride) answer = localResponse(query, parsedQuestion.name, parsedQuestion.type, hostOverride);
    else if (mode === "local") answer = await localLookup(query, parsedQuestion, hosts);
    else {
      try {
        await restoreUpstreamCache();
        const cached = upstreamCache.get(query);
        if (cached) answer = cached;
        else {
          answer = await dohLookup(query, runtime, context);
          upstreamCache.set(query, answer);
          await persistUpstreamCache();
        }
      } catch (error) {
        if (mode !== "auto") throw error;
        context.warn("All DoH upstreams failed; falling back to local DNS");
        answer = await localLookup(query, parsedQuestion, hosts);
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

export async function queryAlias(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const config = await getPersistentRuntimeConfig();
  if (!config.queryAliases.includes(request.params.alias ?? "")) return errorResponse(404, "DNS query alias not found");
  return dnsQuery(request, context);
}

app.http("dnsQuery", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  route: "dns-query",
  handler: dnsQuery
});

app.http("customQuery", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  route: "custom-query",
  handler: dnsQuery
});

app.http("queryAlias", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  route: "{alias}",
  handler: queryAlias
});
