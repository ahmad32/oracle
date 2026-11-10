import json, sys
sys.path.insert(0, '/home/hatch/workspace/mcp-wallet/venv/lib/python3.12/site-packages')
from web3 import Web3
from web3.middleware import ExtraDataToPOAMiddleware
AMNT = '0x2d07B9CcDF5FCdbE26167358B94eeb4c9E995e4E'
WALLET = '0x25CF688b28CA2b2a64A546E218182B7F1F4580F5'
AGENTID = 47180081854018486746556308369438658819430327551400156943248280963129417241949
NONCE = int(sys.argv[1]); EXPECTED = sys.argv[2]
abi = json.load(open('amnt_abi.json'))
w3 = None
for rpc in ['https://bsc-dataseed.binance.org', 'https://binance.llamarpc.com']:
    try:
        w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={'headers': {'User-Agent': 'Mozilla/5.0'}}))
        w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
        print('RPC ok:', rpc); break
    except Exception as e:
        print('RPC fail:', rpc)
if w3 is None: print('NO RPC'); sys.exit(1)
c = w3.eth.contract(address=AMNT, abi=abi)
digest = c.functions.proofDigest(0, WALLET, AGENTID, 2, NONCE).call()
print('MATCH:', digest.hex() == EXPECTED, digest.hex())
print('spentProof:', c.functions.spentProof(bytes.fromhex(EXPECTED)).call())
print('cpuProofsToday:', c.functions.cpuProofsToday().call(), '/ 20000')
calldata = c.encode_abi('mineBatch', [2, [NONCE]])
fn, params = c.decode_function_input(calldata)
print('decoded:', fn.fn_name, params)
try:
    res = w3.eth.call({'from': WALLET, 'to': AMNT, 'value': 0, 'data': calldata})
    print('SIM OK')
except Exception as e:
    print('SIM REVERT:', str(e)[:300])
print('CALLDATA:', calldata)
