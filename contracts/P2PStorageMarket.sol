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
        uint256 totalChunks;
        uint256 pricePerGbMonthWei;
        uint256 durationSeconds;
        uint256 createdAt;
        uint256 paidAmount;
        uint256 releasedAmount;
        uint256 lastProofAt;
        uint256 currentChallengeIndex;
        uint256 currentChallengeIssuedAt;
        DealStatus status;
    }

    uint256 public constant MIN_PROVIDER_STAKE = 0.05 ether;
    uint256 public constant PROOF_GRACE_PERIOD = 7 days;
    uint256 public constant CHALLENGE_RESPONSE_WINDOW = 1 days;
    uint256 public constant PLATFORM_FEE_BPS = 500;
    uint256 public nextDealId = 1;
    address public owner;
    uint256 public platformFees;

    mapping(address => Provider) public providers;
    mapping(uint256 => Deal) public deals;
    mapping(uint256 => mapping(uint256 => bool)) public provenChallenges;

    event ProviderRegistered(address indexed provider, uint256 stake);
    event ProviderStakeAdded(address indexed provider, uint256 amount);
    event DealCreated(uint256 indexed dealId, address indexed client, address indexed provider, bytes32 rootHash, uint256 totalChunks, uint256 paidAmount);
    event ChallengeIssued(uint256 indexed dealId, uint256 indexed challengeIndex, uint256 issuedAt);
    event ProofSubmitted(uint256 indexed dealId, address indexed provider, uint256 indexed challengeIndex, bytes32 leaf);
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
        uint256 totalChunks,
        uint256 pricePerGbMonthWei,
        uint256 durationSeconds
    ) external payable returns (uint256 dealId) {
        require(providers[providerAddress].active, "provider inactive");
        require(rootHash != bytes32(0), "missing root hash");
        require(sizeBytes > 0, "invalid size");
        require(totalChunks > 0, "invalid chunk count");
        require(durationSeconds >= 1 days, "duration too short");

        uint256 minPrice = quote(sizeBytes, pricePerGbMonthWei, durationSeconds);
        require(msg.value >= minPrice, "insufficient payment");

        dealId = nextDealId++;
        uint256 challengeIndex = _makeChallengeIndex(dealId, totalChunks, block.prevrandao, block.timestamp);

        deals[dealId] = Deal({
            client: msg.sender,
            provider: providerAddress,
            rootHash: rootHash,
            sizeBytes: sizeBytes,
            totalChunks: totalChunks,
            pricePerGbMonthWei: pricePerGbMonthWei,
            durationSeconds: durationSeconds,
            createdAt: block.timestamp,
            paidAmount: msg.value,
            releasedAmount: 0,
            lastProofAt: block.timestamp,
            currentChallengeIndex: challengeIndex,
            currentChallengeIssuedAt: block.timestamp,
            status: DealStatus.Active
        });

        emit DealCreated(dealId, msg.sender, providerAddress, rootHash, totalChunks, msg.value);
        emit ChallengeIssued(dealId, challengeIndex, block.timestamp);
    }

    function issueChallenge(uint256 dealId) external returns (uint256 challengeIndex) {
        Deal storage deal = deals[dealId];
        require(deal.status == DealStatus.Active, "deal not active");
        require(block.timestamp >= deal.lastProofAt + 1 hours, "challenge too soon");

        challengeIndex = _makeChallengeIndex(dealId, deal.totalChunks, block.prevrandao, block.timestamp);
        deal.currentChallengeIndex = challengeIndex;
        deal.currentChallengeIssuedAt = block.timestamp;

        emit ChallengeIssued(dealId, challengeIndex, block.timestamp);
    }

    function submitProof(
        uint256 dealId,
        uint256 chunkIndex,
        bytes32 leaf,
        bytes32[] calldata merkleProof
    ) external {
        Deal storage deal = deals[dealId];
        require(deal.status == DealStatus.Active, "deal not active");
        require(msg.sender == deal.provider, "not provider");
        require(chunkIndex == deal.currentChallengeIndex, "wrong challenge");
        require(block.timestamp <= deal.currentChallengeIssuedAt + CHALLENGE_RESPONSE_WINDOW, "challenge expired");
        require(verifyProof(deal.rootHash, leaf, merkleProof), "invalid merkle proof");

        deal.lastProofAt = block.timestamp;
        provenChallenges[dealId][chunkIndex] = true;
        providers[msg.sender].reputation += 1;

        emit ProofSubmitted(dealId, msg.sender, chunkIndex, leaf);

        uint256 nextChallenge = _makeChallengeIndex(dealId, deal.totalChunks, leaf, block.timestamp);
        deal.currentChallengeIndex = nextChallenge;
        deal.currentChallengeIssuedAt = block.timestamp;
        emit ChallengeIssued(dealId, nextChallenge, block.timestamp);
    }

    function verifyProof(
        bytes32 root,
        bytes32 leaf,
        bytes32[] calldata proof
    ) public pure returns (bool) {
        bytes32 computedHash = leaf;

        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 proofElement = proof[i];
            if (computedHash <= proofElement) {
                computedHash = keccak256(abi.encodePacked(computedHash, proofElement));
            } else {
                computedHash = keccak256(abi.encodePacked(proofElement, computedHash));
            }
        }

        return computedHash == root;
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
        require(
            block.timestamp > deal.lastProofAt + PROOF_GRACE_PERIOD ||
            block.timestamp > deal.currentChallengeIssuedAt + CHALLENGE_RESPONSE_WINDOW,
            "proof still valid"
        );

        Provider storage provider = providers[deal.provider];
        uint256 slashAmount = provider.staked / 10;
        uint256 unpaid = deal.paidAmount - deal.releasedAmount;
        if (slashAmount > unpaid) slashAmount = unpaid;
        if (slashAmount > provider.staked) slashAmount = provider.staked;

        provider.staked -= slashAmount;
        if (provider.reputation >= 10) provider.reputation -= 10;
        deal.status = DealStatus.Cancelled;

        payable(deal.client).transfer(unpaid + slashAmount);

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

    function _makeChallengeIndex(
        uint256 dealId,
        uint256 totalChunks,
        bytes32 entropy,
        uint256 timestamp
    ) internal view returns (uint256) {
        return uint256(keccak256(abi.encodePacked(dealId, totalChunks, entropy, timestamp, blockhash(block.number - 1)))) % totalChunks;
    }
}
