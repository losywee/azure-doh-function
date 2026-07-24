import { BlobServiceClient } from "@azure/storage-blob";
import { RuntimeConfig, getRuntimeConfig } from "./config.js";

const containerName = "azure-doh-function";
const configBlobName = "runtime-config.json";
const cacheBlobName = "upstream-cache.json";
let cachedConfig: { config: RuntimeConfig; loadedAt: number } | undefined;

function container() {
  const connectionString = process.env.AzureWebJobsStorage;
  if (!connectionString) throw new Error("AzureWebJobsStorage is required for persistent settings");
  return BlobServiceClient.fromConnectionString(connectionString).getContainerClient(containerName);
}

async function readJson<T>(name: string): Promise<T | undefined> {
  try {
    const download = await container().getBlockBlobClient(name).download();
    if (!download.readableStreamBody) return undefined;
    const chunks: Buffer[] = [];
    for await (const chunk of download.readableStreamBody) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch (error) {
    if (typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 404) return undefined;
    throw error;
  }
}

async function writeJson(name: string, value: unknown): Promise<void> {
  const content = JSON.stringify(value);
  const client = container();
  await client.createIfNotExists();
  await client.getBlockBlobClient(name).upload(content, Buffer.byteLength(content), { blobHTTPHeaders: { blobContentType: "application/json" } });
}

export async function getPersistentRuntimeConfig(): Promise<RuntimeConfig> {
  if (cachedConfig && Date.now() - cachedConfig.loadedAt < 30000) return cachedConfig.config;
  const config = { ...getRuntimeConfig(), ...await readJson<Partial<RuntimeConfig>>(configBlobName) };
  cachedConfig = { config, loadedAt: Date.now() };
  return config;
}

export async function savePersistentRuntimeConfig(config: RuntimeConfig): Promise<RuntimeConfig> {
  await writeJson(configBlobName, config);
  cachedConfig = { config, loadedAt: Date.now() };
  return config;
}

export interface PersistedCacheEntry { key: string; packet: string; storedAt: number; expiresAt: number; }

export async function getPersistentCache(): Promise<PersistedCacheEntry[]> {
  return await readJson<PersistedCacheEntry[]>(cacheBlobName) ?? [];
}

export async function savePersistentCache(entries: PersistedCacheEntry[]): Promise<void> {
  await writeJson(cacheBlobName, entries);
}

export async function deletePersistentCache(): Promise<void> {
  await container().getBlockBlobClient(cacheBlobName).deleteIfExists();
}
