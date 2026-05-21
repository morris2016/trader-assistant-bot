// Encrypted on-disk Binance credential store for the headless bot.
//
// Master key from env BOT_SECRET (operator sets it once in Railway dashboard).
// Falls back to a state-dir-resident key if BOT_SECRET unset — warns but
// continues, since the page is already auth-protected at the proxy layer.
//
// Encryption: AES-256-GCM with a per-write random IV. File format:
//   { iv: base64, tag: base64, ct: base64, ts: epoch }

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";

const ALGO = "aes-256-gcm";

function deriveMasterKey(stateDir: string): Buffer {
  const fromEnv = process.env.BOT_SECRET;
  if (fromEnv && fromEnv.length >= 16) {
    return createHash("sha256").update(fromEnv).digest();
  }
  // Fallback: generate + persist a random key in state dir. Warn loudly.
  const keyFile = path.join(stateDir, "binance-master.key");
  if (!existsSync(keyFile)) {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    const key = randomBytes(32);
    writeFileSync(keyFile, key.toString("base64"));
    console.warn(`[binance-store] BOT_SECRET env unset — generated master key at ${keyFile}. Set BOT_SECRET in env for proper key rotation.`);
    return key;
  }
  return Buffer.from(readFileSync(keyFile, "utf8"), "base64");
}

export type BinanceCreds = { apiKey: string; apiSecret: string; testnet: boolean };

type StoredBlob = { iv: string; tag: string; ct: string; ts: number };

function credsFile(stateDir: string): string {
  return path.join(stateDir, "binance-creds.json");
}

export async function loadBinanceCreds(stateDir: string): Promise<BinanceCreds | null> {
  const file = credsFile(stateDir);
  if (!existsSync(file)) return null;
  try {
    const blob: StoredBlob = JSON.parse(await fs.readFile(file, "utf8"));
    const key = deriveMasterKey(stateDir);
    const iv = Buffer.from(blob.iv, "base64");
    const tag = Buffer.from(blob.tag, "base64");
    const ct = Buffer.from(blob.ct, "base64");
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(pt.toString("utf8")) as BinanceCreds;
  } catch (e) {
    console.error("[binance-store] Failed to load creds:", (e as Error).message);
    return null;
  }
}

export async function saveBinanceCreds(stateDir: string, creds: BinanceCreds): Promise<void> {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const key = deriveMasterKey(stateDir);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const pt = Buffer.from(JSON.stringify(creds), "utf8");
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob: StoredBlob = {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
    ts: Date.now(),
  };
  const file = credsFile(stateDir);
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(blob), "utf8");
  await fs.rename(tmp, file);
}

export async function clearBinanceCreds(stateDir: string): Promise<void> {
  const file = credsFile(stateDir);
  if (existsSync(file)) await fs.unlink(file);
}

export function hasBinanceCreds(stateDir: string): boolean {
  return existsSync(credsFile(stateDir));
}
