// FIXED VERSION
// Removed ipc.invoke('system:open-external') to avoid Electron error

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

  const connectWallet = async () => {
    // FIX: always use browser redirect (no IPC)
    window.location.href = browserConnectUrl;
  };

  return (
    <div style={{ padding: 40 }}>
      {step === 0 && (
        <>
          <h2>Connect Wallet</h2>
          <button onClick={connectWallet}>Connect MetaMask</button>
        </>
      )}
    </div>
  );
}
