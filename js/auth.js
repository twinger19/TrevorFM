// Spotify OAuth: Authorization Code with PKCE. Pure client side, no secret.
import { computeRedirectUri, SCOPES, settings } from "./config.js";

const TOKEN_KEY = "tfm_token"; // { access, refresh, expiresAt }
const VERIFIER_KEY = "tfm_pkce_verifier";

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(str) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
}

function loadToken() {
  try { return JSON.parse(localStorage.getItem(TOKEN_KEY)); } catch { return null; }
}

function saveToken(json) {
  const token = {
    access: json.access_token,
    refresh: json.refresh_token || loadToken()?.refresh,
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
  };
  localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
  return token;
}

export function isLoggedIn() {
  return !!loadToken()?.refresh;
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function beginLogin() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  localStorage.setItem(VERIFIER_KEY, verifier);
  const challenge = b64url(await sha256(verifier));
  const params = new URLSearchParams({
    client_id: settings.clientId,
    response_type: "code",
    redirect_uri: computeRedirectUri(),
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: challenge,
    // Force the consent screen. Without this, re-authorizing an already-
    // approved app silently reissues a token with the ORIGINAL scopes and
    // skips consent — so newly-added scopes (like library access for the
    // like heart) never get granted on reconnect.
    show_dialog: "true",
  });
  location.href = `https://accounts.spotify.com/authorize?${params}`;
}

async function tokenRequest(body) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`Token request failed (${res.status}): ${await res.text()}`);
  return saveToken(await res.json());
}

// Call on page load; completes the redirect back from Spotify if present.
// Keyed on the `code` query param rather than a fixed path, so it works
// whether Spotify lands the user back at /callback (local dev) or the site
// root (GitHub Pages).
export async function handleCallback() {
  const code = new URLSearchParams(location.search).get("code");
  if (!code) return false;
  const verifier = localStorage.getItem(VERIFIER_KEY);
  if (verifier) {
    await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: computeRedirectUri(),
      client_id: settings.clientId,
      code_verifier: verifier,
    });
    localStorage.removeItem(VERIFIER_KEY);
  }
  history.replaceState({}, "", location.pathname + location.hash);
  return true;
}

export async function getAccessToken() {
  let token = loadToken();
  if (!token) throw new Error("Not logged in");
  if (Date.now() >= token.expiresAt) {
    token = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: token.refresh,
      client_id: settings.clientId,
    });
  }
  return token.access;
}
