// Probe Deriv `contracts_for` across the synthetics we trade to see which
// product types (multipliers, callputs, etc.) the authorized account can
// actually place. If MULTUP/MULTDOWN are missing for a symbol, the broker
// will reject placeTrade with OfferingsValidationError regardless of code.
//
// Usage: DERIV_TOKEN=<token> npx ts-node scripts/deriv-offerings-check.ts

const APP_ID = "1089";
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const TOKEN = process.env.DERIV_TOKEN;
if (!TOKEN) { console.error("Set DERIV_TOKEN env var"); process.exit(1); }

const SYMBOLS = [
  "RDBEAR", "RDBULL",
  "BOOM300N", "CRASH300N", "BOOM500", "CRASH500", "BOOM1000", "CRASH1000",
  "JD100", "JD75", "JD50",
  "R_50", "R_75", "R_100", "1HZ100V", "1HZ75V", "1HZ50V",
];
const PRODUCT_TYPES = ["basic", "multi_barrier"];

class C {
  ws: any; reqId = 1;
  pending = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void }>();
  ready!: Promise<void>;
  constructor() {
    const WS = require("ws");
    this.ws = new WS(WS_URL);
    this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => {
      try { const m = JSON.parse(String(raw)); const id = m.req_id;
        if (id != null && this.pending.has(id)) {
          const { resolve, reject } = this.pending.get(id)!;
          this.pending.delete(id);
          if (m.error) reject(new Error(m.error.message)); else resolve(m);
        }
      } catch {}
    });
  }
  send(req: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...req, req_id: id }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout`)); } }, 30_000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function main() {
  const c = new C(); await c.ready;
  const auth = await c.send({ authorize: TOKEN });
  const a = auth.authorize;
  console.log(`Authorized: ${a.loginid}  landing=${a.landing_company_name}  currency=${a.currency}  bal=${a.balance}`);
  console.log(`Account list:`);
  for (const acc of a.account_list ?? []) {
    console.log(`  ${acc.loginid}  type=${acc.account_type}  category=${acc.account_category}  cur=${acc.currency}  landing=${acc.landing_company_name}  disabled=${acc.is_disabled}`);
  }
  console.log();

  console.log(`Probing contracts_for per symbol (product_type=basic):`);
  console.log(`${"symbol".padEnd(12)} contract_types_offered`);
  for (const sym of SYMBOLS) {
    let line = `${sym.padEnd(12)}`;
    let ok = false;
    for (const pt of PRODUCT_TYPES) {
      try {
        const r = await c.send({ contracts_for: sym, product_type: pt, currency: a.currency ?? "USD" });
        const types = new Set<string>();
        for (const ca of (r.contracts_for?.available ?? [])) types.add(ca.contract_type);
        const sorted = Array.from(types).sort();
        const hasMult = sorted.includes("MULTUP") || sorted.includes("MULTDOWN");
        if (sorted.length > 0) {
          line += `  [${pt}] ${sorted.join(",")}${hasMult ? "  ★MULT" : ""}`;
          ok = true;
        }
      } catch (e) {
        const msg = (e as Error).message;
        if (!msg.includes("InputValidationFailed")) line += `  [${pt}] ERR:${msg.slice(0, 40)}`;
      }
    }
    if (!ok) line += `  (no offerings)`;
    console.log(line);
  }
  c.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
