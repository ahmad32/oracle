// fastmint shared helpers: RPC pool (race), WIB logging, error decoding, baw runner, Agent ID lookup.
'use strict';
const ethers = require('./ethers.umd.min.js');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHAIN_ID = 56;
const RPCS = (process.env.FASTMINT_RPCS || [
  'https://bsc-rpc.publicnode.com',
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.binance.org',
  'https://bsc-dataseed2.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
  'https://1rpc.io/bnb',
].join(',')).split(',').map(s => s.trim()).filter(Boolean);
const AGENT_REGISTRY = '0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F';
const SCAN = 'https://bscscan.com';

// ---------- time ----------
function wib(d = new Date()) {
  const s = d.toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' });
  return s + '.' + String(d.getMilliseconds()).padStart(3, '0') + ' WIB';
}
let LOGFILE = null;
function setLogFile(f) { LOGFILE = f; }
function log(...a) {
  const line = `[${wib()}] ` + a.map(x => typeof x === 'string' ? x : safeJson(x)).join(' ');
  console.log(line);
  if (LOGFILE) try { fs.appendFileSync(LOGFILE, line + '\n'); } catch {}
}
function safeJson(x) {
  try { return JSON.stringify(x, (k, v) => typeof v === 'bigint' ? v.toString() : v); } catch { return String(x); }
}
// "HH:MM" or "HH:MM:SS" in WIB -> unix (today WIB; if more than 12h in the past, tomorrow). Plain digits -> unix.
function parseStart(s) {
  if (s == null || s === '') return null;
  s = String(s).trim();
  if (/^\d{9,11}$/.test(s)) return Number(s);
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw new Error('bad --start (use unix seconds or HH:MM[:SS] WIB): ' + s);
  const nowWib = new Date(Date.now() + 7 * 3600e3); // shift so UTC getters read WIB
  let t = Date.UTC(nowWib.getUTCFullYear(), nowWib.getUTCMonth(), nowWib.getUTCDate(), +m[1], +m[2], +(m[3] || 0)) - 7 * 3600e3;
  if (t < Date.now() - 12 * 3600e3) t += 24 * 3600e3;
  return Math.floor(t / 1000);
}
function fmtUnix(u) { return wib(new Date(Number(u) * 1000)).replace('.000', ''); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- RPC ----------
let rpcId = 1;
async function rpcOne(url, method, params, timeoutMs = 4000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }), signal: ctl.signal,
    });
    const j = await r.json();
    if (j.error) { const e = new Error(j.error.message || 'rpc error'); e.rpcError = j.error; e.url = url; throw e; }
    return j.result;
  } finally { clearTimeout(t); }
}
// Is this an execution revert (deterministic) vs transport/rate-limit noise?
function isRevert(e) {
  const er = e && e.rpcError;
  if (!er) return false;
  if (er.data !== undefined && er.data !== null) return true;
  return /revert|execution|invalid opcode|out of gas|insufficient funds/i.test(er.message || '');
}
// Race all RPCs: first success wins; first *revert* also wins (deterministic). Transport errors ignored unless all fail.
function rpcRace(method, params, { urls = RPCS, timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    let left = urls.length, lastErr;
    for (const u of urls) {
      rpcOne(u, method, params, timeoutMs).then(
        res => resolve({ ok: true, result: res, url: u }),
        err => {
          if (isRevert(err)) return resolve({ ok: false, error: err, url: u });
          lastErr = err; if (--left === 0) reject(lastErr);
        });
    }
  });
}
async function rpc(method, params, opts) {
  const r = await rpcRace(method, params, opts);
  if (!r.ok) throw r.error;
  return r.result;
}
async function warmRpcs() {
  const res = await Promise.all(RPCS.map(async u => {
    const s = Date.now();
    try { const b = await rpcOne(u, 'eth_blockNumber', [], 5000); return { u, ms: Date.now() - s, block: parseInt(b, 16) }; }
    catch (e) { return { u, ms: Date.now() - s, err: (e.message || '').slice(0, 60) }; }
  }));
  return res;
}

// ---------- revert decoding ----------
const STD_ERRORS = [
  'error Error(string)', 'error Panic(uint256)',
  // common sale/mint custom errors (names are hints only; selectors computed)
  ...['NotStarted', 'NotOpen', 'NotOpened', 'NotLive', 'NotActive', 'SaleNotStarted', 'MintNotStarted', 'MintNotOpen', 'TooEarly', 'SaleNotActive', 'Paused', 'EnforcedPause',
    'SoldOut', 'FreeSoldOut', 'FreeGone', 'PaidSoldOut', 'MaxSupply', 'ExceedsMaxSupply', 'MaxSupplyReached', 'QuotaExceeded', 'LimitExceeded', 'ExceedsLimit', 'MaxPerWallet', 'MaxPerWalletExceeded',
    'AlreadyClaimed', 'AlreadyMinted', 'AlreadyTaken', 'FreeUsed', 'FreeAlreadyClaimed', 'AlreadyBooked', 'AllowanceUsed',
    'AgentIdRequired', 'NoAgentId', 'NotAgent', 'NotEligible', 'NotWhitelisted', 'NotAllowed', 'Unauthorized', 'InvalidProof', 'BadSignature',
    'SaleExpired', 'Ended', 'SaleEnded', 'MintEnded', 'Closed', 'Expired', 'DeadlinePassed',
    'WrongValue', 'WrongPrice', 'InsufficientPayment', 'BadValue', 'InvalidValue', 'BadQty', 'ZeroQty', 'BadStart', 'StartMismatch', 'Slippage', 'BadInviter', 'SelfInvite', 'NoShares', 'NothingToCollect']
    .map(n => `error ${n}()`),
];
const stdIface = new ethers.Interface(STD_ERRORS);
const sigCache = new Map();
async function lookupSelector(sel) {
  if (sigCache.has(sel)) return sigCache.get(sel);
  let name = null;
  try {
    const ctl = new AbortController(); setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(`https://api.4byte.sourcify.dev/signature-database/v1/lookup?function=${sel}&filter=true`, { signal: ctl.signal });
    const j = await r.json();
    const arr = j && j.result && j.result.function && j.result.function[sel];
    if (arr && arr.length) name = arr[0].name;
  } catch {}
  if (!name) try {
    const ctl = new AbortController(); setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(`https://www.4byte.directory/api/v1/signatures/?hex_signature=${sel}`, { signal: ctl.signal });
    const j = await r.json();
    if (j.results && j.results.length) name = j.results[j.results.length - 1].text_signature;
  } catch {}
  sigCache.set(sel, name);
  return name;
}
// Returns {name, sel, raw, args, msg}
async function decodeRevert(err, extraIface) {
  const er = (err && err.rpcError) || {};
  let raw = typeof er.data === 'string' ? er.data : (er.data && typeof er.data.data === 'string' ? er.data.data : '');
  if (!raw) { const m = String(er.message || err.message || '').match(/0x[0-9a-fA-F]{8,}/); if (m) raw = m[0]; }
  const msg = String(er.message || err.message || '');
  if (!raw || raw === '0x') {
    const m = msg.match(/reverted:?\s*(.*)$/i);
    return { name: m && m[1] ? m[1].trim() : 'Unknown', sel: null, raw: raw || '', msg };
  }
  const sel = raw.slice(0, 10).toLowerCase();
  for (const ifc of [extraIface, stdIface]) {
    if (!ifc) continue;
    try {
      const d = ifc.parseError(raw);
      if (d) {
        if (d.name === 'Error') return { name: String(d.args[0]), sel, raw, msg, isString: true };
        return { name: d.name, sel, raw, args: d.args.map(String), msg };
      }
    } catch {}
  }
  const sig = await lookupSelector(sel);
  return { name: sig ? sig.replace(/\(.*$/, '') : 'Unknown', sig, sel, raw, msg };
}
// Classify a revert name/message: 'wait' (not started yet) | 'fatal' | 'unknown'
const WAIT_RE = /not.?start|not.?open(ed)?$|^notopen$|not.?live|not.?active|too.?early|before.?start|^paused$|enforcedpause|mint.?closed|sale.?closed|not.?yet|wait/i;
const FATAL_RE = /sold.?out|gone|max.?supply|exceed|limit|already|used|taken|booked|agent.?id|no.?agent|not.?agent|eligible|whitelist|not.?allowed|unauthori|proof|signature|expired|ended|deadline|wrong|insufficient|bad|invalid|zero|slippage|mismatch|self|no.?shares|nothing|panic|quota|cap|low|payment|exceeds balance/i;
function classify(name, { waitRe, fatalRe } = {}) {
  const n = String(name || '');
  if (fatalRe && fatalRe.test(n)) return 'fatal';
  if (waitRe && waitRe.test(n)) return 'wait';
  if (WAIT_RE.test(n)) return 'wait';
  if (FATAL_RE.test(n)) return 'fatal';
  return 'unknown';
}

// ---------- baw ----------
function baw(args, timeoutMs = 60000) {
  return new Promise(resolve => {
    const s = Date.now();
    execFile('baw', [...args, '--json'], { timeout: timeoutMs, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      const out = String(stdout || ''), ms = Date.now() - s;
      let j = null;
      try { j = JSON.parse(out); } catch { const i = out.indexOf('{'); if (i >= 0) try { j = JSON.parse(out.slice(i)); } catch {} }
      resolve({ ok: !err && j && j.success === true, json: j, stdout: out, stderr: String(stderr || ''), err, ms });
    });
  });
}
async function bawStatus() {
  const r = await baw(['wallet', 'status']);
  return (r.json && r.json.data && r.json.data.status) || 'UNKNOWN';
}
async function bawEvmAddress() {
  const r = await baw(['wallet', 'address']);
  const a = r.json && r.json.data && r.json.data.addresses || [];
  const bsc = a.find(x => String(x.binanceChainId) === '56') || a.find(x => /^0x/.test(x.address));
  return bsc ? ethers.getAddress(bsc.address) : null;
}

// ---------- Agent ID ----------
const regIface = new ethers.Interface(['function handleOf(address) view returns (string)', 'function ownerOf(uint256) view returns (address)']);
async function agentIdOf(wallet) {
  const res = await rpc('eth_call', [{ to: AGENT_REGISTRY, data: regIface.encodeFunctionData('handleOf', [wallet]) }, 'latest']);
  const handle = regIface.decodeFunctionResult('handleOf', res)[0];
  if (!handle) return { handle: '', tokenId: null };
  return { handle, tokenId: BigInt(ethers.id(handle)) }; // tokenId = uint256(keccak256(handle))
}

// ---------- Sourcify ----------
async function sourcifyAbi(addr, timeoutMs = 6000) {
  try {
    const ctl = new AbortController(); setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(`https://sourcify.dev/server/v2/contract/${CHAIN_ID}/${addr}?fields=abi`, { signal: ctl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    return j.abi ? { abi: j.abi, match: j.match || j.runtimeMatch || 'verified' } : null;
  } catch { return null; }
}
const cacheDir = path.join(__dirname, 'cache');
async function sourcifyAbiCached(addr) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const f = path.join(cacheDir, `abi_${addr.toLowerCase()}.json`);
  if (fs.existsSync(f)) try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  const a = await sourcifyAbi(addr);
  if (a) fs.writeFileSync(f, JSON.stringify(a));
  return a;
}

module.exports = {
  ethers, CHAIN_ID, RPCS, AGENT_REGISTRY, SCAN, wib, log, setLogFile, safeJson, parseStart, fmtUnix, sleep,
  rpcOne, rpcRace, rpc, warmRpcs, isRevert, decodeRevert, classify, lookupSelector, baw, bawStatus, bawEvmAddress,
  agentIdOf, sourcifyAbi, sourcifyAbiCached,
};
