const TEN_TB_BYTES = 10 * 1024 * 1024 * 1024 * 1024;

export class PricingService {
  calculateMonthlyPriceUsd(bytes: number): number {
    return Number(((bytes / TEN_TB_BYTES) * 1).toFixed(6));
  }
}

export const pricingService = new PricingService();
