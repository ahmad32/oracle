import json, sys
sys.path.insert(0, '/home/hatch/workspace/mcp-wallet/venv/lib/python3.12/site-packages')
from web3 import Web3
from web3.middleware import ExtraDataToPOAMiddleware

AMNT = '0x2d07B9CcDF5FCdbE26167358B94eeb4c9E995e4E'
WALLET = '0x25CF688b28CA2b2a64A546E218182B7F1F4580F5'
AGENTID = 47180081854018486746556308369438658819430327551400156943248280963129417241949
NONCE = 10221596432
EXPECTED = '000000040fa2b0058cf3721183bd31da64bb569c76b3cff0d82db089798f1b09'

abi = json.load(open('amnt_abi.json'))
w3 = None
for rpc in ['https://bsc-dataseed.binance.org', 'https://binance.llamarpc.com', 'https://bsc-dataseed1.defibit.io']:
    try:
        w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={'headers': {'User-Agent': 'Mozilla/5.0'}}))
        w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
        print('RPC ok:', rpc, 'chain', w3.eth.chain_id)
        break
    except Exception as e:
        print('RPC fail:', rpc, str(e)[:80])
if w3 is None:
    print('NO RPC'); sys.exit(1)

c = w3.eth.contract(address=AMNT, abi=abi)
# 1. Verify proof digest on-chain
digest = c.functions.proofDigest(0, WALLET, AGENTID, 2, NONCE).call()
print('proofDigest on-chain:', digest.hex())
print('solver digest       :', EXPECTED)
print('MATCH:', digest.hex() == EXPECTED)
# 2. Not already spent?
print('spentProof:', c.functions.spentProof(bytes.fromhex(EXPECTED)).call())
print('effectiveLane:', c.functions.effectiveLane(AGENTID).call())
print('cpuProofsToday:', c.functions.cpuProofsToday().call(), '/ 20000')
print('inSession:', c.functions.inSession().call())
# 3. Build mineBatch calldata programmatically
calldata = c.encode_abi('mineBatch', [2, [NONCE]])
print('calldata:', calldata)
print('selector:', calldata[:10], '(expect 0x738c12e5)')
# decode back
fn, params = c.decode_function_input(calldata)
print('decoded fn:', fn.fn_name, 'params:', params)
# 4. eth_call simulation from user wallet, value 0
try:
    res = w3.eth.call({'from': WALLET, 'to': AMNT, 'value': 0, 'data': calldata})
    print('SIM OK, return:', res.hex())
except Exception as e:
    print('SIM REVERT:', str(e)[:500])
# 5. gas estimate
try:
    gas = w3.eth.estimate_gas({'from': WALLET, 'to': AMNT, 'value': 0, 'data': calldata})
    print('gas estimate:', gas)
    gp = w3.eth.gas_price
    print('gasPrice gwei:', gp / 1e9, '-> est cost BNB:', gas * gp / 1e18)
except Exception as e:
    print('GAS EST FAIL:', str(e)[:300])
