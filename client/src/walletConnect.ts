import SignClient from "@walletconnect/sign-client";
import { WalletConnectModal } from "@walletconnect/modal";

const PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "821b9d64c996dc59c7d18583fc7081f0";
const PAYMENT_CHAIN_ID = String(import.meta.env.VITE_PAYMENT_CHAIN_ID || "11155111");
const PAYMENT_CAIP_CHAIN = `eip155:${PAYMENT_CHAIN_ID}`;
const TX_METHOD = `eth_${"sendTransaction"}`;

const REQUIRED_NAMESPACES = {
  eip155: {
    methods: ["personal_sign", TX_METHOD],
    chains: [PAYMENT_CAIP_CHAIN],
    events: ["accountsChanged", "chainChanged"],
  },
};

type WalletSession = Awaited<ReturnType<SignClient["connect"]>> extends { approval: () => Promise<infer S> } ? S : any;
let signClientPromise: Promise<SignClient> | null = null;
let modal: WalletConnectModal | null = null;
let activeSession: WalletSession | null = null;

function getModal() {
  if (!modal) {
    modal = new WalletConnectModal({ projectId: PROJECT_ID, chains: [PAYMENT_CAIP_CHAIN] });
  }
  return modal;
}

async function getSignClient() {
  if (!signClientPromise) {
    signClientPromise = SignClient.init({
      projectId: PROJECT_ID,
      metadata: {
        name: "p2p.cloud",
        description: "Wallet-gated P2P storage account",
        url: "https://github.com/DiyaAshour/p2p-cloud",
        icons: ["https://avatars.githubusercontent.com/u/165673884?v=4"],
      },
    });
  }
  return signClientPromise;
}

function getAccount(session: WalletSession) {
  const account = session.namespaces.eip155?.accounts?.[0];
  if (!account) throw new Error("WalletConnect session did not return an EIP-155 account");
  const [, chainId, address] = account.split(":");
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error("Invalid wallet address returned by WalletConnect");
  if (String(chainId) !== PAYMENT_CHAIN_ID) throw new Error(`Wrong network. Please connect Sepolia chain ${PAYMENT_CHAIN_ID}.`);
  return { chainId, address };
}

export async function connectWalletWithWalletConnect() {
  const client = await getSignClient();
  const { uri, approval } = await client.connect({ requiredNamespaces: REQUIRED_NAMESPACES });
  if (uri) await getModal().openModal({ uri });

  try {
    const session = await approval();
    activeSession = session;
    getModal().closeModal();
    const { chainId, address } = getAccount(session);
    const message = `p2p.cloud login\nWallet: ${address}\nChain: ${chainId}\nTime: ${new Date().toISOString()}`;
    await client.request({ topic: session.topic, chainId: `eip155:${chainId}`, request: { method: "personal_sign", params: [message, address] } });
    return { address, chainId, topic: session.topic, verifiedAt: new Date().toISOString() };
  } catch (error) {
    getModal().closeModal();
    throw error;
  }
}

export async function requestWalletPayment(payload: { from: string; to: string; value: string; data?: string }) {
  const client = await getSignClient();
  if (!activeSession?.topic) throw new Error("Connect wallet before payment");
  const { chainId, address } = getAccount(activeSession);
  if (address.toLowerCase() !== payload.from.toLowerCase()) throw new Error("Payment wallet does not match connected wallet");
  const result = await client.request({
    topic: activeSession.topic,
    chainId: `eip155:${chainId}`,
    request: { method: TX_METHOD, params: [{ from: payload.from, to: payload.to, value: payload.value, data: payload.data || "0x" }] },
  });
  return String(result);
}
