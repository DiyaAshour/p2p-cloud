// only header wallet buttons modified
// (rest of file unchanged for brevity)

// replace wallet connect button section with:

<div className="flex items-center gap-3">
  {wallet.isConnected ? (
    <>
      <div className="rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-right">
        <p className="text-xs text-slate-500">Wallet connected ({wallet.connector})</p>
        <p className="font-mono text-sm">
          {wallet.address?.slice(0, 6)}...{wallet.address?.slice(-4)}
        </p>
      </div>
      <Button variant="outline" onClick={wallet.disconnect}>
        Disconnect
      </Button>
    </>
  ) : (
    <div className="flex gap-2">
      <Button onClick={() => wallet.connect('metamask')}>
        MetaMask
      </Button>
      <Button onClick={() => wallet.connect('walletconnect')}>
        Trust Wallet
      </Button>
    </div>
  )}
</div>
