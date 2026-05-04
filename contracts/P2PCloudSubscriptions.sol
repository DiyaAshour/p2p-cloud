// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract P2PCloudSubscriptions {
    struct Plan { uint256 priceWei; uint256 quotaBytes; bool active; }
    struct Subscription { uint8 planId; uint256 paidUntil; uint256 quotaBytes; }

    address payable public immutable treasury;
    address public owner;
    uint256 public constant PERIOD = 30 days;

    mapping(uint8 => Plan) public plans;
    mapping(address => Subscription) public subscriptions;

    event PlanUpdated(uint8 indexed planId, uint256 priceWei, uint256 quotaBytes, bool active);
    event PlanPurchased(address indexed buyer, uint8 indexed planId, uint256 amountWei, uint256 paidUntil, uint256 quotaBytes);
    event OwnerChanged(address indexed oldOwner, address indexed newOwner);

    modifier onlyOwner() { require(msg.sender == owner, "NOT_OWNER"); _; }

    constructor(address payable treasuryWallet) {
        require(treasuryWallet != address(0), "BAD_TREASURY");
        treasury = treasuryWallet;
        owner = msg.sender;
    }

    receive() external payable { _purchaseBestMatchingPlan(); }

    function setOwner(address newOwner) external onlyOwner {
        require(newOwner != address(0), "BAD_OWNER");
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    function setPlan(uint8 planId, uint256 priceWei, uint256 quotaBytes, bool active) external onlyOwner {
        require(planId > 0, "BAD_PLAN");
        plans[planId] = Plan(priceWei, quotaBytes, active);
        emit PlanUpdated(planId, priceWei, quotaBytes, active);
    }

    function purchasePlan(uint8 planId) external payable {
        Plan memory plan = plans[planId];
        require(plan.active, "PLAN_INACTIVE");
        require(msg.value >= plan.priceWei, "INSUFFICIENT_PAYMENT");
        _recordAndForward(planId, plan, msg.value);
    }

    function purchaseBestMatchingPlan() external payable { _purchaseBestMatchingPlan(); }

    function _purchaseBestMatchingPlan() internal {
        uint8 bestPlanId = 0;
        Plan memory bestPlan;
        for (uint8 i = 1; i <= 10; i++) {
            Plan memory p = plans[i];
            if (p.active && p.priceWei > 0 && msg.value >= p.priceWei && p.priceWei >= bestPlan.priceWei) {
                bestPlanId = i;
                bestPlan = p;
            }
        }
        require(bestPlanId != 0, "NO_MATCHING_PLAN");
        _recordAndForward(bestPlanId, bestPlan, msg.value);
    }

    function _recordAndForward(uint8 planId, Plan memory plan, uint256 amountWei) internal {
        uint256 start = subscriptions[msg.sender].paidUntil > block.timestamp ? subscriptions[msg.sender].paidUntil : block.timestamp;
        uint256 nextPaidUntil = start + PERIOD;
        subscriptions[msg.sender] = Subscription(planId, nextPaidUntil, plan.quotaBytes);
        (bool ok, ) = treasury.call{ value: amountWei }("");
        require(ok, "TREASURY_TRANSFER_FAILED");
        emit PlanPurchased(msg.sender, planId, amountWei, nextPaidUntil, plan.quotaBytes);
    }

    function getSubscription(address user) external view returns (uint8 planId, uint256 paidUntil, uint256 quotaBytes, bool active) {
        Subscription memory sub = subscriptions[user];
        return (sub.planId, sub.paidUntil, sub.quotaBytes, sub.paidUntil >= block.timestamp);
    }
}
