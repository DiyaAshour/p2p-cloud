// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract P2PStorageMarket {
    enum DealStatus { Active, Completed, Cancelled }

    struct Provider {
        uint256 staked;
        uint256 earned;
        uint256 reputation;
        uint256 joinedAt;
        bool active;
    }

    struct Deal {
        address client;
        address provider;
        bytes32 rootHash;
        uint256 sizeBytes;
        uint256 pricePerGbMonthWei;
        uint256 durationSeconds;
        uint256 createdAt;
        uint256 paidAmount;
        uint256 releasedAmount;
        uint256 lastProofAt;
        DealStatus status;
    }

    uint256 public constant MIN_PROVIDER_STAKE = 0.05 ether;
    uint256 public constant PROOF_GRACE_PERIOD = 7 days;
    uint256 public constant PLATFORM_FEE_BPS = 500;
    uint256 public nextDealId = 1;
    address public owner;
    uint256 public platformFees;

    mapping(address => Provider) public providers;
    mapping(uint256 => Deal) public deals;

    event ProviderRegistered(address indexed provider, uint256 stake);
    event ProviderStakeAdded(address indexed provider, uint256 amount);
    event DealCreated(uint256 indexed dealId, address indexed client, address indexed provider, bytes32 rootHash, uint256 paidAmount);
    event ProofSubmitted(uint256 indexed dealId, address indexed provider, bytes32 proofHash);
    event RewardsReleased(uint256 indexed dealId, address indexed provider, uint256 providerAmount, uint256 platformFee);
    event ProviderSlashed(uint256 indexed dealId, address indexed provider, uint256 amount);
    event ProviderWithdraw(address indexed provider, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyActiveProvider() {
        require(providers[msg.sender].active, "not active provider");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function registerProvider() external payable {
        require(msg.value >= MIN_PROVIDER_STAKE, "stake too low");
        Provider storage provider = providers[msg.sender];
        require(!provider.active, "already active");

        provider.staked = msg.value;
        provider.reputation = 100;
        provider.joinedAt = block.timestamp;
        provider.active = true;

        emit ProviderRegistered(msg.sender, msg.value);
    }

    function addStake() external payable onlyActiveProvider {
        require(msg.value > 0, "zero stake");
        providers[msg.sender].staked += msg.value;
        emit ProviderStakeAdded(msg.sender, msg.value);
    }

    function createDeal(
        address providerAddress,
        bytes32 rootHash,
        uint256 sizeBytes,
        uint256 pricePerGbMonthWei,
        uint256 durationSeconds
    ) external payable returns (uint256 dealId) {
        require(providers[providerAddress].active, "provider inactive");
        require(rootHash != bytes32(0), "missing root hash");
        require(sizeBytes > 0, "invalid size");
        require(durationSeconds >= 1 days, "duration too short");

        uint256 minPrice = quote(sizeBytes, pricePerGbMonthWei, durationSeconds);
        require(msg.value >= minPrice, "insufficient payment");

        dealId = nextDealId++;
        deals[dealId] = Deal({
            client: msg.sender,
            provider: providerAddress,
            rootHash: rootHash,
            sizeBytes: sizeBytes,
            pricePerGbMonthWei: pricePerGbMonthWei,
            durationSeconds: durationSeconds,
            createdAt: block.timestamp,
            paidAmount: msg.value,
            releasedAmount: 0,
            lastProofAt: block.timestamp,
            status: DealStatus.Active
        });

        emit DealCreated(dealId, msg.sender, providerAddress, rootHash, msg.value);
    }

    function submitProof(uint256 dealId, bytes32 proofHash) external {
        Deal storage deal = deals[dealId];
        require(deal.status == DealStatus.Active, "deal not active");
        require(msg.sender == deal.provider, "not provider");
        require(proofHash != bytes32(0), "missing proof");

        deal.lastProofAt = block.timestamp;
        providers[msg.sender].reputation += 1;

        emit ProofSubmitted(dealId, msg.sender, proofHash);
    }

    function releaseEarned(uint256 dealId) external {
        Deal storage deal = deals[dealId];
        require(deal.status == DealStatus.Active, "deal not active");
        require(msg.sender == deal.provider || msg.sender == deal.client, "not participant");
        require(block.timestamp <= deal.lastProofAt + PROOF_GRACE_PERIOD, "proof expired");

        uint256 elapsed = block.timestamp - deal.createdAt;
        if (elapsed > deal.durationSeconds) elapsed = deal.durationSeconds;

        uint256 releasable = (deal.paidAmount * elapsed) / deal.durationSeconds;
        require(releasable > deal.releasedAmount, "nothing releasable");

        uint256 gross = releasable - deal.releasedAmount;
        deal.releasedAmount = releasable;

        uint256 fee = (gross * PLATFORM_FEE_BPS) / 10000;
        uint256 providerAmount = gross - fee;

        providers[deal.provider].earned += providerAmount;
        platformFees += fee;

        if (elapsed == deal.durationSeconds) {
            deal.status = DealStatus.Completed;
        }

        emit RewardsReleased(dealId, deal.provider, providerAmount, fee);
    }

    function slashExpiredProvider(uint256 dealId) external {
        Deal storage deal = deals[dealId];
        require(deal.status == DealStatus.Active, "deal not active");
        require(block.timestamp > deal.lastProofAt + PROOF_GRACE_PERIOD, "proof still valid");

        Provider storage provider = providers[deal.provider];
        uint256 slashAmount = provider.staked / 10;
        if (slashAmount > deal.paidAmount - deal.releasedAmount) {
            slashAmount = deal.paidAmount - deal.releasedAmount;
        }
        if (slashAmount > provider.staked) {
            slashAmount = provider.staked;
        }

        provider.staked -= slashAmount;
        if (provider.reputation >= 10) provider.reputation -= 10;
        deal.status = DealStatus.Cancelled;

        payable(deal.client).transfer(deal.paidAmount - deal.releasedAmount + slashAmount);

        emit ProviderSlashed(dealId, deal.provider, slashAmount);
    }

    function withdrawProviderEarnings() external {
        Provider storage provider = providers[msg.sender];
        uint256 amount = provider.earned;
        require(amount > 0, "nothing to withdraw");
        provider.earned = 0;
        payable(msg.sender).transfer(amount);
        emit ProviderWithdraw(msg.sender, amount);
    }

    function withdrawPlatformFees(address payable to) external onlyOwner {
        require(to != address(0), "bad recipient");
        uint256 amount = platformFees;
        platformFees = 0;
        to.transfer(amount);
    }

    function quote(uint256 sizeBytes, uint256 pricePerGbMonthWei, uint256 durationSeconds) public pure returns (uint256) {
        uint256 gb = (sizeBytes + 1_073_741_823) / 1_073_741_824;
        return (gb * pricePerGbMonthWei * durationSeconds) / 30 days;
    }
}
