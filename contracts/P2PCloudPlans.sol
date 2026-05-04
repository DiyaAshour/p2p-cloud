// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title P2PCloudPlans
/// @notice On-chain subscription and quota registry for p2p.cloud.
/// @dev MVP production-safe shape: native token payments, owner-managed plans, wallet plan expiry.
contract P2PCloudPlans {
    address public owner;
    address payable public treasury;

    struct Plan {
        uint256 priceWei;
        uint256 quotaBytes;
        uint256 durationSeconds;
        bool active;
        string name;
    }

    struct Subscription {
        uint256 planId;
        uint256 paidUntil;
        uint256 quotaBytes;
    }

    mapping(uint256 => Plan) public plans;
    mapping(address => Subscription) public subscriptions;
    uint256 public planCount;

    event PlanSet(uint256 indexed planId, string name, uint256 priceWei, uint256 quotaBytes, uint256 durationSeconds, bool active);
    event Subscribed(address indexed wallet, uint256 indexed planId, uint256 paidUntil, uint256 quotaBytes, uint256 paidAmountWei);
    event TreasuryUpdated(address indexed treasury);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor(address payable initialTreasury) {
        require(initialTreasury != address(0), "BAD_TREASURY");
        owner = msg.sender;
        treasury = initialTreasury;

        _setPlan(1, "1 TB", 0.00035 ether, 1 * 1024 ** 4, 30 days, true);
        _setPlan(3, "3 TB", 0.0009 ether, 3 * 1024 ** 4, 30 days, true);
        _setPlan(7, "7 TB", 0.0018 ether, 7 * 1024 ** 4, 30 days, true);
        _setPlan(10, "10 TB", 0.0028 ether, 10 * 1024 ** 4, 30 days, true);
    }

    function setPlan(uint256 planId, string calldata name, uint256 priceWei, uint256 quotaBytes, uint256 durationSeconds, bool active) external onlyOwner {
        _setPlan(planId, name, priceWei, quotaBytes, durationSeconds, active);
    }

    function _setPlan(uint256 planId, string memory name, uint256 priceWei, uint256 quotaBytes, uint256 durationSeconds, bool active) internal {
        require(planId > 0, "BAD_PLAN_ID");
        require(quotaBytes > 0, "BAD_QUOTA");
        require(durationSeconds >= 1 days, "BAD_DURATION");
        if (plans[planId].durationSeconds == 0) planCount += 1;
        plans[planId] = Plan(priceWei, quotaBytes, durationSeconds, active, name);
        emit PlanSet(planId, name, priceWei, quotaBytes, durationSeconds, active);
    }

    function subscribe(uint256 planId) external payable {
        Plan memory plan = plans[planId];
        require(plan.active, "PLAN_INACTIVE");
        require(msg.value >= plan.priceWei, "INSUFFICIENT_PAYMENT");

        uint256 start = block.timestamp;
        if (subscriptions[msg.sender].paidUntil > block.timestamp) {
            start = subscriptions[msg.sender].paidUntil;
        }

        uint256 paidUntil = start + plan.durationSeconds;
        subscriptions[msg.sender] = Subscription(planId, paidUntil, plan.quotaBytes);

        (bool ok,) = treasury.call{value: msg.value}("");
        require(ok, "TREASURY_TRANSFER_FAILED");

        emit Subscribed(msg.sender, planId, paidUntil, plan.quotaBytes, msg.value);
    }

    function hasActiveSubscription(address wallet) external view returns (bool) {
        return subscriptions[wallet].paidUntil >= block.timestamp;
    }

    function effectiveQuota(address wallet, uint256 freeQuotaBytes) external view returns (uint256) {
        Subscription memory sub = subscriptions[wallet];
        if (sub.paidUntil >= block.timestamp && sub.quotaBytes > freeQuotaBytes) return sub.quotaBytes;
        return freeQuotaBytes;
    }

    function setTreasury(address payable nextTreasury) external onlyOwner {
        require(nextTreasury != address(0), "BAD_TREASURY");
        treasury = nextTreasury;
        emit TreasuryUpdated(nextTreasury);
    }

    function transferOwnership(address nextOwner) external onlyOwner {
        require(nextOwner != address(0), "BAD_OWNER");
        emit OwnershipTransferred(owner, nextOwner);
        owner = nextOwner;
    }
}
