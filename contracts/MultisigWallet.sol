// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title MultisigWallet
 * @notice 프록시 업그레이드 및 긴급 출금 권한을 위한 멀티시그 지갑
 *         최소 2/3 서명이 있어야 실행됨
 */
contract MultisigWallet {
    // ─── 상수 ───────────────────────────────────────────────
    uint256 public constant REQUIRED_CONFIRMATIONS = 2;
    uint256 public constant MAX_OWNERS = 10;

    // ─── 상태 변수 ──────────────────────────────────────────
    address[] public owners;
    mapping(address => bool) public isOwner;
    uint256 public transactionCount;

    struct Transaction {
        address to;
        uint256 value;
        bytes data;
        bool executed;
        uint256 confirmations;
    }

    mapping(uint256 => Transaction) public transactions;
    mapping(uint256 => mapping(address => bool)) public confirmed;

    // ─── 이벤트 ─────────────────────────────────────────────
    event TransactionSubmitted(uint256 indexed txId, address indexed submitter, address indexed to, bytes data);
    event TransactionConfirmed(uint256 indexed txId, address indexed owner);
    event TransactionExecuted(uint256 indexed txId);
    event ConfirmationRevoked(uint256 indexed txId, address indexed owner);
    event OwnerAdded(address indexed owner);
    event OwnerRemoved(address indexed owner);

    // ─── 수정자 ─────────────────────────────────────────────
    modifier onlyOwner() {
        require(isOwner[msg.sender], "Multisig: owner only");
        _;
    }

    modifier txExists(uint256 txId) {
        require(txId < transactionCount, "Multisig: tx not found");
        _;
    }

    modifier notExecuted(uint256 txId) {
        require(!transactions[txId].executed, "Multisig: already executed");
        _;
    }

    modifier notConfirmed(uint256 txId) {
        require(!confirmed[txId][msg.sender], "Multisig: already confirmed");
        _;
    }

    // ─── 생성자 ─────────────────────────────────────────────
    constructor(address[] memory _owners) {
        require(_owners.length >= 2, "Multisig: min 2 owners");
        require(_owners.length <= MAX_OWNERS, "Multisig: max 10 owners");

        for (uint256 i = 0; i < _owners.length; i++) {
            address owner = _owners[i];
            require(owner != address(0), "Multisig: invalid address");
            require(!isOwner[owner], "Multisig: duplicate owner");
            isOwner[owner] = true;
            owners.push(owner);
            emit OwnerAdded(owner);
        }
    }

    // ─── 트랜잭션 제출 ───────────────────────────────────────
    function submitTransaction(address to, uint256 value, bytes calldata data)
        external
        onlyOwner
        returns (uint256 txId)
    {
        txId = transactionCount;
        transactions[txId] = Transaction({
            to: to,
            value: value,
            data: data,
            executed: false,
            confirmations: 0
        });
        transactionCount++;
        emit TransactionSubmitted(txId, msg.sender, to, data);
    }

    // ─── 트랜잭션 서명 ───────────────────────────────────────
    function confirmTransaction(uint256 txId)
        external
        onlyOwner
        txExists(txId)
        notExecuted(txId)
        notConfirmed(txId)
    {
        confirmed[txId][msg.sender] = true;
        transactions[txId].confirmations++;
        emit TransactionConfirmed(txId, msg.sender);

        // 서명 수 충족 시 자동 실행
        if (transactions[txId].confirmations >= REQUIRED_CONFIRMATIONS) {
            _executeTransaction(txId);
        }
    }

    // ─── 서명 철회 ───────────────────────────────────────────
    function revokeConfirmation(uint256 txId)
        external
        onlyOwner
        txExists(txId)
        notExecuted(txId)
    {
        require(confirmed[txId][msg.sender], "Multisig: not confirmed");
        confirmed[txId][msg.sender] = false;
        transactions[txId].confirmations--;
        emit ConfirmationRevoked(txId, msg.sender);
    }

    // ─── 내부 실행 ───────────────────────────────────────────
    function _executeTransaction(uint256 txId) internal {
        Transaction storage txn = transactions[txId];
        txn.executed = true;
        (bool success, ) = txn.to.call{value: txn.value}(txn.data);
        require(success, "Multisig: execution failed");
        emit TransactionExecuted(txId);
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function getTransaction(uint256 txId)
        external
        view
        returns (address to, uint256 value, bytes memory data, bool executed, uint256 confirmations)
    {
        Transaction memory txn = transactions[txId];
        return (txn.to, txn.value, txn.data, txn.executed, txn.confirmations);
    }

    receive() external payable {}
}
