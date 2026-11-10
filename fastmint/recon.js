#!/usr/bin/env node
// recon.js <url> [--wallet 0x..] [--contract 0x..] [--json] [--timeout 25]
// Fast (<30s) FCFS mint recon: site HTML + JS bundles + agent docs -> addresses, chainId, mint fns,
// eth_getCode, Sourcify v2 ABI, view getters, suggested calldata + eth_call sim. Read-only.
'use strict';
const L = require('./lib');
const { ethers } = L;
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const opt = { url: null, wallet: process.env.FASTMINT_WALLET || null, contracts: [], json: false, timeout: 25 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--wallet') opt.wallet = argv[++i];
  else if (a === '--contract') opt.contracts.push(argv[++i]);
  else if (a === '--json') opt.json = true;
  else if (a === '--timeout') opt.timeout = +argv[++i];
  else if (!a.startsWith('--')) opt.url = a;
}
if (!opt.url && !opt.contracts.length) { console.error('usage: recon.js <url> [--contract 0x..] [--wallet 0x..]'); process.exit(2); }
const T0 = Date.now();
const el = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';
const HARD = setTimeout(() => { console.error('recon hard timeout'); process.exit(3); }, (opt.timeout + 5) * 1000);

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
async function get(url, ms = 7000, max = 3 << 20) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA }, signal: ctl.signal, redirect: 'follow' });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (/image|font|video|audio|octet/.test(ct)) return null;
    const txt = await r.text();
    return txt.length > max ? txt.slice(0, max) : txt;
  } catch { return null; } finally { clearTimeout(t); }
}
const VENDOR = /ethers|web3\.|viem|wagmi|qrcode|motion|gsap|three|lottie|jquery|react-dom|polyfill|analytics|gtag|sentry|chunk-vendors|vendor/i;

async function crawl(url) {
  const base = new URL(url);
  const pages = {};
  const html = await get(url);
  if (html) pages[url] = html;
  const assets = new Set();
  const addAsset = (u, from) => { try { const x = new URL(u, from); if (x.host === base.host && /\.(m?js|json|md|txt)(\?|$)/i.test(x.pathname)) assets.add(x.href); } catch {} };
  if (html) {
    for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) addAsset(m[1], url);
    for (const m of html.matchAll(/<link[^>]+href=["']([^"']+\.m?js[^"']*)["']/gi)) addAsset(m[1], url);
    for (const m of html.matchAll(/href=["']([^"']+\.(?:md|txt|json))["']/gi)) addAsset(m[1], url);
  }
  // agent-facing docs commonly shipped by these sites
  for (const p of ['/llms.txt', '/skill.md', '/SKILL.md', '/handbook.md', '/agents.md', '/AGENTS.md', '/mint.md', '/how-to-mint.md', '/llms-full.txt', '/.well-known/agent.json'])
    assets.add(new URL(p, base).href);
  const fetchList = async list => Promise.all(list.map(async u => {
    if (pages[u] !== undefined) return;
    const name = new URL(u).pathname.split('/').pop();
    if (VENDOR.test(name)) { pages[u] = null; return; }
    const t = await get(u, 6000);
    // reject SPA fallbacks (html returned for missing .md/.txt)
    pages[u] = t && !/^\s*<!doctype html|^\s*<html/i.test(t) ? t : null;
  }));
  await fetchList([...assets]);
  // one more level: imports / chunk references inside fetched JS
  const lvl2 = new Set();
  for (const [u, t] of Object.entries(pages)) {
    if (!t || !/\.m?js/.test(u)) continue;
    for (const m of t.matchAll(/(?:import\s*\(?\s*|from\s*)["'`]([^"'`]+\.m?js)["'`]/g)) { try { const x = new URL(m[1], u); if (x.host === base.host && !pages.hasOwnProperty(x.href)) lvl2.add(x.href); } catch {} }
    for (const m of t.matchAll(/["'`](\/?(?:assets|static|_next\/static|js|press|codex)\/[^"'`\s]+\.m?js)["'`]/g)) { try { const x = new URL(m[1], url); if (!pages.hasOwnProperty(x.href)) lvl2.add(x.href); } catch {} }
  }
  if (lvl2.size && Date.now() - T0 < 12000) await fetchList([...lvl2].slice(0, 20));
  return pages;
}

function ctxOf(text, idx, w = 50) { return text.slice(Math.max(0, idx - w), idx).replace(/\s+/g, ' '); }

function extract(pages) {
  const addrs = new Map(); const chainIds = new Set(); const fnSigs = new Set(); const fnNames = new Map();
  const selectors = new Set(); const jsonAbis = []; const times = new Set(); const notes = [];
  for (const [u, t] of Object.entries(pages)) {
    if (!t) continue;
    for (const m of t.matchAll(/0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/g)) {
      const a = m[0].toLowerCase();
      const e = addrs.get(a) || { count: 0, ctx: new Set(), files: new Set() };
      e.count++; e.files.add(new URL(u).pathname); const c = ctxOf(t, m.index).match(/([A-Za-z_][\w ]{0,30})[\s"':=,]*$/); if (c && e.ctx.size < 3) e.ctx.add(c[1].trim().slice(-30));
      addrs.set(a, e);
    }
    for (const m of t.matchAll(/chain_?id["'\s]*[:=]\s*["']?(0x[0-9a-f]+|\d+)/gi)) chainIds.add(String(parseInt(m[1])));
    for (const m of t.matchAll(/chainId\s*\(?\s*(56|97|1|8453|42161)\b/g)) chainIds.add(m[1]);
    // human-readable ABI strings
    for (const m of t.matchAll(/["'`]((?:function|error|event)\s+\w+\s*\([^"'`]*?\)[^"'`]*)["'`]/g)) fnSigs.add(m[1].replace(/\s+/g, ' ').trim());
    // JSON ABI fragments
    for (const m of t.matchAll(/\[\s*\{[^\[\]]{0,200}"type"\s*:\s*"(?:function|error|constructor)"[\s\S]{0,200000}?\}\s*\]/g)) {
      try { const abi = JSON.parse(m[0]); if (Array.isArray(abi) && abi.some(x => x.type === 'function')) jsonAbis.push(abi); } catch {}
    }
    for (const m of t.matchAll(/functionName\s*:\s*["'](\w+)["']/g)) fnNames.set(m[1], (fnNames.get(m[1]) || 0) + 1);
    for (const m of t.matchAll(/\.(\w*(?:mint|claim|buy|free|purchase|acquire|reserve|book)\w*)\s*\(/gi)) fnNames.set(m[1], (fnNames.get(m[1]) || 0) + 1);
    for (const m of t.matchAll(/["'](0x[0-9a-fA-F]{8})["']/g)) selectors.add(m[1].toLowerCase());
    for (const m of t.matchAll(/\b(17\d{8}|18\d{8})\b/g)) times.add(m[1]);
    if (/\.(md|txt)$/.test(new URL(u).pathname) || /llms|skill|handbook/i.test(u)) notes.push({ file: new URL(u).pathname, head: t.slice(0, 1200) });
  }
  return { addrs, chainIds: [...chainIds], fnSigs: [...fnSigs], fnNames, selectors: [...selectors], jsonAbis, times: [...times], notes };
}

const MINT_RE = /mint|claim|free|buy|purchase|acquire|reserve|book|join|deposit|commit|participate|subscribe/i;
const SKIP_WRITE = /^(approve|transfer|transferFrom|setApprovalForAll|safeTransferFrom|renounce|transferOwnership|acceptOwnership|set[A-Z]|withdraw|rescue|pause|unpause|upgrade|init|admin|owner)/;

function argGuess(input, ctx) {
  const n = (input.name || '').toLowerCase(), t = input.type;
  if (t === 'address') return /invit|ref|sponsor|upline/.test(n) ? ctx.inviter : (/to|recipient|wallet|user|account|receiver/.test(n) ? ctx.wallet : ctx.inviter);
  if (/^uint|^int/.test(t)) {
    if (/agent|^id$|tokenid|handle/.test(n)) return ctx.agentId != null ? ctx.agentId : 0n;
    if (/deadline|expir/.test(n)) return BigInt(Math.floor(Date.now() / 1000) + 1800);
    if (/qty|quantity|amount|shares|count|num|lots?$/.test(n)) return 1n;
    if (/min/.test(n)) return 0n;
    if (/max/.test(n)) return ethers.MaxUint256;
    return 0n;
  }
  if (t === 'bool') return false;
  if (/^bytes32$/.test(t)) return ethers.ZeroHash;
  if (/^bytes/.test(t)) return '0x';
  if (t === 'string') return '';
  if (t.endsWith('[]')) return [];
  return null;
}

(async () => {
  const out = { url: opt.url, t: L.wib(), wallet: null, agent: null, chainIds: [], contracts: [], notes: [], warnings: [] };
  // parallel: crawl site, warm RPC, wallet + agent id
  const walletP = (async () => {
    let w = opt.wallet;
    if (!w) { try { w = await L.bawEvmAddress(); } catch {} }
    if (!w) return null;
    w = ethers.getAddress(w);
    let agent = null; try { agent = await L.agentIdOf(w); } catch {}
    return { w, agent };
  })();
  const pagesP = opt.url ? crawl(opt.url) : Promise.resolve({});
  const [pages, wa] = await Promise.all([pagesP, walletP, L.warmRpcs()]);
  out.wallet = wa && wa.w; out.agent = wa && wa.agent ? { handle: wa.agent.handle, tokenId: wa.agent.tokenId && wa.agent.tokenId.toString() } : null;
  const fetched = Object.entries(pages).filter(([, t]) => t).map(([u, t]) => `${new URL(u).pathname} (${(t.length / 1024).toFixed(0)}KB)`);
  const ex = extract(pages);
  out.fetched = fetched; out.chainIds = ex.chainIds; out.notes = ex.notes; out.siteFns = [...ex.fnNames.keys()].filter(n => MINT_RE.test(n));
  out.siteSigs = ex.fnSigs.filter(s => /^function/.test(s) && MINT_RE.test(s)).slice(0, 25);
  out.siteTimes = ex.times.map(x => `${x} = ${L.fmtUnix(x)}`).slice(0, 8);
  if (ex.chainIds.length && !ex.chainIds.includes('56')) out.warnings.push('site chainId not 56: ' + ex.chainIds.join(','));

  // candidate addresses, rank by count; manual --contract first
  let cands = [...opt.contracts.map(a => a.toLowerCase()), ...[...ex.addrs.entries()].sort((a, b) => b[1].count - a[1].count).map(x => x[0])];
  const INFRA = new Set(['0x55d398326f99059ff775485246999027b3197955', '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', '0x10ed43c718714eb63d5aa57b78b54704e256024e', '0xca143ce32fe78f1f7019d7d551a6402fc5350c73', '0x13f4ea83d0bd40e75c8222255bc855a974568dd4', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', '0xe9e7cea3dedca5984780bafc599bd69add087d56', '0x000000000000000000000000000000000000dead', '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3', '0x0000000000000000000000000000000000000000']);
  const infraHit = [...new Set(cands)].filter(a => INFRA.has(a));
  if (infraHit.length) out.infra = infraHit.map(a => ethers.getAddress(a));
  cands = [...new Set(cands)].filter(a => !INFRA.has(a) && a !== (out.wallet || '').toLowerCase() && !opt.contracts.includes('!' + a)).slice(0, 25);
  const codes = await Promise.all(cands.map(a => L.rpc('eth_getCode', [a, 'latest']).catch(() => null)));
  const withCode = cands.filter((a, i) => codes[i] && codes[i] !== '0x');
  const eoa = cands.filter((a, i) => codes[i] === '0x');
  out.eoas = eoa.map(a => ({ address: ethers.getAddress(a), ctx: ex.addrs.get(a) ? [...ex.addrs.get(a).ctx] : [] }));

  // site ABI fallback interface
  let siteFrags = [];
  for (const abi of ex.jsonAbis) siteFrags.push(...abi.filter(x => ['function', 'error', 'event'].includes(x.type)));
  for (const s of ex.fnSigs) { try { siteFrags.push(ethers.Fragment.from(s)); } catch {} }
  const siteIface = (() => { try { return new ethers.Interface(dedupe(siteFrags)); } catch { return null; } })();

  const abis = await Promise.all(withCode.map(a => L.sourcifyAbiCached(ethers.getAddress(a))));
  for (let i = 0; i < withCode.length; i++) {
    const addr = ethers.getAddress(withCode[i]);
    const c = { address: addr, ctx: ex.addrs.get(withCode[i]) ? [...ex.addrs.get(withCode[i]).ctx] : [], codeBytes: (codes[cands.indexOf(withCode[i])].length - 2) / 2, sourcify: abis[i] ? abis[i].match : null };
    let iface = null;
    if (abis[i]) iface = new ethers.Interface(abis[i].abi);
    else if (siteIface) { iface = siteIface; c.abiFrom = 'site-bundle'; }
    if (/^0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F$/i.test(addr)) { c.role = 'AgentID registry'; out.contracts.push(c); continue; }
    if (iface && !abis[i]) {
      // keep only fragments whose selector is PUSH4'd in this contract's runtime code
      const code = codes[cands.indexOf(withCode[i])].toLowerCase();
      const keep = iface.fragments.filter(f => (f.type === 'function' || f.type === 'error') && code.includes('63' + f.selector.slice(2)));
      iface = keep.filter(f => f.type === 'function').length ? new ethers.Interface(keep) : null;
      if (!iface) c.note = 'no site ABI selector found in bytecode';
    }
    if (iface) await probe(c, iface, out, !!abis[i]);
    out.contracts.push(c);
  }
  // order: contracts with mint candidates first
  out.contracts.sort((a, b) => ((b.mintFns || []).length > 0) - ((a.mintFns || []).length > 0) || b.codeBytes - a.codeBytes);
  out.elapsed = el();
  print(out);
  if (opt.json) fs.writeFileSync(path.join(__dirname, 'runs', `recon_${Date.now()}.json`), L.safeJson(out));
  clearTimeout(HARD);
  process.exit(0);
})().catch(e => { console.error('recon ERR', e.stack || e.message); process.exit(1); });

function dedupe(frags) {
  const seen = new Set(), outF = [];
  for (const f of frags) { let k; try { k = ethers.Fragment.from(f).format('sighash') + ':' + (f.type || ethers.Fragment.from(f).type); } catch { continue; } if (seen.has(k)) continue; seen.add(k); outF.push(f); }
  return outF;
}

async function probe(c, iface, out, verified) {
  const W = out.wallet || ethers.ZeroAddress;
  const agentId = out.agent && out.agent.tokenId ? BigInt(out.agent.tokenId) : null;
  const fns = iface.fragments.filter(f => f.type === 'function');
  const views = fns.filter(f => (f.stateMutability === 'view' || f.stateMutability === 'pure'));
  const writes = fns.filter(f => !(f.stateMutability === 'view' || f.stateMutability === 'pure'));
  c.errors = iface.fragments.filter(f => f.type === 'error').map(f => `${f.name}=${f.selector}`);
  // getters: 0-arg, (address wallet), (uint256 agentId)
  const calls = [];
  for (const f of views) {
    if (f.inputs.length === 0) calls.push([f, []]);
    else if (f.inputs.length === 1 && f.inputs[0].type === 'address') calls.push([f, [W]]);
    else if (f.inputs.length === 1 && /^uint/.test(f.inputs[0].type) && agentId != null && /agent|id|token/i.test(f.inputs[0].name + f.name)) calls.push([f, [agentId]]);
  }
  const SKIPV = /^(name|symbol|decimals|totalSupply|owner|supportsInterface|DOMAIN_SEPARATOR|eip712Domain|nonces|allowance|balanceOf|tokenURI|baseURI|contractURI|version|pendingOwner|getApproved|isApprovedForAll)$/;
  const imp = /start|open|time|begin|end|deadline|price|cost|fee|paused|sold|minted|claimed|max|cap|supply|left|remain|quota|limit|free|status|info|state|active|live|phase|stage|can|eligible|agent|taken|booked|used|user|share|lot|config|params|launch/i;
  const picked = calls.filter(([f]) => !SKIPV.test(f.name) || f.name === 'owner' || f.name === 'totalSupply').sort((a, b) => imp.test(b[0].name) - imp.test(a[0].name)).slice(0, 70);
  const res = await Promise.all(picked.map(async ([f, args]) => {
    try {
      const r = await L.rpc('eth_call', [{ from: W, to: c.address, data: iface.encodeFunctionData(f, args) }, 'latest'], { timeoutMs: 5000 });
      const d = iface.decodeFunctionResult(f, r);
      return [f.name + (args.length ? '(' + (args[0] === W ? 'wallet' : 'agentId') + ')' : ''), fmtVal(d, f)];
    } catch (e) { const dr = await L.decodeRevert(e, iface).catch(() => ({ name: 'err' })); return [f.name + (args.length ? '(…)' : ''), 'REVERT:' + dr.name]; }
  }));
  c.getters = Object.fromEntries(res);
  // annotate unix timestamps
  for (const [k, v] of Object.entries(c.getters)) if (/^\d{10}$/.test(v) && +v > 1.6e9 && +v < 2.2e9) c.getters[k] = `${v} (${L.fmtUnix(v)})`;
  c.writes = writes.map(f => f.format('sighash') + (f.payable ? ' payable' : '') + ' ' + f.selector);
  const prio = f => (/free/i.test(f.name) ? 0 : /mint/i.test(f.name) ? 1 : /buy|purchase|acquire/i.test(f.name) ? 2 : 3);
  const mintFns = writes.filter(f => MINT_RE.test(f.name) && !SKIP_WRITE.test(f.name) && !/reward|refund|collect|withdraw|^claimBnb$|^claim$/i.test(f.name)).sort((a, b) => prio(a) - prio(b));
  c.mintFns = [];
  for (const f of mintFns.slice(0, 8)) {
    const ctx = { wallet: W, inviter: ethers.ZeroAddress, agentId };
    const args = f.inputs.map(i => argGuess(i, ctx));
    let data = null; try { data = iface.encodeFunctionData(f, args); } catch { }
    if (f.payable) { const pk = Object.keys(c.getters).find(k => /price|cost/i.test(k) && /^[1-9]\d{9,}$/.test(String(c.getters[k]).split(' ')[0])); if (pk) var vhint = `${pk}=${ethers.formatEther(String(c.getters[pk]).split(' ')[0])} BNB x qty`; }
    const entry = { vhint: f.payable ? (vhint || 'payable: read price from site/docs') : null, sig: f.format('sighash'), selector: f.selector, payable: f.payable, params: f.inputs.map(i => `${i.type} ${i.name}`).join(', '), guessArgs: args.map(String), data, value: '0' };
    if (data) {
      const sim = await L.rpcRace('eth_call', [{ from: W, to: c.address, data, value: '0x0' }, 'latest']).catch(e => ({ ok: false, error: e }));
      if (sim.ok) entry.sim = 'OK';
      else { const d = await L.decodeRevert(sim.error, iface); entry.sim = `REVERT ${d.name}${d.sel ? ' ' + d.sel : ''} [${L.classify(d.name)}]`; }
    }
    c.mintFns.push(entry);
  }
  // find price getter -> suggest value for payable paid mint
  const priceKey = Object.keys(c.getters).find(k => /price|cost|fee/i.test(k) && /^\d+$/.test(String(c.getters[k]).split(' ')[0]));
  if (priceKey) c.priceHint = `${priceKey}=${c.getters[priceKey]} wei = ${ethers.formatEther(String(c.getters[priceKey]).split(' ')[0])} BNB per unit (check units!)`;
}

function fmtVal(d, f) {
  const conv = v => typeof v === 'bigint' ? v.toString() : (v && typeof v === 'object' && typeof v.toObject === 'function' ? (() => { try { const o = v.toObject(); return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, conv(x)])); } catch { return [...v].map(conv); } })() : (Array.isArray(v) ? v.map(conv) : v));
  if (d.length === 1) { const v = conv(d[0]); return typeof v === 'object' ? JSON.stringify(v) : String(v); }
  try { const names = f.outputs.map((o, i) => o.name || `o${i}`); return JSON.stringify(Object.fromEntries(names.map((n, i) => [n, conv(d[i])]))); } catch { return JSON.stringify(conv([...d])); }
}

function print(o) {
  const P = (...a) => console.log(...a);
  P(`=== RECON ${o.url || ''}  (${o.elapsed}, ${o.t})`);
  P(`wallet ${o.wallet || '?'}  agentId ${o.agent && o.agent.handle ? o.agent.handle + '.ai tokenId=' + o.agent.tokenId : 'NONE'}`);
  P(`site chainId: ${o.chainIds.join(',') || '?'} | fetched: ${(o.fetched || []).join(', ')}`);
  if (o.siteTimes.length) P(`unix times in site: ${o.siteTimes.join(' | ')}`);
  if (o.siteFns.length) P(`site calls: ${o.siteFns.join(', ')}`);
  if (o.siteSigs.length) P(`site ABI sigs: ${o.siteSigs.slice(0, 12).join(' ; ')}`);
  for (const n of o.notes) P(`--- doc ${n.file}:\n${n.head.slice(0, 700).trim()}\n---`);
  if (o.infra) P(`known infra skipped: ${o.infra.join(', ')}`);
  if (o.eoas.length) P(`EOAs (no code): ${o.eoas.map(e => e.address + (e.ctx.length ? ' [' + e.ctx.join('/') + ']' : '')).join(', ')}`);
  for (const c of o.contracts) {
    P(`\n## ${c.address} ${c.role || ''} code=${c.codeBytes}B sourcify=${c.sourcify || 'no'}${c.abiFrom ? ' abi=' + c.abiFrom : ''} ${c.ctx.length ? '[' + c.ctx.join('/') + ']' : ''}`);
    if (c.getters) {
      const bad = [];
      const full = c.mintFns && c.mintFns.length; let shown = 0;
      for (const [k, v] of Object.entries(c.getters)) { if (/^REVERT/.test(v)) bad.push(k); else if (full || /start|open|price|paused|sold|left|free|max|status|agent|can|time/i.test(k) && shown++ < 12) P(`  ${k}: ${String(v).slice(0, 300)}`); }
      if (bad.length) P(`  (${bad.length} getters reverted: ${bad.join(', ').slice(0, 200)})`);
    }
    if (c.note) P('  ' + c.note);
    if (c.priceHint) P(`  price hint: ${c.priceHint}`);
    if (c.mintFns && c.mintFns.length) {
      P('  MINT CANDIDATES:');
      for (const m of c.mintFns) {
        P(`   * ${m.sig}${m.payable ? ' PAYABLE' : ''} ${m.selector}  params(${m.params})`);
        P(`     sim(value 0): ${m.sim || 'n/a'}${m.vhint ? '  | value hint: ' + m.vhint : ''}`);
        if (m.data) P(`     fire: node fire.js --to ${c.address} --data ${m.data.length > 300 ? m.data.slice(0, 300) + '…' : m.data} --value ${m.payable ? '<BNB> --maxValue <BNB>' : '0'} --start HH:MM --dry`);
      }
    }
    if (c.writes && c.writes.length) P(`  writes: ${c.writes.join(' | ').slice(0, 900)}`);
    if (c.errors && c.errors.length) P(`  errors: ${c.errors.join(' ').slice(0, 600)}`);
  }
  if (o.warnings.length) P('WARN', o.warnings.join('; '));
}
