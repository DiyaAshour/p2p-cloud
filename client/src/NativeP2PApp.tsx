// ONLY RELEVANT PART UPDATED
import { connectWalletWithWalletConnect } from "./walletConnect";

// replace connectWallet function
const connectWallet = () => runBusy(async () => {
  const result = await connectWalletWithWalletConnect();
  const nextWallet = await bridge.invoke("wallet:connect", { address: result.address });
  setWallet(nextWallet);
  toast.success("Wallet connected via WalletConnect");
  await refreshAll();
});

// replace UI block (remove input)
<div className="flex flex-col gap-2 sm:flex-row">
  {walletConnected ? (
    <Button variant="destructive" onClick={disconnectWallet} disabled={busy}>Disconnect</Button>
  ) : (
    <Button onClick={connectWallet} disabled={busy}>
      <Wallet className="size-4" />Connect Wallet
    </Button>
  )}
</div>
