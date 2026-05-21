// Single-admin auth store for the headless bot.
//
//   - First-time setup: anyone can hit POST /api/auth/setup ONLY while no
//     admin exists on disk. They set username + password; bot persists hash.
//   - After setup: only that admin can log in via POST /api/auth/login.
//     New admin creation is impossible until the on-disk admin file is deleted.
//   - Sessions: random 32-byte tokens, persisted to disk, expire after 30 days
//     unless extended on use. Stored in HttpOnly cookie.
//   - Password hashing: scrypt (node:crypto built-in, no external dep).
//
// Disk layout:
//   <stateDir>/admin.json     — { username, salt, hash, createdAt }
//   <stateDir>/sessions.json  — { [token]: { createdAt, lastUsedAt } }

import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

type AdminRecord = { username: string; salt: string; hash: string; createdAt: number };
type Sessions = Record<string, { createdAt: number; lastUsedAt: number }>;

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, HASH_LEN = 64;

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, HASH_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (err, key) => err ? reject(err) : resolve(key as Buffer));
  });
}

export class AuthStore {
  private adminFile: string;
  private sessionsFile: string;
  private cachedAdmin: AdminRecord | null | undefined = undefined; // undefined = unread
  private sessions: Sessions | null = null;
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private stateDir: string) {
    this.adminFile = path.join(stateDir, "admin.json");
    this.sessionsFile = path.join(stateDir, "sessions.json");
    // Flush dirty sessions every 30s so per-request lastUsedAt updates don't
    // pound the disk. Worst-case data loss on crash: 30s of lastUsedAt.
    this.flushTimer = setInterval(() => { this.flush().catch(() => {}); }, 30_000);
  }

  /** Persist if dirty. Called on login/logout (immediate) and via 30s timer. */
  private async flush(): Promise<void> {
    if (!this.dirty || !this.sessions) return;
    try { await this.saveSessions(); this.dirty = false; } catch {}
  }

  async hasAdmin(): Promise<boolean> {
    if (this.cachedAdmin === undefined) await this.loadAdmin();
    return this.cachedAdmin !== null;
  }

  private async loadAdmin() {
    if (!existsSync(this.adminFile)) { this.cachedAdmin = null; return; }
    try { this.cachedAdmin = JSON.parse(await fs.readFile(this.adminFile, "utf8")); }
    catch { this.cachedAdmin = null; }
  }

  private async loadSessions(): Promise<Sessions> {
    if (this.sessions) return this.sessions;
    if (!existsSync(this.sessionsFile)) { this.sessions = {}; return this.sessions; }
    try { this.sessions = JSON.parse(await fs.readFile(this.sessionsFile, "utf8")); return this.sessions ?? (this.sessions = {}); }
    catch { this.sessions = {}; return this.sessions; }
  }

  private async saveSessions() {
    if (!this.sessions) return;
    if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true });
    const tmp = this.sessionsFile + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(this.sessions), "utf8");
    await fs.rename(tmp, this.sessionsFile);
  }

  /** Create the admin account. Only succeeds when no admin exists. */
  async setupAdmin(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
    if (await this.hasAdmin()) return { ok: false, error: "Admin already exists. Delete admin.json to reset." };
    if (!username || username.length < 3) return { ok: false, error: "Username must be ≥3 chars" };
    if (!password || password.length < 8) return { ok: false, error: "Password must be ≥8 chars" };
    const salt = randomBytes(16);
    const hash = await scryptAsync(password, salt);
    const rec: AdminRecord = { username, salt: salt.toString("base64"), hash: hash.toString("base64"), createdAt: Date.now() };
    if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true });
    const tmp = this.adminFile + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(rec, null, 2), "utf8");
    await fs.rename(tmp, this.adminFile);
    this.cachedAdmin = rec;
    return { ok: true };
  }

  /** Verify creds + create session. Returns session token, or error. */
  async login(username: string, password: string): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
    if (!await this.hasAdmin()) return { ok: false, error: "No admin configured. Visit /api/auth/check then POST /api/auth/setup." };
    const a = this.cachedAdmin!;
    if (username !== a.username) return { ok: false, error: "Invalid credentials" };
    const salt = Buffer.from(a.salt, "base64");
    const expected = Buffer.from(a.hash, "base64");
    const candidate = await scryptAsync(password, salt);
    const match = candidate.length === expected.length && timingSafeEqual(candidate, expected);
    if (!match) return { ok: false, error: "Invalid credentials" };
    const token = randomBytes(32).toString("base64url");
    const sessions = await this.loadSessions();
    sessions[token] = { createdAt: Date.now(), lastUsedAt: Date.now() };
    this.dirty = true;
    await this.flush();
    return { ok: true, token };
  }

  /** Check if a session token is currently valid. Hot path — must not write
   *  to disk on every request. Updates lastUsedAt in-memory only; the 30s
   *  flush timer persists it. Expired sessions are deleted in-memory and
   *  marked dirty for the next flush. */
  async validateSession(token: string): Promise<boolean> {
    if (!token) return false;
    const sessions = await this.loadSessions();
    const s = sessions[token];
    if (!s) return false;
    const age = Date.now() - s.createdAt;
    if (age > SESSION_TTL_MS) {
      delete sessions[token];
      this.dirty = true;
      return false;
    }
    s.lastUsedAt = Date.now();
    this.dirty = true; // flushed by the 30s timer; no disk I/O on the hot path
    return true;
  }

  async logout(token: string): Promise<void> {
    if (!token) return;
    const sessions = await this.loadSessions();
    if (sessions[token]) {
      delete sessions[token];
      this.dirty = true;
      await this.flush();
    }
  }

  /** GC: drop sessions older than TTL. Call occasionally. */
  async gcSessions() {
    const sessions = await this.loadSessions();
    const cutoff = Date.now() - SESSION_TTL_MS;
    let changed = false;
    for (const [k, v] of Object.entries(sessions)) {
      if (v.createdAt < cutoff) { delete sessions[k]; changed = true; }
    }
    if (changed) await this.saveSessions();
  }
}

/** Parse session cookie value. Cookie name: bot_session. */
export function parseSessionCookie(cookieHdr: string): string {
  for (const part of cookieHdr.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === "bot_session") return part.slice(eq + 1).trim();
  }
  return "";
}
