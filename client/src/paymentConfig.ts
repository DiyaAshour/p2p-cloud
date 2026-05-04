export const TREASURY_WALLET = "0x870dc8c138634B3d9E93Dbe6ed9bee511C36D257";
export const PAYMENT_CHAIN_ID = "1";
export const PAYMENT_CHAIN_NAME = "Ethereum";
export const PAYMENT_CONTRACT_ADDRESS = import.meta.env.VITE_PAYMENT_CONTRACT_ADDRESS || "";
export const PAYMENT_RPC_URL = "https://ethereum-rpc.publicnode.com";
export const PAYMENT_RPC_URLS = [
  PAYMENT_RPC_URL,
  "https://rpc.ankr.com/eth",
  "https://cloudflare-eth.com",
];

export const PAID_STORAGE_PLANS = [
  { id: "tb1", contractPlanId: 1, name: "1 TB", quotaBytes: 1 * 1024 ** 4, label: "$1/month" },
  { id: "tb3", contractPlanId: 3, name: "3 TB", quotaBytes: 3 * 1024 ** 4, label: "$2.50/month" },
  { id: "tb7", contractPlanId: 7, name: "7 TB", quotaBytes: 7 * 1024 ** 4, label: "$4.99/month" },
  { id: "tb10", contractPlanId: 10, name: "10 TB", quotaBytes: 10 * 1024 ** 4, label: "$7.99/month" },
];

export const SUBSCRIPTION_ABI = [
  "function purchasePlan(uint8 planId) payable",
  "function getSubscription(address user) view returns (uint8 planId,uint256 paidUntil,uint256 quotaBytes,bool active)",
  "function plans(uint8 planId) view returns (uint256 priceWei,uint256 quotaBytes,bool active)",
] as const;
