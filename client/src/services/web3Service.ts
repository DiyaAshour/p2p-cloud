import { ethers } from 'ethers';
import { createWalletConnectProvider } from './walletConnectService';

export type WalletConnector = 'metamask' | 'walletconnect';

export interface WalletState {
  address: string | null;
  balance: string;
  isConnected: boolean;
  chainId: number | null;
  connector: WalletConnector | null;
}

const WALLET_SESSION_KEY = 'p2p-cloud-wallet-session';
const DEFAULT_STORAGE_PRICE_USD_PER_TB = 1;
const MOCK_USD_TO_ETH = 0.0005;
const DEFAULT_STORAGE_CONTRACT_ADDRESS = import.meta.env.VITE_STORAGE_CONTRACT_ADDRESS || '';

const STORAGE_CONTRACT_ABI = [
  'function buyStorage(uint256 storageGb) payable',
  'function getQuota(address user) view returns (uint256)',
];

class Web3Service {
  private provider: ethers.BrowserProvider | null = null;
  private signer: ethers.Signer | null = null;
  private externalProvider: any = null;
  private walletConnectProvider: any = null;
  private walletState: WalletState = {
    address: null,
    balance: '0',
    isConnected: false,
    chainId: null,
    connector: null,
  };

  async connectWallet(connector: WalletConnector = 'metamask'): Promise<WalletState> {
    if (connector === 'walletconnect') {
      return this.connectWalletConnect();
    }

    return this.connectInjectedWallet();
  }

  async reconnectWallet(): Promise<WalletState> {
    const savedConnector = this.getSavedConnector();

    if (!savedConnector) {
      return this.walletState;
    }

    if (savedConnector === 'metamask') {
      return this.reconnectInjectedWallet();
    }

    return this.connectWalletConnect();
  }

  private async connectInjectedWallet(): Promise<WalletState> {
    if (!window.ethereum) {
      throw new Error('MetaMask or injected wallet is not installed');
    }

    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });

    if (!accounts || accounts.length === 0) {
      throw new Error('No wallet accounts found');
    }

    await this.setProvider(window.ethereum, 'metamask', accounts[0]);
    this.attachInjectedListeners();
    this.saveSession('metamask');

    return this.walletState;
  }

  private async reconnectInjectedWallet(): Promise<WalletState> {
    if (!window.ethereum) {
      this.clearSession();
      return this.walletState;
    }

    const accounts = await window.ethereum.request({ method: 'eth_accounts' });

    if (!accounts || accounts.length === 0) {
      this.clearSession();
      return this.walletState;
    }

    await this.setProvider(window.ethereum, 'metamask', accounts[0]);
    this.attachInjectedListeners();

    return this.walletState;
  }

  private async connectWalletConnect(): Promise<WalletState> {
    this.walletConnectProvider = await createWalletConnectProvider();
    const accounts = await this.walletConnectProvider.enable();

    if (!accounts || accounts.length === 0) {
      throw new Error('No WalletConnect accounts found');
    }

    await this.setProvider(this.walletConnectProvider, 'walletconnect', accounts[0]);
    this.attachWalletConnectListeners();
    this.saveSession('walletconnect');

    return this.walletState;
  }

  private async setProvider(externalProvider: any, connector: WalletConnector, address: string): Promise<void> {
    this.externalProvider = externalProvider;
    this.provider = new ethers.BrowserProvider(externalProvider);
    this.signer = await this.provider.getSigner();

    const balance = await this.provider.getBalance(address);
    const network = await this.provider.getNetwork();

    this.walletState = {
      address,
      balance: ethers.formatEther(balance),
      isConnected: true,
      chainId: Number(network.chainId),
      connector,
    };
  }

  private attachInjectedListeners(): void {
    if (!window.ethereum?.on) return;

    window.ethereum.on('accountsChanged', async (accounts: string[]) => {
      if (!accounts || accounts.length === 0) {
        await this.disconnectWallet();
        return;
      }

      await this.setProvider(window.ethereum, 'metamask', accounts[0]);
    });

    window.ethereum.on('chainChanged', () => {
      window.location.reload();
    });
  }

  private attachWalletConnectListeners(): void {
    if (!this.walletConnectProvider?.on) return;

    this.walletConnectProvider.on('accountsChanged', async (accounts: string[]) => {
      if (!accounts || accounts.length === 0) {
        await this.disconnectWallet();
        return;
      }

      await this.setProvider(this.walletConnectProvider, 'walletconnect', accounts[0]);
    });

    this.walletConnectProvider.on('chainChanged', async () => {
      if (this.walletState.address) {
        await this.setProvider(this.walletConnectProvider, 'walletconnect', this.walletState.address);
      }
    });

    this.walletConnectProvider.on('disconnect', async () => {
      await this.disconnectWallet();
    });
  }

  async disconnectWallet(): Promise<void> {
    try {
      if (this.walletConnectProvider?.disconnect) {
        await this.walletConnectProvider.disconnect();
      }
    } catch (error) {
      console.warn('Wallet disconnect warning:', error);
    }

    this.walletState = {
      address: null,
      balance: '0',
      isConnected: false,
      chainId: null,
      connector: null,
    };
    this.provider = null;
    this.signer = null;
    this.externalProvider = null;
    this.walletConnectProvider = null;
    this.clearSession();
  }

  getWalletState(): WalletState {
    return this.walletState;
  }

  private saveSession(connector: WalletConnector): void {
    localStorage.setItem(WALLET_SESSION_KEY, JSON.stringify({ connector }));
  }

  private getSavedConnector(): WalletConnector | null {
    try {
      const raw = localStorage.getItem(WALLET_SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed.connector === 'metamask' || parsed.connector === 'walletconnect' ? parsed.connector : null;
    } catch {
      return null;
    }
  }

  private clearSession(): void {
    localStorage.removeItem(WALLET_SESSION_KEY);
  }

  async getBalance(): Promise<string> {
    if (!this.provider || !this.walletState.address) {
      throw new Error('Wallet not connected');
    }

    const balance = await this.provider.getBalance(this.walletState.address);
    return ethers.formatEther(balance);
  }

  async signMessage(message: string): Promise<string> {
    if (!this.signer) {
      throw new Error('Signer not available');
    }

    return this.signer.signMessage(message);
  }

  calculateStorageCost(sizeInTB: number): number {
    return sizeInTB * DEFAULT_STORAGE_PRICE_USD_PER_TB;
  }

  calculateStorageCostByGb(storageGb: number): number {
    return (storageGb / 1024) * DEFAULT_STORAGE_PRICE_USD_PER_TB;
  }

  async createPaymentTransaction(recipientAddress: string, amountInUSD: number): Promise<string> {
    if (!this.signer) {
      throw new Error('Signer not available');
    }

    const ethAmount = amountInUSD * MOCK_USD_TO_ETH;
    const tx = await this.signer.sendTransaction({
      to: recipientAddress,
      value: ethers.parseEther(ethAmount.toString()),
    });

    return tx.hash;
  }

  async buyStorageWithWallet(storageGb: number, contractAddress = DEFAULT_STORAGE_CONTRACT_ADDRESS): Promise<string> {
    if (!this.signer) {
      throw new Error('Signer not available');
    }

    if (!contractAddress) {
      throw new Error('Missing VITE_STORAGE_CONTRACT_ADDRESS');
    }

    const usdCost = this.calculateStorageCostByGb(storageGb);
    const ethAmount = usdCost * MOCK_USD_TO_ETH;
    const contract = new ethers.Contract(contractAddress, STORAGE_CONTRACT_ABI, this.signer);
    const tx = await contract.buyStorage(storageGb, {
      value: ethers.parseEther(ethAmount.toString()),
    });

    return tx.hash;
  }

  async getStorageQuota(contractAddress = DEFAULT_STORAGE_CONTRACT_ADDRESS): Promise<number> {
    if (!this.provider || !this.walletState.address) {
      throw new Error('Wallet not connected');
    }

    if (!contractAddress) {
      return 5;
    }

    const contract = new ethers.Contract(contractAddress, STORAGE_CONTRACT_ABI, this.provider);
    const quota = await contract.getQuota(this.walletState.address);
    return Number(quota);
  }

  async verifySignature(message: string, signature: string, address: string): Promise<boolean> {
    try {
      const recoveredAddress = ethers.verifyMessage(message, signature);
      return recoveredAddress.toLowerCase() === address.toLowerCase();
    } catch (error) {
      console.error('Failed to verify signature:', error);
      return false;
    }
  }
}

export const web3Service = new Web3Service();

declare global {
  interface Window {
    ethereum?: any;
  }
}
