// AMNT (Agent Mining) Plan B / CPU-lane PoW solver — CUDA version.
// Adapted from the VERIFIED pearl_cuda.cu (same Keccak-f1600 core).
//
// Preimage (192 bytes, ABI-encoded):
//   keccak256(abi.encode(seedBase, wallet, agentId, lane, day, nonce))
//   = 6 x 32-byte BE words. Target CPU = 2^228-1 (28 leading zero bits).
// Two Keccak blocks: block 1 (bytes 0-135) is CONSTANT for a given
// (seedBase, wallet, agentId, lane, day) -> absorbed + permuted ONCE on host
// into c_base[25]. Block 2 (bytes 136-191 + pad) varies only in the nonce
// (bytes 160-191 = lanes 3-6; for nonce < 2^64 only lane 6 is nonzero).
// Per hash cost = ONE Keccak-f1600 permutation.
//
// Verified against on-chain proofDigest (AMNT 0x2d07...):
//   seedBase[0]=0x1488c2b9cd6462bf7db63c585894f7bdc3654e8a0e9ba3e297c53a163f84d536
//   wallet=0x25CF688b28CA2b2a64A546E218182B7F1F4580F5, lane=2, day=0
//   nonce 0 -> 9bfce708a52adfe3e9c6ca2385813a6e26796d37f855140823cd08893e730485
//   nonce 1 -> d07a254722cfeb6b0991bc6d83c232e5896f042de5a637509cec6c5014881667
//
//   GPU:  nvcc -O3 -arch=sm_75 -o amnt_cuda amnt_cuda.cu   (T4 = sm_75)
//   CPU test of the core: gcc -O2 -x c -o amnt_cuda_test amnt_cuda.cu
//         then: ./amnt_cuda_test --seedbase <hex64> --wallet <hex40> \
//                 --agentid <hex64> --lane 2 --day 0
//         prints digests for nonces 0 and 1 — must equal the values above.
//
// Usage (GPU):
//   amnt_cuda --seedbase <hex64> --wallet <hex40> --agentid <hex64> \
//             --lane <u8> --day <u64> --bits N \
//             --range-start <u64> --range-end <u64>
// Output: FOUND <nonce-decimal> <digest-hex-64> bits=N | BENCH <hashes> <sec> <hash_per_sec>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>

#ifdef __CUDACC__
#include <cuda_runtime.h>
#define DEV __device__
#define HOSTDEV __host__ __device__
#define DEVCONST __constant__
#else
#define DEV
#define HOSTDEV
#define DEVCONST
#endif

DEVCONST static const uint64_t RC[24] = {
 0x0000000000000001ULL,0x0000000000008082ULL,0x800000000000808aULL,0x8000000080008000ULL,
 0x000000000000808bULL,0x0000000080000001ULL,0x8000000080008081ULL,0x8000000000008009ULL,
 0x000000000000008aULL,0x0000000000000088ULL,0x0000000080008009ULL,0x000000008000000aULL,
 0x000000008000808bULL,0x800000000000008bULL,0x8000000000008089ULL,0x8000000000008003ULL,
 0x8000000000008002ULL,0x8000000000000080ULL,0x000000000000800aULL,0x800000008000000aULL,
 0x8000000080008081ULL,0x8000000000008080ULL,0x0000000080000001ULL,0x8000000080008008ULL};
DEVCONST static const int R[24] = {1,3,6,10,15,21,28,36,45,55,2,14,27,41,56,8,25,43,62,18,39,61,20,44};
DEVCONST static const int P[24] = {10,7,11,17,18,3,5,16,8,21,24,4,15,23,19,13,12,2,20,14,22,9,6,1};

HOSTDEV static inline uint64_t rol(uint64_t x, int n){ return (x<<n)|(x>>(64-n)); }

HOSTDEV static void permute(uint64_t st[25]){
    for(int round=0;round<24;round++){
        uint64_t bc[5], t;
        for(int i=0;i<5;i++) bc[i]=st[i]^st[i+5]^st[i+10]^st[i+15]^st[i+20];
        for(int i=0;i<5;i++){ t=bc[(i+4)%5]^rol(bc[(i+1)%5],1); for(int j=0;j<25;j+=5) st[j+i]^=t; }
        t=st[1];
        for(int i=0;i<24;i++){ int j=P[i]; bc[0]=st[j]; st[j]=rol(t,R[i]); t=bc[0]; }
        for(int j=0;j<25;j+=5){ uint64_t r0=st[j],r1=st[j+1],r2=st[j+2],r3=st[j+3],r4=st[j+4];
            st[j]^=(~r1)&r2; st[j+1]^=(~r2)&r3; st[j+2]^=(~r3)&r4; st[j+3]^=(~r4)&r0; st[j+4]^=(~r0)&r1; }
        st[0]^=RC[round];
    }
}

HOSTDEV static int leading_zero_bits(const unsigned char *d){
    int n=0;
    for(int i=0;i<32;i++){
        if(d[i]==0){ n+=8; continue; }
        unsigned char b=d[i];
        while(!(b & 0x80)){ n++; b<<=1; }
        break;
    }
    return n;
}

HOSTDEV static inline uint64_t bswap64(uint64_t x){
    return ((x & 0x00000000000000ffULL) << 56) | ((x & 0x000000000000ff00ULL) << 40) |
           ((x & 0x0000000000ff0000ULL) << 24) | ((x & 0x00000000ff000000ULL) << 8)  |
           ((x & 0x000000ff00000000ULL) >> 8)  | ((x & 0x0000ff0000000000ULL) >> 24) |
           ((x & 0x00ff000000000000ULL) >> 40) | ((x & 0xff00000000000000ULL) >> 56);
}

#ifdef __CUDACC__
DEVCONST static uint64_t c_base[25];  // state after absorbing block 1
DEVCONST static uint64_t c_b2[17];    // block-2 template lanes (day + pads; nonce lanes 0)
#endif
#ifndef __CUDACC__
static uint64_t c_base[25];
static uint64_t c_b2[17];
#endif

/* Hash one nonce: state = c_base XOR c_b2 (+ nonce in lane 6), one permute. */
HOSTDEV static void hash_nonce(uint64_t n, unsigned char dig[32]){
    uint64_t st[25];
    for(int i=0;i<25;i++) st[i]=c_base[i];
    for(int i=0;i<17;i++) st[i]^=c_b2[i];
    st[6]^=bswap64(n);
    permute(st);
    for(int i=0;i<4;i++){ uint64_t w=st[i]; for(int j=0;j<8;j++) dig[i*8+j]=(unsigned char)((w>>(8*j))&0xff); }
}

#ifdef __CUDACC__

__global__ void solve_kernel(uint64_t start, uint64_t chunk_end, int need_bits,
                             volatile unsigned int *found_flag,
                             unsigned long long *found_nonce,
                             unsigned char *found_digest){
    uint64_t stride = (uint64_t)gridDim.x * blockDim.x;
    uint64_t idx = (uint64_t)blockIdx.x * blockDim.x + threadIdx.x;
    unsigned char dig[32];
    for(uint64_t n = start + idx; n < chunk_end; n += stride){
        if(*found_flag) return;
        hash_nonce(n,dig);
        if(leading_zero_bits(dig) >= need_bits){
            if(atomicExch((unsigned int*)found_flag, 1u) == 0){
                *found_nonce = (unsigned long long)n;
                for(int i=0;i<32;i++) found_digest[i]=dig[i];
            }
            return;
        }
    }
}

static int hexval(char c){ if(c>='0'&&c<='9')return c-'0'; if(c>='a'&&c<='f')return c-'a'+10; if(c>='A'&&c<='F')return c-'A'+10; return 0; }
static void parse_hex(const char *hex, unsigned char *out, int n){
    for(int i=0;i<n;i++) out[i]=(unsigned char)((hexval(hex[2*i])<<4)|hexval(hex[2*i+1]));
}
static uint64_t load_lane_le(const unsigned char *b){
    uint64_t w=0; for(int i=0;i<8;i++) w |= (uint64_t)b[i]<<(8*i); return w;
}

#define CHUNK ((uint64_t)1<<28)
#define BLOCKS 1024
#define THREADS 256

int main(int argc, char **argv){
    const char *seed_hex=NULL, *wallet_hex=NULL, *agent_hex=NULL;
    uint64_t lane=2, day=0, rs=0, re=0; int need_bits=-1; int have_rs=0, have_re=0;
    for(int i=1;i<argc;i++){
        if(!strcmp(argv[i],"--seedbase") && i+1<argc) seed_hex=argv[++i];
        else if(!strcmp(argv[i],"--wallet") && i+1<argc) wallet_hex=argv[++i];
        else if(!strcmp(argv[i],"--agentid") && i+1<argc) agent_hex=argv[++i];
        else if(!strcmp(argv[i],"--lane") && i+1<argc) lane=strtoull(argv[++i],NULL,10);
        else if(!strcmp(argv[i],"--day") && i+1<argc) day=strtoull(argv[++i],NULL,10);
        else if(!strcmp(argv[i],"--bits") && i+1<argc) need_bits=atoi(argv[++i]);
        else if(!strcmp(argv[i],"--range-start") && i+1<argc){ rs=strtoull(argv[++i],NULL,10); have_rs=1; }
        else if(!strcmp(argv[i],"--range-end") && i+1<argc){ re=strtoull(argv[++i],NULL,10); have_re=1; }
        else if(!strcmp(argv[i],"--help")){ printf("usage: %s --seedbase <hex64> --wallet <hex40> --agentid <hex64> --lane <u8> --day <u64> --bits N --range-start <u64> --range-end <u64>\n", argv[0]); return 0; }
        else { fprintf(stderr,"unknown arg: %s\n", argv[i]); return 2; }
    }
    if(!seed_hex || !wallet_hex || !agent_hex || need_bits<0 || !have_rs || !have_re || re<=rs ||
       strlen(seed_hex)!=64 || strlen(wallet_hex)!=40 || strlen(agent_hex)!=64){
        fprintf(stderr,"usage: %s --seedbase <hex64> --wallet <hex40> --agentid <hex64> --lane <u8> --day <u64> --bits N --range-start <u64> --range-end <u64>\n", argv[0]);
        return 2;
    }
    unsigned char seed[32], agent[32], addr[20];
    parse_hex(seed_hex, seed, 32);
    parse_hex(agent_hex, agent, 32);
    parse_hex(wallet_hex, addr, 20);

    // Build 192-byte preimage; block 1 = bytes 0-135, block 2 template = bytes 136-191 + pad.
    unsigned char pre[192];
    memset(pre, 0, sizeof pre);
    memcpy(pre+0, seed, 32);
    memcpy(pre+44, addr, 20);
    memcpy(pre+64, agent, 32);
    pre[127] = (unsigned char)lane;
    for(int i=0;i<8;i++) pre[152+i] = (unsigned char)((day >> (56-8*i)) & 0xff);
    uint64_t base[25]; memset(base, 0, sizeof base);
    for(int i=0;i<17;i++) base[i] = load_lane_le(pre + i*8);
    permute(base);
    uint64_t b2[17]; memset(b2, 0, sizeof b2);
    for(int i=0;i<7;i++) b2[i] = load_lane_le(pre + 136 + i*8); // bytes 136-191 (day tail + nonce area=0)
    b2[7] = 0x0000000000000001ULL;  // pad 0x01 at block-2 byte 56
    b2[16] = 0x8000000000000000ULL; // pad 0x80 at block-2 last byte
    cudaMemcpyToSymbol(c_base, base, sizeof base);
    cudaMemcpyToSymbol(c_b2, b2, sizeof b2);

    unsigned int *d_flag=NULL; unsigned long long *d_nonce=NULL; unsigned char *d_digest=NULL;
    cudaMalloc(&d_flag, sizeof(unsigned int));
    cudaMalloc(&d_nonce, sizeof(unsigned long long));
    cudaMalloc(&d_digest, 32);
    cudaMemset(d_flag, 0, sizeof(unsigned int));

    struct timespec t0,t1; clock_gettime(CLOCK_MONOTONIC,&t0);
    int found=0; unsigned long long fnonce=0; unsigned char fdig[32]; memset(fdig,0,32);
    for(uint64_t cs=rs; cs<re && !found; cs+=CHUNK){
        uint64_t ce = cs+CHUNK; if(ce>re) ce=re;
        solve_kernel<<<BLOCKS, THREADS>>>(cs,ce,need_bits,d_flag,d_nonce,d_digest);
        cudaError_t err = cudaDeviceSynchronize();
        if(err!=cudaSuccess){ fprintf(stderr,"cuda error: %s\n", cudaGetErrorString(err)); return 3; }
        unsigned int hflag=0;
        cudaMemcpy(&hflag, d_flag, sizeof(unsigned int), cudaMemcpyDeviceToHost);
        if(hflag){
            cudaMemcpy(&fnonce, d_nonce, sizeof(unsigned long long), cudaMemcpyDeviceToHost);
            cudaMemcpy(fdig, d_digest, 32, cudaMemcpyDeviceToHost);
            found=1; break;
        }
        fprintf(stderr, "[gpu] %lluM hashes\n", (unsigned long long)((ce-rs)/1000000ULL));
        fflush(stderr);
    }
    clock_gettime(CLOCK_MONOTONIC,&t1);
    double sec=(t1.tv_sec-t0.tv_sec)+(t1.tv_nsec-t0.tv_nsec)/1e9;
    if(found){
        printf("FOUND %llu ", fnonce);
        for(int i=0;i<32;i++) printf("%02x", fdig[i]);
        printf(" bits=%d\n", leading_zero_bits(fdig));
    } else {
        uint64_t tot = re-rs;
        printf("BENCH %llu %.2f %.0f\n", (unsigned long long)tot, sec, tot/sec);
    }
    return 0;
}

#else /* CPU test of the keccak core (gcc, no CUDA) */

static int hexval(char c){ if(c>='0'&&c<='9')return c-'0'; if(c>='a'&&c<='f')return c-'a'+10; if(c>='A'&&c<='F')return c-'A'+10; return 0; }
static void parse_hex(const char *hex, unsigned char *out, int n){
    for(int i=0;i<n;i++) out[i]=(unsigned char)((hexval(hex[2*i])<<4)|hexval(hex[2*i+1]));
}
static uint64_t load_lane_le(const unsigned char *b){
    uint64_t w=0; for(int i=0;i<8;i++) w |= (uint64_t)b[i]<<(8*i); return w;
}

int main(int argc, char **argv){
    const char *seed_hex=NULL, *wallet_hex=NULL, *agent_hex=NULL;
    uint64_t lane=2, day=0;
    for(int i=1;i<argc;i++){
        if(!strcmp(argv[i],"--seedbase") && i+1<argc) seed_hex=argv[++i];
        else if(!strcmp(argv[i],"--wallet") && i+1<argc) wallet_hex=argv[++i];
        else if(!strcmp(argv[i],"--agentid") && i+1<argc) agent_hex=argv[++i];
        else if(!strcmp(argv[i],"--lane") && i+1<argc) lane=strtoull(argv[++i],NULL,10);
        else if(!strcmp(argv[i],"--day") && i+1<argc) day=strtoull(argv[++i],NULL,10);
    }
    if(!seed_hex || !wallet_hex || !agent_hex ||
       strlen(seed_hex)!=64 || strlen(wallet_hex)!=40 || strlen(agent_hex)!=64){
        fprintf(stderr,"usage: %s --seedbase <hex64> --wallet <hex40> --agentid <hex64> --lane <u8> --day <u64>\n", argv[0]); return 2;
    }
    unsigned char seed[32], agent[32], addr[20];
    parse_hex(seed_hex, seed, 32);
    parse_hex(agent_hex, agent, 32);
    parse_hex(wallet_hex, addr, 20);
    unsigned char pre[192];
    memset(pre, 0, sizeof pre);
    memcpy(pre+0, seed, 32);
    memcpy(pre+44, addr, 20);
    memcpy(pre+64, agent, 32);
    pre[127] = (unsigned char)lane;
    for(int i=0;i<8;i++) pre[152+i] = (unsigned char)((day >> (56-8*i)) & 0xff);
    uint64_t base[25]; memset(base, 0, sizeof base);
    for(int i=0;i<17;i++) base[i] = load_lane_le(pre + i*8);
    permute(base);
    memcpy(c_base, base, sizeof base);
    uint64_t b2[17]; memset(b2, 0, sizeof b2);
    for(int i=0;i<7;i++) b2[i] = load_lane_le(pre + 136 + i*8);
    b2[7] = 0x0000000000000001ULL;
    b2[16] = 0x8000000000000000ULL;
    memcpy(c_b2, b2, sizeof b2);
    uint64_t nonces[] = {0ULL, 1ULL};
    for(int k=0;k<2;k++){
        unsigned char dig[32];
        hash_nonce(nonces[k],dig);
        printf("nonce %llu digest ", (unsigned long long)nonces[k]);
        for(int i=0;i<32;i++) printf("%02x", dig[i]);
        printf(" lzb=%d\n", leading_zero_bits(dig));
    }
    return 0;
}

#endif
