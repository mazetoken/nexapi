// @ts-types="npm:@types/express@5.0.6"
import express from "npm:express@5.2.1";
import { ElectrumClient } from "npm:@vgrunner/electrum-cash@3.0.0";

// ============================================================================
// TYPES
// ============================================================================

interface CacheEntry { data: unknown; expires: number; }
interface Metric { method: string; duration: number; success: boolean; timestamp: number; }
interface Server { host: string; port: number; protocol: string; }

// ============================================================================
// APP
// ============================================================================

const app = express();
app.use(express.json());
app.use(express.static("public"));

// ============================================================================
// ELECTRUM
// ============================================================================

const SERVERS: Server[] = [
  { host: "electrum.nexa.org", port: 20004, protocol: "wss" },
  { host: "rostrum.otoplo.com", port: 443, protocol: "wss" },
  { host: "onekey-electrum.bitcoinunlimited.info", port: 20004, protocol: "wss" },
  { host: "rostrum.nexa.ink", port: 20004, protocol: "wss" },
  { host: "electrum.nexa.org", port: 20003, protocol: "ws" },
];

let idx = 0;
let client = makeClient(idx);
let connected = false;
let connecting = false;

function makeClient(i: number) {
  const s = SERVERS[i];
  return new ElectrumClient("Rostrum", "1.4.3", s.host, s.port, s.protocol);
}

async function ensureConnected() {
  if (connected) return;
  if (connecting) { while (connecting) await sleep(100); return; }
  connecting = true;
  const start = idx;
  do {
    try {
      await client.connect();
      connected = true;
      console.log(`✅ ${SERVERS[idx].host}:${SERVERS[idx].port}`);
      break;
    } catch {
      console.error(`❌ ${SERVERS[idx].host} failed`);
      connected = false;
      idx = (idx + 1) % SERVERS.length;
      client = makeClient(idx);
    }
  } while (idx !== start);
  connecting = false;
  if (!connected) throw new Error("All servers unreachable");
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================================
// CACHE
// ============================================================================

const cache = new Map<string, CacheEntry>();

const TTL = {
  balance: 10_000,  // 10s  — changes with new blocks (~2min)
  tokenBalance: 10_000,  // 10s
  transaction: Infinity, // confirmed txs are immutable
  genesis: Infinity, // token genesis never changes
  headers: 30_000,  // 30s  — blocks arrive ~2min apart, 5s was wasteful
  headerVerbose: 30_000,  // 30s
  utxos: 10_000,  // 10s
  nftList: 60_000,  // 1min
  block: Infinity, // confirmed blocks are immutable
  mempool: 10_000,  // 10s
  history: 10_000,  // 10s
} as const;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) if (v.expires < now) cache.delete(k);
}, 60_000);

// ============================================================================
// REQUEST PIPELINE
// ============================================================================

const pending = new Map<string, Promise<unknown>>();
const metrics: Metric[] = [];
const START = Date.now();

function key(...args: unknown[]) { return JSON.stringify(args); }

async function request(method: string, params: unknown[]): Promise<unknown> {
  for (let attempt = 0; attempt < SERVERS.length; attempt++) {
    try {
      await ensureConnected();
      return await (client as any).request(method, ...params);
    } catch {
      connected = false;
      idx = (idx + 1) % SERVERS.length;
      client = makeClient(idx);
    }
  }
  throw new Error(`All servers failed: ${method}`);
}

async function timed(method: string, params: unknown[]): Promise<unknown> {
  const t0 = Date.now();
  let ok = false;
  try {
    const timeout = new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 30_000));
    const result = await Promise.race([request(method, params), timeout]);
    ok = true;
    return result;
  } finally {
    const ms = Date.now() - t0;
    metrics.push({ method, duration: ms, success: ok, timestamp: t0 });
    if (metrics.length > 1000) metrics.shift();
    if (ms > 5000) console.warn(`⚠️  slow: ${method} ${ms}ms`);
  }
}

async function deduped(method: string, params: unknown[]): Promise<unknown> {
  const k = key(method, ...params);
  if (pending.has(k)) return pending.get(k)!;
  const p = timed(method, params).finally(() => pending.delete(k));
  pending.set(k, p);
  return p;
}

async function cached(ttl: number, method: string, params: unknown[]): Promise<unknown> {
  const k = key(method, ...params);
  const hit = cache.get(k);
  if (hit && hit.expires > Date.now()) return hit.data;
  const data = await deduped(method, params);
  if (cache.size < 10_000) cache.set(k, { data, expires: Date.now() + ttl });
  return data;
}

// ============================================================================
// VALIDATION
// ============================================================================

const isAddr = (v: unknown) => typeof v === "string" && v.length > 0 && v.length < 200;
const isTxHash = (v: unknown) => typeof v === "string" && /^[a-fA-F0-9]{64}$/.test(v);
const isHeight = (v: unknown) => { const n = parseInt(v as string); return !isNaN(n) && n >= 0 && n < 1e8; };
const isGroup = (v: unknown) => typeof v === "string" && v.length > 0 && v.length < 200;
const lim = (v: unknown) => { const n = parseInt(v as string); return isNaN(n) || n < 0 ? 0 : Math.min(n, 1000); };
const off = (v: unknown) => { const n = parseInt(v as string); return isNaN(n) || n < 0 ? 0 : n; };

function fail(res: any, code: number, msg: string) { return res.status(code).json({ error: msg }); }

// ============================================================================
// ROUTES
// ============================================================================

app.get("/", (_req: any, res: any) => res.json({ status: "ok" }));

app.get("/balance/:address", async (req: any, res: any) => {
  if (!isAddr(req.params.address)) return fail(res, 400, "Invalid address");
  try { res.json({ balance: await cached(TTL.balance, "blockchain.address.get_balance", [req.params.address]) }); }
  catch { fail(res, 500, "Failed to get balance"); }
});

app.get("/rawtx/:txhash", async (req: any, res: any) => {
  if (!isTxHash(req.params.txhash)) return fail(res, 400, "Invalid tx hash");
  try { res.json({ transaction: await cached(TTL.transaction, "blockchain.transaction.get", [req.params.txhash, false]) }); }
  catch { fail(res, 500, "Failed to get raw tx"); }
});

app.get("/tx/:txhash", async (req: any, res: any) => {
  if (!isTxHash(req.params.txhash)) return fail(res, 400, "Invalid tx hash");
  try { res.json({ transaction: await cached(TTL.transaction, "blockchain.transaction.get", [req.params.txhash, true]) }); }
  catch { fail(res, 500, "Failed to get tx"); }
});

app.get("/transactions/:address", async (req: any, res: any) => {
  if (!isAddr(req.params.address)) return fail(res, 400, "Invalid address");
  try {
    res.json({
      transactions: await cached(TTL.history, "blockchain.address.get_history", [
        req.params.address, { limit: lim(req.query.limit), offset: off(req.query.offset), include_tokens: true }
      ])
    });
  } catch { fail(res, 500, "Failed to get transactions"); }
});

app.get("/tokenbalance/:address", async (req: any, res: any) => {
  if (!isAddr(req.params.address)) return fail(res, 400, "Invalid address");
  try { res.json({ balance: await cached(TTL.tokenBalance, "token.address.get_balance", [req.params.address]) }); }
  catch { fail(res, 500, "Failed to get token balance"); }
});

app.get("/tokentransactions/:address", async (req: any, res: any) => {
  if (!isAddr(req.params.address)) return fail(res, 400, "Invalid address");
  try {
    res.json({
      tokentransactions: await cached(TTL.history, "token.address.get_history", [
        req.params.address, { limit: lim(req.query.limit), offset: off(req.query.offset), include_tokens: true }
      ])
    });
  } catch { fail(res, 500, "Failed to get token transactions"); }
});

app.get("/genesis/:group", async (req: any, res: any) => {
  if (!isGroup(req.params.group)) return fail(res, 400, "Invalid group id");
  try { res.json({ genesis: await cached(TTL.genesis, "token.genesis.info", [req.params.group]) }); }
  catch { fail(res, 500, "Failed to get genesis"); }
});

app.get("/nftlist/:group", async (req: any, res: any) => {
  if (!isGroup(req.params.group)) return fail(res, 400, "Invalid group id");
  try { res.json({ nftlist: await cached(TTL.nftList, "token.nft.list", [req.params.group]) }); }
  catch { fail(res, 500, "Failed to get NFT list"); }
});

app.get("/utxos/:address", async (req: any, res: any) => {
  if (!isAddr(req.params.address)) return fail(res, 400, "Invalid address");
  try { res.json({ utxos: await cached(TTL.utxos, "blockchain.address.listunspent", [req.params.address, "include_tokens"]) }); }
  catch { fail(res, 500, "Failed to get UTXOs"); }
});

// Chain tip — hex + height (used by server.mjs bootstrap)
app.get("/headers", async (_req: any, res: any) => {
  try { res.json({ headers: await cached(TTL.headers, "blockchain.headers.tip", []) }); }
  catch { fail(res, 500, "Failed to get headers"); }
});

// Verbose tip — accurate txcount, size, timestamp for visualizer bootstrap
app.get("/header/verbose", async (_req: any, res: any) => {
  try {
    const tip = await cached(TTL.headerVerbose, "blockchain.headers.tip", []) as { height: number };
    const header = await cached(TTL.headerVerbose, "blockchain.block.header_verbose", [tip.height]);
    res.json({ header });
  } catch { fail(res, 500, "Failed to get verbose header"); }
});

// Verbose header by height or hash
app.get("/header/verbose/:heightOrHash", async (req: any, res: any) => {
  const h = req.params.heightOrHash;
  const param = /^\d+$/.test(h) ? parseInt(h) : h;
  if (typeof param === "number" && !isHeight(h)) return fail(res, 400, "Invalid height");
  try { res.json({ header: await cached(TTL.headerVerbose, "blockchain.block.header_verbose", [param]) }); }
  catch { fail(res, 500, "Failed to get verbose header"); }
});

// Block raw data
app.get("/block/:height", async (req: any, res: any) => {
  if (!isHeight(req.params.height)) return fail(res, 400, "Invalid height");
  try { res.json({ blockdata: await cached(TTL.block, "blockchain.block.get", [parseInt(req.params.height)]) }); }
  catch { fail(res, 500, "Failed to get block"); }
});

// Mempool count — FIX: was blockchain.mempool.count, correct is mempool.count
app.get("/mempool", async (_req: any, res: any) => {
  try { res.json({ mempool: await cached(TTL.mempool, "mempool.count", []) }); }
  catch { fail(res, 500, "Failed to get mempool"); }
});

// Broadcast — POST, never GET for mutations
app.post("/broadcast", async (req: any, res: any) => {
  const { tx } = req.body;
  if (!tx || typeof tx !== "string" || tx.length > 100_000) return fail(res, 400, "Invalid transaction");
  try { res.json({ txId: await deduped("blockchain.transaction.broadcast", [tx]) }); }
  catch { fail(res, 500, "Failed to broadcast"); }
});

// Metrics
app.get("/metrics", (_req: any, res: any) => {
  const now = Date.now();
  const recent = metrics.filter(m => m.timestamp > now - 300_000);
  const total = recent.length;
  const ok = recent.filter(m => m.success).length;
  res.json({
    totalRequests: total,
    successRate: total > 0 ? ok / total : 0,
    averageDuration: total > 0 ? recent.reduce((s, m) => s + m.duration, 0) / total : 0,
    slowRequests: recent.filter(m => m.duration > 5000).length,
    cacheSize: cache.size,
    pendingRequests: pending.size,
    connected,
    currentServer: `${SERVERS[idx].host}:${SERVERS[idx].port}`,
    uptime: (now - START) / 1000,
  });
});

// ============================================================================
// START
// ============================================================================

await ensureConnected().catch(e => console.error("⚠️  Startup connect failed:", (e as Error).message));

app.listen(8000, () => console.log("🚀 http://localhost:8000"));
