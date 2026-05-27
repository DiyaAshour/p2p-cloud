import { ipcMain } from 'electron';
import crypto from 'node:crypto';

const INSTALLED = Symbol.for('chunknet.walletPlanGuardInstalled');
const ORIGINAL_HANDLE = Symbol.for('chunknet.walletPlanGuardOriginalHandle');
const PLAN_UNLOCK_VERSION = 'plan-unlock-hmac-sha256-v1';

function planUnlockSecret() {
  return String(process.env.P2P_PLAN_UNLOCK_SECRET || process.env.PLAN_UNLOCK_SECRET || '').trim();
}

function normalizeWallet(address = '') {
  return String(address || '').trim().toLowerCase();
}

function timingSafeEqualText(a = '', b = '') {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function planUnlockPayload({ wallet, planId, paidUntil, orderId }) {
  return JSON.stringify({
    version: PLAN_UNLOCK_VERSION,
    wallet: normalizeWallet(wallet),
    planId: String(planId || '').trim(),
    paidUntil: Number(paidUntil || 0),
    orderId: String(orderId || '').trim(),
  });
}

function signPlanUnlock(payload, secret = planUnlockSecret()) {
  if (!secret) throw new Error('Plan unlock secret is not configured');
  return crypto.createHmac('sha256', secret).update(planUnlockPayload(payload)).digest('hex');
}

function verifyPlanUnlock(payload = {}) {
  const planId = String(payload.planId || 'free').trim();
  if (planId === 'free') return;

  const secret = planUnlockSecret();
  if (!secret) throw new Error('Paid plan unlock is disabled: P2P_PLAN_UNLOCK_SECRET is not configured');

  const wallet = normalizeWallet(payload.wallet || payload.walletAddress || payload.address);
  if (!/^0x[a-f0-9]{40}$/.test(wallet)) throw new Error('Paid plan unlock requires the paid wallet address');

  const paidUntil = Number(payload.paidUntil || 0);
  if (!Number.isFinite(paidUntil) || paidUntil <= Math.floor(Date.now() / 1000)) {
    throw new Error('Paid plan unlock requires a future paidUntil timestamp');
  }

  const orderId = String(payload.orderId || payload.paypalOrderId || payload.captureId || payload.txHash || '').trim();
  if (!orderId) throw new Error('Paid plan unlock requires a PayPal order id, capture id, or contract tx hash');

  const token = String(payload.planUnlockToken || payload.unlockToken || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Paid plan unlock token is missing or invalid');

  const expected = signPlanUnlock({ wallet, planId, paidUntil, orderId }, secret);
  if (!timingSafeEqualText(token, expected)) throw new Error('Paid plan unlock token verification failed');
}

export function installWalletPlanGuard() {
  if (globalThis[INSTALLED]) return;
  globalThis[INSTALLED] = true;

  if (!globalThis[ORIGINAL_HANDLE]) {
    globalThis[ORIGINAL_HANDLE] = ipcMain.handle.bind(ipcMain);
  }

  ipcMain.handle = (channel, listener) => {
    if (channel !== 'wallet:setPlan') return globalThis[ORIGINAL_HANDLE](channel, listener);

    return globalThis[ORIGINAL_HANDLE](channel, async (event, payload = {}) => {
      verifyPlanUnlock(payload);
      return listener(event, payload);
    });
  };

  console.log('[wallet-plan-guard] installed: paid plans require signed unlock tokens');
}

installWalletPlanGuard();

export { PLAN_UNLOCK_VERSION, signPlanUnlock, verifyPlanUnlock };
