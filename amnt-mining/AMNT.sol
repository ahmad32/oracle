// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IAgentRegistry} from "./interfaces/IAgentRegistry.sol";
import {IFeeSink} from "./interfaces/IFeeSink.sol";

/// @title AMNT — the Agent Mining token: proof-of-work mining, two lanes.
/// @notice Minted only against valid proofs submitted inside the daily
///         sessions. No owner and no setters — every parameter is a
///         constructor immutable. The one exception is setFeeSink: the
///         deployer wires the plan-switch fee sink exactly once, then
///         it is locked for good.
contract AMNT is ERC20 {
    uint8 public constant LANE_NONE = 0;
    uint8 public constant LANE_GPU = 1;
    uint8 public constant LANE_CPU = 2;

    // ---------------- errors ----------------
    error BadGpuTargets();
    error BadCpuTarget();
    error ZeroRegistry();
    error BadSupplyOrDays();
    error BadSessionShape();
    error BadCaps();
    error RetargetPaceZero();
    error SeedOverCap();
    error BadLane();
    error NoAgentId();
    error FirstSelectMustBeFree();
    error FirstPickOutsideWindow();
    error SwitchInsideWindow();
    error SwitchFeeRequired();
    error AlreadyOnLane();
    error SwitchAlreadyQueued();
    error NoSession();
    error NoBlockhash();
    error BadBatchSize();
    error WrongLane();
    error SessionNotPinned();
    error GpuDailyCapExceeded();
    error CpuDailyCapExceeded();
    error CpuPerIdCapExceeded();
    error InvalidProof();
    error ProofAlreadySpent();
    error SupplyCapExceeded();
    error NotDeployer();
    error FeeSinkAlreadyLocked();
    error ZeroFeeSink();
    error FeeSinkNotSet();

    // ---------------- immutables (set once at deploy) ----------------
    uint256 public immutable MAX_SUPPLY;
    IAgentRegistry public immutable registry;
    uint256 public immutable anchor; // timestamp of day-0 session open
    uint256 public immutable dayLength; // mainnet 86400
    uint256 public immutable sessionLength; // mainnet 7200
    uint256 public immutable totalDays; // mainnet 45

    uint256 public immutable gpuReward; // base units per proof
    uint256 public immutable gpuDailyTarget; // proofs/day: pace schedule AND hard cap
    uint256 public immutable gpuTargetMin; // hardest allowed target (38 bits mainnet)
    uint256 public immutable gpuTargetMax; // easiest allowed target (35 bits mainnet) = day-1 start
    uint256 public immutable retargetInterval; // proofs between retargets (250 mainnet)

    uint256 public immutable cpuReward;
    uint256 public immutable cpuDailyCap; // proofs/day pool cap (20000 mainnet)
    uint256 public immutable cpuTarget; // fixed target (28 bits mainnet)
    uint256 public immutable cpuPerIdCap; // proofs per Agent ID per day (20)

    uint256 public immutable switchFee; // wei (0.01 BNB mainnet)
    uint256 public immutable maxBatch; // 10
    address public feeSink; // AMNTSwitchLocker; address(0) until wired (see setFeeSink)
    bool public feeSinkLocked; // true = feeSink can never change again
    address public immutable deployer; // the only account that may wire the fee sink, once

    // ---------------- mining state ----------------
    uint256 public gpuTarget; // current GPU target; persists across days (carry-over)
    uint256 public gpuDay;
    uint256 public gpuDayProofs;
    uint256 public gpuSinceRetarget;
    uint256 public lastRetargetTime;

    uint256 public cpuDay;
    uint256 public cpuDayProofs;

    mapping(uint256 => bytes32) public sessionSeedBase; // day => pinned blockhash
    mapping(bytes32 => bool) public spentProof; // digest => submitted
    mapping(uint256 => uint256) public cpuDayOfId; // agentId => day of the counter below
    mapping(uint256 => uint256) public cpuCountOfId; // agentId => CPU proofs that day

    struct Plan {
        uint8 current;
        uint8 pending;
        uint32 pendingDay;
    }

    mapping(uint256 => Plan) public planOf; // agentId => plan state

    // ---------------- events ----------------
    event SessionPinned(uint256 indexed day, bytes32 seedBase);
    event PlanSelected(uint256 indexed agentId, uint8 lane);
    event PlanSwitchQueued(uint256 indexed agentId, uint8 fromLane, uint8 toLane, uint256 effectiveDay);
    event Mined(address indexed wallet, uint256 indexed agentId, uint8 lane, uint256 day, uint256 proofs);
    event Retarget(uint256 oldTarget, uint256 newTarget, uint256 elapsed, uint256 expected);
    event FeeSinkSet(address feeSink);

    struct Params {
        uint256 maxSupply;
        address registry;
        uint256 anchor;
        uint256 dayLength;
        uint256 sessionLength;
        uint256 totalDays;
        uint256 seedAmount; // minted to deployer for pool seeding
        uint256 gpuReward;
        uint256 gpuDailyTarget;
        uint256 gpuTargetMin;
        uint256 gpuTargetMax;
        uint256 retargetInterval;
        uint256 cpuReward;
        uint256 cpuDailyCap;
        uint256 cpuTarget;
        uint256 cpuPerIdCap;
        uint256 switchFee;
        uint256 maxBatch;
        address feeSink; // AMNTSwitchLocker address; address(0) = wire after deploy via setFeeSink
    }

    constructor(string memory name_, string memory symbol_, Params memory p) ERC20(name_, symbol_) {
        if (p.gpuTargetMin == 0 || p.gpuTargetMin > p.gpuTargetMax) revert BadGpuTargets();
        if (p.cpuTarget == 0) revert BadCpuTarget();
        // Immutable once deployed, so bad combinations fail here.
        if (p.registry == address(0)) revert ZeroRegistry();
        if (p.maxSupply == 0 || p.totalDays == 0) revert BadSupplyOrDays();
        if (p.dayLength == 0 || p.sessionLength == 0 || p.sessionLength > p.dayLength) revert BadSessionShape();
        if (p.gpuDailyTarget == 0 || p.cpuDailyCap == 0 || p.maxBatch == 0) revert BadCaps();
        // Pace must be >= 1s per interval or _retarget divides by zero.
        // Written as a division so a huge retargetInterval cannot overflow.
        if (p.retargetInterval < (p.gpuDailyTarget + p.sessionLength - 1) / p.sessionLength) revert RetargetPaceZero();
        MAX_SUPPLY = p.maxSupply;
        registry = IAgentRegistry(p.registry);
        anchor = p.anchor;
        dayLength = p.dayLength;
        sessionLength = p.sessionLength;
        totalDays = p.totalDays;
        gpuReward = p.gpuReward;
        gpuDailyTarget = p.gpuDailyTarget;
        gpuTargetMin = p.gpuTargetMin;
        gpuTargetMax = p.gpuTargetMax;
        retargetInterval = p.retargetInterval;
        cpuReward = p.cpuReward;
        cpuDailyCap = p.cpuDailyCap;
        cpuTarget = p.cpuTarget;
        cpuPerIdCap = p.cpuPerIdCap;
        switchFee = p.switchFee;
        maxBatch = p.maxBatch;
        feeSink = p.feeSink;
        deployer = msg.sender;
        if (p.feeSink != address(0)) feeSinkLocked = true; // pre-wired profile: locked from birth

        gpuTarget = p.gpuTargetMax; // day 1 opens at the difficulty floor (easiest allowed)
        gpuDay = type(uint256).max; // sentinel: forces day-roll (and retarget clock init) on first mine
        cpuDay = type(uint256).max;
        if (p.seedAmount > p.maxSupply) revert SeedOverCap();
        if (p.seedAmount > 0) _mint(msg.sender, p.seedAmount);
    }

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    // ---------------- time ----------------
    function dayIndex() public view returns (uint256) {
        if (block.timestamp < anchor) return 0;
        return (block.timestamp - anchor) / dayLength;
    }

    function inSession() public view returns (bool) {
        if (block.timestamp < anchor) return false;
        uint256 d = (block.timestamp - anchor) / dayLength;
        if (d >= totalDays) return false;
        return block.timestamp < anchor + d * dayLength + sessionLength;
    }

    function _nextEffectiveDay() internal view returns (uint256) {
        if (block.timestamp < anchor) return 0;
        return dayIndex() + 1;
    }

    // ---------------- plan selection / locking ----------------
    function effectiveLane(uint256 agentId) public view returns (uint8) {
        Plan memory p = planOf[agentId];
        if (p.pending != LANE_NONE && dayIndex() >= p.pendingDay) return p.pending;
        return p.current;
    }

    /// @notice First pick is free, effective immediately, and only inside
    ///         an open window. Later calls are switches: they cost
    ///         switchFee, can only be submitted between windows, and take
    ///         effect from the next session day — which is also why there
    ///         is no cooldown to track: a same-day flip can never be
    ///         mined on. The fee goes straight to the switch locker in
    ///         the same transaction and becomes the switcher's buy +
    ///         7-day locked LP position.
    function selectPlan(uint8 lane) external payable {
        if (lane != LANE_GPU && lane != LANE_CPU) revert BadLane();
        uint256 id = registry.agentIdOf(msg.sender);
        if (id == 0) revert NoAgentId();
        Plan storage p = planOf[id];
        if (p.current == LANE_NONE && p.pending == LANE_NONE) {
            if (msg.value != 0) revert FirstSelectMustBeFree();
            if (!inSession()) revert FirstPickOutsideWindow();
            p.current = lane;
            emit PlanSelected(id, lane);
            return;
        }
        if (inSession()) revert SwitchInsideWindow();
        if (msg.value != switchFee) revert SwitchFeeRequired();
        uint8 eff = effectiveLane(id);
        if (lane == eff) revert AlreadyOnLane();
        if (p.pending != LANE_NONE && lane == p.pending) revert SwitchAlreadyQueued();
        p.current = eff; // materialize any pending lane before queuing the next one
        p.pending = lane;
        p.pendingDay = uint32(_nextEffectiveDay());
        if (feeSink == address(0)) revert FeeSinkNotSet();
        IFeeSink(feeSink).deposit{value: msg.value}(id, msg.sender);
        emit PlanSwitchQueued(id, eff, lane, p.pendingDay);
    }

    // ---------------- fee sink wiring (one-time) ----------------
    /// @notice Wire the fee sink (the switch locker) after it is
    ///         deployed: deployer only, exactly once, and the call locks
    ///         it forever. A sink passed to the constructor is locked
    ///         from birth instead. Until wired, paid switches revert —
    ///         this contract never holds switch BNB.
    function setFeeSink(address sink) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (feeSinkLocked) revert FeeSinkAlreadyLocked();
        if (sink == address(0)) revert ZeroFeeSink();
        feeSink = sink;
        feeSinkLocked = true;
        emit FeeSinkSet(sink);
    }

    // ---------------- session seed ----------------
    /// @notice Pin today's seed to the previous block's hash. Anyone
    ///         may call; there is no mining until pinned, and the seed
    ///         does not exist before the pin — nobody can pre-mine.
    function pinSession() public {
        if (!inSession()) revert NoSession();
        uint256 d = dayIndex();
        if (sessionSeedBase[d] == bytes32(0)) {
            bytes32 h = blockhash(block.number - 1);
            if (h == bytes32(0)) revert NoBlockhash();
            sessionSeedBase[d] = h;
            emit SessionPinned(d, h);
        }
    }

    /// @notice Rollover-aware counters for frontends/miners (raw gpuDayProofs/cpuDayProofs
    /// keep yesterday's value until the first mine of a new day rolls them).
    function gpuProofsToday() public view returns (uint256) {
        return gpuDay == dayIndex() ? gpuDayProofs : 0;
    }

    function cpuProofsToday() public view returns (uint256) {
        return cpuDay == dayIndex() ? cpuDayProofs : 0;
    }

    function proofDigest(uint256 day, address wallet, uint256 agentId, uint8 lane, uint256 nonce)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(sessionSeedBase[day], wallet, agentId, lane, day, nonce));
    }

    // ---------------- mining ----------------
    function mineBatch(uint8 lane, uint256[] calldata nonces) external {
        if (!inSession()) revert NoSession();
        uint256 n = nonces.length;
        if (n == 0 || n > maxBatch) revert BadBatchSize();
        uint256 id = registry.agentIdOf(msg.sender);
        if (id == 0) revert NoAgentId();
        if (effectiveLane(id) != lane) revert WrongLane();

        uint256 d = dayIndex();
        bytes32 base = sessionSeedBase[d];
        if (base == bytes32(0)) revert SessionNotPinned();

        uint256 cpuCount;
        if (lane == LANE_GPU) {
            _rollGpuDay(d);
            if (gpuDayProofs + n > gpuDailyTarget) revert GpuDailyCapExceeded();
        } else {
            _rollCpuDay(d);
            if (cpuDayProofs + n > cpuDailyCap) revert CpuDailyCapExceeded();
            cpuCount = cpuDayOfId[id] == d ? cpuCountOfId[id] : 0;
            if (cpuCount + n > cpuPerIdCap) revert CpuPerIdCapExceeded();
        }

        uint256 target = lane == LANE_GPU ? gpuTarget : cpuTarget;
        for (uint256 i = 0; i < n; i++) {
            bytes32 digest = keccak256(abi.encode(base, msg.sender, id, lane, d, nonces[i]));
            if (uint256(digest) > target) revert InvalidProof();
            if (spentProof[digest]) revert ProofAlreadySpent();
            spentProof[digest] = true;
        }

        uint256 reward = (lane == LANE_GPU ? gpuReward : cpuReward) * n;
        if (totalSupply() + reward > MAX_SUPPLY) revert SupplyCapExceeded();
        if (lane == LANE_GPU) {
            gpuDayProofs += n;
            _mint(msg.sender, reward);
            _retarget(n);
        } else {
            cpuDayProofs += n;
            cpuDayOfId[id] = d;
            cpuCountOfId[id] = cpuCount + n;
            _mint(msg.sender, reward);
        }
        emit Mined(msg.sender, id, lane, d, n);
    }

    function _rollGpuDay(uint256 d) internal {
        if (gpuDay != d) {
            gpuDay = d;
            gpuDayProofs = 0;
            gpuSinceRetarget = 0;
            lastRetargetTime = block.timestamp;
        }
    }

    function _rollCpuDay(uint256 d) internal {
        if (cpuDay != d) {
            cpuDay = d;
            cpuDayProofs = 0;
        }
    }

    /// @notice Difficulty retarget: every retargetInterval proofs,
    /// compare elapsed time with the scheduled pace; scale the target by the ratio,
    /// clamped to at most x1.5 difficulty change per step and to [gpuTargetMin, gpuTargetMax].
    function _retarget(uint256 n) internal {
        gpuSinceRetarget += n;
        if (gpuSinceRetarget < retargetInterval) return;
        uint256 expected = retargetInterval * sessionLength / gpuDailyTarget; // seconds per interval at pace
        uint256 elapsed = block.timestamp - lastRetargetTime;
        if (elapsed == 0) elapsed = 1;
        uint256 old = gpuTarget;
        // mul-div decomposed: old * elapsed would overflow for targets near 2^250
        uint256 nt = (old / expected) * elapsed + ((old % expected) * elapsed) / expected;
        uint256 hi = old * 3 / 2; // at most x1.5 easier
        uint256 lo = old * 2 / 3; // at most x1.5 harder
        if (nt > hi) nt = hi;
        if (nt < lo) nt = lo;
        if (nt > gpuTargetMax) nt = gpuTargetMax;
        if (nt < gpuTargetMin) nt = gpuTargetMin;
        gpuTarget = nt;
        gpuSinceRetarget -= retargetInterval; // keep the overflow phase (<= maxBatch proofs) instead of discarding it
        lastRetargetTime = block.timestamp;
        emit Retarget(old, nt, elapsed, expected);
    }
}
