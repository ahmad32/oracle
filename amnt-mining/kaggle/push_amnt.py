#!/usr/bin/env python3
"""Push the AMNT Plan B Kaggle kernel via the Kaggle API (JSON POST to
/api/v1/kernels/push), authenticated with the custom.kaggle vault surrogate
as a Bearer header (verified: GET /kernels/list returns 200 with it).
Replicates what kaggle 2.2.5's save_kernel does (camelCase JSON body).
Usage: python3 push_amnt.py  -> prints response, writes push_result.json
"""
import sys, json, urllib.request, urllib.error
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request

DIR = "/home/hatch/workspace/amnt_kaggle"
OUT = DIR + "/push_result.json"

meta = json.load(open(DIR + "/kernel-metadata.json"))
text = open(DIR + "/main.py", encoding="utf-8").read()

body = {
    "slug": meta["id"],
    "newTitle": meta["title"],
    "text": text,
    "language": meta["language"],
    "kernelType": meta["kernel_type"],
    "isPrivate": meta["is_private"],
    "enableGpu": meta["enable_gpu"],
    "enableInternet": meta["enable_internet"],
    "datasetDataSources": meta.get("dataset_sources", []),
    "competitionDataSources": meta.get("competition_sources", []),
    "kernelDataSources": meta.get("kernel_sources", []),
    "modelDataSources": [],
    "categoryIds": [],
    "machineShape": meta.get("machine_shape"),
    "sessionTimeoutSeconds": 1800,
}

data = json.dumps(body).encode("utf-8")
req = urllib.request.Request(
    "https://www.kaggle.com/api/v1/kernels/push",
    data=data, method="POST",
    headers={"Content-Type": "application/json"},
)
add_surrogate_to_request(req, "custom.kaggle", allowed_hosts=["www.kaggle.com", "kaggle.com"])
try:
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read().decode(errors="replace")
        print("STATUS", resp.status)
        print(raw[:2000])
        json.dump({"status": resp.status, "body": raw}, open(OUT, "w"), indent=2)
except urllib.error.HTTPError as e:
    raw = e.read().decode(errors="replace")
    print("HTTPError", e.code)
    print(raw[:2000])
    json.dump({"status": e.code, "body": raw}, open(OUT, "w"), indent=2)
    sys.exit(1)
except Exception as e:
    print("ERR", type(e).__name__, e)
    sys.exit(2)
