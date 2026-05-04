import SignClient from "@walletconnect/sign-client";
import { WalletConnectModal } from "@walletconnect/modal";

const PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "821b9d64c996dc59c7d18583fc7081f0";
const REQUIRED_NAMESPACES = {
  eip155: {
    methods: ["personal_sign"],
    chains: ["eip155:1"],
    events: ["accountsChanged", "chainChanged"],
  },
};

let signClientPromise: Promise<SignClient> | null = null;
let modal: WalletConnectModal | null = null;

function getModal() {
  if (!modal) {
    modal = new WalletConnectModal({
      projectId: PROJECT_ID,
      chains: ["eip155:1"],
    });
  }
  return modal;
}

async function getSignClient() {
  if (!signClientPromise) {
    signClientPromise = SignClient.init({
      projectId: PROJECT_ID,
      metadata: {
        name: "Native P2P Cloud",
        description: "Wallet-gated P2P storage account",
        url: "https://github.com/DiyaAshour/p2p-cloud",
        icons: ["https://avatars.githubusercontent.com/u/165673884?v=4"],
      },
    });
  }
  return signClientPromise;
}

export async function connectWalletWithWalletConnect() {
  const client = await getSignClient();
  const { uri, approval } = await client.connect({ requiredNamespaces: REQUIRED_NAMESPACES });

  if (uri) {
    await getModal().openModal({ uri });
  }

  try {
    const session = await approval();
    getModal().closeModal();

    const account = session.namespaces.eip155?.accounts?.[0];
    if (!account) throw new Error("WalletConnect session did not return an EIP-155 account");

    const [, chainId, address] = account.split(":");
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error("Invalid wallet address returned by WalletConnect");

    const message = `Native P2P Cloud login\nWallet: ${address}\nChain: ${chainId}\nTime: ${new Date().toISOString()}`;

    await client.request({
      topic: session.topic,
      chainId: `eip155:${chainId}`,
      request: {
        method: "personal_sign",
        params: [message, address],
      },
    });

    return {
      address,
      chainId,
      topic: session.topic,
      verifiedAt: new Date().toISOString(),
    };
  } catch (error) {
    getModal().closeModal();
    throw error;
  }
}
