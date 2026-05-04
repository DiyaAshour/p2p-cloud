import { createPublicClient, encodeFunctionData, http, type Address } from "viem";
import { sepolia } from "viem/chains";
import { PAYMENT_CONTRACT_ADDRESS, PAYMENT_RPC_URL, SUBSCRIPTION_ABI } from "./paymentConfig";
import { requestWalletPayment } from "./walletConnect";

export type PlanForPayment = { id: string; contractPlanId: number; quotaBytes: number };
export type SubscriptionState = { planId: number; paidUntil: number; quotaBytes: number; active: boolean };

const client = createPublicClient({ chain: sepolia, transport: http(PAYMENT_RPC_URL) });

function getContractAddress(): Address {
  if (!/^0x[a-fA-F0-9]{40}$/.test(PAYMENT_CONTRACT_ADDRESS)) {
    throw new Error("Payment contract is not configured. Set VITE_PAYMENT_CONTRACT_ADDRESS after deployment.");
  }
  return PAYMENT_CONTRACT_ADDRESS as Address;
}

export async function readPlanPrice(planId: number) {
  const result = await client.readContract({
    address: getContractAddress(),
    abi: SUBSCRIPTION_ABI,
    functionName: "plans",
    args: [planId],
  }) as readonly [bigint, bigint, boolean];
  return { priceWei: result[0], quotaBytes: result[1], active: result[2] };
}

export async function readSubscription(address: string): Promise<SubscriptionState> {
  const result = await client.readContract({
    address: getContractAddress(),
    abi: SUBSCRIPTION_ABI,
    functionName: "getSubscription",
    args: [address as Address],
  }) as readonly [number, bigint, bigint, boolean];
  return { planId: Number(result[0]), paidUntil: Number(result[1]), quotaBytes: Number(result[2]), active: Boolean(result[3]) };
}

export async function payForPlan(walletAddress: string, plan: PlanForPayment) {
  const onchainPlan = await readPlanPrice(plan.contractPlanId);
  if (!onchainPlan.active) throw new Error("This plan is not active on-chain yet");
  if (onchainPlan.priceWei <= 0n) throw new Error("This plan price is not configured on-chain yet");
  const data = encodeFunctionData({ abi: SUBSCRIPTION_ABI, functionName: "purchasePlan", args: [plan.contractPlanId] });
  const paymentHash = await requestWalletPayment({
    from: walletAddress,
    to: getContractAddress(),
    value: `0x${onchainPlan.priceWei.toString(16)}`,
    data,
  });
  return { paymentHash, onchainPlan };
}
