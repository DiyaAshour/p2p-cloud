import { pricingService } from './pricingService';

declare global {
  interface Window {
    ethereum?: any;
  }
}

const PLATFORM_WALLET = import.meta.env.VITE_PLATFORM_WALLET || '';
const USD_PER_ETH = 3000;

export type PaymentIntent = {
  amountUsd: number;
  amountEth: number;
  to: string;
};

export class PaymentService {
  createIntent(bytes: number): PaymentIntent {
    if (!PLATFORM_WALLET) {
      throw new Error('Missing platform wallet address');
    }

    const amountUsd = pricingService.calculateMonthlyPriceUsd(bytes);
    const amountEth = amountUsd / USD_PER_ETH;

    return {
      amountUsd,
      amountEth,
      to: PLATFORM_WALLET,
    };
  }

  async waitForConfirmation(txHash: string) {
    let receipt = null;

    while (!receipt) {
      receipt = await window.ethereum.request({
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      });

      if (!receipt) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    if (receipt.status !== '0x1') {
      throw new Error('PAYMENT_FAILED');
    }

    return receipt;
  }

  async payForUpload(bytes: number): Promise<{ txHash: string; intent: PaymentIntent; receipt: any }> {
    if (!window.ethereum) {
      throw new Error('MetaMask is required');
    }

    const intent = this.createIntent(bytes);
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const from = accounts?.[0];

    if (!from) {
      throw new Error('No wallet connected');
    }

    const weiValue = BigInt(Math.max(1, Math.floor(intent.amountEth * 1e18)));

    const txHash = await window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [
        {
          from,
          to: intent.to,
          value: `0x${weiValue.toString(16)}`,
        },
      ],
    });

    const receipt = await this.waitForConfirmation(txHash);
    return { txHash, intent, receipt };
  }
}

export const paymentService = new PaymentService();
