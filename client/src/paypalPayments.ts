import { PAID_STORAGE_PLANS } from "./paymentConfig";

export const PAYPAL_ME_URL = "https://paypal.me/peercloud";

type PayPalPlan = { id: string; name: string; label: string; quotaBytes: number; contractPlanId: number };

function priceFromLabel(label: string) {
  const match = label.match(/\$([0-9]+(?:\.[0-9]+)?)/);
  return match ? match[1] : "";
}

export function getPayPalUrl(plan: PayPalPlan) {
  const amount = priceFromLabel(plan.label);
  const base = amount ? `${PAYPAL_ME_URL}/${amount}` : PAYPAL_ME_URL;
  const note = encodeURIComponent(`PeerCloud ${plan.name} monthly storage plan (${plan.id})`);
  return `${base}?note=${note}`;
}

export function getPlanPaidUntil() {
  return Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
}

export function getPayPalPriceLabels() {
  return Object.fromEntries(PAID_STORAGE_PLANS.map((plan) => [plan.contractPlanId, plan.label]));
}
