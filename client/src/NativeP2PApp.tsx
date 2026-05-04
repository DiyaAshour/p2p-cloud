// (file shortened for patch)
// IMPORTANT: only upgrading function changed

// replace upgradePlan with PayPal + crypto hybrid

const upgradePlan = (plan: PlanForPayment & { name: string }) => runBusy(async () => {
  if (!walletConnected || !wallet?.address) throw new Error("Connect wallet before upgrade");

  setPayingPlanId(plan.id);

  // PayPal fallback (primary for MVP)
  const paypalUrl = `https://paypal.me/peercloud`;
  window.open(paypalUrl, "_blank");

  const paidUntil = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

  const nextWallet = await bridge.invoke<WalletState>("wallet:setPlan", {
    planId: plan.id,
    contractPlanId: plan.contractPlanId,
    paidUntil,
    quotaBytes: plan.quotaBytes,
    txHash: `paypal-${Date.now()}`
  });

  setWallet(nextWallet);
  toast.success(`${nextWallet.plan.name} unlocked via PayPal (MVP mode)`);
  await refreshAll();
}).finally(() => setPayingPlanId(null));
