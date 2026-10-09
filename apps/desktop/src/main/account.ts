import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { app, safeStorage, shell } from "electron";
import type { AccountState } from "../shared/account";
import { cloudConfig } from "./cloud";

interface Tokens { idToken: string; refreshToken: string; expiresAt: number; email: string }
const credentialsFile = () => join(app.getPath("userData"), "account.enc");
let memory: Tokens | null = null;
let signingIn: Promise<AccountState> | null = null;
let refreshing: Promise<string> | null = null;
let generation = 0;
let credentialWrite: Promise<void> = Promise.resolve();

export function tokenExpiry(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) throw new Error("Invalid sign-in expiry.");
  return Date.now() + seconds * 1000;
}

function mutateCredentials(operation: () => Promise<void>): Promise<void> {
  const next = credentialWrite.then(operation);
  credentialWrite = next.catch(() => {});
  return next;
}

function config() {
  const clientId = process.env.DECKASTRA_GOOGLE_DESKTOP_CLIENT_ID ?? cloudConfig().googleDesktopClientId;
  const apiKey = process.env.DECKASTRA_IDENTITY_API_KEY ?? cloudConfig().apiKey;
  return { clientId, apiKey };
}

export function pkce(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function validState(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function load(): Promise<Tokens | null> {
  if (memory) return memory;
  const expected = generation;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const value: unknown = JSON.parse(safeStorage.decryptString(await readFile(credentialsFile())));
    if (!value || typeof value !== "object") return null;
    const t = value as Tokens;
    if (typeof t.idToken !== "string" || typeof t.refreshToken !== "string" || typeof t.email !== "string" || !Number.isFinite(t.expiresAt)) return null;
    if (expected !== generation) return null;
    memory = t;
  } catch { return null; }
  return memory;
}

async function save(tokens: Tokens, expected: number) {
  if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === "basic_text") {
    throw new Error("This computer cannot securely store sign-in credentials.");
  }
  await mutateCredentials(async () => {
    if (expected !== generation) throw new Error("Sign-in was cancelled.");
    await writeFile(credentialsFile(), safeStorage.encryptString(JSON.stringify(tokens)), { mode: 0o600 });
    if (expected === generation) memory = tokens;
  });
  if (expected !== generation) throw new Error("Sign-in was cancelled.");
}

export async function accountState(): Promise<AccountState> {
  const tokens = await load();
  const { clientId, apiKey } = config();
  return { signedIn: !!tokens, email: tokens?.email ?? null, configured: !!clientId && !!apiKey };
}

export async function signOut(): Promise<AccountState> {
  generation += 1;
  memory = null;
  await mutateCredentials(() => rm(credentialsFile(), { force: true }));
  return accountState();
}

async function tokenJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error("Sign-in could not be completed. Try again.");
  return response.json() as Promise<Record<string, unknown>>;
}

export async function accountToken(): Promise<string> {
  const expected = generation;
  const tokens = await load();
  if (!tokens || expected !== generation) throw new Error("Sign in to use AI credits.");
  if (tokens.expiresAt > Date.now() + 60_000) return tokens.idToken;
  if (!refreshing) refreshing = (async () => {
    const reply = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(config().apiKey)}`, {
      method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refreshToken }),
      signal: AbortSignal.timeout(30_000),
    });
    if ([400, 401, 403].includes(reply.status)) {
      if (expected === generation) await signOut();
      throw new Error("Sign in again to use AI credits.");
    }
    const data = await tokenJson(reply);
    if (typeof data.id_token !== "string" || typeof data.refresh_token !== "string") throw new Error("Invalid sign-in response.");
    await save({ ...tokens, idToken: data.id_token, refreshToken: data.refresh_token, expiresAt: tokenExpiry(data.expires_in) }, expected);
    return data.id_token;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export function signIn(): Promise<AccountState> {
  if (!signingIn) signingIn = browserSignIn().finally(() => { signingIn = null; });
  return signingIn;
}

async function browserSignIn(): Promise<AccountState> {
  const expected = generation;
  const { clientId, apiKey } = config();
  if (!clientId || !apiKey) throw new Error("Google sign-in is awaiting the OAuth client configuration.");
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable.");
  const verifier = randomBytes(48).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  let redirect = "";
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", redirect);
    if (request.method !== "GET" || url.pathname !== "/callback" || !validState(url.searchParams.get("state"), state)) {
      response.writeHead(400); response.end("Invalid sign-in callback."); return;
    }
    response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    response.end("Return to Deckastra to finish signing in.");
    const code = url.searchParams.get("code");
    if (code && code.length <= 4096) resolveCode(code);
    else rejectCode(new Error("Sign-in was cancelled."));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Sign-in callback could not start.");
  redirect = `http://127.0.0.1:${address.port}/callback`;
  const timer = setTimeout(() => rejectCode(new Error("Sign-in timed out.")), 180_000);
  try {
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code",
      scope: "openid email profile", state, code_challenge: pkce(verifier), code_challenge_method: "S256" });
    await shell.openExternal("https://accounts.google.com/o/oauth2/v2/auth?" + params);
    const code = await codePromise;
    const google = await tokenJson(await fetch(cloudConfig().apiUrl + "/v1/auth/google/exchange", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, redirect_uri: redirect, code_verifier: verifier }),
      signal: AbortSignal.timeout(30_000) }));
    if (typeof google.id_token !== "string") throw new Error("Google did not return a sign-in token.");
    const firebase = await tokenJson(await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${encodeURIComponent(apiKey)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ requestUri: redirect, postBody: new URLSearchParams({ id_token: google.id_token, providerId: "google.com" }).toString(), returnSecureToken: true }),
    }));
    if (typeof firebase.idToken !== "string" || typeof firebase.refreshToken !== "string" || typeof firebase.email !== "string") throw new Error("Identity Platform did not return an account.");
    await save({ idToken: firebase.idToken, refreshToken: firebase.refreshToken, email: firebase.email, expiresAt: tokenExpiry(firebase.expiresIn) }, expected);
    return accountState();
  } finally {
    clearTimeout(timer); server.closeAllConnections(); server.close();
  }
}
