// Auth gate wrapper for the web app.
//   - On boot, GET /api/auth/check
//   - If hasAdmin === false: show "Create admin" setup form
//   - If hasAdmin === true && !authenticated: show "Login" form
//   - Once authenticated: render children (the rest of the app)
//
// Setup form is only visible when the bot has no admin on disk yet. After
// first admin is created, the only way to reset is to delete admin.json
// from the bot's state dir.

import React, { useEffect, useState } from "react";
import { api } from "./api";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"loading" | "setup" | "login" | "ok">("loading");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function check() {
    try {
      const r = await api.authCheck();
      if (!r.hasAdmin) setState("setup");
      else if (!r.authenticated) setState("login");
      else setState("ok");
    } catch {
      setState("login"); // assume need login on error
    }
  }
  useEffect(() => { check(); }, []);

  async function doSetup() {
    setErr(null);
    if (!username.trim() || !password.trim()) { setErr("Username and password required"); return; }
    if (username.trim().length < 3) { setErr("Username must be ≥3 chars"); return; }
    if (password.length < 8) { setErr("Password must be ≥8 chars"); return; }
    if (password !== confirmPassword) { setErr("Passwords don't match"); return; }
    setBusy(true);
    const r = await api.authSetup(username.trim(), password);
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? "Setup failed"); return; }
    setPassword(""); setConfirmPassword("");
    setState("ok");
  }

  async function doLogin() {
    setErr(null);
    if (!username.trim() || !password) { setErr("Username and password required"); return; }
    setBusy(true);
    const r = await api.authLogin(username.trim(), password);
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? "Login failed"); return; }
    setPassword("");
    setState("ok");
  }

  if (state === "loading") {
    return <div style={containerStyle}><div style={cardStyle}><div style={{ color: "#8a95b8" }}>Loading…</div></div></div>;
  }

  if (state === "setup") {
    return (
      <div style={containerStyle}>
        <div style={cardStyle}>
          <h2 style={titleStyle}>Create admin account</h2>
          <p style={subStyle}>First-time setup. After you create this account, only it can log in.</p>
          <input style={inputStyle} placeholder="Username" value={username} onChange={(e) => { setUsername(e.target.value); setErr(null); }} />
          <input style={inputStyle} type="password" placeholder="Password (≥8 chars)" value={password} onChange={(e) => { setPassword(e.target.value); setErr(null); }} />
          <input style={inputStyle} type="password" placeholder="Confirm password" value={confirmPassword} onChange={(e) => { setConfirmPassword(e.target.value); setErr(null); }} />
          {err && <div style={errStyle}>{err}</div>}
          <button style={btnStyle} onClick={doSetup} disabled={busy}>{busy ? "Creating…" : "Create admin"}</button>
        </div>
      </div>
    );
  }

  if (state === "login") {
    return (
      <div style={containerStyle}>
        <div style={cardStyle}>
          <h2 style={titleStyle}>Sign in</h2>
          <p style={subStyle}>Enter your admin credentials.</p>
          <input style={inputStyle} placeholder="Username" value={username} onChange={(e) => { setUsername(e.target.value); setErr(null); }} onKeyDown={(e) => { if (e.key === "Enter") doLogin(); }} />
          <input style={inputStyle} type="password" placeholder="Password" value={password} onChange={(e) => { setPassword(e.target.value); setErr(null); }} onKeyDown={(e) => { if (e.key === "Enter") doLogin(); }} />
          {err && <div style={errStyle}>{err}</div>}
          <button style={btnStyle} onClick={doLogin} disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

const containerStyle: React.CSSProperties = {
  minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
  background: "#080d18", color: "#e0e5f5", padding: 20, fontFamily: "system-ui, -apple-system, sans-serif",
};
const cardStyle: React.CSSProperties = {
  background: "#0f1626", border: "1px solid #1e2842", borderRadius: 10, padding: 28, width: "100%", maxWidth: 380,
  boxShadow: "0 8px 40px rgba(0,0,0,0.4)",
};
const titleStyle: React.CSSProperties = { margin: "0 0 4px 0", fontSize: 20, color: "#e0e5f5" };
const subStyle: React.CSSProperties = { margin: "0 0 18px 0", fontSize: 13, color: "#8a95b8" };
const inputStyle: React.CSSProperties = {
  display: "block", width: "100%", boxSizing: "border-box", padding: "10px 12px",
  background: "#0e1528", color: "#e0e5f5", border: "1px solid #1e2842", borderRadius: 6,
  marginBottom: 10, fontSize: 14, outline: "none",
};
const btnStyle: React.CSSProperties = {
  width: "100%", padding: "11px 14px", background: "#4a89e0", color: "#fff", border: "none",
  borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: "pointer", marginTop: 6,
};
const errStyle: React.CSSProperties = { color: "#d4a35f", fontSize: 12, marginBottom: 10 };
