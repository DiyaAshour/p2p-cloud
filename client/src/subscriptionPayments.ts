import { PAYMENT_CONTRACT_ADDRESS, PAYMENT_RPC_URL, SUBSCRIPTION_ABI } from "./paymentConfig";
import { requestWalletPayment } from "./walletConnect";

type PlanConfig = { contractPlanId: number; id: string; quotaBytes: number };
type ContractPlan = { priceWei: bigint; quotaBytes: bigint; active: boolean };
type SubscriptionState = { planId: number; paidUntil: number; quotaBytes: number; active: boolean };

const SELECTOR_PURCHASE_PLAN = "0x1b86a4a1";
const SELECTOR_GET_SUBSCRIPTION = "0x7a6e2e0d";
const SELECTOR_PLANS = "0x86298f49";

function assertContract() {
  if (!/^0x[a-fA-F0-9]{40}$/.test(PAYMENT_CONTRACT_ADDRESS)) {
    throw new Error("Payment contract is not configured. Set VITE_PAYMENT_CONTRACT_ADDRESS after deployment.");
  }
}

function pad32(hex: string) {
  return hex.replace(/^0x/, "").padStart(64, "0");
}

function encodeUint8(value: number) {
  return pad32(`0x${Number(value).toString(16)}`);
}

function encodeAddress(address: string) {
  return pad32(address.toLowerCase());
}

function hexToBigInt(hex: string) {
  return BigInt(hex || "0x0");
}

function chunks64(data: string) {
  const clean = data.replace(/^0x/, "");
  const out: string[] = [];
  for (let i = 0; i < clean.length; i += 64) out.push(clean.slice(i, i + 64));
  return out;
}

async function rpcCall(to: string, data: string) {
  const res = await fetch(PAYMENT_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || "RPC call failed");
  return String(body.result || "0x");
}

export async function getContractPlan(planId: number): Promise<ContractPlan> {
  assertContract();
  const data = `${SELECTOR_PLANS}${encodeUint8(planId)}`;
  const result = await rpcCall(PAYMENT_CONTRACT_ADDRESS, data);
  const [price, quota, active] = chunks64(result);
  return { priceWei: hexToBigInt(`0x${price || "0"}`), quotaBytes: hexToBigInt(`0x${quota || "0"}`), active: hexToBigInt(`0x${active || "0"}`) === 1n };
}

export async function getSubscription(address: string): Promise<SubscriptionState> {
  assertContract();
  const data = `${SELECTOR_GET_SUBSCRIPTION}${encodeAddress(address)}`;
  const result = await rpcCall(PAYMENT_CONTRACT_ADDRESS, data);
  const [planId, paidUntil, quotaBytes, active] = chunks64(result);
  return {
    planId: Number(hexToBigInt(`0x${planId || "0"}`)),
    paidUntil: Number(hexToBigInt(`0x${paidUntil || "0"}`)),
    quotaBytes: Number(hexToBigInt(`0x${quotaBytes || "0"}`)),
    active: hexToBigInt(`0x${active || "0"}`) === 1n,
  };
}

export async function purchasePlanWithWallet(walletAddress: string, plan: PlanConfig) {
  assertContract();
  const contractPlan = await getContractPlan(plan.contractPlanId);
  if (!contractPlan.active) throw new Error("Selected plan is not active on-chain yet");
  if (contractPlan.priceWei <= 0n) throw new Error("Selected plan price is not configured on-chain yet");
  const data = `${SELECTOR_PURCHASE_PLAN}${encodeUint8(plan.contractPlanId)}`;
  const txHash = await requestWalletPayment({
    from: walletAddress,
    to: PAYMENT_CONTRACT_ADDRESS,
    value: `0x${contractPlan.priceWei.toString(16)}`,
    data,
  });
  return { txHash, priceWei: contractPlan.priceWei, contractPlan };
}

export { SUBSCRIPTION_ABI };
