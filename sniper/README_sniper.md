# Sniper — free-mint sniper for FCFS mints on BSC

Snipes a free mint the instant it opens. Built after the Broccoli Agent free mint
(10 Nov 2026) sold out its 500 free lots in ~14 seconds — the old race polled
every 10-15s and built the tx at open time, so it never got a submission window.

## How it wins

1. **Calldata is built + decoded + verified BEFORE the open** — zero work at fire time.
2. **Open condition is polled every 1s** (not 10-15s) across rotating RPCs.
3. **On open, fire immediately**: baw preview → execute back-to-back, no delay.
4. **Dynamic args**: a parameter like `minTokens` can be read from a view function
   (e.g. `previewMint(1)`) at fire time, with a static fallback if that call reverts.

## Files

- `sniper.py` — the sniper. Config-driven, see its module docstring for the full spec.
- `broccoli_abi.json` — minimal ABI for the Broccoli contract (mintFree, mintOpen,
  totalMinted, freeMinted, balanceOf, previewMint).
- `sniper_config.broccoli.json` — reference config for the Broccoli free mint
  (SOLD OUT — kept as the template for the next FCFS mint).

## Usage

```bash
# 1. Copy the Broccoli config and edit it for the new mint:
#    contract, function, args, open_at / open_call, value_wei, verify.
cp sniper_config.broccoli.json sniper_config.<new-mint>.json

# 2. Dry run — builds the calldata, decodes it back, verifies every field.
#    Sends NOTHING.
python3 sniper.py --config sniper_config.<new-mint>.json --dry-run

# 3. Arm it — waits for the open condition, then fires once.
python3 sniper.py --config sniper_config.<new-mint>.json
```

## Config fields

| field | meaning |
|---|---|
| `contract` | mint contract address |
| `abi_path` | path to the contract ABI JSON (or inline `abi`) |
| `function` | function name, e.g. `mintFree` |
| `args` | function arguments. Big ints as decimal strings (JSON floats lose precision). Use `"DEADLINE"` for an arg that should be `block ts + 600` at fire time. |
| `value_wei` | value in wei (0 for a free mint). A config with value > 0 is refused unless `--allow-paid` is passed AND the paid amount was explicitly ordered. |
| `open_at` | unix timestamp when the mint opens (polls block time) |
| `open_call` | `{"function": "mintOpen", "args": [], "expect": true}` — poll a view function instead of / in addition to `open_at` |
| `dynamic_args` | `[{"arg_index": 2, "call": {"function": "previewMint", "args": [1]}, "pick": 0}]` — read an arg from a view function at fire time; falls back to the static value if the call reverts |
| `wallet` | sender address (default: main wallet) |
| `sender` | `"baw"` (default; required for Agent-ID-gated mints) or `"mcp"` (direct send, not wired yet) |
| `poll_s` | poll interval in seconds (default 1.0) |
| `max_wait_s` | give up this many seconds past the open (default 300) |
| `verify` | `{"function": "balanceOf", "args": [...], "expect": ...}` — read after the receipt to confirm the mint landed |
| `log_path` | where to append the run log |

## Safety rails (never bypassed)

- Free mints only unless `value_wei` is explicitly set AND `--allow-paid` is passed
  AND the user ordered that exact paid amount.
- Calldata is always built programmatically (`web3.encode_abi`) and decoded back;
  if the decoded fields do not match the config, the script refuses to fire.
- A baw preview runs first; fire only on a clean preview.
- Never call a function other than the configured mint function.

## Verified (10 Nov 2026, dry run vs Broccoli)

- Calldata selector `0xc4310955` matches the race script's manual encoding exactly.
- Decoded args match the config (agentId, expectedStart 1794319200, minTokens 3e25,
  deadline block ts + 600, inviter zero address).
- `previewMint(1)` reverts post-sellout (0x04e22101) — the sniper falls back to the
  static minTokens and continues instead of crashing.
- Dry run sends nothing.
