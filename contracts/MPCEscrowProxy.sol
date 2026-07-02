// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title MPCEscrowProxy
 * @notice EIP-1967 기반 투명 프록시 컨트랙트
 *         구현체는 MPCEscrow.sol
 *         업그레이드 권한: MultisigWallet을 통해서만 가능
 *
 * 슬롯:
 *   _IMPLEMENTATION_SLOT = keccak256("eip1967.proxy.implementation") - 1
 *   _ADMIN_SLOT          = keccak256("eip1967.proxy.admin") - 1
 */
contract MPCEscrowProxy {

    // EIP-1967 표준 슬롯
    bytes32 private constant _IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 private constant _ADMIN_SLOT =
        0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    event Upgraded(address indexed implementation);
    event AdminChanged(address indexed previousAdmin, address indexed newAdmin);

    // ─── 생성자 ─────────────────────────────────────────────────────────
    /**
     * @param _logic      MPCEscrow 구현체 주소
     * @param _admin      멀티시그 지갑 주소 (업그레이드 권한자)
     * @param _initData   initialize() ABI 인코딩 데이터
     */
    constructor(address _logic, address _admin, bytes memory _initData) {
        require(_logic != address(0), "No implementation");
        require(_admin != address(0), "No admin");

        _setImplementation(_logic);
        _setAdmin(_admin);

        if (_initData.length > 0) {
            (bool success, ) = _logic.delegatecall(_initData);
            require(success, "Init failed");
        }
    }

    // ─── 관리자 함수 ─────────────────────────────────────────────────────
    /**
     * @notice 구현체 업그레이드 (관리자=Multisig only)
     */
    function upgradeTo(address newImplementation) external {
        require(msg.sender == _getAdmin(), "Proxy: admin only");
        require(newImplementation != address(0), "Invalid implementation");
        require(_isContract(newImplementation),  "Proxy: not a contract");
        _setImplementation(newImplementation);
        emit Upgraded(newImplementation);
    }

    /**
     * @notice 관리자 변경 (기존 관리자만 가능)
     */
    function changeAdmin(address newAdmin) external {
        require(msg.sender == _getAdmin(), "Proxy: admin change only");
        require(newAdmin != address(0), "Proxy: invalid admin");
        emit AdminChanged(_getAdmin(), newAdmin);
        _setAdmin(newAdmin);
    }

    /**
     * @notice 현재 구현체 주소 조회
     */
    function implementation() external view returns (address) {
        return _getImplementation();
    }

    /**
     * @notice 현재 관리자 주소 조회
     */
    function admin() external view returns (address) {
        return _getAdmin();
    }

    // ─── Fallback / Receive ─────────────────────────────────────────────
    fallback() external payable {
        _delegate(_getImplementation());
    }

    receive() external payable {
        _delegate(_getImplementation());
    }

    // ─── 내부 함수 ───────────────────────────────────────────────────────
    function _delegate(address impl) internal {
        assembly {
            // calldata를 메모리에 복사
            calldatacopy(0, 0, calldatasize())
            // delegatecall 실행
            let result := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            // 반환 데이터 복사
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    function _getImplementation() internal view returns (address impl) {
        bytes32 slot = _IMPLEMENTATION_SLOT;
        assembly { impl := sload(slot) }
    }

    function _setImplementation(address impl) internal {
        bytes32 slot = _IMPLEMENTATION_SLOT;
        assembly { sstore(slot, impl) }
    }

    function _getAdmin() internal view returns (address adm) {
        bytes32 slot = _ADMIN_SLOT;
        assembly { adm := sload(slot) }
    }

    function _setAdmin(address adm) internal {
        bytes32 slot = _ADMIN_SLOT;
        assembly { sstore(slot, adm) }
    }

    function _isContract(address addr) internal view returns (bool) {
        uint256 size;
        assembly { size := extcodesize(addr) }
        return size > 0;
    }
}
