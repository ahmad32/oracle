---
name: fastmint-fcfs
description: Use when the user says "mint free jam HH:MM", "fcfs", "gausah riset", or wants a free/paid FCFS mint, claim, or share sale fired the moment it opens from the Binance Agentic Wallet (baw) on BSC. Fast recon -> fire -> report, with no long research.
---

# Fast FCFS mint (Binance Agentic Wallet, BSC 56)

Toolkit: `/workspace/fastmint/` (`recon.sh`/`recon.js`, `fire.js`, `lib.js`, logs and locks in `runs/`).
Speed matters, so skip the deep risk research unless the user asks for it. Keep these safety rails anyway.

## Safety rails (never skip)
- Fire only on the user's explicit command for this mint ("mint free jam 23:00", "gas", "ok"). A link alone is not a go-ahead.
- Free mint means `--value 0`. A paid mint needs an amount the user stated explicitly. Pass it as `--value` and also as `--maxValue` (the cap). fire.js refuses value > maxValue, and refuses any value > 0 without a cap.
- One broadcast only. fire.js writes `runs/lock_<hash>.json` before execute and refuses to run the same to/data/value again. Never auto-retry after execute, even when execute errors or the tx reverts. Delete a lock only when the user gives a new explicit command.
- Never run `baw auth signin` automatically. If the status is not CONNECTED, stop and ask the user. Never ask for a private key, seed phrase, or website session token.
- Never work around Binance risk blocks (351803), RISK flags, or allowance/authority changes in the preview. Stop and report.
- Use only the connected wallet. Do not touch other wallets' funds.

## Flow
1. **Recon (about 5–10s):** `cd /workspace/fastmint && ./recon.sh <site-url>` (add `--contract 0x..` if the CA is known and not on the site).
   It fetches the HTML, JS bundles, and agent docs (llms.txt, handbook.md, skill.md…). It extracts 0x addresses, chainId, mint function names and ABI sigs, and unix times.
   It runs eth_getCode and loads the Sourcify v2 ABI (or the site-bundle ABI filtered to selectors present in the bytecode). It reads every view getter (0-arg, `(wallet)`, `(agentId)`).
   Then it lists the MINT CANDIDATES with guessed args, calldata, an eth_call simulation, and a ready `fire:` command.
   - Read from the output: start time (`SALE_START`/`MINT_START`/`status.saleStart`), free left, price, per-wallet limit, and agentIdOf(wallet).
   - Arg guesses: inviter/ref → 0x0 unless the user gave one; agentId/id → the wallet's Agent ID tokenId (= uint256(keccak256(handle)) from registry 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F `handleOf`); qty → 1; deadline → now+30min; minTokens → 0. **Verify** any arg like `expectedStart` / `totalMinted+1`. These can change at open. If so, build the calldata in a small script just before firing, as in broccoli/go.js.
   - A sim before the start usually reverts `NotStarted` (fine). `SoldOut`/`FreeGone`/`AlreadyTaken`/`AgentIdRequired` mean stop and tell the user.
2. **Fire:** run it in the background (Shell `block_until_ms: 0`) so the chat stays responsive:
   ```bash
   cd /workspace/fastmint
   # free mint at 23:00 WIB
   node fire.js --to 0xSALE --data 0x195ad114 --start 23:00 --label feg_free
   # same with signature encoding
   node fire.js --to 0xSALE --sig "claimFreeShare()" --start 23:00
   node fire.js --to 0xSALE --sig "mintFree(uint256,uint256,uint256,uint256,address)" --args '["<agentId>","1","0","1794330000","0x0000000000000000000000000000000000000000"]' --start 21:00
   # paid (user said: 2 shares at 0.005 = 0.01 BNB)
   node fire.js --to 0xSALE --sig "buyWithBnb(uint256,address,uint256)" --args '[2,"0x000…0",0]' --value 0.01 --maxValue 0.01 --start 23:00
   # rehearsal: everything incl. baw preview, stops before execute
   node fire.js ... --dry            # add --noPreview to stop before preview too
   ```
   What fire.js does:
   - Prechecks: `baw wallet status` = CONNECTED, devMode on (`wallet settings`), code at `--to`, balance ≥ value + gas, no lock file.
   - Warms the RPCs and loads the Sourcify ABI for error decoding.
   - Starts at start − `--lead` (2000ms). It spins `eth_call` from the wallet at 6 RPCs × {latest, pending} every 120ms.
   - On the first OK it runs `baw contract-call preview`. It checks simCode `000000000`, no allowance/authority changes, no RISK, and native outflow ≤ cap. Then it runs `baw contract-call execute` once.
   - Polls the receipt and prints status and the BscScan link. Logs show WIB times, in `runs/<stamp>_<label>.log`, with preview/exec/receipt JSON beside them.
   - Not-started reverts (NotStarted/NotOpen/NotLive/TooEarly/Paused…) are retried until `--timeout` (600s). Unknown reverts are retried until start + `--grace` (8s). Terminal reverts (sold out, gone, already, agent id, not eligible, expired, payment low…) stop at once.
   - Tune with `--waitOn`/`--fatalOn <regex>`. `--once` makes a single attempt. `--eager` previews when the chain head ts ≥ start, even before eth_call succeeds (preview is simulation-only, so this is safe and saves about a block).
   - baw has no single-step send for contract calls. Preview → execute is the required two-step, and the `requestId` comes only from preview. Typical latency: preview about 2–3s, execute about 2s. So T+0 sim OK → broadcast at about T+5s (AgentFeg: sim OK 23:00:01, broadcast 23:00:06, included 23:00:07).
3. **Report:** tx hash, status, BscScan link, what was received (re-run `./recon.sh` or read the getters), and the log path. If it stopped, give the decoded revert and what it means.

## Troubleshooting
- **UNCONNECTED / session error:** stop. Tell the user the session dropped. Only on their OK run `baw auth signin --json`, then `auth verify --qrCodeId <id>` after they approve in the Binance App. Never do this automatically mid-fire.
- **Developer Mode off/expired (351802):** the user enables it in the Binance App (Agentic Wallet → Settings → Developer Mode). Then re-run.
- **NotStarted forever:** check that the start time is right (contract getter vs site). Did the team change the start? Is `--timeout` long enough?
- **Sold out / FreeGone / FreeSoldOut:** terminal. Report it; do not switch to a paid mint without the user's explicit "ok paid" + amount.
- **AgentIdRequired / NotEligible:** the wallet has no Agent ID (`handleOf` empty) or the contract needs an id arg. Check `agentIdOf(wallet)` in recon and pass the tokenId.
- **AlreadyTaken / AlreadyClaimed:** this wallet or Agent ID already claimed. Done; nothing to do.
- **Inviter args:** use 0x0 (or the user-provided ref). The inviter is often bound on the first mint and cannot be changed later, so ask if unsure. Never use your own wallet as inviter where the contract forbids self-invite.
- **PaymentLow / WrongValue:** the value must equal price × qty (read the price getter, e.g. `nextSharePrice`). Re-confirm the amount with the user.
- **Preview RISK / 351803 blocked:** stop and show the risk text. Do not bypass.
- **PENDING_CONFIRMATION:** the user must approve in the Binance App. Do not resend.
- **Execute error / no receipt:** do NOT retry. Check `baw wallet tx-history --json` and `baw wallet tx-lock --json`, then report.
- **Slow RPC:** override with `FASTMINT_RPCS="https://bsc-rpc.publicnode.com,https://1rpc.io/bnb,..."`.
