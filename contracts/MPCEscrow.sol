// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title MPCEscrow
 * @notice MPC ↔ USDT P2P 에스크로 구현체 (UUPS 업그레이드 가능)
 *
 * 흐름:
 *   1. 판매자: commitTrade(commitHash)           → COMMITTED 상태
 *   2. 판매자: revealAndDeposit(tradeId, ...)    → PENDING 상태, MPC 예치
 *   3. 구매자: buyerDeposit(tradeId)             → ACTIVE 상태, USDT 예치
 *   4. 판매자: confirmTrade(tradeId)             → COMPLETED, 양측 지급
 *
 * 취소/만료:
 *   - 판매자 또는 구매자가 cancelTrade() 호출 → 즉시 반환
 *   - 10분 경과 후 누구든 expireTrade() 호출 → 자동 반환
 */

// ─── 최소화된 인터페이스 (외부 라이브러리 없이 인라인 구현) ─────────────────

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

// ─── ReentrancyGuard (인라인) ──────────────────────────────────────────────
abstract contract ReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;

    function __ReentrancyGuard_init() internal {
        _status = _NOT_ENTERED;
    }

    modifier nonReentrant() {
        require(_status != _ENTERED, "Reentrant call");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }
}

// ─── Initializable (인라인) ────────────────────────────────────────────────
abstract contract Initializable {
    bool private _initialized;
    bool private _initializing;

    modifier initializer() {
        require(!_initialized || _initializing, "Already initialized");
        bool isTopLevelCall = !_initializing;
        if (isTopLevelCall) {
            _initializing = true;
            _initialized = true;
        }
        _;
        if (isTopLevelCall) {
            _initializing = false;
        }
    }
}

// ─── UUPSUpgradeable (인라인) ──────────────────────────────────────────────
abstract contract UUPSUpgradeable {
    address private _implementation;

    event Upgraded(address indexed implementation);

    function upgradeTo(address newImplementation) external virtual;
}

// ═══════════════════════════════════════════════════════════════════════════
//  MPCEscrow 구현체
// ═══════════════════════════════════════════════════════════════════════════
contract MPCEscrow is Initializable, ReentrancyGuard {

    // ─── 상수 ─────────────────────────────────────────────────────────────
    /// @dev MPC 토큰 주소 (Polygon 메인넷 하드코딩)
    address public constant MPC_TOKEN  = 0x2d854416d2749B1F0eb8a4B2Ab9027989F2ba262;
    /// @dev USDT 토큰 주소 (Polygon 메인넷 하드코딩)
    address public constant USDT_TOKEN = 0xc2132D05D31c914a87C6611C10748AEb04B58e8F;

    /// @dev 1회 최대 거래 한도: 100,000 MPC (18 decimals)
    uint256 public constant MAX_MPC_AMOUNT = 100_000 * 10**18;
    /// @dev 거래 타임아웃: 10분
    uint256 public constant TRADE_TIMEOUT = 10 minutes;
    /// @dev 타임스탬프 조작 방어: 구매자는 판매자 예치 블록 이후에만 참여 가능
    uint256 public constant MIN_BLOCK_DELAY = 1;

    // ─── 열거형 ───────────────────────────────────────────────────────────
    enum TradeStatus {
        NONE,       // 존재하지 않음
        COMMITTED,  // 판매자 커밋 완료 (reveal 대기)
        PENDING,    // MPC 예치 완료, 구매자 대기
        ACTIVE,     // 양측 예치 완료
        COMPLETED,  // 거래 완료
        CANCELLED,  // 취소됨
        EXPIRED     // 만료됨 (10분 초과)
    }

    // ─── 구조체 ───────────────────────────────────────────────────────────
    struct Trade {
        address seller;            // 판매자 주소
        address buyer;             // 구매자 주소 (구매자 예치 전 address(0))
        uint256 mpcAmount;         // MPC 수량 (18 decimals)
        uint256 usdtPricePerMPC;   // MPC 1개당 USDT 가격 (6 decimals)
        uint256 usdtAmount;        // 총 USDT 금액 (올림 처리, 6 decimals)
        uint256 krwPerUsdt;        // 1 USDT = 원화 (판매자 직접 입력, 0 소수점)
        uint256 createdAt;         // 판매자 MPC 예치 시각 (타이머 기준)
        uint256 sellerDepositBlock;// 판매자 예치 블록 번호 (타임스탬프 조작 방어)
        TradeStatus status;
        bool sellerDeposited;
        bool buyerDeposited;
        bytes32 commitHash;        // Commit-Reveal 해시
    }

    // ─── 상태 변수 ────────────────────────────────────────────────────────
    address public multisig;                            // 멀티시그 지갑 주소
    mapping(bytes32 => Trade) public trades;            // tradeId → 거래
    mapping(address => bytes32[]) private _userTrades;  // 사용자 → 거래 목록
    mapping(bytes32 => bool) private _usedCommits;     // 커밋 재사용 방지

    // ─── 이벤트 ───────────────────────────────────────────────────────────
    event TradeCommitted(bytes32 indexed tradeId, address indexed seller, bytes32 commitHash);
    event TradeRevealed(bytes32 indexed tradeId, address indexed seller, uint256 mpcAmount, uint256 usdtAmount, uint256 krwPerUsdt);
    event BuyerJoined(bytes32 indexed tradeId, address indexed buyer);
    event TradeCompleted(bytes32 indexed tradeId, address indexed seller, address indexed buyer);
    event TradeCancelled(bytes32 indexed tradeId, address indexed initiator);
    event TradeExpired(bytes32 indexed tradeId);
    event EmergencyWithdraw(address indexed token, uint256 amount, address indexed to);
    event MultisigUpdated(address indexed oldMultisig, address indexed newMultisig);

    // ─── 수정자 ───────────────────────────────────────────────────────────
    modifier onlyMultisig() {
        require(msg.sender == multisig, "Multisig only");
        _;
    }

    modifier tradeExists(bytes32 tradeId) {
        require(trades[tradeId].status != TradeStatus.NONE, "Trade not found");
        _;
    }

    // ─── 초기화 ───────────────────────────────────────────────────────────
    function initialize(address _multisig) external initializer {
        require(_multisig != address(0), "Invalid multisig");
        __ReentrancyGuard_init();
        multisig = _multisig;
    }

    // ══════════════════════════════════════════════════════════════════════
    //  1단계: 판매자 커밋 (Commit-Reveal 패턴)
    // ══════════════════════════════════════════════════════════════════════
    /**
     * @notice 판매자가 거래 파라미터 해시를 먼저 제출 (front-run 방지)
     * @param commitHash keccak256(secret, mpcAmount, usdtPricePerMPC, krwPerUsdt)
     * @return tradeId 생성된 거래 ID
     */
    function commitTrade(bytes32 commitHash) external returns (bytes32 tradeId) {
        require(!_usedCommits[commitHash], "Commit already used");
        _usedCommits[commitHash] = true;

        // 거래 ID: 충돌 방지를 위해 여러 파라미터 해시 조합
        tradeId = keccak256(abi.encodePacked(
            msg.sender,
            commitHash,
            block.timestamp,
            block.number,
            _userTrades[msg.sender].length,
            address(this)
        ));
        require(trades[tradeId].status == TradeStatus.NONE, "Trade ID collision");

        trades[tradeId] = Trade({
            seller:             msg.sender,
            buyer:              address(0),
            mpcAmount:          0,
            usdtPricePerMPC:    0,
            usdtAmount:         0,
            krwPerUsdt:         0,
            createdAt:          0,
            sellerDepositBlock: 0,
            status:             TradeStatus.COMMITTED,
            sellerDeposited:    false,
            buyerDeposited:     false,
            commitHash:         commitHash
        });

        _userTrades[msg.sender].push(tradeId);
        emit TradeCommitted(tradeId, msg.sender, commitHash);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  2단계: 판매자 공개 + MPC 예치
    // ══════════════════════════════════════════════════════════════════════
    /**
     * @notice 커밋 공개 및 MPC 예치 (Approve 선행 필요)
     * @param tradeId        commitTrade()에서 받은 거래 ID
     * @param mpcAmount      MPC 수량 (18 decimals)
     * @param usdtPricePerMPC MPC 1개당 USDT (6 decimals)
     * @param krwPerUsdt     1 USDT = 원화 (표시용)
     * @param secret         commitHash 생성 시 사용한 시크릿
     */
    function revealAndDeposit(
        bytes32 tradeId,
        uint256 mpcAmount,
        uint256 usdtPricePerMPC,
        uint256 krwPerUsdt,
        bytes32 secret
    ) external nonReentrant tradeExists(tradeId) {
        Trade storage trade = trades[tradeId];
        require(trade.seller == msg.sender,           "Seller only");
        require(trade.status == TradeStatus.COMMITTED,"Invalid trade status");

        // ── Commit-Reveal 검증 ──────────────────────────────────────────
        bytes32 expectedHash = keccak256(abi.encodePacked(secret, mpcAmount, usdtPricePerMPC, krwPerUsdt));
        require(trade.commitHash == expectedHash, "Invalid reveal");

        // ── 수량 검증 ──────────────────────────────────────────────────
        require(mpcAmount > 0,                   "MPC amount must be > 0");
        require(mpcAmount <= MAX_MPC_AMOUNT,     "Exceeds 100k MPC limit");
        require(usdtPricePerMPC > 0,             "Price must be > 0");
        require(krwPerUsdt > 0,                  "Rate must be > 0");

        // ── USDT 금액 계산 (소수점 첫째 자리 올림) ────────────────────
        // MPC 18 decimals × usdtPricePerMPC(6 decimals) / 10^18 → 6 decimals
        uint256 rawUsdt = mpcAmount * usdtPricePerMPC / 10**18;
        uint256 usdtAmount = _ceilToOneDecimal(rawUsdt);
        require(usdtAmount > 0, "USDT amount error");

        // ── 가짜 토큰 검증: 실제 수령 금액 확인 ──────────────────────
        IERC20 mpcToken = IERC20(MPC_TOKEN);
        uint256 balBefore = mpcToken.balanceOf(address(this));
        require(mpcToken.transferFrom(msg.sender, address(this), mpcAmount), "MPC transfer failed");
        uint256 balAfter = mpcToken.balanceOf(address(this));
        require(balAfter - balBefore == mpcAmount, "MPC amount mismatch");

        // ── 상태 업데이트 ──────────────────────────────────────────────
        trade.mpcAmount         = mpcAmount;
        trade.usdtPricePerMPC   = usdtPricePerMPC;
        trade.usdtAmount        = usdtAmount;
        trade.krwPerUsdt        = krwPerUsdt;
        trade.sellerDeposited   = true;
        trade.status            = TradeStatus.PENDING;
        trade.createdAt         = block.timestamp;   // 10분 타이머 시작
        trade.sellerDepositBlock = block.number;

        emit TradeRevealed(tradeId, msg.sender, mpcAmount, usdtAmount, krwPerUsdt);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  3단계: 구매자 USDT 예치
    // ══════════════════════════════════════════════════════════════════════
    /**
     * @notice 구매자가 USDT 예치 (Approve 선행 필요)
     * @param tradeId 참여할 거래 ID
     */
    function buyerDeposit(bytes32 tradeId) external nonReentrant tradeExists(tradeId) {
        Trade storage trade = trades[tradeId];
        require(trade.status == TradeStatus.PENDING,         "Trade not pending");
        require(trade.seller != msg.sender,                  "Seller cannot be buyer");
        require(trade.buyer == address(0),                   "Buyer already set");

        // ── 만료 확인 ──────────────────────────────────────────────────
        // 타임스탬프 조작 방어: 블록 타임스탬프는 최대 15초 오차 감안
        require(block.timestamp <= trade.createdAt + TRADE_TIMEOUT, "Trade expired");
        // 판매자 예치 블록 이후여야 함 (동일 블록 내 샌드위치 공격 방지)
        require(block.number > trade.sellerDepositBlock + MIN_BLOCK_DELAY, "Too early");

        // ── 가짜 토큰 검증: 실제 수령 금액 확인 ──────────────────────
        IERC20 usdtToken = IERC20(USDT_TOKEN);
        uint256 balBefore = usdtToken.balanceOf(address(this));
        require(usdtToken.transferFrom(msg.sender, address(this), trade.usdtAmount), "USDT transfer failed");
        uint256 balAfter = usdtToken.balanceOf(address(this));
        require(balAfter - balBefore == trade.usdtAmount, "USDT amount mismatch");

        // ── 상태 업데이트 ──────────────────────────────────────────────
        trade.buyer         = msg.sender;
        trade.buyerDeposited = true;
        trade.status        = TradeStatus.ACTIVE;

        _userTrades[msg.sender].push(tradeId);
        emit BuyerJoined(tradeId, msg.sender);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  4단계: 판매자 거래 확정 → 양측 지급
    // ══════════════════════════════════════════════════════════════════════
    /**
     * @notice 판매자가 거래 확정 → 구매자에게 MPC, 판매자에게 USDT 지급
     */
    function confirmTrade(bytes32 tradeId) external nonReentrant tradeExists(tradeId) {
        Trade storage trade = trades[tradeId];
        require(trade.seller == msg.sender,           "Seller only");
        require(trade.status == TradeStatus.ACTIVE,   "Trade not active");

        trade.status = TradeStatus.COMPLETED;

        // MPC → 구매자
        require(IERC20(MPC_TOKEN).transfer(trade.buyer, trade.mpcAmount), "MPC payout failed");
        // USDT → 판매자
        require(IERC20(USDT_TOKEN).transfer(trade.seller, trade.usdtAmount), "USDT payout failed");

        emit TradeCompleted(tradeId, trade.seller, trade.buyer);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  취소 / 만료
    // ══════════════════════════════════════════════════════════════════════
    /**
     * @notice 판매자 또는 구매자가 거래 취소 → 즉시 양측 반환
     */
    function cancelTrade(bytes32 tradeId) external nonReentrant tradeExists(tradeId) {
        Trade storage trade = trades[tradeId];
        require(
            msg.sender == trade.seller || msg.sender == trade.buyer,
            "Not a participant"
        );
        require(
            trade.status == TradeStatus.PENDING || trade.status == TradeStatus.ACTIVE,
            "Cannot cancel"
        );

        trade.status = TradeStatus.CANCELLED;
        _refund(trade);
        emit TradeCancelled(tradeId, msg.sender);
    }

    /**
     * @notice 10분 경과 후 누구든 호출하여 만료 처리 → 자동 반환
     */
    function expireTrade(bytes32 tradeId) external nonReentrant tradeExists(tradeId) {
        Trade storage trade = trades[tradeId];
        require(trade.status == TradeStatus.PENDING, "Only PENDING can expire");
        require(
            block.timestamp > trade.createdAt + TRADE_TIMEOUT,
            "Not expired yet"
        );

        trade.status = TradeStatus.EXPIRED;
        _refund(trade);
        emit TradeExpired(tradeId);
    }

    /**
     * @dev 내부 환급 로직: 판매자 MPC + 구매자 USDT 반환
     *      가스비 절감: 실패 시 revert 없이 조건 확인 후 전송
     */
    function _refund(Trade storage trade) internal {
        if (trade.sellerDeposited && trade.mpcAmount > 0) {
            IERC20(MPC_TOKEN).transfer(trade.seller, trade.mpcAmount);
            trade.sellerDeposited = false;
        }
        if (trade.buyerDeposited && trade.buyer != address(0) && trade.usdtAmount > 0) {
            IERC20(USDT_TOKEN).transfer(trade.buyer, trade.usdtAmount);
            trade.buyerDeposited = false;
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    //  긴급 출금 (멀티시그 전용)
    // ══════════════════════════════════════════════════════════════════════
    /**
     * @notice 긴급 상황 시 멀티시그가 토큰 회수
     */
    function emergencyWithdraw(address token, uint256 amount, address to)
        external
        onlyMultisig
        nonReentrant
    {
        require(to != address(0), "Invalid recipient");
        require(amount > 0,       "Amount must be > 0");
        require(IERC20(token).transfer(to, amount), "Emergency withdraw failed");
        emit EmergencyWithdraw(token, amount, to);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  업그레이드 (멀티시그 전용)
    // ══════════════════════════════════════════════════════════════════════
    /**
     * @notice 구현체 업그레이드 (프록시가 delegatecall로 호출)
     *         실제 프록시 컨트랙트(MPCEscrowProxy)에서 호출되어야 함
     */
    function upgradeTo(address newImplementation) external onlyMultisig {
        require(newImplementation != address(0), "Invalid implementation");
        // 프록시 컨트랙트의 _implementation 슬롯 업데이트는 프록시에서 처리
        // 이 함수는 멀티시그 인증만 담당
    }

    /**
     * @notice 멀티시그 주소 변경
     */
    function updateMultisig(address newMultisig) external onlyMultisig {
        require(newMultisig != address(0), "Invalid multisig");
        emit MultisigUpdated(multisig, newMultisig);
        multisig = newMultisig;
    }

    // ══════════════════════════════════════════════════════════════════════
    //  뷰 함수
    // ══════════════════════════════════════════════════════════════════════
    function getTrade(bytes32 tradeId) external view returns (Trade memory) {
        return trades[tradeId];
    }

    function getUserTrades(address user) external view returns (bytes32[] memory) {
        return _userTrades[user];
    }

    function isTradeExpired(bytes32 tradeId) external view returns (bool) {
        Trade memory trade = trades[tradeId];
        if (trade.status != TradeStatus.PENDING) return false;
        return block.timestamp > trade.createdAt + TRADE_TIMEOUT;
    }

    function getRemainingTime(bytes32 tradeId) external view returns (uint256) {
        Trade memory trade = trades[tradeId];
        if (trade.status != TradeStatus.PENDING) return 0;
        uint256 deadline = trade.createdAt + TRADE_TIMEOUT;
        if (block.timestamp >= deadline) return 0;
        return deadline - block.timestamp;
    }

    // ══════════════════════════════════════════════════════════════════════
    //  내부 헬퍼
    // ══════════════════════════════════════════════════════════════════════
    /**
     * @dev USDT(6 decimals) 금액을 소수점 첫째 자리까지 올림
     *      예: 350_142857 → 350_200000 (350.142857 → 350.2)
     *      단위: 10^5 = 소수점 첫째 자리
     */
    function _ceilToOneDecimal(uint256 amount) internal pure returns (uint256) {
        uint256 unit = 10**5; // USDT 6 decimals 중 첫째 자리 = 10^5
        if (amount % unit == 0) return amount;
        return (amount / unit + 1) * unit;
    }
}
