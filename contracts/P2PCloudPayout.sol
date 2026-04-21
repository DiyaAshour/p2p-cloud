// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract P2PCloudPayout {
    address public owner;

    mapping(address => uint256) public balances;

    event EarningsCredited(address indexed node, uint256 amount);
    event Withdrawn(address indexed node, uint256 amount);
    event Deposited(address indexed from, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    function creditNode(address node, uint256 amountWei) external onlyOwner {
        require(node != address(0), "Invalid node");
        require(amountWei > 0, "Amount must be > 0");
        balances[node] += amountWei;
        emit EarningsCredited(node, amountWei);
    }

    function creditMany(address[] calldata nodes, uint256[] calldata amountsWei) external onlyOwner {
        require(nodes.length == amountsWei.length, "Length mismatch");
        for (uint256 i = 0; i < nodes.length; i++) {
            require(nodes[i] != address(0), "Invalid node");
            require(amountsWei[i] > 0, "Amount must be > 0");
            balances[nodes[i]] += amountsWei[i];
            emit EarningsCredited(nodes[i], amountsWei[i]);
        }
    }

    function withdraw() external {
        uint256 amount = balances[msg.sender];
        require(amount > 0, "No balance");
        balances[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Transfer failed");
        emit Withdrawn(msg.sender, amount);
    }
}
