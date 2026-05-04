import SignClient from "@walletconnect/sign-client";
import { WalletConnectModal } from "@walletconnect/modal";

const PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "821b9d64c996dc59c7d18583fc7081f0";
const PAYMENT_CHAIN_ID = String(import.meta.env.VITE_PAYMENT_CHAIN_ID || "11155111");
const PAYMENT_CHAIN_HEX = `0x${Number(PAYMENT_CHAIN_ID).toString(16)}`;
const PAYMENT_CAIP_CHAIN = `eip155:${PAYMENT_CHAIN_ID}`;
const ETHEREUM_CAIP_CHAIN = "eip155:1";
const TX_METHOD = `eth_${"sendTransaction"}`;
const ENCRYPTION_MESSAGE_PREFIX = "p2p.cloud encryption key v1";

const REQUIRED_NAMESPACES = {
  eip155: {
    methods: ["personal_sign", TX_METHOD],
    chains: [PAYMENT_CAIP_CHAIN, ETHEREUM_CAIP_CHAIN],
    events: ["accountsChanged", "chainChanged"],
  },
};

type Eip1193Provider = {
  isMetaMask?: boolean;
  providers?: Eip1193Provider[];
  request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>;
};
type WalletSession = Awaited<ReturnType<SignClient["connect"]>> extends { approval: () => Promise<infer S> } ? S : any;
let signClientPromise: Promise<SignClient> | null = null;
let modal: WalletConnectModal | null = null;
let activeSession: WalletSession | null = null;
let activeWalletConnectChain = PAYMENT_CAIP_CHAIN;
let injectedAddress: string | null = null;

declare global { interface Window { ethereum?: Eip1193Provider } }

function getModal() {
  if (!modal) modal = new WalletConnectModal({ projectId: PROJECT_ID, chains: [PAYMENT_CAIP_CHAIN, ETHEREUM_CAIP_CHAIN] });
  return modal;
}

function getInjectedProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const ethereum = window.ethereum;
  if (!ethereum) return null;
  return ethereum.providers?.find((provider) => provider.isMetaMask) || ethereum;
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

async function clearWalletConnectSessions(client: SignClient) {
  const sessions = client.session.getAll();
  await Promise.allSettled(sessions.map((session: any) => client.disconnect({
    topic: session.topic,
    reason: { code: 6000, message: "Reset p2p.cloud payment session" },
  })));
  activeSession = null;
}

function normalizeAddress(value: unknown) {
  const address = String(value || "");
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error("Invalid wallet address returned by wallet");
  return address;
}

function encryptionMessage(address: string) {
  return `${ENCRYPTION_MESSAGE_PREFIX}\nWallet: ${address.toLowerCase()}\nPurpose: portable private file decryption`;
}

async function signInjected(provider: Eip1193Provider, message: string, address: string) {
  return String(await provider.request({ method: "personal_sign", params: [message, address] }));
}

async function ensureInjectedSepolia(provider: Eip1193Provider) {
  const chainId = String(await provider.request({ method: "eth_chainId" }));
  if (chainId.toLowerCase() === PAYMENT_CHAIN_HEX.toLowerCase()) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: PAYMENT_CHAIN_HEX }] });
  } catch (error: any) {
    if (error?.code === 4902) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: PAYMENT_CHAIN_HEX,
          chainName: "Sepolia",
          nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://1rpc.io/sepolia", "https://ethereum-sepolia-rpc.publicnode.com", "https://rpc.sepolia.org"],
          blockExplorerUrls: ["https://sepolia.etherscan.io"],
        }],
      });
      return;
    }
    throw new Error(`Switch MetaMask to Sepolia chain ${PAYMENT_CHAIN_ID} and try again.`);
  }
}

async function connectInjectedWallet() {
  const provider = getInjectedProvider();
  if (!provider) return null;
  await ensureInjectedSepolia(provider);
  const accounts = await provider.request({ method: "eth_requestAccounts" }) as unknown[];
  const address = normalizeAddress(accounts?.[0]);
  const loginMessage = `p2p.cloud login\nWallet: ${address}\nChain: ${PAYMENT_CHAIN_ID}\nTime: ${new Date().toISOString()}`;
  await signInjected(provider, loginMessage, address);
  const encryptionSignature = await signInjected(provider, encryptionMessage(address), address);
  injectedAddress = address;
  activeSession = null;
  return { address, chainId: PAYMENT_CHAIN_ID, topic: "injected", verifiedAt: new Date().toISOString(), provider: "injected", encryptionSignature, signature: encryptionSignature };
}

function getWalletConnectAccount(session: WalletSession) {
  const accounts: string[] = session.namespaces.eip155?.accounts || [];
  const preferred = accounts.find((item) => item.startsWith(`${PAYMENT_CAIP_CHAIN}:`));
  const fallback = accounts[0];
  const account = preferred || fallback;
  if (!account) throw new Error("WalletConnect did not return any Ethereum account. Disconnect and reconnect your wallet.");
  const [, chainId, address] = account.split(":");
  const normalizedAddress = normalizeAddress(address);
  activeWalletConnectChain = preferred ? PAYMENT_CAIP_CHAIN : `eip155:${chainId}`;
  return { chainId, address: normalizedAddress };
}

export async function connectWalletWithWalletConnect() {
  const injected = await connectInjectedWallet();
  if (injected) return injected;

  const client = await getSignClient();
  await clearWalletConnectSessions(client);
  const { uri, approval } = await client.connect({ requiredNamespaces: REQUIRED_NAMESPACES });
  if (uri) await getModal().openModal({ uri });

  try {
    const session = await approval();
    activeSession = session;
    getModal().closeModal();
    const { chainId, address } = getWalletConnectAccount(session);
    const loginMessage = `p2p.cloud login\nWallet: ${address}\nChain: ${chainId}\nTime: ${new Date().toISOString()}`;
    await client.request({ topic: session.topic, chainId: activeWalletConnectChain, request: { method: "personal_sign", params: [loginMessage, address] } });
    const encryptionSignature = String(await client.request({ topic: session.topic, chainId: activeWalletConnectChain, request: { method: "personal_sign", params: [encryptionMessage(address), address] } }));
    return { address, chainId, topic: session.topic, verifiedAt: new Date().toISOString(), provider: "walletconnect", encryptionSignature, signature: encryptionSignature };
  } catch (error) {
    getModal().closeModal();
    throw error;
  }
}

async function requestInjectedPayment(payload: { from: string; to: string; value: string; data?: string }) {
  const provider = getInjectedProvider();
  if (!provider) return null;
  await ensureInjectedSepolia(provider);
  const accounts = await provider.request({ method: "eth_accounts" }) as unknown[];
  const address = normalizeAddress(accounts?.[0] || injectedAddress);
  if (address.toLowerCase() !== payload.from.toLowerCase()) throw new Error("Payment wallet does not match connected wallet");
  const result = await provider.request({
    method: "eth_sendTransaction",
    params: [{ from: payload.from, to: payload.to, value: payload.value, data: payload.data || "0x" }],
  });
  return String(result);
}

export async function requestWalletPayment(payload: { from: string; to: string; value: string; data?: string }) {
  const injectedPayment = await requestInjectedPayment(payload);
  if (injectedPayment) return injectedPayment;

  const client = await getSignClient();
  if (!activeSession?.topic) throw new Error("Connect wallet before payment");
  const { address } = getWalletConnectAccount(activeSession);
  if (address.toLowerCase() !== payload.from.toLowerCase()) throw new Error("Payment wallet does not match connected wallet");
  const result = await client.request({
    topic: activeSession.topic,
    chainId: activeWalletConnectChain,
    request: { method: TX_METHOD, params: [{ from: payload.from, to: payload.to, value: payload.value, data: payload.data || "0x" }] },
  });
  return String(result);
}
