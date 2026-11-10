// recon.js — read-only recon for an FCFS mint.
// Given a sniper config JSON (same format as ~/workspace/tools/sniper_config.*.json):
//   1. loads the contract ABI,
//   2. builds the mint calldata and decodes it back, verifying every field,
//   3. simulates the call with eth_call (read-only, sends NO transaction),
//   4. reads the open condition and the current supply / cap state.
// Usage:
//   node recon.js --config <config.json>
//   node recon.js --config <config.json> --json   (machine-readable output)
//
// This is the read-only half of the fastmint toolkit. It never signs, never
// previews via baw, and never broadcasts. Safe to run any time before a mint.

const fs = require('fs');
const { ethers } = require('ethers');
const lib = require('./lib');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--config') out.config = argv[++i];
    else if (argv[i] === '--json') out.json = true;
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.config) {
    console.error('usage: node recon.js --config <config.json> [--json]');
    process.exit(2);
  }
  const cfg = lib.loadConfig(opts.config);
  const abi = cfg.abi ? cfg.abi : JSON.parse(fs.readFileSync(cfg.abi_path, 'utf8'));
  const provider = lib.makeProvider(cfg.rpcs);
  provider.rpcs = cfg.rpcs;
  const report = { contract: cfg.contract, function: cfg.function, wallet: cfg.wallet, value_wei: String(cfg.value_wei) };

  // 1. Build + decode-verify the calldata.
  const block = await provider.getBlock('latest');
  let args = lib.resolveArgs(cfg.args, block.timestamp, cfg.deadline_seconds);
  args = await lib.resolveDynamicArgs(provider, cfg.contract, abi, args, cfg.dynamic_args, cfg.log_path);
  const { calldata, decoded } = lib.buildCalldata(cfg.contract, abi, cfg.function, args);
  lib.verifyDecoded(decoded, args);
  report.selector = calldata.slice(0, 10);
  report.calldata = calldata;
  report.decoded = Object.fromEntries(
    Object.keys(decoded).filter((k) => /^\d+$/.test(k)).map((k) => [k, String(decoded[k])])
  );

  // 2. Simulate (eth_call, read-only). A revert here means the mint would fail
  //    right now — expected BEFORE the open; a clean sim at/after open is the
  //    green light. We report the result, we do not treat pre-open revert as fatal.
  try {
    const sim = await provider.call({ from: cfg.wallet, to: cfg.contract, data: calldata, value: cfg.value_wei });
    report.simulation = { ok: true, returnData: sim };
  } catch (e) {
    report.simulation = { ok: false, error: await lib.decodeRevert(e) };
  }

  // 3. Open condition + supply state (best effort, per config).
  report.open = {};
  if (cfg.open_at) report.open.open_at = cfg.open_at;
  if (cfg.open_call) {
    try {
      const v = await lib.readView(provider, cfg.contract, abi, cfg.open_call.function, cfg.open_call.args || []);
      report.open[cfg.open_call.function] = String(v);
    } catch (e) {
      report.open[cfg.open_call.function] = `read failed: ${await lib.decodeRevert(e)}`;
    }
  }
  for (const fn of ['totalMinted', 'freeMinted', 'totalSupply', 'minted', 'claimed']) {
    try {
      const c = new ethers.Contract(cfg.contract, abi, provider);
      if (typeof c[fn] === 'function') {
        const v = await c[fn]();
        report[fn] = String(v);
      }
    } catch (_) { /* function may not exist on this contract */ }
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`recon: ${cfg.function} on ${cfg.contract}`);
    console.log(`  selector: ${report.selector}`);
    console.log(`  decoded: ${JSON.stringify(report.decoded)}`);
    console.log(`  calldata: ${calldata}`);
    console.log(`  simulation: ${report.simulation.ok ? 'OK (clean)' : 'reverts — ' + report.simulation.error}`);
    console.log(`  open: ${JSON.stringify(report.open)}`);
    for (const k of ['totalMinted', 'freeMinted', 'totalSupply', 'minted', 'claimed']) {
      if (report[k] !== undefined) console.log(`  ${k}: ${report[k]}`);
    }
    console.log('recon done — read-only, no transaction sent.');
  }
}

main().catch((e) => { console.error('recon failed:', e.message || e); process.exit(1); });
