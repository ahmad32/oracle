#!/usr/bin/env python3
"""Build a ready-to-paste Google Colab cell for the AMNT Plan B PoW solver.
Usage: python3 build_colab_cell.py --seedbase <hex64> --day <n> [--base 60000000000] [--out colab_cell.py]
Mirrors the Pearl Colab pattern (~/workspace/pearl/colab_cell_r1.txt):
embed the .cu as base64, write it, nvcc-compile, loop 2^30 ranges and print
AMNT_PROOF lines. Ranges: local VM [0,20B), box [20B,40B), Kaggle [40B,60B),
Colab [60B, ...) — pick --base accordingly so lanes never overlap.
The user pastes the generated file into a Colab notebook (Runtime: T4 GPU)
and runs the single cell.
"""
import argparse, base64

CU_PATH = "/home/hatch/workspace/agentmining/amnt_cuda.cu"
WALLET = "25CF688b28CA2b2a64A546E218182B7F1F4580F5"
AGENTID = "684efae207533a4f3cc179249773d92f2e955ac315658b97604695b1d825955d"

CELL = '''# AMNT Plan B (CPU lane) PoW solver — Google Colab cell (T4 GPU).
# Paste this whole cell into a Colab notebook (Runtime type: GPU, T4) and run it.
# It compiles the CUDA solver and searches sequential 2^30 ranges for proofs.
# Each proof = 2500 AMNT. Prints AMNT_PROOF <nonce> <digest> for every hit.
# Day __DAY__ | seed __SEEDBASE__ | ranges start at __BASE__ (Colab lane).
import subprocess, base64, os, time, re
CU_B64 = "__CU_B64__"
SEEDBASE = "__SEEDBASE__"
WALLET = "25CF688b28CA2b2a64A546E218182B7F1F4580F5"
AGENTID = "684efae207533a4f3cc179249773d92f2e955ac315658b97604695b1d825955d"
LANE = "2"
DAY = "__DAY__"
BITS = "28"
N_PROOFS = 10
BASE = __BASE__
CHUNK = 1 << 30
MAX_RANGES = 40

def run(cmd):
    print("$ " + " ".join(cmd), flush=True)
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.stdout: print(r.stdout, end="", flush=True)
    if r.stderr: print(r.stderr, end="", flush=True)
    return r

os.makedirs("/content/amnt", exist_ok=True)
open("/content/amnt/amnt_cuda.cu", "wb").write(base64.b64decode(CU_B64))
print("=== nvidia-smi ===", flush=True)
run(["nvidia-smi"])
print("=== compile ===", flush=True)
r = run(["nvcc", "-O3", "-arch=sm_75", "-o", "/content/amnt/amnt_cuda", "/content/amnt/amnt_cuda.cu"])
print("compile rc:", r.returncode, flush=True)
if r.returncode != 0:
    print("COMPILE FAILED", flush=True)
else:
    print("COMPILE OK — mining day %s, seed %s..." % (DAY, SEEDBASE[:16]), flush=True)
    found = []
    cursor = BASE
    t0 = time.time()
    log = open("/content/amnt/amnt.log", "w")
    log.write(f"started {time.strftime('%H:%M:%S')} day={DAY} seed={SEEDBASE} base={BASE}\\n"); log.flush()
    attempts = 0
    while len(found) < N_PROOFS and attempts < MAX_RANGES:
        rs, re_ = cursor, cursor + CHUNK
        cursor += CHUNK
        attempts += 1
        print("=== proof %d/%d: range [%d, %d) ===" % (len(found)+1, N_PROOFS, rs, re_), flush=True)
        r = run(["/content/amnt/amnt_cuda", "--seedbase", SEEDBASE, "--wallet", WALLET,
                 "--agentid", AGENTID, "--lane", LANE, "--day", DAY,
                 "--bits", BITS, "--range-start", str(rs), "--range-end", str(re_)])
        m = re.search(r"FOUND\\s+(\\d+)\\s+([0-9a-f]{64})\\s+bits=(\\d+)", r.stdout or "")
        if m:
            nonce, digest, bits = int(m.group(1)), m.group(2), int(m.group(3))
            found.append((nonce, digest))
            line = "AMNT_PROOF %d %s bits=%d" % (nonce, digest, bits)
            print(line, flush=True)
            log.write(line + "\\n"); log.flush()
        else:
            print("range empty (BENCH), skipping", flush=True)
    print("=== DONE: %d/%d proofs in %.1fs ===" % (len(found), N_PROOFS, time.time()-t0), flush=True)
    for nonce, digest in found:
        print("AMNT_PROOF %d %s" % (nonce, digest), flush=True)
    log.write(f"done {len(found)}/{N_PROOFS} proofs in {time.time()-t0:.1f}s\\n"); log.close()
    print("log: /content/amnt/amnt.log", flush=True)
'''

CELL_AUTOSEED = '''# AMNT Plan B (CPU lane) PoW solver — Google Colab cell (T4 GPU), AUTO-SEED mode.
# Paste this whole cell into a Colab notebook (Runtime type: GPU, T4) and run it.
# It compiles the CUDA solver FIRST, then polls the AMNT contract for the day-__DAY__
# seed (sessionSeedBase) every 15s until it is pinned, then mines immediately.
# Launch it BEFORE the window (e.g. 20:50 WITA) — it waits for the seed itself.
# Each proof = 2500 AMNT. Prints AMNT_PROOF <nonce> <digest> for every hit.
# Day __DAY__ | ranges start at __BASE__ (Colab lane).
import subprocess, base64, os, time, re, json, urllib.request, urllib.error
CU_B64 = "__CU_B64__"
WALLET = "25CF688b28CA2b2a64A546E218182B7F1F4580F5"
AGENTID = "684efae207533a4f3cc179249773d92f2e955ac315658b97604695b1d825955d"
LANE = "2"
DAY = "__DAY__"
BITS = "28"
N_PROOFS = 10
BASE = __BASE__
CHUNK = 1 << 30
MAX_RANGES = 40
CONTRACT = "0x2d07B9CcDF5FCdbE26167358B94eeb4c9E995e4E"
SEED_SEL = "7666e2ae"  # sessionSeedBase(uint256)
RPCS = ["https://bsc-dataseed1.defibit.io", "https://bsc-dataseed.binance.org",
        "https://binance.llamarpc.com", "https://bsc-rpc.publicnode.com"]
ZERO_SEED = "00" * 32

def run(cmd):
    print("$ " + " ".join(cmd), flush=True)
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.stdout: print(r.stdout, end="", flush=True)
    if r.stderr: print(r.stderr, end="", flush=True)
    return r

def read_seed(day, timeout_s=1800):
    """Poll sessionSeedBase(day) until non-zero. Returns the 64-hex seed or None."""
    data = "0x" + SEED_SEL + format(int(day), "064x")
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        for rpc in RPCS:
            try:
                body = json.dumps({"jsonrpc": "2.0", "method": "eth_call",
                    "params": [{"to": CONTRACT, "data": data}, "latest"], "id": 1}).encode()
                req = urllib.request.Request(rpc, data=body,
                    headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=15) as resp:
                    res = json.load(resp)
                seed = (res.get("result") or "")[2:]
                if seed and seed != ZERO_SEED and len(seed) == 64:
                    return seed
                break
            except Exception as e:
                print(f"seed poll via {rpc} failed: {str(e)[:80]}", flush=True)
                continue
        print(f"seed still 0 (day {day}), waiting 15s... elapsed {time.time()-t0:.0f}s", flush=True)
        time.sleep(15)
    return None

os.makedirs("/content/amnt", exist_ok=True)
open("/content/amnt/amnt_cuda.cu", "wb").write(base64.b64decode(CU_B64))
print("=== nvidia-smi ===", flush=True)
run(["nvidia-smi"])
print("=== compile (while waiting for the seed) ===", flush=True)
r = run(["nvcc", "-O3", "-arch=sm_75", "-o", "/content/amnt/amnt_cuda", "/content/amnt/amnt_cuda.cu"])
print("compile rc:", r.returncode, flush=True)
if r.returncode != 0:
    print("COMPILE FAILED", flush=True)
else:
    print("COMPILE OK — waiting for day %s seed..." % DAY, flush=True)
    SEEDBASE = read_seed(DAY)
    if not SEEDBASE:
        print("SEED NEVER PINNED (timeout) — nothing mined.", flush=True)
    else:
        print("SEED FOUND: %s — mining day %s..." % (SEEDBASE, DAY), flush=True)
        found = []
        cursor = BASE
        t0 = time.time()
        log = open("/content/amnt/amnt.log", "w")
        log.write(f"started {time.strftime('%H:%M:%S')} day={DAY} seed={SEEDBASE} base={BASE}\\n"); log.flush()
        attempts = 0
        while len(found) < N_PROOFS and attempts < MAX_RANGES:
            rs, re_ = cursor, cursor + CHUNK
            cursor += CHUNK
            attempts += 1
            print("=== proof %d/%d: range [%d, %d) ===" % (len(found)+1, N_PROOFS, rs, re_), flush=True)
            r = run(["/content/amnt/amnt_cuda", "--seedbase", SEEDBASE, "--wallet", WALLET,
                     "--agentid", AGENTID, "--lane", LANE, "--day", DAY,
                     "--bits", BITS, "--range-start", str(rs), "--range-end", str(re_)])
            m = re.search(r"FOUND\\s+(\\d+)\\s+([0-9a-f]{64})\\s+bits=(\\d+)", r.stdout or "")
            if m:
                nonce, digest, bits = int(m.group(1)), m.group(2), int(m.group(3))
                found.append((nonce, digest))
                line = "AMNT_PROOF %d %s bits=%d" % (nonce, digest, bits)
                print(line, flush=True)
                log.write(line + "\\n"); log.flush()
            else:
                print("range empty (BENCH), skipping", flush=True)
        print("=== DONE: %d/%d proofs in %.1fs ===" % (len(found), N_PROOFS, time.time()-t0), flush=True)
        for nonce, digest in found:
            print("AMNT_PROOF %d %s" % (nonce, digest), flush=True)
        log.write(f"done {len(found)}/{N_PROOFS} proofs in {time.time()-t0:.1f}s\\n"); log.close()
        print("log: /content/amnt/amnt.log", flush=True)
'''

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seedbase", required=False, default=None)
    ap.add_argument("--day", required=True, type=int)
    ap.add_argument("--base", type=int, default=60000000000)
    ap.add_argument("--auto-seed", action="store_true",
                    help="cell polls sessionSeedBase(day) itself instead of a hardcoded seed")
    ap.add_argument("--out", default="colab_cell.py")
    args = ap.parse_args()
    if not args.auto_seed:
        if not args.seedbase:
            ap.error("--seedbase is required unless --auto-seed is set")
        seed = args.seedbase.lower().removeprefix("0x")
        assert len(seed) == 64 and all(c in "0123456789abcdef" for c in seed)
        cu = open(CU_PATH, "rb").read()
        cell = (CELL.replace("__CU_B64__", base64.b64encode(cu).decode())
                    .replace("__SEEDBASE__", seed)
                    .replace("__DAY__", str(args.day))
                    .replace("__BASE__", str(args.base)))
    else:
        cu = open(CU_PATH, "rb").read()
        cell = (CELL_AUTOSEED.replace("__CU_B64__", base64.b64encode(cu).decode())
                    .replace("__DAY__", str(args.day))
                    .replace("__BASE__", str(args.base)))
    open(args.out, "w").write(cell)
    print(f"wrote {args.out} ({len(cell)} bytes) day={args.day} auto_seed={args.auto_seed} base={args.base}")

if __name__ == "__main__":
    main()
