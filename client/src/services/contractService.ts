import { ethers } from 'ethers';

declare global {
  interface Window {
    ethereum?: any;
  }
}

const CONTRACT_ADDRESS = import.meta.env.VITE_P2P_PAYOUT_CONTRACT_ADDRESS || '';

const ABI = [
  'function withdraw()',
  'function balances(address) view returns (uint256)'
];

export class ContractService {
  async getContract() {
    if (!window.ethereum) {
      throw new Error('MetaMask is required');
    }

    if (!CONTRACT_ADDRESS) {
      throw new Error('Missing payout contract address');
    }

    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    return new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
  }

  async withdraw() {
    const contract = await this.getContract();
    const tx = await contract.withdraw();
    await tx.wait();
    return tx.hash;
  }
}

export const contractService = new ContractService();
