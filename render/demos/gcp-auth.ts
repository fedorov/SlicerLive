// gcp-auth.ts — Google sign-in for the `?gcp=` secondary source.
//
// A Google Identity Services token client: a popup, no redirect route, no client secret, so it
// works from a GitHub Pages subpath. Also the `?token=` intake OHIF accepts, for testing with
// `gcloud auth print-access-token` before an OAuth client exists.
//
// The access token is held in memory and mirrored to sessionStorage, because every series switch
// reloads the page; never in localStorage. gcpFetch attaches it ONLY to requests for
// https://healthcare.googleapis.com/ — never to the IDC API or the S3 buckets.
import { GHC_ORIGIN } from "./gcp-source.ts";

/** There is no read-only Healthcare scope; read-only is the store's IAM role plus GET-only use. */
export const SCOPE = "https://www.googleapis.com/auth/cloud-healthcare";
const GIS_SRC = "https://accounts.google.com/gsi/client";
const KEY = "slicerrad:gcp-token";
const URL_TOKEN_LIFE = 55 * 60_000; // gcloud tokens last an hour; the age when pasted is unknown
const MARGIN = 30_000;

interface Token {
  access: string;
  exp: number; // ms since epoch
  source: "google" | "url";
}

/** Not signed in, or the store turned the token down (401). Renewal needs a click. */
export class AuthError extends Error {
  override name = "AuthError";
}

let tok: Token | null = load();
const listeners = new Set<() => void>();

function load(): Token | null {
  try {
    const t = JSON.parse(sessionStorage.getItem(KEY) || "null");
    return t && typeof t.access === "string" && typeof t.exp === "number" && t.exp > Date.now() ? t : null;
  } catch {
    return null;
  }
}

function save(t: Token | null): void {
  tok = t;
  try {
    if (t) sessionStorage.setItem(KEY, JSON.stringify(t));
    else sessionStorage.removeItem(KEY);
  } catch { /* storage blocked: the token lives for this page only */ }
  for (const f of listeners) f();
}

/** The deployment's OAuth client ID (build.ts writes it into config.js); "" when unset. */
export function clientId(): string {
  // deno-lint-ignore no-explicit-any
  const id = (globalThis as any).__SLICERRAD_CONFIG?.googleClientId;
  return typeof id === "string" ? id.trim() : "";
}

export function hasValidToken(): boolean {
  return !!tok && tok.exp - MARGIN > Date.now();
}

/** How the current token was obtained, and when it lapses — for the Data sources dialog. */
export function tokenInfo(): { source: Token["source"]; exp: number } | null {
  return hasValidToken() ? { source: tok!.source, exp: tok!.exp } : null;
}

/** Subscribe to sign-in / sign-out / expiry; returns the unsubscribe. */
export function onAuthChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** Take `?token=` off the URL (before anything can log or share it) and keep it for this tab. */
export function takeUrlToken(): boolean {
  const u = new URL(globalThis.location.href);
  const t = u.searchParams.get("token");
  if (t == null) return false;
  u.searchParams.delete("token");
  history.replaceState(history.state, "", u.pathname + u.search + u.hash);
  if (!t.trim()) return false;
  save({ access: t.trim(), exp: Date.now() + URL_TOKEN_LIFE, source: "url" });
  return true;
}

// ---- Google Identity Services ------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
type Gis = any;
let gisLoad: Promise<Gis> | null = null;
let client: Gis = null;
let pending: { resolve: () => void; reject: (e: Error) => void } | null = null;

function loadGis(): Promise<Gis> {
  // deno-lint-ignore no-explicit-any
  const ready = () => (globalThis as any).google?.accounts?.oauth2;
  return gisLoad ??= new Promise((resolve, reject) => {
    if (ready()) return resolve(ready());
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => ready() ? resolve(ready()) : reject(new Error("Google sign-in loaded without its OAuth API"));
    s.onerror = () => {
      gisLoad = null;
      reject(new Error("couldn't load Google sign-in — is accounts.google.com blocked?"));
    };
    document.head.appendChild(s);
  });
}

function settle(err: Error | null): void {
  const p = pending;
  pending = null;
  if (err) p?.reject(err);
  else p?.resolve();
}

/** Load GIS and build the token client AHEAD of the click. requestAccessToken has to run inside
 *  the click's own task: awaiting a script load first outlasts Safari's user-activation window
 *  and the popup is blocked. */
export async function prepareSignIn(): Promise<void> {
  const id = clientId();
  if (!id) throw new Error("Google sign-in isn't configured for this deployment (no OAuth client ID)");
  const oauth2 = await loadGis();
  if (client) return;
  client = oauth2.initTokenClient({
    client_id: id,
    scope: SCOPE,
    prompt: "",
    // deno-lint-ignore no-explicit-any
    callback: (r: any) => {
      if (r.error) return settle(new Error(`Google sign-in failed: ${r.error_description || r.error}`));
      if (!oauth2.hasGrantedAllScopes(r, SCOPE)) {
        return settle(new Error("Google sign-in didn't grant access to Cloud Healthcare — tick the box and try again"));
      }
      save({ access: r.access_token, exp: Date.now() + Number(r.expires_in || 3600) * 1000, source: "google" });
      settle(null);
    },
    // deno-lint-ignore no-explicit-any
    error_callback: (e: any) => {
      settle(new Error(
        e?.type === "popup_closed"
          ? "the sign-in window was closed"
          : e?.type === "popup_failed_to_open"
          ? "the browser blocked the sign-in popup — allow popups for this site"
          : `Google sign-in failed: ${e?.message || e?.type || "unknown error"}`,
      ));
    },
  });
}

export const signInReady = (): boolean => !!client;

/** Open Google's popup. Call SYNCHRONOUSLY from a click handler, after prepareSignIn resolved. */
export function signIn(): Promise<void> {
  if (!client) return Promise.reject(new Error("Google sign-in isn't ready yet"));
  settle(new Error("superseded by a newer sign-in"));
  const p = new Promise<void>((resolve, reject) => (pending = { resolve, reject }));
  client.requestAccessToken({ prompt: "" });
  return p;
}

/** Forget the token. A Google-issued one is also revoked; a pasted `?token=` is the user's own
 *  gcloud credential, which revoking would break outside this viewer, so it is only dropped. */
export function signOut(): void {
  const t = tok;
  save(null);
  // deno-lint-ignore no-explicit-any
  if (t?.source === "google") (globalThis as any).google?.accounts?.oauth2?.revoke?.(t.access, () => {});
}

/** fetch() for the store: the Bearer token, and only for Google Healthcare. */
export async function gcpFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (!url.startsWith(GHC_ORIGIN + "/")) {
    throw new Error(`refusing to send the Google token to ${new URL(url, globalThis.location?.href).origin}`);
  }
  if (!hasValidToken()) throw new AuthError("not signed in to Google");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${tok!.access}`);
  const r = await fetch(url, { ...init, headers, credentials: "omit" });
  if (r.status === 401) {
    save(null);
    throw new AuthError("Google turned the sign-in down (expired or revoked) — sign in again");
  }
  return r;
}
