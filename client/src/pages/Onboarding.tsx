import { useEffect, useMemo, useState } from "react";

const ipc = (window as any).electron?.ipcRenderer;

export default function Onboarding({ onReady }) {
  const [step, setStep] = useState(0);
  const [wallet, setWallet] = useState<string | null>(null);
  const [disk, setDisk] = useState({ total: 0, free: 0 });
  const [selected, setSelected] = useState(0);

  const browserConnectUrl = useMemo(() => {
    const url = new URL("http://127.0.0.1:3000/");
    url.searchParams.set("walletConnect", "1");
    return url.toString();
  }, []);

  useEffect(() => {
    const init = async () => {
      if (!ipc) return;

      const existing = await ipc.invoke("onboarding:read");
      if (existing?.wallet && existing?.storage) {
        onReady();
        return;
      }

      if (existing?.wallet) {
        setWallet(existing.wallet);
        setStep(1);
      }

      const d = await ipc.invoke("system:get-disk-info");
      const defaultShare = d.total * 0.3;
      setDisk(d);
      setSelected(defaultShare);
    };

    init();
  }, []);

  useEffect(() => {
    if (!ipc || typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);
    const connectMode = params.get("walletConnect") === "1";

    if (connectMode && window.ethereum) {
      const run = async () => {
        try {
          const accounts = await window.ethereum.request({
            method: "eth_requestAccounts",
          });

          const nextWallet = accounts?.[0];
          if (!nextWallet) return;

          await ipc.invoke("onboarding:save", {
            wallet: nextWallet,
            storage: null,
          });

          alert("Wallet connected. Go back to the app.");
        } catch (e) {
          console.error(e);
        }
      };

      run();
    }
  }, []);

  useEffect(() => {
    if (!ipc || step !== 0) return;

    const timer = setInterval(async () => {
      const existing = await ipc.invoke("onboarding:read");
      if (existing?.wallet) {
        setWallet(existing.wallet);
        setStep(1);
      }
    }, 1500);

    return () => clearInterval(timer);
  }, [step]);

  const connectWallet = async () => {
    if (!window.ethereum) {
      if (ipc) {
        await ipc.invoke("system:open-external", browserConnectUrl);
      } else {
        window.open(browserConnectUrl, "_blank");
      }
      alert("Opening browser to connect wallet...");
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
          <p>This will open Chrome to connect MetaMask.</p>
          <button onClick={connectWallet}>Connect MetaMask</button>
        </>
      )}

      {step === 1 && (
        <>
          <h2>Allocate Storage</h2>

          <p>Wallet: {wallet}</p>
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
