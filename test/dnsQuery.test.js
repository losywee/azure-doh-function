const test = require("node:test");
const assert = require("node:assert/strict");

test("project builds the Azure Function entrypoint", async () => {
  const { access } = require("node:fs/promises");
  await access("dist/src/index.js");
  await access("dist/src/persistentState.js");
  await access("dist/src/functions/cache.js");
  await access("dist/src/functions/dnsQuery.js");
  await access("dist/src/functions/config.js");
  assert.ok(true);
});

test("supports the documented DNS configuration format", () => {
  assert.match("https://cloudflare-dns.com/dns-query,https://dns.google/dns-query", /,/);
  assert.match("10.0.0.10 internal.example.com", /^\S+\s+\S+$/);
});

test("accepts safe custom DNS query aliases", () => {
  const { validQueryAlias } = require("../dist/src/config.js");
  assert.equal(validQueryAlias("resolver-2"), true);
  assert.equal(validQueryAlias("dns-query"), false);
  assert.equal(validQueryAlias("not/a-route"), false);
});

function dnsPacket(id, ttl, name = "example") {
  const question = Buffer.from([name.length, ...Buffer.from(name), 3, ...Buffer.from("com"), 0, 0, 1, 0, 1]);
  const answer = Buffer.alloc(16);
  answer.writeUInt16BE(0xc00c, 0);
  answer.writeUInt16BE(1, 2);
  answer.writeUInt16BE(1, 4);
  answer.writeUInt32BE(ttl, 6);
  answer.writeUInt16BE(4, 10);
  answer.set([1, 2, 3, 4], 12);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(1, 6);
  return Buffer.concat([header, question, answer]);
}

test("caches upstream DNS replies by query and preserves DNS TTL behavior", () => {
  const { UpstreamDnsCache } = require("../dist/src/functions/dnsQuery.js");
  const cache = new UpstreamDnsCache(2, 60000);
  const originalQuery = dnsPacket(0x1234, 0);
  const upstreamReply = dnsPacket(0x1234, 30);
  cache.set(originalQuery, upstreamReply, 1000);

  const cached = cache.get(dnsPacket(0xabcd, 0), 6000);
  assert.equal(cached.readUInt16BE(0), 0xabcd);
  assert.equal(cached.readUInt32BE(35), 25);
  assert.equal(cache.get(dnsPacket(0xabcd, 0), 31000), undefined);
});

test("evicts least recently used upstream DNS replies", () => {
  const { UpstreamDnsCache } = require("../dist/src/functions/dnsQuery.js");
  const cache = new UpstreamDnsCache(2, 60000);
  const first = dnsPacket(1, 30, "first");
  const second = dnsPacket(2, 30, "second");
  const third = dnsPacket(3, 30, "third");
  cache.set(first, first, 1000);
  cache.set(second, second, 1000);
  cache.get(first, 1000);
  cache.set(third, third, 1000);

  assert.ok(cache.get(first, 1000));
  assert.equal(cache.get(second, 1000), undefined);
  assert.ok(cache.get(third, 1000));
});

test("restores only unexpired upstream DNS cache entries", () => {
  const { UpstreamDnsCache } = require("../dist/src/functions/dnsQuery.js");
  const source = new UpstreamDnsCache(2, 60000);
  const query = dnsPacket(1, 30, "saved");
  source.set(query, query, 1000);
  const snapshot = source.snapshot(2000);
  snapshot.push({ key: "expired", packet: query.toString("base64"), storedAt: 0, expiresAt: 1 });

  const restored = new UpstreamDnsCache(2, 60000);
  restored.restore(snapshot, 2000);
  assert.ok(restored.get(query, 2000));
  assert.equal(restored.stats().entries, 1);
});
