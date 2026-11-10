# fastmint — FCFS mint toolkit for Binance Agentic Wallet (BSC)

A JS toolkit that snipes a free mint the instant it opens. Rebuilt from the
pattern in the `fastmint.zip` screenshot (recon / fire / lib) using the same
proven logic as `~/workspace/tools/sniper.py` (Python), which was dry-run
verified against the Broccoli free mint (selector `0xc4310955`, decoded args
match the config exactly).

## Files

- `lib.js` — shared helpers: RPC rotation, eth_call, revert decoding (incl.
  4byte lookup), Agent ID, calldata build + decode-verify, dynamic args.
- `recon.js` — read-only recon: builds + verifies the calldata, simulates it
  with eth_call, reads the open condition and supply state. Sends NO tx.
- `fire.js` — the sniper: pre-builds + verifies calldata, polls the open
  condition every 120ms, then baw preview -> execute back-to-back, waits for
  the receipt, optionally verifies the result on-chain.
- `config.broccoli.json` — reference config for the Broccoli free mint
  (SOLD OUT — kept as the template for the next FCFS mint).
- `package.json` / `node_modules` — ethers v6 (installed locally, no global deps).

## Setup

```bash
cd ~/workspace/fastmint
npm install   # ethers v6, local only
which baw     # must resolve (shim at ~/workspace/custom-skills/binance-agentic-wallet/scripts/baw)
```

## Usage

```bash
# 1. Recon (read-only, safe any time) — builds + verifies calldata, sims it,
#    reads the open condition and supply.
node recon.js --config config.broccoli.json

# 2. Dry run the sniper — builds + verifies calldata, sends NOTHING.
node fire.js --config config.broccoli.json --dry-run

# 3. Arm it — waits for the open condition, then fires once.
node fire.js --config config.broccoli.json
```

For a new mint, copy `config.broccoli.json`, edit contract / function / args /
open_at / open_call / value_wei / verify, then recon -> dry-run -> arm.

## Config fields

Same format as the Python sniper (`~/workspace/tools/sniper_config.*.json`):

| field | meaning |
|---|---|
| `contract` | mint contract address |
| `abi_path` | path to the contract ABI JSON (or inline `abi`) |
| `function` | function name, e.g. `mintFree` |
| `args` | function arguments. Big ints as decimal strings. Use `"DEADLINE"` for an arg that should be `block ts + 600` at fire time. |
| `value_wei` | value in wei (0 for a free mint). Refused unless `--allow-paid` is passed AND the paid amount was explicitly ordered. |
| `open_at` | unix timestamp when the mint opens |
| `open_call` | `{"function": "mintOpen", "args": [], "expect": true}` — poll a view function instead of / in addition to `open_at` |
| `dynamic_args` | `[{"arg_index": 2, "call": {"function": "previewMint", "args": [1]}, "pick": 0}]` — read an arg from a view function at fire time; falls back to the static value if the call reverts |
| `wallet` | sender address (default: main wallet) |
| `poll_ms` | poll interval in ms (default 120) |
| `max_wait_s` | give up this many seconds past the open (default 300) |
| `verify` | `{"function": "balanceOf", "args": [...], "expect": ...}` — read after the receipt to confirm the mint landed |
| `log_path` | where to append the run log |

## Safety rails (never bypassed)

- Free mints only unless `value_wei` is explicitly set AND `--allow-paid` is passed
  AND the user ordered that exact paid amount.
- Calldata is always built programmatically (ethers `encodeFunctionData`) and
  decoded back; if the decoded fields do not match the config, the script
  refuses to fire.
- A baw preview runs first; fire only on a clean preview.
- A lock file prevents a second broadcast of the same config.
- Never sends a transaction for a different function than the configured one.
- No private keys / seed phrases anywhere. Only public BSC RPCs, Sourcify and
  4byte are contacted, and only for reads / error decoding.

## Verified (11 Nov 2026, dry run vs Broccoli)

- `recon.js`: selector `0xc4310955`, decoded args match config, sim reverts
  (expected — sold out, custom error `0x589ed34b`), `mintOpen=false`,
  `totalMinted=11000`, `freeMinted=500`. Read-only, no tx.
- `fire.js --dry-run`: calldata built (330 chars), selector `0xc4310955`,
  decoded args match config, "DRY RUN OK — no transaction sent."
- The JS calldata matches the Python sniper's output exactly (same selector,
  same args; only the deadline differs because it is computed from the live
  block time).
