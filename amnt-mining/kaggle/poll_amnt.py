#!/usr/bin/env python3
"""Poll Kaggle kernel output for the AMNT Plan B proofs. Writes result to amnt_found.json.
Adapted from ~/workspace/pearl_kaggle/poll_output.py (same surrogate auth).
"""
import sys, json, urllib.request, urllib.error, time, re
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request

SLUG = json.load(open("/home/hatch/workspace/amnt_kaggle/kernel-metadata.json"))["id"]
KERNEL_ID = None  # filled from push_result.json when present
try:
    KERNEL_ID = str(json.load(open("/home/hatch/workspace/amnt_kaggle/push_result.json"))["body"] and json.loads(json.load(open("/home/hatch/workspace/amnt_kaggle/push_result.json"))["body"]).get("kernelId", ""))
except Exception:
    KERNEL_ID = None
OUT = "/home/hatch/workspace/amnt_kaggle/amnt_found.json"
MAX_WAIT = 1500  # 25 min
INTERVAL = 60

def kaggle_get(path):
    url = "https://www.kaggle.com/api/v1" + path
    req = urllib.request.Request(url, method="GET")
    add_surrogate_to_request(req, "custom.kaggle", allowed_hosts=["www.kaggle.com", "kaggle.com"])
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.status, resp.read().decode(errors="replace")

def try_output():
    paths = [f"/kernels/output/{SLUG}"]
    if KERNEL_ID:
        paths.append(f"/kernels/output/{KERNEL_ID}")
    for path in paths:
        try:
            st, body = kaggle_get(path)
            if st == 200:
                return body
        except urllib.error.HTTPError as e:
            if e.code == 404:
                continue
            raise
        except Exception:
            continue
    return None

start = time.time()
result = None
while time.time() - start < MAX_WAIT:
    try:
        body = try_output()
        if body:
            proofs = re.findall(r"AMNT_PROOF\s+(\d+)\s+([0-9a-f]{64})", body)
            print(f"[{time.strftime('%H:%M:%S')}] output available ({len(body)} chars), proofs so far: {len(proofs)}", flush=True)
            if len(proofs) >= 10:
                result = {"nonces": [int(p[0]) for p in proofs[:10]],
                          "digests": [p[1] for p in proofs[:10]],
                          "raw_tail": body[-2000:]}
                break
            if "=== DONE:" in body and "SHORT" in body:
                result = {"nonces": [int(p[0]) for p in proofs],
                          "digests": [p[1] for p in proofs],
                          "note": "SHORT - kernel finished with fewer than 10 proofs",
                          "raw_tail": body[-2000:]}
                break
            if "COMPILE FAILED" in body:
                result = {"nonces": [], "note": "COMPILE FAILED", "raw_tail": body[-2000:]}
                break
        else:
            print(f"[{time.strftime('%H:%M:%S')}] output not ready (404), waiting...", flush=True)
    except Exception as e:
        print(f"[{time.strftime('%H:%M:%S')}] poll error: {e}", flush=True)
    time.sleep(INTERVAL)

if result is None:
    result = {"nonces": [], "note": "timeout, no 10 proofs in 25 min"}
json.dump(result, open(OUT, "w"), indent=2)
print("RESULT WRITTEN:", json.dumps({k: v for k, v in result.items() if k != "raw_tail"}, indent=2), flush=True)
