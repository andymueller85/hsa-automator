import fs from "fs/promises";
import crypto from "crypto";
import { CACHE_FILE } from "./config.js";
import type { ParsedFileMetadata } from "./types.js";

export async function hashFile(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export async function loadCache(): Promise<Record<string, ParsedFileMetadata>> {
  try {
    return JSON.parse(await fs.readFile(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

export async function saveCache(
  cache: Record<string, ParsedFileMetadata>
): Promise<void> {
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}
