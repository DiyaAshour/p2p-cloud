import { useEffect, useState } from "react";

const ipc = (window as any).electron?.ipcRenderer;

export default function Onboarding({ onReady }) {
  const [step, setStep] = useState(0);
  const [wallet, setWallet] = useState<string | null>(null);
  const [disk, setDisk] = useState({ total: 0, free: 0 });
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    const init = async () => {
      if (!ipc) return;

      const existing = await ipc.invoke("onboarding:read");
      if (existing?.wallet && existing?.storage) {
        onReady();
        return;
      }

      const d = await ipc.invoke("system:get-disk-info");
      const defaultShare = d.total * 0.3;
      setDisk(d);
      setSelected(defaultShare);
    };

    init();
  }, []);

  const connectWallet = async () => {
    if (!window.ethereum) {
      window.open("http://127.0.0.1:3000", "_blank");
      alert("MetaMask is not available inside Electron. A browser tab has been opened so you can connect your wallet there.");
      return;
    }

    const accounts = await window.ethereum.request({
      method: "eth_requestAccounts",
    });

    setWallet(accounts[0]);
    setStep(1);
  };

  const activate = async () => {
    if (!ipc) return;

    await ipc.invoke("p2p:start");

    await ipc.invoke("p2p:update-config", {
      walletAddress: wallet,
      totalSharedBytes: selected,
      acceptsNetworkStorage: true,
    });

    await ipc.invoke("onboarding:save", {
      wallet,
      storage: selected,
    });

    onReady();
  };

  return (
    <div style={{ padding: 40 }}>
      {step === 0 && (
        <>
          <h2>Connect Wallet</h2>
          <p>If MetaMask is unavailable in Electron, this button will open the wallet flow in your browser.</p>
          <button onClick={connectWallet}>Connect MetaMask</button>
        </>
      )}

      {step === 1 && (
        <>
          <h2>Allocate Storage</h2>

          <p>Total: {(disk.total / 1e9).toFixed(2)} GB</p>
          <p>Selected: {(selected / 1e9).toFixed(2)} GB</p>

          <input
            type="range"
            min={disk.total * 0.1}
            max={disk.total * 0.75}
            value={selected}
            onChange={(e) => setSelected(Number(e.target.value))}
          />

          <br />
          <button onClick={activate}>Activate Node</button>
        </>
      )}
    </div>
  );
}
