# AMNT Mining — Plan B (CPU lane) PoW solver

Tools for mining AMNT (Agent Mining, agentmining.fun) on BSC, Plan B / CPU lane.
PoW: `keccak256(abi.encode(seedBase, wallet, agentId, lane, day, nonce)) <= 2^228-1`
(28 leading zero bits), 2,500 AMNT per proof, max 20 proofs / Agent ID / day,
daily CPU cap 20,000. Windows daily 21:00–23:00 WITA, 45 days from 10 Nov 2026.

Token: `0x2d07B9CcDF5FCdbE26167358B94eeb4c9E995e4E` (Sourcify exact match).
Plan B selected via `selectPlan(2)`; proofs submitted with `mineBatch(2, nonces[])`.

## Day 0 result

3/20 proofs, 7,500 AMNT. The daily CPU cap filled ~21:32 WITA.
Local C solver did all 3 proofs; the Kaggle kernel never left the GPU queue.

## Files

- `amnt_solver.c` — C solver (pthread, two-block Keccak: block 1 absorbed once,
  per-hash = 1 permutation). ~1.3M h/s on the VM. Build: `gcc -O3 -pthread -o amnt_solver amnt_solver.c`
- `amnt_cuda.cu` — CUDA solver (same Keccak core; CPU test path included).
  Build: `nvcc -O3 -arch=sm_75 -o amnt_cuda amnt_cuda.cu`
- `amnt_abi.json` / `AMNT.sol` — contract ABI + source
- `llms.txt` — project guide from agentmining.fun
- `verify_and_sim.py`, `verify_and_sim2.py` — verify a nonce against the
  on-chain `proofDigest` + simulate `mineBatch` (eth_call) before sending
- `kaggle/` — Kaggle GPU kernel (2x Tesla T4, ~666M h/s benchmark)
  - `main.py` — kernel code (embeds the .cu as base64; script kernels ship only
    the code file). Day-0 seed inside; regenerate per day with `prep_day1.py`.
  - `prep_day1.py` — regenerate `main.py` + `kernel-metadata.json` for a new
    day: `python3 prep_day1.py --seedbase <64 hex> --day 1`
  - `push_amnt.py` — push the kernel via Kaggle REST API (needs the
    `custom.kaggle` vault surrogate for the Bearer token)
  - `poll_amnt.py` — poll `/kernels/output/{slug}` every 60s for `AMNT_PROOF` lines
  - `kernel-metadata.json` — kernel metadata (slug, GPU, T4)

## Day-1 run order (lesson from day 0)

1. Read the day-1 `seedBase` (pinSession pins it; first pin wins).
2. `python3 kaggle/prep_day1.py --seedbase <seed> --day 1`
3. Push the Kaggle kernel FIRST, then start local VM + box solvers in parallel.
   Kaggle ranges start at 40B; local VM [0, 20B); box [20B, 40B).
4. Verify each proof vs on-chain `proofDigest`, simulate `mineBatch`, then send.
   Stop on on-chain proof that the daily cap (20,000) is full.
