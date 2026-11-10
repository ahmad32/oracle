// lib.js — shared helpers for the fastmint FCFS toolkit (BSC, Binance Agentic Wallet).
// Mirrors the logic of ~/workspace/tools/sniper.py (Python, tested vs Broccoli)
// but in JS so it can be run with plain `node` and called from other JS tools.
// No private keys, no seed phrases, no exfiltration: only public BSC RPCs,
// Sourcify and 4byte are ever contacted, and only for reads / error decoding.

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPCS = [
  'https://bsc-dataseed.binance.org',
  'https://bsc-dataseed1.defibit.io',
  'https://binance.llamarpc.com',
  'https://bsc-rpc.publicnode.com',
];

// Agent ID for ryukisan (uint256 = keccak256("ryukisan")).
const AGENT_ID = 47180081854018486746556308369438658819430327551400156943248280963129417241949n;
const AGENT_ID_HEX = '684efae207533a4f3cc179249773d92f2e955ac315658b97604695b1d825955d';
// Main wallet (Binance Agentic Wallet).
const MAIN_WALLET = '0x25CF688b28CA2b2a64A546E218182B7F1F4580F5';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function log(msg, logPath) {
  const line = `[${new Date().toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Makassar' })}] ${msg}`;
  console.log(line);
  if (logPath) fs.appendFileSync(logPath, line + '\n');
}

function loadConfig(configPath) {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!cfg.contract || !cfg.function) throw new Error('config needs contract + function');
  cfg.wallet = cfg.wallet || MAIN_WALLET;
  cfg.value_wei = cfg.value_wei ?? 0;
  cfg.poll_ms = cfg.poll_ms ?? 120;          // fastmint polls eth_call every 120ms
  cfg.max_wait_s = cfg.max_wait_s ?? 300;
  cfg.deadline_seconds = cfg.deadline_seconds ?? 600;
  cfg.rpcs = cfg.rpcs || RPCS;
  cfg.sender = cfg.sender || 'baw';
  return cfg;
}

// A provider that rotates to the next RPC on failure.
function makeProvider(rpcs) {
  let idx = 0;
  const get = () => new ethers.JsonRpcProvider(rpcs[idx % rpcs.length], 56, { staticNetwork: true });
  let provider = get();
  provider.next = () => { idx += 1; provider = get(); return provider; };
  provider.currentRpc = () => rpcs[idx % rpcs.length];
  return provider;
}

async function ethCall(provider, to, data, label) {
  // One eth_call, rotating RPC on failure. Returns the raw hex result.
  let lastErr = null;
  for (let i = 0; i < provider.rpcs.length; i++) {
    try {
      const p = i === 0 ? provider : provider.next();
      return await p.call({ to, data });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(`eth_call failed (${label || 'call'})`);
}

// Decode a revert: returns a human-readable string (reason or custom-error selector).
async function decodeRevert(err) {
  const s = String(err && (err.info?.error?.message || err.message || err));
  const m = s.match(/0x[0-9a-fA-F]{8}/);
  if (/reverted with reason string/i.test(s)) {
    const r = s.match(/reason string '([^']*)'/) || s.match(/reverted with reason string "([^"]*)"/);
    if (r) return `revert: ${r[1]}`;
  }
  if (m) {
    const sel = m[0].toLowerCase();
    // Look up the selector on 4byte (read-only, public).
    try {
      const res = await fetch(`https://www.4byte.directory/api/v1/signatures/?hex_signature=${sel}`);
      const j = await res.json();
      if (j.results && j.results.length) return `custom error ${sel} (${j.results[0].text_signature})`;
    } catch (_) { /* ignore lookup failure */ }
    return `custom error ${sel}`;
  }
  return s.slice(0, 200);
}

// Read a uint256 / bool / address view function and return the decoded value.
async function readView(provider, contract, abi, fnName, args = []) {
  const c = new ethers.Contract(contract, abi, provider);
  return await c[fnName](...args);
}

// Build calldata for `fnName` with `args` (ethers v6), then decode it back and
// verify every field matches the intended args. Returns { calldata, decoded }.
function buildCalldata(contract, abi, fnName, args) {
  const iface = new ethers.Interface(abi);
  const calldata = iface.encodeFunctionData(fnName, args);
  const decoded = iface.decodeFunctionData(fnName, calldata);
  return { calldata, decoded, iface };
}

// Compare decoded args against the intended args. Throws on any mismatch.
function verifyDecoded(decoded, intended) {
  const norm = (v) => {
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'string') return v.toLowerCase();
    return String(v);
  };
  for (let i = 0; i < intended.length; i++) {
    const got = norm(decoded[i]);
    const want = norm(intended[i]);
    if (got !== want) throw new Error(`calldata decode mismatch arg[${i}]: got ${got}, want ${want}`);
  }
}

// Resolve "DEADLINE" placeholders and numeric strings in an args array.
function resolveArgs(args, nowTs, deadlineSeconds) {
  return args.map((a) => {
    if (typeof a === 'string' && a === 'DEADLINE') return BigInt(nowTs + deadlineSeconds);
    if (typeof a === 'string' && /^-?\d+$/.test(a)) return BigInt(a);
    return a;
  });
}

// Read dynamic args (e.g. minTokens from previewMint) at fire time.
// Falls back to the static value if the view call reverts — a failed read
// must never block the fire.
async function resolveDynamicArgs(provider, contract, abi, args, dynamicArgs, logPath) {
  const out = [...args];
  for (const d of dynamicArgs || []) {
    const idx = Number(d.arg_index);
    try {
      const c = new ethers.Contract(contract, abi, provider);
      const got = await c[d.call.function](...(d.call.args || []).map((a) => (typeof a === 'string' && /^-?\d+$/.test(a) ? BigInt(a) : a)));
      const val = (d.pick !== undefined && Array.isArray(got)) ? got[d.pick] : got;
      out[idx] = BigInt(val);
      log(`dynamic arg[${idx}] from ${d.call.function} = ${val}`, logPath);
    } catch (e) {
      log(`dynamic arg[${idx}] read failed (${String(e.message || e).slice(0, 100)}) — keeping static value ${out[idx]}`, logPath);
    }
  }
  return out;
}

module.exports = {
  RPCS, AGENT_ID, AGENT_ID_HEX, MAIN_WALLET, ZERO_ADDRESS,
  log, loadConfig, makeProvider, ethCall, decodeRevert, readView,
  buildCalldata, verifyDecoded, resolveArgs, resolveDynamicArgs,
};
