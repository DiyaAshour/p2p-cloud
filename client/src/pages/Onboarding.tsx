import { useMemo, useState } from "react";

type OnboardingProps = {
  onReady?: () => void;
};

export default function Onboarding({ onReady }: OnboardingProps) {
  const [step, setStep] = useState(0);

  const browserConnectUrl = useMemo(() => {
    const url = new URL("http://127.0.0.1:3000/");
    url.searchParams.set("walletConnect", "1");
    return url.toString();
  }, []);

  const connectWallet = () => {
    window.location.href = browserConnectUrl;
  };

  const finishOnboarding = () => {
    onReady?.();
  };

  return (
    <div style={{ padding: 40 }}>
      {step === 0 && (
        <>
          <h2>Connect Wallet</h2>
          <button onClick={connectWallet}>Connect MetaMask</button>
          <button onClick={() => setStep(1)}>Skip for now</button>
        </>
      )}

      {step === 1 && (
        <>
          <h2>Node Ready</h2>
          <button onClick={finishOnboarding}>Continue</button>
        </>
      )}
    </div>
  );
}
