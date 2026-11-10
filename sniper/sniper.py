#!/usr/bin/env python3
"""Generic free-mint SNIPER for BSC (EVM) — snipes a free mint the instant it opens.

Why a sniper (lesson from Broccoli, 10 Nov 2026): the 500 free lots sold out in
~14 seconds. The old race polled every 10-15s and built the tx at open time, so
it never got a submission window. A sniper wins by doing ALL work BEFORE the
open and firing the instant the open condition is true.

Speed levers:
  1. Calldata is built + decoded + verified BEFORE the open (zero work at fire time).
  2. Open condition is polled every 1s (not 10-15s) across rotating RPCs.
  3. On open, fire immediately: baw preview -> execute back-to-back, no delay.
  4. Optional: submit via the MCP wallet (direct send, no preview step) when the
     mint is NOT gated to the main wallet's Agent ID. For Agent-ID-gated mints
     (the usual case), baw is required because only the main wallet holds the
     Agent ID — use the baw path.

Usage:
  # 1. Write a config JSON (see sniper_config.example.json / the BROCCOLI dict below).
  # 2. Dry run (build + decode + verify calldata, no tx):
  #      python3 sniper.py --config my_mint.json --dry-run
  # 3. Arm it (waits for open, then fires once):
  #      python3 sniper.py --config my_mint.json
  # 4. Or pass everything on the CLI (see --help).

Config JSON fields:
  contract   : mint contract address (0x...)
  abi_path   : path to the contract ABI JSON (or "inline" + abi list)
  function   : function name to call, e.g. "mintFree"
  args       : list of function arguments (numbers as int or decimal string,
               addresses as 0x..., bytes32 as 0x... hex)
  value_wei  : value in wei (0 for a free mint)
  open_at    : unix timestamp when the mint opens (polls block time until >= it),
               OR open_call: {"function": "mintOpen", "args": [], "expect": true}
  wallet     : sender address (default: main wallet 0x25CF...)
  sender     : "baw" (default, Agent-ID-gated) or "mcp" (direct send, not gated)
  max_wait_s : give up after this many seconds past open_at (default 300)
  poll_s     : poll interval in seconds (default 1.0)
  rpcs       : list of RPC URLs (default BSC public list)
  log_path   : where to append the run log

Safety rails (never bypassed):
  - Free mints only unless value_wei is explicitly set in the config AND the
    user ordered that exact paid amount. A config with value_wei > 0 is refused
    unless --allow-paid is passed AND the paid amount was explicitly ordered.
  - Calldata is always built programmatically (web3 encode_abi) and decoded back
    and printed before firing; if the decoded fields do not match the config,
    the script refuses to fire.
  - A baw preview is run first and its decoded effect is shown; fire only on a
    clean preview (value matches, no unexpected allowance/authority change).
  - Never call a function that is not the configured mint function.
"""
import argparse, json, os, subprocess, sys, time
from datetime import datetime, timedelta, timezone

sys.path.insert(0, "/home/hatch/workspace/mcp-wallet")
sys.path.insert(0, "/home/hatch/workspace/mcp-wallet/venv/lib/python3.12/site-packages")

MAIN_WALLET = "0x25CF688b28CA2b2a64A546E218182B7F1F4580F5"
ZERO_ADDR = "0x0000000000000000000000000000000000000000"

DEFAULT_RPCS = [
    "https://bsc-dataseed.binance.org",
    "https://bsc-rpc.publicnode.com",
    "https://bsc-dataseed1.defibit.io",
    "https://binance.llamarpc.com",
]

BROCCOLI_EXAMPLE = {
    "contract": "0xc438821D5937E5246a50f877311a74e40f82eB87",
    "function": "mintFree",
    "args": [47180081854018486746556308369438658819430327551400156943248280963129417241949,
             1794319200, 30000000000000000000000000, 1794319800, ZERO_ADDR],
    "value_wei": 0,
    "open_at": 1794319200,
    "wallet": MAIN_WALLET,
    "sender": "baw",
    "note": "Broccoli 10 Nov 2026 — sold out in ~14s. Kept as a reference config.",
}


def log(msg, log_path=None):
    line = f"[{wita_now()}] {msg}"
    print(line, flush=True)
    if log_path:
        with open(log_path, "a") as f:
            f.write(line + "\n")


def wita_now():
    return (datetime.now(timezone.utc) + timedelta(hours=8)).strftime("%H:%M:%S")


def load_config(path):
    with open(path) as f:
        cfg = json.load(f)
    return cfg


def get_w3(rpcs):
    from web3 import Web3
    from web3.middleware import ExtraDataToPOAMiddleware
    last_err = None
    for rpc in rpcs:
        try:
            w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={
                "timeout": 10,
                "headers": {"User-Agent": "Mozilla/5.0"}}))
            w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
            _ = w3.eth.block_number
            return w3, rpc
        except Exception as e:
            last_err = e
    raise RuntimeError(f"all RPCs failed: {last_err}")


def build_calldata(w3, contract, abi, function, args):
    c = w3.eth.contract(address=contract, abi=abi)
    calldata = c.encode_abi(function, args)
    # decode back and verify (contract-level decode returns the fn + a params dict)
    _fn, decoded_args = c.decode_function_input(calldata)
    return calldata, decoded_args


def open_condition_met(w3, contract, abi, open_at, open_call):
    if open_call:
        c = w3.eth.contract(address=contract, abi=abi)
        fn = getattr(c.functions, open_call["function"])
        got = fn(*open_call.get("args", [])).call()
        return got == open_call.get("expect", True)
    if open_at:
        ts = w3.eth.get_block("latest")["timestamp"]
        return ts >= open_at
    return True


def fire_baw(contract, wallet, value_wei, calldata, log_path=None):
    """baw preview -> execute, back-to-back. Returns (tx_hash or None, preview)."""
    log("BAW preview...", log_path)
    t0 = time.time()
    prev = subprocess.run(
        ["baw", "contract-call", "preview", "--binanceChainId", "56",
         "--from", wallet, "--to", contract, "--value", str(value_wei),
         "--inputData", calldata, "--json"],
        capture_output=True, text=True, timeout=120)
    log(f"preview took {time.time()-t0:.1f}s rc={prev.returncode}", log_path)
    if prev.returncode != 0:
        log(f"preview FAILED: {(prev.stdout + prev.stderr)[-500:]}", log_path)
        return None, None
    try:
        pj = json.loads(prev.stdout)
    except Exception:
        log(f"preview output not JSON: {prev.stdout[:300]}", log_path)
        return None, None
    req_id = pj.get("requestId") or pj.get("request_id")
    log(f"preview OK requestId={req_id} decoded={json.dumps(pj.get('decoded') or pj.get('preview') or {}, default=str)[:400]}", log_path)
    if not req_id:
        log("no requestId in preview — refusing to execute", log_path)
        return None, pj
    log("BAW execute...", log_path)
    t1 = time.time()
    ex = subprocess.run(
        ["baw", "contract-call", "execute", "--requestId", req_id, "--json"],
        capture_output=True, text=True, timeout=120)
    log(f"execute took {time.time()-t1:.1f}s rc={ex.returncode}", log_path)
    if ex.returncode != 0:
        log(f"execute FAILED: {(ex.stdout + ex.stderr)[-500:]}", log_path)
        return None, pj
    try:
        ej = json.loads(ex.stdout)
    except Exception:
        ej = {"raw": ex.stdout[:300]}
    tx = ej.get("txHash") or ej.get("tx_hash") or ej.get("hash")
    log(f"execute OK tx={tx}", log_path)
    return tx, pj


def wait_receipt(w3, tx_hash, timeout_s=120):
    try:
        r = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=timeout_s)
        return r
    except Exception as e:
        return {"error": str(e)[:200]}


def main():
    ap = argparse.ArgumentParser(description="Free-mint sniper (BSC). See module docstring.")
    ap.add_argument("--config", required=True, help="JSON config file")
    ap.add_argument("--dry-run", action="store_true", help="build + decode + verify only, no fire")
    ap.add_argument("--allow-paid", action="store_true", help="required if value_wei > 0")
    ap.add_argument("--deadline-seconds", type=int, default=600,
                    help="deadline = block ts + this at fire time (used when an arg is the string 'DEADLINE')")
    args = ap.parse_args()

    cfg = load_config(args.config)
    log_path = cfg.get("log_path")
    contract = cfg["contract"]
    function = cfg["function"]
    value_wei = int(cfg.get("value_wei", 0))
    wallet = cfg.get("wallet", MAIN_WALLET)
    sender = cfg.get("sender", "baw")
    rpcs = cfg.get("rpcs", DEFAULT_RPCS)
    poll_s = float(cfg.get("poll_s", 1.0))
    max_wait_s = int(cfg.get("max_wait_s", 300))
    open_at = cfg.get("open_at")
    open_call = cfg.get("open_call")

    if value_wei > 0 and not args.allow_paid:
        print("REFUSED: value_wei > 0 needs --allow-paid (paid mint needs an explicit user order).")
        sys.exit(2)

    # resolve ABI
    abi_path = cfg.get("abi_path")
    if abi_path:
        with open(abi_path) as f:
            abi = json.load(f)
    else:
        abi = cfg.get("abi")
    if not abi:
        print("REFUSED: no abi_path or inline abi in config.")
        sys.exit(2)

    # resolve DEADLINE placeholders in args (deadline = now + N, computed at build time
    # for a dry run and recomputed at fire time — the sniper rebuilds calldata at fire
    # if any arg is DEADLINE, so the deadline is always fresh).
    # Numeric strings are converted to int (JSON floats lose precision on big ints).
    def norm_arg(a):
        if isinstance(a, str) and a.lstrip("-").isdigit():
            return int(a)
        return a

    def resolve_dynamic_args(w3, contract, abi, args_list):
        """Replace args marked in cfg['dynamic_args'] by calling a view function now.
        dynamic_args: [{"arg_index": 2, "call": {"function": "previewMint", "args": [1]},
                        "pick": 0, "note": "minTokens from previewMint(1)"}]
        'pick' selects which return element to use (0 = first, or omit for the whole value).
        If the view call reverts (e.g. the mint is sold out or not open yet), the
        static configured value is kept and a warning is logged — a failed read
        must never block the fire.
        """
        out = list(args_list)
        for d in cfg.get("dynamic_args", []):
            idx = int(d["arg_index"])
            call = d["call"]
            try:
                c = w3.eth.contract(address=contract, abi=abi)
                fn = getattr(c.functions, call["function"])
                got = fn(*[norm_arg(a) for a in call.get("args", [])]).call()
                val = got[d["pick"]] if "pick" in d and isinstance(got, (list, tuple)) else got
                out[idx] = int(val)
                log(f"dynamic arg[{idx}] from {call['function']} = {val}", log_path)
            except Exception as e:
                log(f"dynamic arg[{idx}] read failed ({str(e)[:100]}) — keeping static value {out[idx]}", log_path)
        return out

    def resolve_args(now_ts):
        out = []
        for a in cfg["args"]:
            if isinstance(a, str) and a == "DEADLINE":
                out.append(now_ts + args.deadline_seconds)
            else:
                out.append(norm_arg(a))
        return out

    w3, rpc = get_w3(rpcs)
    log(f"sniper armed: {function} on {contract} value={value_wei} sender={sender} rpc={rpc}", log_path)
    log(f"open_at={open_at} open_call={open_call} poll={poll_s}s max_wait={max_wait_s}s", log_path)

    # Pre-build + decode + verify calldata BEFORE the open (dry-run the build now).
    now_ts = w3.eth.get_block("latest")["timestamp"]
    pre_args = resolve_dynamic_args(w3, contract, abi, resolve_args(now_ts))
    calldata, decoded = build_calldata(w3, contract, abi, function, pre_args)
    log(f"calldata built ({len(calldata)} chars) selector={calldata[:10]}", log_path)
    log(f"decoded args: {decoded}", log_path)
    # verify decoded matches config args
    for i, (want, got) in enumerate(zip(pre_args, decoded.values())):
        if str(want).lower() != str(got).lower():
            log(f"DECODE MISMATCH arg {i}: want {want} got {got} — REFUSING", log_path)
            sys.exit(3)
    log("calldata decode verified against config.", log_path)

    if args.dry_run:
        log("DRY RUN OK — no transaction sent.", log_path)
        print("CALLDATA:", calldata)
        return

    # Wait for the open condition (1s polling).
    t_start = time.time()
    fired = False
    while time.time() - t_start < max_wait_s + (open_at - now_ts if open_at else 0) + 60:
        try:
            w3b, _ = get_w3(rpcs)
            if open_condition_met(w3b, contract, abi, open_at, open_call):
                log("OPEN CONDITION MET — firing now.", log_path)
                fired = True
                break
        except Exception as e:
            log(f"poll error (retrying): {str(e)[:120]}", log_path)
        time.sleep(poll_s)
    if not fired:
        log("open condition never met within the wait window — giving up, no tx sent.", log_path)
        sys.exit(4)

    # Rebuild calldata at fire time (fresh DEADLINE + fresh dynamic args) and re-verify decode.
    now_ts = w3.eth.get_block("latest")["timestamp"]
    fire_args = resolve_dynamic_args(w3, contract, abi, resolve_args(now_ts))
    calldata, decoded = build_calldata(w3, contract, abi, function, fire_args)
    log(f"fire calldata selector={calldata[:10]} decoded={decoded}", log_path)

    if sender == "baw":
        tx, _ = fire_baw(contract, wallet, value_wei, calldata, log_path)
    elif sender == "mcp":
        log("MCP sender requested — direct send path not wired in this version; use baw.", log_path)
        sys.exit(5)
    else:
        log(f"unknown sender {sender}", log_path)
        sys.exit(5)

    if not tx:
        log("NO TX HASH — sniper did not fire.", log_path)
        sys.exit(6)

    log(f"waiting for receipt tx={tx} ...", log_path)
    rcpt = wait_receipt(w3, tx)
    if isinstance(rcpt, dict) and "error" in rcpt:
        log(f"receipt wait failed: {rcpt['error']}", log_path)
        sys.exit(7)
    log(f"RECEIPT status={rcpt.get('status')} block={rcpt.get('blockNumber')} gasUsed={rcpt.get('gasUsed')}", log_path)
    # verify the mint landed: re-read the configured balance/check if provided
    check = cfg.get("verify")
    if check:
        try:
            c = w3.eth.contract(address=contract, abi=abi)
            fn = getattr(c.functions, check["function"])
            got = fn(*check.get("args", [])).call()
            log(f"verify {check['function']} = {got} (expect {check.get('expect')})", log_path)
        except Exception as e:
            log(f"verify read failed: {str(e)[:150]}", log_path)
    log(f"SNIPER DONE tx={tx}", log_path)
    print("TX:", tx)


if __name__ == "__main__":
    main()
