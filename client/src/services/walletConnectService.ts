import EthereumProvider from '@walletconnect/ethereum-provider';

export async function createWalletConnectProvider() {
  const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '821b9d64c996dc59c7d18583fc7081f0';

  return EthereumProvider.init({
    projectId,
    chains: [1],
    optionalChains: [1, 11155111, 137, 56, 42161, 10],
    showQrModal: true,
    metadata: {
      name: 'P2P Cloud Browser',
      description: 'Encrypted peer-to-peer storage browser',
      url: 'https://github.com/DiyaAshour/p2p-cloud',
      icons: ['https://avatars.githubusercontent.com/u/165673884?v=4'],
    },
  });
}
