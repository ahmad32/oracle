// fire.js — the FCFS sniper. Fires the mint exactly once, the instant it opens.
//   1. Builds + decode-verifies the calldata BEFORE the open (zero work at fire time).
//   2. Polls the open condition with eth_call every 120ms (configurable via poll_ms).
//   3. On open: rebuilds the calldata (fresh DEADLINE + fresh dynamic args),
//      re-verifies the decode, then baw preview -> execute back-to-back.
//   4. Waits for the receipt and optionally verifies the result on-chain.
// Usage:
//   node fire.js --config <config.json> [--allow-paid] [--dry-run]
//
// Safety rails (never bypassed):
//   - Free mints only unless value_wei is explicitly set AND --allow-paid is passed
//     AND the user ordered that exact paid amount.
//   - Calldata is always built programmatically and decoded back; if the decoded
//     fields do not match the config, the script refuses to fire.
//   - A baw preview runs first; fire only on a clean preview.
//   - A lock file prevents a second broadcast of the same mint.
//   - Never sends a transaction for a different function than the configured one.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { ethers } = require('ethers');
const lib = require('./lib');

function parseArgs(argv) {
  const out = { allowPaid: false, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--config') out.config = argv[++i];
    else if (argv[i] === '--allow-paid') out.allowPaid = true;
    else if (argv[i] === '--dry-run') out.dryRun = true;
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function baw(args, timeoutMs = 120000) {
  const { stdout } = await execFileAsync('baw', args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function openConditionMet(provider, cfg, abi) {
  const now = Math.floor(Date.now() / 1000);
  if (cfg.open_call) {
    try {
      const v = await lib.readView(provider, cfg.contract, abi, cfg.open_call.function, cfg.open_call.args || []);
      if (String(v) === String(cfg.open_call.expect)) return true;
    } catch (_) { /* fall through to open_at */ }
  }
  if (cfg.open_at && now >= cfg.open_at) return true;
  return false;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.config) {
    console.error('usage: node fire.js --config <config.json> [--allow-paid] [--dry-run]');
    process.exit(2);
  }
  const cfg = lib.loadConfig(opts.config);
  const abi = cfg.abi ? cfg.abi : JSON.parse(fs.readFileSync(cfg.abi_path, 'utf8'));
  const logPath = cfg.log_path;
  const log = (m) => lib.log(m, logPath);

  if (cfg.value_wei > 0 && !opts.allowPaid) {
    throw new Error(`value_wei=${cfg.value_wei} > 0 but --allow-paid not passed. Refusing a paid mint without an explicit order.`);
  }
  if (cfg.sender !== 'baw') {
    throw new Error(`sender '${cfg.sender}' not supported yet (only 'baw').`);
  }

  const provider = lib.makeProvider(cfg.rpcs);
  provider.rpcs = cfg.rpcs;
  log(`sniper armed: ${cfg.function} on ${cfg.contract} value=${cfg.value_wei} sender=baw rpc=${provider.currentRpc()}`);
  log(`open_at=${cfg.open_at || '-'} open_call=${JSON.stringify(cfg.open_call || null)} poll=${cfg.poll_ms}ms max_wait=${cfg.max_wait_s}s`);

  // Pre-build + decode + verify calldata BEFORE the open.
  const block = await provider.getBlock('latest');
  let preArgs = lib.resolveArgs(cfg.args, block.timestamp, cfg.deadline_seconds);
  preArgs = await lib.resolveDynamicArgs(provider, cfg.contract, abi, preArgs, cfg.dynamic_args, logPath);
  const pre = lib.buildCalldata(cfg.contract, abi, cfg.function, preArgs);
  lib.verifyDecoded(pre.decoded, preArgs);
  log(`calldata built (${pre.calldata.length} chars) selector=${pre.calldata.slice(0, 10)}`);
  log(`decoded args: ${JSON.stringify(Object.fromEntries(Object.keys(pre.decoded).filter((k) => /^\d+$/.test(k)).map((k) => [k, String(pre.decoded[k])])))}`);
  log('calldata decode verified against config.');
  if (opts.dryRun) {
    log('DRY RUN OK — no transaction sent.');
    console.log(`CALLDATA: ${pre.calldata}`);
    return;
  }

  // Lock file — refuse to run twice for the same config (prevents double broadcast).
  const lockPath = path.join(path.dirname(path.resolve(opts.config)), `.fire.${path.basename(opts.config)}.lock`);
  if (fs.existsSync(lockPath)) throw new Error(`lock file exists (${lockPath}) — this config already fired. Delete it only if you are sure no tx went out.`);
  fs.writeFileSync(lockPath, JSON.stringify({ started: new Date().toISOString(), config: opts.config }));

  // Poll the open condition every poll_ms until open or max_wait past the open.
  const deadlineMs = Date.now() + cfg.max_wait_s * 1000 + (cfg.open_at ? Math.max(0, cfg.open_at * 1000 - Date.now()) : 0);
  let opened = false;
  while (Date.now() < deadlineMs) {
    if (await openConditionMet(provider, cfg, abi)) { opened = true; break; }
    await sleep(cfg.poll_ms);
  }
  if (!opened) {
    fs.unlinkSync(lockPath);
    log('STOP: open condition never met within max_wait — no transaction sent.');
    return;
  }
  log('OPEN detected — firing.');

  // Rebuild at fire time (fresh DEADLINE + fresh dynamic args) and re-verify.
  const fireBlock = await provider.getBlock('latest');
  let fireArgs = lib.resolveArgs(cfg.args, fireBlock.timestamp, cfg.deadline_seconds);
  fireArgs = await lib.resolveDynamicArgs(provider, cfg.contract, abi, fireArgs, cfg.dynamic_args, logPath);
  const fire = lib.buildCalldata(cfg.contract, abi, cfg.function, fireArgs);
  lib.verifyDecoded(fire.decoded, fireArgs);
  log(`fire calldata selector=${fire.calldata.slice(0, 10)} deadline=${fireArgs.find((a) => typeof a === 'bigint' && a > 1700000000n && a < 2000000000n) || '(n/a)'}`);

  // baw preview -> execute, back-to-back. Clean preview only.
  let preview;
  try {
    preview = await baw([
      'contract-call', 'preview',
      '--binanceChainId', '56',
      '--from', cfg.wallet,
      '--to', cfg.contract,
      '--value', String(cfg.value_wei),
      '--inputData', fire.calldata,
      '--json',
    ]);
  } catch (e) {
    fs.unlinkSync(lockPath);
    throw new Error(`baw preview failed: ${await lib.decodeRevert(e)}`);
  }
  const requestId = preview.requestId || preview.request_id || preview.id;
  if (!requestId) {
    fs.unlinkSync(lockPath);
    throw new Error('baw preview returned no requestId — not executing.');
  }
  log(`preview clean (requestId ${requestId}) — executing.`);
  const exec = await baw(['contract-call', 'execute', '--requestId', requestId, '--json']);
  const txHash = exec.txHash || exec.transactionHash || exec.hash;
  if (!txHash) {
    fs.unlinkSync(lockPath);
    throw new Error(`baw execute returned no txHash: ${JSON.stringify(exec).slice(0, 300)}`);
  }
  log(`broadcast: ${txHash}`);

  // Wait for the receipt (this is the source of truth, not the preview).
  const receipt = await provider.waitForTransaction(txHash, 1, 180000);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`transaction failed or no receipt: ${txHash} status=${receipt ? receipt.status : 'none'}`);
  }
  log(`CONFIRMED: ${txHash} block=${receipt.blockNumber} status=1`);

  // Optional on-chain verify (e.g. balanceOf).
  if (cfg.verify) {
    try {
      const v = await lib.readView(provider, cfg.contract, abi, cfg.verify.function, (cfg.verify.args || []).map((a) => (typeof a === 'string' && /^-?\d+$/.test(a) ? BigInt(a) : a)));
      const want = cfg.verify.expect;
      const ok = want === undefined || String(v) === String(want);
      log(`verify ${cfg.verify.function}: ${v} (expected ${want}) -> ${ok ? 'OK' : 'MISMATCH'}`);
    } catch (e) {
      log(`verify read failed: ${await lib.decodeRevert(e)}`);
    }
  }
  log('DONE — mint fired once, receipt confirmed.');
}

main().catch((e) => { console.error('fire failed:', e.message || e); process.exit(1); });
