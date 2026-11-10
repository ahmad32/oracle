#!/usr/bin/env node
// fire.js — FCFS one-shot contract call through Binance Agentic Wallet (baw) on BSC.
// Flow: precheck (CONNECTED, devMode, balance, lock) -> prewarm -> wait start-lead -> spin eth_call
// (latest+pending, all RPCs) -> baw preview -> checks -> baw execute ONCE -> receipt.
// Never runs auth signin. Never broadcasts twice. --dry stops before execute.
'use strict';
const L = require('./lib');
const { ethers, log } = L;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HELP = `usage: node fire.js --to 0xC --data 0x... | --sig "fn(type,..)" --args '[..]'
  --value <BNB>        BNB to send (decimal, default 0). Paid mint needs explicit amount.
  --maxValue <BNB>     safety cap; required when --value > 0; refuses if value > cap
  --start <t>          unix seconds or HH:MM[:SS] WIB (optional; omit = now)
  --lead <ms>          start spinning eth_call this long before start (default 2000)
  --interval <ms>      spin interval (default 120)
  --timeout <s>        keep retrying 'not started' reverts this long after start (default 600)
  --grace <s>          treat Unknown reverts as 'wait' until start+grace (default 8)
  --once               single attempt at start: one sim, one preview, one execute
  --dry                do everything up to (and incl.) preview, stop before execute
  --noPreview          with --dry: stop before preview too (pure eth_call)
  --eager              also fire preview when chain head ts >= start, without waiting for eth_call OK
  --from 0x..          wallet (default: baw wallet address on chain 56)
  --abi 0x..           extra address whose Sourcify ABI is used for error decoding (default --to)
  --waitOn <regex>     extra revert names to keep retrying;  --fatalOn <regex> extra names to stop on
  --label <name>       run label for log/lock files`;

const a = process.argv.slice(2); const o = { value: '0', lead: 2000, interval: 120, timeout: 600, grace: 8 };
for (let i = 0; i < a.length; i++) {
  const k = a[i]; const nx = () => a[++i];
  switch (k) {
    case '--to': o.to = nx(); break; case '--data': o.data = nx(); break; case '--sig': o.sig = nx(); break;
    case '--args': o.args = nx(); break; case '--value': o.value = nx(); break; case '--maxValue': o.maxValue = nx(); break;
    case '--start': o.start = nx(); break; case '--lead': o.lead = +nx(); break; case '--interval': o.interval = +nx(); break;
    case '--timeout': o.timeout = +nx(); break; case '--grace': o.grace = +nx(); break; case '--once': o.once = true; break;
    case '--dry': o.dry = true; break; case '--noPreview': o.noPreview = true; break; case '--eager': o.eager = true; break;
    case '--from': o.from = nx(); break; case '--abi': o.abi = nx(); break; case '--label': o.label = nx(); break;
    case '--waitOn': o.waitOn = new RegExp(nx(), 'i'); break; case '--fatalOn': o.fatalOn = new RegExp(nx(), 'i'); break;
    case '-h': case '--help': console.log(HELP); process.exit(0);
    default: console.error('unknown arg ' + k + '\n' + HELP); process.exit(2);
  }
}
const die = (m, code = 1) => { log('STOP ' + m); process.exit(code); };
if (!o.to || !ethers.isAddress(o.to)) die('--to missing/invalid', 2);
o.to = ethers.getAddress(o.to);
// calldata
let fnFrag = null;
if (o.sig) {
  fnFrag = ethers.FunctionFragment.from(o.sig.startsWith('function') ? o.sig : 'function ' + o.sig);
  const args = o.args ? JSON.parse(o.args) : [];
  o.data = new ethers.Interface([fnFrag]).encodeFunctionData(fnFrag, args);
}
if (!o.data || !/^0x([0-9a-fA-F]{2})*$/.test(o.data) || o.data.length < 10) die('--data (or --sig) missing/invalid hex', 2);
// value
let valueWei, maxWei;
try { valueWei = ethers.parseEther(String(o.value)); } catch { die('bad --value (BNB decimal, e.g. 0.005)', 2); }
if (valueWei > 0n) {
  if (o.maxValue == null) die('--value > 0 requires --maxValue (explicit cap the user approved)', 2);
  maxWei = ethers.parseEther(String(o.maxValue));
  if (valueWei > maxWei) die(`value ${o.value} BNB > maxValue ${o.maxValue} BNB — refusing`, 2);
} else maxWei = o.maxValue != null ? ethers.parseEther(String(o.maxValue)) : 0n;
const valueHex = '0x' + valueWei.toString(16);

const label = o.label || `${o.to.slice(0, 8)}_${o.data.slice(0, 10)}`;
const RUNS = path.join(__dirname, 'runs'); fs.mkdirSync(RUNS, { recursive: true });
const stamp = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 19).replace(/[-:T]/g, '');
L.setLogFile(path.join(RUNS, `${stamp}_${label}${o.dry ? '_dry' : ''}.log`));
const lockKey = crypto.createHash('sha256').update([o.to.toLowerCase(), o.data.toLowerCase(), valueWei.toString()].join('|')).digest('hex').slice(0, 16);
const lockFile = path.join(RUNS, `lock_${lockKey}.json`);
const save = (name, obj) => fs.writeFileSync(path.join(RUNS, `${stamp}_${label}_${name}.json`), typeof obj === 'string' ? obj : L.safeJson(obj));

let decodeIface = null;
let lastHead = { number: 0, ts: 0 };

async function headLoop(stopAt) {
  while (Date.now() < stopAt) {
    try {
      const b = await L.rpc('eth_getBlockByNumber', ['latest', false], { timeoutMs: 2500 });
      const n = parseInt(b.number, 16), ts = parseInt(b.timestamp, 16);
      if (n > lastHead.number) lastHead = { number: n, ts };
    } catch {}
    await L.sleep(250);
  }
}

// eth_call at all RPCs x {latest,pending}; resolve on first success, else first revert after all/most return.
function simAll(from) {
  const tx = { from, to: o.to, data: o.data, value: valueHex };
  return new Promise(resolve => {
    const jobs = []; for (const u of L.RPCS) for (const tag of ['latest', 'pending']) jobs.push([u, tag]);
    let left = jobs.length, firstRevert = null, done = false;
    const fin = r => { if (!done) { done = true; resolve(r); } };
    setTimeout(() => fin(firstRevert ? { ok: false, ...firstRevert } : { ok: false, transport: true }), 1500);
    for (const [u, tag] of jobs) {
      L.rpcOne(u, 'eth_call', [tx, tag], 1500).then(
        () => fin({ ok: true, url: u, tag }),
        e => { if (L.isRevert(e) && !firstRevert) { firstRevert = { error: e, url: u, tag }; setTimeout(() => fin({ ok: false, ...firstRevert }), 250); } if (--left === 0) fin(firstRevert ? { ok: false, ...firstRevert } : { ok: false, transport: true }); });
    }
  });
}

function nativeOutflowWei(sim) {
  // best effort over balanceChanges shape; returns max native outflow seen (wei) or null
  let max = null;
  for (const b of (sim && sim.balanceChanges) || []) {
    const s = JSON.stringify(b).toLowerCase();
    if (!/0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee|"bnb"|native/.test(s)) continue;
    for (const k of ['amount', 'change', 'value', 'delta', 'balanceChange', 'rawAmount']) {
      if (b[k] == null) continue;
      try { let v = String(b[k]); if (/[.eE]/.test(v)) continue; let w = BigInt(v.replace(/^-/, '')); if (max == null || w > max) max = w; } catch {}
    }
  }
  return max;
}

async function preview(from) {
  const args = ['contract-call', 'preview', '--binanceChainId', '56', '--from', from, '--to', o.to, '--value', valueWei.toString(), '--inputData', o.data];
  const r = await L.baw(args, 30000);
  return r;
}

function checkPreview(r) {
  const j = r.json || {};
  if (!r.ok || !j.data) {
    const e = j.error || {};
    const txt = L.safeJson(j.error || r.stdout || r.stderr).slice(0, 600);
    if (e.code === 351803 || /RISK_BLOCKED|risk/i.test(e.name || '')) return { verdict: 'fatal', why: `Binance risk block ${e.code} ${e.name}: ${e.message} — not bypassing` };
    if (e.code === 351802 || /dev.?mode/i.test(txt)) return { verdict: 'fatal', why: 'Developer Mode off/expired (enable in Binance App) ' + txt };
    if (/UNCONNECTED|not.?log|unauth|sign.?in/i.test(txt)) return { verdict: 'fatal', why: 'wallet session problem — do NOT auth signin automatically; ask the user ' + txt };
    return { verdict: classifyText(txt), why: 'preview error ' + txt };
  }
  const d = j.data, sim = d.simulationResult || {};
  if (sim.simulationCode !== '000000000') {
    const txt = L.safeJson(sim).slice(0, 600);
    return { verdict: classifyText(txt), why: `preview simulationCode ${sim.simulationCode} ${txt}` };
  }
  if ((sim.allowanceChanges || []).length || (sim.authorityChanges || []).length)
    return { verdict: 'fatal', why: 'preview shows allowance/authority changes — not executing ' + L.safeJson({ a: sim.allowanceChanges, au: sim.authorityChanges }) };
  const risks = d.risks || {};
  const hard = (risks.riskDetails || []).filter(x => String(x.riskType).toUpperCase() === 'RISK');
  const addrHard = Object.entries(risks.addresses || {}).filter(([, v]) => (v.riskDetails || []).some(x => String(x.riskType).toUpperCase() === 'RISK'));
  if (hard.length || addrHard.length) return { verdict: 'fatal', why: 'preview RISK flags — needs user review: ' + L.safeJson({ hard, addrHard }) };
  const out = nativeOutflowWei(sim);
  if (out != null && out > maxWei + ethers.parseEther('0.003')) return { verdict: 'fatal', why: `native outflow ${ethers.formatEther(out)} BNB > cap` };
  if (d.parsedTx && d.parsedTx.amount != null && /^\d+$/.test(String(d.parsedTx.amount)) && (d.parsedTx.contractAddress == null || /0xeeee/i.test(d.parsedTx.contractAddress)) && BigInt(d.parsedTx.amount) > (maxWei > valueWei ? maxWei : valueWei) && valueWei === 0n && BigInt(d.parsedTx.amount) > 0n)
    return { verdict: 'fatal', why: 'parsedTx amount > 0 on a value-0 call: ' + L.safeJson(d.parsedTx) };
  if (!d.requestId) return { verdict: 'fatal', why: 'no requestId in preview' };
  const caution = (risks.riskDetails || []).filter(x => String(x.riskType).toUpperCase() !== 'RISK');
  return { verdict: 'ok', requestId: d.requestId, requireConfirmation: !!d.requireConfirmation, caution, gas: sim.gasTokenFromData, balanceChanges: sim.balanceChanges };
}

function classifyText(txt) {
  const names = (txt.match(/\b[A-Z][A-Za-z]{3,40}\b/g) || []);
  for (const n of names) { const c = L.classify(n, { waitRe: o.waitOn, fatalRe: o.fatalOn }); if (c !== 'unknown') return c; }
  return L.classify(txt, { waitRe: o.waitOn, fatalRe: o.fatalOn }) === 'wait' ? 'wait' : 'unknown';
}

async function receipt(hash) {
  const until = Date.now() + 120000;
  while (Date.now() < until) {
    try { const r = await L.rpc('eth_getTransactionReceipt', [hash], { timeoutMs: 3000 }); if (r) return r; } catch {}
    await L.sleep(400);
  }
  return null;
}

(async () => {
  const startUnix = L.parseStart(o.start);
  log(`FIRE ${label} to=${o.to} value=${o.value} BNB (${valueWei} wei) cap=${ethers.formatEther(maxWei)} BNB data=${o.data.length > 140 ? o.data.slice(0, 140) + '…' : o.data}${o.dry ? ' [DRY]' : ''}${o.once ? ' [ONCE]' : ''}`);
  if (startUnix) log(`start ${startUnix} = ${L.fmtUnix(startUnix)}${startUnix * 1000 < Date.now() ? ' (already passed → fire now)' : ` (in ${((startUnix * 1000 - Date.now()) / 1000).toFixed(0)}s)`}`);
  if (fs.existsSync(lockFile) && !o.dry) die(`lock exists ${lockFile} — this exact call was already executed. Never auto-repeat. Delete the lock only on the user's explicit new command.`);

  // ---- precheck (parallel) ----
  const [status, addr, settings, warm] = await Promise.all([
    L.bawStatus(), o.from ? Promise.resolve(ethers.getAddress(o.from)) : L.bawEvmAddress(), L.baw(['wallet', 'settings']), L.warmRpcs(),
  ]);
  log(`baw status ${status} | from ${addr} | rpc ${warm.map(w => `${new URL(w.u).host}:${w.err ? 'ERR' : w.ms + 'ms#' + w.block}`).join(' ')}`);
  if (status !== 'CONNECTED') die(`baw wallet status = ${status}. Not running auth signin. Ask the user to reconnect (auth signin is a user-approved step).`);
  if (!addr) die('could not read wallet address');
  const dm = settings.json && settings.json.data && settings.json.data.devMode;
  if (!dm || !dm.enabled || (dm.expiresAt && Date.parse(dm.expiresAt) < Date.now())) die('Developer Mode is off/expired — user must enable it in the Binance App (Agentic Wallet → Settings → Developer Mode).');
  log(`devMode on until ${dm.expiresAt}; devMode quota used today ${settings.json.data.developerModeQuotaUsed} / ${dm.dailyLimit} USD`);
  const [code, bal] = await Promise.all([L.rpc('eth_getCode', [o.to, 'latest']), L.rpc('eth_getBalance', [addr, 'latest'])]);
  if (!code || code === '0x') die(`${o.to} has no code on BSC`);
  const balWei = BigInt(bal);
  log(`balance ${ethers.formatEther(balWei)} BNB`);
  if (balWei < valueWei + ethers.parseEther('0.0003')) die(`balance too low for value + gas`);
  // errors ABI for decoding
  const ab = await L.sourcifyAbiCached(ethers.getAddress(o.abi || o.to));
  if (ab) { try { decodeIface = new ethers.Interface(ab.abi); log(`sourcify ABI loaded (${ab.match}), ${decodeIface.fragments.filter(f => f.type === 'error').length} errors`); } catch {} }
  if (decodeIface && !fnFrag) { try { const f = decodeIface.getFunction(o.data.slice(0, 10)); if (f) log(`call = ${f.format('sighash')}${f.payable ? ' payable' : ''} args ${L.safeJson(decodeIface.decodeFunctionData(f, o.data))}`); else log('WARN selector not in verified ABI'); } catch { log('WARN selector not in verified ABI'); } }

  // ---- wait ----
  const startMs = (startUnix || 0) * 1000;
  const deadline = (startMs || Date.now()) + o.timeout * 1000;
  headLoop(deadline + 5000);
  if (startMs > Date.now() + o.lead) {
    // re-check session ~20s before start (also warms the baw path)
    while (Date.now() < startMs - o.lead) {
      const left = startMs - o.lead - Date.now();
      if (left > 25000 && left < 26000 + 1000) { const s = await L.bawStatus(); log(`T-${((startMs - Date.now()) / 1000).toFixed(0)}s baw status ${s}`); if (s !== 'CONNECTED') die('session dropped before start'); await L.warmRpcs(); }
      await L.sleep(Math.min(1000, Math.max(20, left)));
    }
  }
  log(`spinning eth_call (latest+pending x ${L.RPCS.length} RPCs) head #${lastHead.number} ts ${lastHead.ts}`);

  // ---- spin ----
  let attempt = 0, lastLogName = '', previewInFlight = false, previews = 0;
  for (;;) {
    if (Date.now() > deadline) die(`timeout ${o.timeout}s after start, still not mintable`);
    attempt++;
    let trigger = null;
    const sim = await simAll(addr);
    if (sim.ok) trigger = `eth_call OK (${new URL(sim.url).host} ${sim.tag})`;
    else if (sim.transport) { log('all RPC transport errors'); await L.sleep(o.interval); continue; }
    else {
      const d = await L.decodeRevert(sim.error, decodeIface);
      let c = L.classify(d.name, { waitRe: o.waitOn, fatalRe: o.fatalOn });
      if (c === 'unknown') c = (!startMs || Date.now() < startMs + o.grace * 1000) ? 'wait' : 'fatal';
      if (startMs && Date.now() < startMs && c === 'fatal' && !/sold|gone|already|taken|used|agent|eligible|expired|ended/i.test(d.name)) c = 'wait';
      const nm = `${d.name}${d.sel ? ' ' + d.sel : ''}`;
      if (nm !== lastLogName || attempt % 25 === 0) { log(`sim #${attempt} REVERT ${nm} [${c}] head #${lastHead.number} ts ${lastHead.ts}`); lastLogName = nm; }
      if (c === 'fatal') die(`terminal revert: ${nm}${d.args ? ' ' + d.args.join(',') : ''} — not sending`);
      if (o.once && (!startMs || Date.now() >= startMs + 3000)) die(`--once: revert ${nm}, not retrying`);
      if (o.eager && startMs && lastHead.ts >= startUnix && !previewInFlight && previews < 6) trigger = `eager (head ts ${lastHead.ts} >= start)`;
      if (!trigger) { await L.sleep(o.interval); continue; }
    }
    log(`TRIGGER ${trigger}`);
    if (o.dry && o.noPreview) { log(`DRY: would preview+execute now. calldata ${o.data} value ${valueWei}`); process.exit(0); }

    // ---- preview ----
    previewInFlight = true; previews++;
    const t0 = Date.now();
    const pr = await preview(addr);
    previewInFlight = false;
    save(`preview${previews}`, pr.stdout || pr.stderr);
    const ck = checkPreview(pr);
    log(`preview ${pr.ms}ms verdict ${ck.verdict}${ck.why ? ' ' + ck.why : ''}${ck.requestId ? ' requestId ' + ck.requestId + ' requireConfirmation ' + ck.requireConfirmation + ' gas ' + ck.gas + ' balChanges ' + L.safeJson(ck.balanceChanges) : ''}`);
    if (ck.caution && ck.caution.length) log('preview CAUTION (non-blocking):', L.safeJson(ck.caution));
    if (ck.verdict === 'wait' || (ck.verdict === 'unknown' && startMs && Date.now() < startMs + o.grace * 1000)) {
      if (o.once && previews >= 2) die('--once: preview not ready');
      if (previews >= 12) die('too many previews without success');
      await L.sleep(250); continue;
    }
    if (ck.verdict !== 'ok') die(ck.why || 'preview failed');

    // ---- execute exactly once ----
    if (o.dry) {
      log(`DRY: stop before execute. Would run: baw contract-call execute --requestId ${ck.requestId} --json  (preview→ready in ${Date.now() - t0}ms)`);
      process.exit(0);
    }
    if (fs.existsSync(lockFile)) die('lock appeared — another run executed this call');
    fs.writeFileSync(lockFile, L.safeJson({ t: L.wib(), to: o.to, data: o.data, value: valueWei, requestId: ck.requestId, state: 'executing' }));
    const ex = await L.baw(['contract-call', 'execute', '--requestId', ck.requestId], 90000);
    save('exec', ex.stdout || ex.stderr);
    const ed = ex.json && ex.json.data;
    fs.writeFileSync(lockFile, L.safeJson({ t: L.wib(), to: o.to, data: o.data, value: valueWei, requestId: ck.requestId, state: ed ? ed.status : 'exec_error', exec: ex.json || ex.stdout }));
    if (!ex.ok || !ed) {
      log(`EXECUTE ERROR (${ex.ms}ms) — NOT retrying. ${L.safeJson(ex.json || ex.stdout || ex.stderr).slice(0, 800)}`);
      log('Check `baw wallet tx-history --json` / `baw wallet tx-lock --json` before any manual retry.');
      process.exit(1);
    }
    log(`EXECUTE ${ed.status} (${ex.ms}ms, preview→execute ${Date.now() - t0}ms) orderId ${ed.orderId} txHash ${ed.txHash || '-'} ${ed.message || ''}`);
    if (ed.status === 'PENDING_CONFIRMATION' || !ed.txHash) { log('Needs approval in the Binance App (abnormal/large tx). Not resending.'); process.exit(0); }
    log(`BscScan ${L.SCAN}/tx/${ed.txHash}`);
    const rc = await receipt(ed.txHash);
    if (!rc) { log('receipt not found in 120s — check BscScan; NOT resending'); process.exit(0); }
    const st = parseInt(rc.status, 16);
    save('receipt', rc);
    log(`RECEIPT status ${st === 1 ? 'SUCCESS' : 'REVERTED'} block ${parseInt(rc.blockNumber, 16)} gasUsed ${parseInt(rc.gasUsed, 16)} logs ${rc.logs.length} | ${L.SCAN}/tx/${ed.txHash}`);
    process.exit(st === 1 ? 0 : 1);
  }
})().catch(e => { log('ERR ' + (e.stack || e.message)); process.exit(1); });
