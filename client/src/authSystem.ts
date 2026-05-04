export type AuthProvider = "wallet" | "google" | "email" | "guest";

export type AuthUser = {
  id: string;
  provider: AuthProvider;
  displayName: string;
  email?: string;
  walletAddress?: string;
  avatarUrl?: string;
  createdAt: string;
};

const AUTH_KEY = "peercloud.auth.user";

function nowIso() {
  return new Date().toISOString();
}

function safeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function getSavedAuthUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    return raw ? JSON.parse(raw) as AuthUser : null;
  } catch {
    return null;
  }
}

export function saveAuthUser(user: AuthUser) {
  localStorage.setItem(AUTH_KEY, JSON.stringify(user));
  return user;
}

export function clearAuthUser() {
  localStorage.removeItem(AUTH_KEY);
}

export function loginWithWalletAddress(walletAddress: string) {
  const short = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
  return saveAuthUser({
    id: walletAddress.toLowerCase(),
    provider: "wallet",
    displayName: short,
    walletAddress,
    createdAt: nowIso(),
  });
}

export function loginAsGuest() {
  return saveAuthUser({
    id: safeId("guest"),
    provider: "guest",
    displayName: "Guest User",
    createdAt: nowIso(),
  });
}

export function loginWithEmail(email: string) {
  const clean = email.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(clean)) throw new Error("Enter a valid email address");
  return saveAuthUser({
    id: `email:${clean}`,
    provider: "email",
    displayName: clean.split("@")[0],
    email: clean,
    createdAt: nowIso(),
  });
}

export function buildGoogleOAuthUrl() {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  const redirectUri = import.meta.env.VITE_GOOGLE_REDIRECT_URI || window.location.origin;
  if (!clientId) throw new Error("Google login is not configured. Set VITE_GOOGLE_CLIENT_ID first.");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "token",
    scope: "openid email profile",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export function startGoogleLogin() {
  window.location.href = buildGoogleOAuthUrl();
}

export async function finishGoogleLoginFromUrl(url = window.location.href): Promise<AuthUser | null> {
  const parsed = new URL(url);
  const hash = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
  const params = new URLSearchParams(hash || parsed.search.slice(1));
  const accessToken = params.get("access_token");
  if (!accessToken) return null;

  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error("Google login failed while reading profile");
  const profile = await response.json() as { sub: string; name?: string; email?: string; picture?: string };
  const user = saveAuthUser({
    id: `google:${profile.sub}`,
    provider: "google",
    displayName: profile.name || profile.email || "Google User",
    email: profile.email,
    avatarUrl: profile.picture,
    createdAt: nowIso(),
  });
  history.replaceState(null, document.title, parsed.origin + parsed.pathname);
  return user;
}
