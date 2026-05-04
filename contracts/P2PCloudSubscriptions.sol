// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title p2p.cloud subscriptions
/// @notice Native-token subscription contract. Payments are forwarded to treasury immediately.
contract P2PCloudSubscriptions {
    struct Plan {
        uint256 priceWei;
        uint256 quotaBytes;
        bool active;
    }

    struct Subscription {
        uint8 planId;
        uint256 paidUntil;
        uint256 quotaBytes;
    }

    address payable public immutable treasury;
    address public owner;
    uint256 public constant PERIOD = 30 days;

    mapping(uint8 => Plan) public plans;
    mapping(address => Subscription) public subscriptions;

    event PlanUpdated(uint8 indexed planId, uint256 priceWei, uint256 quotaBytes, bool active);
    event PlanPurchased(address indexed buyer, uint8 indexed planId, uint256 amountWei, uint256 paidUntil, uint256 quotaBytes);
    event OwnerChanged(address indexed oldOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor(address payable treasuryWallet) {
        require(treasuryWallet != address(0), "BAD_TREASURY");
        treasury = treasuryWallet;
        owner = msg.sender;
    }

    function setOwner(address newOwner) external onlyOwner {
        require(newOwner != address(0), "BAD_OWNER");
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    function setPlan(uint8 planId, uint256 priceWei, uint256 quotaBytes, bool active) external onlyOwner {
        require(planId > 0, "BAD_PLAN");
        plans[planId] = Plan({ priceWei: priceWei, quotaBytes: quotaBytes, active: active });
        emit PlanUpdated(planId, priceWei, quotaBytes, active);
    }

    function purchasePlan(uint8 planId) external payable {
        Plan memory plan = plans[planId];
        require(plan.active, "PLAN_INACTIVE");
        require(msg.value >= plan.priceWei, "INSUFFICIENT_PAYMENT");

        uint256 currentPaidUntil = subscriptions[msg.sender].paidUntil;
        uint256 start = currentPaidUntil > block.timestamp ? currentPaidUntil : block.timestamp;
        uint256 nextPaidUntil = start + PERIOD;

        subscriptions[msg.sender] = Subscription({
            planId: planId,
            paidUntil: nextPaidUntil,
            quotaBytes: plan.quotaBytes
        });

        (bool ok, ) = treasury.call{ value: msg.value }("");
        require(ok, "TREASURY_TRANSFER_FAILED");

        emit PlanPurchased(msg.sender, planId, msg.value, nextPaidUntil, plan.quotaBytes);
    }

    function getSubscription(address user) external view returns (uint8 planId, uint256 paidUntil, uint256 quotaBytes, bool active) {
        Subscription memory sub = subscriptions[user];
        return (sub.planId, sub.paidUntil, sub.quotaBytes, sub.paidUntil >= block.timestamp);
    }
}
