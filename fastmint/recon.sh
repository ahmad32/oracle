#!/usr/bin/env bash
# fast FCFS recon: ./recon.sh <url> [--contract 0x..] [--wallet 0x..]
cd "$(dirname "$0")" && exec node recon.js "$@"
