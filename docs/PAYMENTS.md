# p2p.cloud Payments

Treasury wallet:

```text
0x870dc8c138634B3d9E93Dbe6ed9bee511C36D257
```

## Security model

Users should never type or paste a transaction hash manually.

The app must create the payment transaction itself:

```text
to = deployed P2PCloudSubscriptions contract
value = selected plan price
```

The contract forwards the payment to the treasury wallet and records the buyer subscription on-chain.

Direct payments to another wallet do not unlock storage because the contract will not record an active subscription.

## Contract

```text
contracts/P2PCloudSubscriptions.sol
```

Important methods:

```solidity
purchasePlan(uint8 planId)
purchaseBestMatchingPlan()
getSubscription(address user)
```

## Plans

Plan ids are app-defined:

```text
1 = 1 TB
3 = 3 TB
7 = 7 TB
10 = 10 TB
```

The deployer/owner must configure prices and quotas with `setPlan` after deployment.

## MVP deployment flow

1. Deploy `P2PCloudSubscriptions` with the treasury wallet.
2. Configure plans on the contract.
3. Put the deployed address in the app config/env.
4. User connects wallet.
5. User selects a plan.
6. App sends a transaction to the contract.
7. Contract forwards funds to treasury and records subscription.
8. App reads `getSubscription(user)` and unlocks quota.

## Do not

- Do not store private keys in the app.
- Do not accept user-provided tx hashes as proof.
- Do not unlock plans for direct transfers to arbitrary addresses.
- Do not unlock paid storage unless the contract reports an active subscription.
