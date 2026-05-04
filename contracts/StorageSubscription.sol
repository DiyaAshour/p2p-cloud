// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract StorageSubscription {
    address public owner;
    address public treasury;

    struct Plan {
        uint256 priceWei;
        uint256 quotaBytes;
        bool active;
    }

    struct Subscription {
        uint8 planId;
        uint256 paidUntil;
        uint256 quotaBytes;
        bool active;
    }

    mapping(uint8 => Plan) public plans;
    mapping(address => Subscription) private subscriptions;

    event PlanUpdated(uint8 indexed planId, uint256 priceWei, uint256 quotaBytes, bool active);
    event SubscriptionPurchased(address indexed user, uint8 indexed planId, uint256 paidUntil, uint256 quotaBytes, uint256 paidWei);
    event TreasuryUpdated(address indexed treasury);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address initialTreasury) {
        require(initialTreasury != address(0), "treasury required");
        owner = msg.sender;
        treasury = initialTreasury;

        plans[1] = Plan(0.0003 ether, 1 * 1024 ** 4, true);
        plans[3] = Plan(0.0007 ether, 3 * 1024 ** 4, true);
        plans[7] = Plan(0.001 ether, 7 * 1024 ** 4, true);
        plans[10] = Plan(0.0015 ether, 10 * 1024 ** 4, true);
    }

    function setPlan(uint8 planId, uint256 priceWei, uint256 quotaBytes, bool active) external onlyOwner {
        require(planId > 0, "invalid plan");
        require(quotaBytes > 0, "invalid quota");
        plans[planId] = Plan(priceWei, quotaBytes, active);
        emit PlanUpdated(planId, priceWei, quotaBytes, active);
    }

    function setTreasury(address nextTreasury) external onlyOwner {
        require(nextTreasury != address(0), "treasury required");
        treasury = nextTreasury;
        emit TreasuryUpdated(nextTreasury);
    }

    function transferOwnership(address nextOwner) external onlyOwner {
        require(nextOwner != address(0), "owner required");
        emit OwnershipTransferred(owner, nextOwner);
        owner = nextOwner;
    }

    function purchasePlan(uint8 planId) external payable {
        Plan memory plan = plans[planId];
        require(plan.active, "inactive plan");
        require(plan.priceWei > 0, "price not configured");
        require(msg.value >= plan.priceWei, "insufficient ETH");

        uint256 currentPaidUntil = subscriptions[msg.sender].paidUntil;
        uint256 startsAt = currentPaidUntil > block.timestamp ? currentPaidUntil : block.timestamp;
        uint256 paidUntil = startsAt + 30 days;

        subscriptions[msg.sender] = Subscription({
            planId: planId,
            paidUntil: paidUntil,
            quotaBytes: plan.quotaBytes,
            active: true
        });

        (bool sent, ) = payable(treasury).call{value: msg.value}("");
        require(sent, "treasury transfer failed");

        emit SubscriptionPurchased(msg.sender, planId, paidUntil, plan.quotaBytes, msg.value);
    }

    function getSubscription(address user) external view returns (uint8 planId, uint256 paidUntil, uint256 quotaBytes, bool active) {
        Subscription memory subscription = subscriptions[user];
        bool isActive = subscription.active && subscription.paidUntil >= block.timestamp;
        return (subscription.planId, subscription.paidUntil, subscription.quotaBytes, isActive);
    }
}
