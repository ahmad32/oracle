#!/usr/bin/env python3
"""Prepare the AMNT Plan B Kaggle kernel for a new day (e.g. day 1).
Usage: python3 prep_day1.py --seedbase <hex64> --day 1 [--base 40000000000]
Regenerates ~/workspace/amnt_kaggle/main.py (CUDA solver + params) and
kernel-metadata.json (new slug amnt-pow-solve-plan-b-d<day>) from the durable
solver in ~/workspace/agentmining/amnt_cuda.cu.
After this, push with:  python3 push_amnt.py   (reads metadata + main.py)
Then poll with:        python3 poll_amnt.py    (reads slug from metadata)
No building at window time — just: read seed -> run this -> push -> poll.
"""
import argparse, base64, json, os

CU_PATH = "/home/hatch/workspace/agentmining/amnt_cuda.cu"
KAGGLE_DIR = "/home/hatch/workspace/amnt_kaggle"
WALLET = "25CF688b28CA2b2a64A546E218182B7F1F4580F5"
AGENTID = "684efae207533a4f3cc179249773d92f2e955ac315658b97604695b1d825955d"

MAIN_TEMPLATE = '''#!/usr/bin/env python3
"""Kaggle GPU PoW solver for AMNT (Agent Mining) Plan B / CPU lane, day __DAY__.
Preimage: keccak256(abi.encode(seedBase, wallet, agentId, lane, day, nonce));
need digest <= 2^228-1 (28 leading zero bits). Two-block Keccak: block 1
constant -> absorbed once on host; per-hash cost = ONE permutation.
The .cu source is embedded as base64 (script kernels only ship the code file).
CUDA core CPU-verified vs on-chain proofDigest (day 0 nonces 0,1).
Finds 10 proofs (2,500 AMNT each = 25,000 AMNT for one mineBatch of 10).
Ranges start at __BASE__ (local VM owns [0, 20B), box owns [20B, 40B)).
Each 2^30 range expects ~4 proofs; BENCH (empty) ranges are skipped.
"""
import subprocess, sys, time, base64, re

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
    if r.stdout:
        print(r.stdout, end="", flush=True)
    if r.stderr:
        print(r.stderr, end="", flush=True)
    return r

open("amnt_cuda.cu", "wb").write(base64.b64decode(CU_B64))
print("=== nvidia-smi ===", flush=True)
run(["nvidia-smi"])
print("=== nvcc ===", flush=True)
run(["nvcc", "--version"])
print("=== compile amnt_cuda.cu ===", flush=True)
r = run(["nvcc", "-O3", "-arch=sm_75", "-o", "amnt_cuda", "amnt_cuda.cu"])
if r.returncode != 0:
    print("COMPILE FAILED", flush=True)
    sys.exit(1)
print("COMPILE OK", flush=True)

found = []
cursor = BASE
attempts = 0
t0 = time.time()
while len(found) < N_PROOFS and attempts < MAX_RANGES:
    rs, re_ = cursor, cursor + CHUNK
    cursor += CHUNK
    attempts += 1
    print("=== proof %d/%d: range [%d, %d) ===" % (len(found)+1, N_PROOFS, rs, re_), flush=True)
    r = run(["./amnt_cuda", "--seedbase", SEEDBASE, "--wallet", WALLET,
             "--agentid", AGENTID, "--lane", LANE, "--day", DAY,
             "--bits", BITS, "--range-start", str(rs), "--range-end", str(re_)])
    m = re.search(r"FOUND\\s+(\\d+)\\s+([0-9a-f]{64})\\s+bits=(\\d+)", r.stdout or "")
    if m:
        nonce, digest, bits = int(m.group(1)), m.group(2), int(m.group(3))
        found.append((nonce, digest))
        print("AMNT_PROOF %d %s bits=%d" % (nonce, digest, bits), flush=True)
    else:
        print("range empty (BENCH), skipping", flush=True)
print("=== DONE: %d/%d proofs in %.1fs ===" % (len(found), N_PROOFS, time.time()-t0), flush=True)
for nonce, digest in found:
    print("AMNT_PROOF %d %s" % (nonce, digest), flush=True)
if len(found) < N_PROOFS:
    print("SHORT: only %d proofs" % len(found), flush=True)
'''

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seedbase", required=True, help="day seedBase, 64 hex chars")
    ap.add_argument("--day", required=True, type=int)
    ap.add_argument("--base", type=int, default=40000000000, help="Kaggle range start (default 40B)")
    args = ap.parse_args()
    seed = args.seedbase.lower().removeprefix("0x")
    assert len(seed) == 64 and all(c in "0123456789abcdef" for c in seed), "seedbase must be 64 hex chars"
    cu = open(CU_PATH, "rb").read()
    b64 = base64.b64encode(cu).decode()
    main_py = (MAIN_TEMPLATE
               .replace("__CU_B64__", b64)
               .replace("__SEEDBASE__", seed)
               .replace("__DAY__", str(args.day))
               .replace("__BASE__", str(args.base)))
    open(os.path.join(KAGGLE_DIR, "main.py"), "w").write(main_py)
    meta = {
        "code_file": "main.py",
        "competition_sources": [],
        "dataset_sources": [],
        "enable_gpu": True,
        "enable_internet": False,
        "id": f"ahmedriyadi/amnt-pow-solve-plan-b-d{args.day}",
        "is_private": True,
        "kernel_sources": [],
        "kernel_type": "script",
        "language": "python",
        "machine_shape": "NvidiaTeslaT4",
        "title": f"AMNT PoW Solve Plan B Day {args.day}",
    }
    open(os.path.join(KAGGLE_DIR, "kernel-metadata.json"), "w").write(json.dumps(meta, indent=2))
    print(f"day {args.day} kernel ready: slug={meta['id']} seed={seed[:16]}... base={args.base}")
    print("next: cd ~/workspace/amnt_kaggle && python3 push_amnt.py && nohup python3 poll_amnt.py > poll_amnt.log 2>&1 &")

if __name__ == "__main__":
    main()
