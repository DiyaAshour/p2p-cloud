import { pricingService } from './pricingService';

declare global {
  interface Window {
    ethereum?: any;
  }
}

const PLATFORM_WALLET = '0x1111111111111111111111111111111111111111';
const USD_PER_ETH = 3000;

export type PaymentIntent = {
  amountUsd: number;
  amountEth: number;
  to: string;
};

export class PaymentService {
  createIntent(bytes: number): PaymentIntent {
    const amountUsd = pricingService.calculateMonthlyPriceUsd(bytes);
    const amountEth = amountUsd / USD_PER_ETH;

    return {
      amountUsd,
      amountEth,
      to: PLATFORM_WALLET,
    };
  }

  async payForUpload(bytes: number): Promise<{ txHash: string; intent: PaymentIntent }> {
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

    return { txHash, intent };
  }
}

export const paymentService = new PaymentService();
