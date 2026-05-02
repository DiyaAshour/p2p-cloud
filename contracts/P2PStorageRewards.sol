// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract P2PStorageRewards {
    address public owner;
    uint256 public rewardPool;

    struct NodeStats {
        uint256 storedChunks;
        uint256 servedChunks;
        uint256 uptimeScore;
        uint256 rewardPoints;
        uint256 claimedWei;
        bool registered;
    }

    mapping(address => NodeStats) public nodes;
    mapping(address => uint256) public storageQuotaGb;

    event NodeRegistered(address indexed node);
    event StatsSubmitted(address indexed node, uint256 storedChunks, uint256 servedChunks, uint256 uptimeScore, uint256 rewardPoints);
    event StoragePurchased(address indexed user, uint256 storageGb, uint256 paidWei);
    event RewardClaimed(address indexed node, uint256 amountWei);
    event RewardPoolFunded(address indexed sender, uint256 amountWei);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    receive() external payable {
        rewardPool += msg.value;
        emit RewardPoolFunded(msg.sender, msg.value);
    }

    function registerNode() external {
        require(!nodes[msg.sender].registered, "already registered");
        nodes[msg.sender].registered = true;
        emit NodeRegistered(msg.sender);
    }

    function buyStorage(uint256 storageGb) external payable {
        require(storageGb > 0, "storage required");
        require(msg.value > 0, "payment required");
        storageQuotaGb[msg.sender] += storageGb;
        rewardPool += msg.value;
        emit StoragePurchased(msg.sender, storageGb, msg.value);
    }

    function submitNodeStats(
        address node,
        uint256 storedChunks,
        uint256 servedChunks,
        uint256 uptimeScore
    ) external onlyOwner {
        require(nodes[node].registered, "node not registered");
        uint256 points = storedChunks + (servedChunks * 2) + (uptimeScore * 5);
        nodes[node].storedChunks = storedChunks;
        nodes[node].servedChunks = servedChunks;
        nodes[node].uptimeScore = uptimeScore;
        nodes[node].rewardPoints = points;
        emit StatsSubmitted(node, storedChunks, servedChunks, uptimeScore, points);
    }

    function claimReward(uint256 amountWei) external {
        NodeStats storage stats = nodes[msg.sender];
        require(stats.registered, "node not registered");
        require(stats.rewardPoints > 0, "no points");
        require(amountWei <= rewardPool, "pool too low");

        stats.claimedWei += amountWei;
        rewardPool -= amountWei;
        payable(msg.sender).transfer(amountWei);
        emit RewardClaimed(msg.sender, amountWei);
    }

    function getQuota(address user) external view returns (uint256) {
        uint256 quota = storageQuotaGb[user];
        if (quota < 5) {
            return 5;
        }
        return quota;
    }
}
