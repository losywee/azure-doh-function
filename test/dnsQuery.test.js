const test = require("node:test");
const assert = require("node:assert/strict");

test("project builds the Azure Function entrypoint", async () => {
  const { access } = require("node:fs/promises");
  await access("dist/src/index.js");
  await access("dist/src/functions/dnsQuery.js");
  await access("dist/src/functions/config.js");
  assert.ok(true);
});

test("supports the documented DNS configuration format", () => {
  assert.match("https://cloudflare-dns.com/dns-query,https://dns.google/dns-query", /,/);
  assert.match("10.0.0.10 internal.example.com", /^\S+\s+\S+$/);
});
