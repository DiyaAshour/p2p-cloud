import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PAYPAL_SERVER_PORT || 8791);
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const PAYPAL_ENV = process.env.PAYPAL_ENV || 'sandbox';
const PAYPAL_API_BASE = process.env.PAYPAL_API_BASE || (PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');
const APP_RETURN_URL = process.env.PAYPAL_RETURN_URL || 'http://127.0.0.1:8791/paypal/success';
const APP_CANCEL_URL = process.env.PAYPAL_CANCEL_URL || 'http://127.0.0.1:8791/paypal/cancel';

const PLANS = {
  tb1: { id: 'tb1', name: '1 TB', quotaBytes: 1 * 1024 ** 4, priceUsd: '1.00' },
  tb3: { id: 'tb3', name: '3 TB', quotaBytes: 3 * 1024 ** 4, priceUsd: '2.50' },
  tb7: { id: 'tb7', name: '7 TB', quotaBytes: 7 * 1024 ** 4, priceUsd: '4.99' },
  tb10: { id: 'tb10', name: '10 TB', quotaBytes: 10 * 1024 ** 4, priceUsd: '7.99' },
};

const orders = new Map();
const subscriptions = new Map();

function sendJson(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
  });
  res.end(JSON.stringify(data));
}

function sendHtml(res, html) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 1_000_000) req.destroy(); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

async function paypalAccessToken() {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET');
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error_description || data?.message || 'PayPal auth failed');
  return data.access_token;
}

async function paypalRequest(path, options = {}) {
  const token = await paypalAccessToken();
  const response = await fetch(`${PAYPAL_API_BASE}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data?.message || data?.details?.[0]?.description || `PayPal request failed: ${response.status}`);
  return data;
}

function activeSubscription(wallet) {
  const key = String(wallet || '').toLowerCase();
  const sub = subscriptions.get(key);
  if (!sub) return null;
  if (!sub.paidUntil || Number(sub.paidUntil) < Math.floor(Date.now() / 1000)) return null;
  return sub;
}

async function createOrder(req, res) {
  const body = await readBody(req);
  const wallet = String(body.wallet || '').trim().toLowerCase();
  const planId = String(body.planId || '').trim();
  const plan = PLANS[planId];
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) return sendJson(res, 400, { ok: false, error: 'Valid wallet is required' });
  if (!plan) return sendJson(res, 400, { ok: false, error: 'Unknown plan' });

  const requestId = randomUUID();
  const order = await paypalRequest('/v2/checkout/orders', {
    method: 'POST',
    headers: { 'PayPal-Request-Id': requestId },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: `${wallet}:${plan.id}`,
        custom_id: JSON.stringify({ wallet, planId: plan.id }),
        description: `PeerCloud ${plan.name} monthly storage`,
        amount: { currency_code: 'USD', value: plan.priceUsd },
      }],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'PeerCloud',
            landing_page: 'LOGIN',
            user_action: 'PAY_NOW',
            return_url: APP_RETURN_URL,
            cancel_url: APP_CANCEL_URL,
          },
        },
      },
    }),
  });

  const approveUrl = order.links?.find((link) => link.rel === 'payer-action' || link.rel === 'approve')?.href;
  orders.set(order.id, { wallet, planId: plan.id, status: 'CREATED', createdAt: Date.now() });
  sendJson(res, 200, { ok: true, orderId: order.id, approveUrl });
}

async function captureOrder(req, res) {
  const body = await readBody(req);
  const orderId = String(body.orderId || '').trim();
  const local = orders.get(orderId);
  if (!orderId || !local) return sendJson(res, 400, { ok: false, error: 'Unknown order' });

  const capture = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: 'POST', body: '{}' });
  const status = capture.status;
  const unit = capture.purchase_units?.[0];
  const captureInfo = unit?.payments?.captures?.[0];
  const amount = captureInfo?.amount;
  const plan = PLANS[local.planId];

  if (status !== 'COMPLETED' || captureInfo?.status !== 'COMPLETED') return sendJson(res, 400, { ok: false, error: 'Payment not completed', capture });
  if (amount?.currency_code !== 'USD' || amount?.value !== plan.priceUsd) return sendJson(res, 400, { ok: false, error: 'Payment amount mismatch' });

  const paidUntil = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
  const subscription = {
    wallet: local.wallet,
    planId: local.planId,
    paidUntil,
    quotaBytes: plan.quotaBytes,
    provider: 'paypal',
    orderId,
    captureId: captureInfo.id,
    amount: amount.value,
    currency: 'USD',
    activatedAt: new Date().toISOString(),
  };
  subscriptions.set(local.wallet, subscription);
  orders.set(orderId, { ...local, status: 'COMPLETED', captureId: captureInfo.id, paidUntil });
  sendJson(res, 200, { ok: true, subscription });
}

async function subscriptionStatus(req, res, url) {
  const wallet = String(url.searchParams.get('wallet') || '').trim().toLowerCase();
  const sub = activeSubscription(wallet);
  sendJson(res, 200, { ok: true, active: Boolean(sub), subscription: sub });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return sendJson(res, 204, {});
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true, paypalEnv: PAYPAL_ENV });
    if (req.method === 'GET' && url.pathname === '/paypal/success') return sendHtml(res, '<h1>Payment approved</h1><p>Return to PeerCloud and click Confirm Payment.</p>');
    if (req.method === 'GET' && url.pathname === '/paypal/cancel') return sendHtml(res, '<h1>Payment cancelled</h1><p>You can close this page.</p>');
    if (req.method === 'POST' && url.pathname === '/api/paypal/create-order') return await createOrder(req, res);
    if (req.method === 'POST' && url.pathname === '/api/paypal/capture-order') return await captureOrder(req, res);
    if (req.method === 'GET' && url.pathname === '/api/subscription') return await subscriptionStatus(req, res, url);
    return sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    console.error('[paypal-checkout]', error);
    return sendJson(res, 500, { ok: false, error: error?.message || 'PayPal server error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[paypal-checkout] listening on http://127.0.0.1:${PORT}`);
  console.log(`[paypal-checkout] env=${PAYPAL_ENV} api=${PAYPAL_API_BASE}`);
});
