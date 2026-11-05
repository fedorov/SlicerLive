// gcp-panel.ts — the reader-facing side of the secondary source of segmentations, named by
// `?gcp=` (a Google Cloud Healthcare store, read with a sign-in token) or `?dicomweb=` (a public
// DICOMweb root, e.g. a read-only proxy in front of such a store, read with no credentials):
//   connectGcp       — before the study opens: sign in (or not), then list the store's SEGs.
//                      A `?dicomweb=` store skips straight to the listing.
//   the sign-in gate — shown only when a link names a `?gcp=` store and there is no token. Its
//                      button is the user gesture Google's popup needs, which is why it comes
//                      BEFORE the images rather than as a strip row that appears later.
//   openDataSources  — the toolbar dialog: which sources are in use, paste or pick a store,
//                      sign in or out. Changing the store reloads, like changing series does.
import {
  AuthError,
  clientId,
  gcpFetch,
  hasValidToken,
  onAuthChange,
  prepareSignIn,
  signIn,
  signOut,
  tokenInfo,
} from "./gcp-auth.ts";
import {
  type GcpSeg,
  type GcpStore,
  type GFetch,
  gcpParamValue,
  listSegs,
  parseDicomwebParam,
  parseGcpParam,
  parseStoreInput,
  publicFetch,
  storeParamName,
} from "./gcp-source.ts";
import { CARD_CSS, OVERLAY_CSS } from "./idc-share.ts";

/** What the store contributed to this page load. */
export interface GcpState {
  /** `?dicomweb=` or `?gcp=` as given; null when the page has neither. */
  raw: string | null;
  store: GcpStore | null;
  segs: GcpSeg[];
  /** Why the store contributed nothing: a malformed value, a refused or failed search. */
  error?: string;
  /** The reader chose "Continue without" for this store, in this tab. */
  skipped?: boolean;
}

const RECENT_KEY = "slicerrad:gcp-recent"; // store paths and DICOMweb URLs only — never a token
const INPUT_HINT = "A Google Cloud store path or its https://healthcare.googleapis.com/… URL (sign-in), " +
  "or the https:// root of a public DICOMweb service (no sign-in).";
const MAX_RECENT = 8;
const skipKey = (s: GcpStore) => `slicerrad:gcp-skip:${s.path}`;

/** The page's secondary store: `?dicomweb=` if given (it needs no sign-in), else `?gcp=`. */
export function readStoreParam(params: URLSearchParams): GcpState {
  const dicomweb = params.get("dicomweb");
  const gcp = params.get("gcp");
  const [raw, parse] = dicomweb?.trim()
    ? [dicomweb, parseDicomwebParam]
    : gcp?.trim()
    ? [gcp, parseGcpParam]
    : [null, null];
  if (raw == null || !parse) return { raw: null, store: null, segs: [] };
  if (dicomweb?.trim() && gcp?.trim()) console.warn("[gcp] both ?dicomweb= and ?gcp= given; using ?dicomweb=");
  try {
    return { raw, store: parse(raw), segs: [] };
  } catch (e) {
    return { raw, store: null, segs: [], error: (e as Error).message };
  }
}

/** The fetch a store is read with: the Google token for `?gcp=`, nothing at all for `?dicomweb=`. */
export function fetchFor(store: GcpStore): GFetch {
  return store.kind === "dicomweb" ? publicFetch : gcpFetch;
}

/** Sign in if needed (the gate), then list the store's SEGs for the study. Never throws: a store
 *  that can't be read leaves the IDC study exactly as it would open without one. */
export async function connectGcp(st: GcpState, studyUID: string, onStatus: (m: string) => void): Promise<GcpState> {
  const store = st.store;
  if (!store) return st;
  if (store.kind === "dicomweb") {
    // Public: no gate, no token, no Google sign-in script.
    onStatus(`searching ${store.label} for segmentations…`);
    try {
      const segs = await listSegs(store, studyUID, publicFetch);
      remember(store);
      return { ...st, segs };
    } catch (e) {
      console.warn("[dicomweb]", e);
      return { ...st, error: (e as Error).message };
    }
  }
  for (let attempt = 0;; attempt++) {
    if (!hasValidToken()) {
      if (session(skipKey(store))) return { ...st, skipped: true };
      const choice = await gate(store, attempt ? "Google turned that sign-in down — sign in again." : undefined);
      if (choice === "skip") {
        session(skipKey(store), "1");
        return { ...st, skipped: true };
      }
    }
    onStatus(`searching ${store.label} for segmentations…`);
    try {
      const segs = await listSegs(store, studyUID, gcpFetch);
      remember(store);
      return { ...st, segs };
    } catch (e) {
      if (e instanceof AuthError && attempt === 0) continue; // a stale or pasted-bad token
      console.warn("[gcp]", e);
      return { ...st, error: (e as Error).message };
    }
  }
}

// ---- the sign-in gate ------------------------------------------------------------------------

function gate(store: GcpStore, note?: string): Promise<"signin" | "skip"> {
  return new Promise((resolve) => {
    const id = clientId();
    const ov = modal("gcp-gate", `
      <h3>Segmentations from Google Cloud</h3>
      <p>This link adds segmentations from a Google Cloud Healthcare DICOM store:</p>
      <p class="mono">${esc(store.path)}</p>
      <p>Sign in with a Google account that can read it to see them over the IDC images.
        The images themselves are public and open either way.</p>
      ${note ? `<p class="err">${esc(note)}</p>` : ""}
      ${id ? "" : `<p class="dim">Sign-in isn't configured for this deployment (no OAuth client ID).
        For testing, add <code>&amp;token=</code> with the output of
        <code>gcloud auth print-access-token</code> to the URL.</p>`}
      <p class="err" data-err hidden></p>
      <div class="actions">
        <button class="link" data-act="skip">Continue without</button>
        <button class="primary" data-act="signin" disabled>Sign in with Google</button>
      </div>`);
    const btn = ov.querySelector("[data-act=signin]") as HTMLButtonElement;
    const errEl = ov.querySelector("[data-err]") as HTMLElement;
    const showErr = (m: string) => {
      errEl.textContent = m;
      errEl.hidden = false;
    };
    const done = (c: "signin" | "skip") => {
      ov.remove();
      document.removeEventListener("keydown", onKey);
      resolve(c);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && done("skip");
    document.addEventListener("keydown", onKey);
    (ov.querySelector("[data-act=skip]") as HTMLElement).addEventListener("click", () => done("skip"));
    if (id) {
      btn.textContent = "Loading Google sign-in…";
      prepareSignIn().then(() => {
        btn.disabled = false;
        btn.textContent = "Sign in with Google";
        btn.focus();
      }, (e) => showErr((e as Error).message));
    }
    btn.addEventListener("click", () => {
      btn.disabled = true;
      errEl.hidden = true;
      signIn().then(() => done("signin"), (e) => {
        showErr((e as Error).message);
        btn.disabled = false;
      });
    });
  });
}

// ---- the Data sources dialog -------------------------------------------------------------------

/** The toolbar dialog. `state` is what this page load got from the store. */
export function openDataSources(state: GcpState): void {
  if (document.getElementById("gcp-sources")) return;
  const ov = modal("gcp-sources", `
    <h3>Data sources</h3>
    <div class="sec first">
      <div class="lbl">Primary</div>
      <p>NCI Imaging Data Commons — public, no sign-in. Images and IDC's own segmentations.</p>
    </div>
    <div class="sec">
      <div class="lbl">Secondary — segmentations from a DICOM store</div>
      <div data-current></div>
      <div class="row" style="margin-top:8px;">
        <input data-input spellcheck="false" autocomplete="off"
          placeholder="projects/…/dicomStores/…  or  https://… (public DICOMweb)">
        <button class="primary" data-act="apply" disabled>Apply</button>
      </div>
      <p class="dim" data-valid style="margin-top:4px;">${INPUT_HINT}</p>
      <div data-recent></div>
    </div>
    <div class="sec">
      <div class="lbl">Google account</div>
      <div data-auth></div>
    </div>
    <div class="actions"><button class="link" data-act="close">Close</button></div>`);

  const $ = (sel: string) => ov.querySelector(sel) as HTMLElement;
  const input = $("[data-input]") as HTMLInputElement;
  const applyBtn = $("[data-act=apply]") as HTMLButtonElement;
  const valid = $("[data-valid]");

  // What the current store gave this page.
  const cur = $("[data-current]");
  if (state.store) {
    const what = state.error
      ? `<p class="err">${esc(state.error)}</p>`
      : state.skipped
      ? `<p class="warn">Not signed in — its segmentations aren't shown. Sign in below.</p>`
      : state.store.kind === "dicomweb"
      ? `<p>Public DICOMweb, no sign-in. ${state.segs.length ? `${state.segs.length} segmentation series for this study.` : "No segmentations for this study."}</p>`
      : `<p>${state.segs.length ? `${state.segs.length} segmentation series for this study.` : "No segmentations for this study."}</p>`;
    cur.innerHTML = `<p class="mono">${esc(state.store.path)}</p>${what}
      <div class="row"><button data-act="remove">Remove</button></div>`;
    cur.querySelector("[data-act=remove]")!.addEventListener("click", () => go(null, state));
  } else {
    cur.innerHTML = state.error
      ? `<p class="err">The link's store couldn't be used: ${esc(state.error)}</p>`
      : `<p>None.</p>`;
  }

  // Paste a path: validated as it is typed.
  let parsed: GcpStore | null = null;
  input.addEventListener("input", () => {
    const v = input.value.trim();
    parsed = null;
    valid.className = "dim";
    if (!v) valid.textContent = INPUT_HINT;
    else {
      try {
        parsed = parseStoreInput(v);
        valid.textContent = parsed.kind === "dicomweb"
          ? `✓ ${parsed.label} (public DICOMweb at ${new URL(parsed.root).host}, no sign-in)`
          : `✓ ${parsed.label} (project ${parsed.path.split("/")[1]})`;
      } catch (e) {
        valid.textContent = (e as Error).message;
        valid.className = "err";
      }
    }
    applyBtn.disabled = !parsed || parsed.root === state.store?.root;
  });
  input.addEventListener("keydown", (e) => e.key === "Enter" && !applyBtn.disabled && applyBtn.click());
  applyBtn.addEventListener("click", () => parsed && go(parsed, state));

  // Recent stores.
  const recentEl = $("[data-recent]");
  const drawRecent = () => {
    const list = recent().filter((v) => v !== (state.store && gcpParamValue(state.store)));
    recentEl.innerHTML = list.length ? `<div class="dim" style="margin:8px 0 4px;">Recent</div>` : "";
    for (const v of list) {
      let s: GcpStore;
      try {
        s = parseStoreInput(v);
      } catch {
        continue;
      }
      const where = s.kind === "dicomweb"
        ? `DICOMweb · ${new URL(s.root).host}`
        : `${s.path.split("/")[1]} · ${s.path.split("/")[5]}`;
      const r = document.createElement("div");
      r.className = "row recent";
      r.innerHTML = `<button class="pick" title="${esc(s.path)}"><b>${esc(s.label)}</b>
        <span class="dim">${esc(where)}</span></button>
        <button class="link" title="Forget this store">✕</button>`;
      const [pick, forget] = r.querySelectorAll("button");
      pick.addEventListener("click", () => go(s, state));
      forget.addEventListener("click", () => {
        setRecent(recent().filter((x) => x !== v));
        drawRecent();
      });
      recentEl.appendChild(r);
    }
  };
  drawRecent();

  // Sign-in status, kept current while the dialog is open.
  const authEl = $("[data-auth]");
  const id = clientId();
  if (id) prepareSignIn().then(drawAuth, () => {});
  function drawAuth() {
    const t = tokenInfo();
    if (t) {
      const min = Math.max(1, Math.round((t.exp - Date.now()) / 60_000));
      authEl.innerHTML = `<p>${t.source === "google" ? "Signed in with Google" : "Using the access token from the link (?token=)"}
        — valid for about ${min} more minute${min === 1 ? "" : "s"}.</p>
        <div class="row"><button data-act="signout">Sign out</button></div>`;
      authEl.querySelector("[data-act=signout]")!.addEventListener("click", () => signOut());
      return;
    }
    authEl.innerHTML = `<p>Not signed in. Public IDC data and public DICOMweb stores need no sign-in;
        a Google Cloud store does.</p>
      ${id ? "" : `<p class="dim">Sign-in isn't configured for this deployment (no OAuth client ID).</p>`}
      <p class="err" data-err hidden></p>
      <div class="row"><button class="primary" data-act="signin" ${id ? "" : "disabled"}>Sign in with Google</button></div>`;
    const b = authEl.querySelector("[data-act=signin]") as HTMLButtonElement;
    const err = authEl.querySelector("[data-err]") as HTMLElement;
    b.addEventListener("click", () => {
      b.disabled = true;
      signIn().then(() => {
        // The store this page was opened with was skipped or refused: read it now.
        if (state.store?.kind === "gcp" && (state.skipped || state.error)) {
          session(skipKey(state.store), null);
          location.reload();
        }
      }, (e) => {
        err.textContent = (e as Error).message;
        err.hidden = false;
        b.disabled = false;
      });
    });
  }
  drawAuth();
  const unsub = onAuthChange(drawAuth);

  const close = () => {
    unsub();
    document.removeEventListener("keydown", onKey);
    ov.remove();
  };
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
  document.addEventListener("keydown", onKey);
  ov.addEventListener("click", (e) => e.target === ov && close());
  $("[data-act=close]").addEventListener("click", close);
  input.focus();
}

/** Reopen this study with `store` as the secondary source (null removes it). The URL may name
 *  a SEG from the old store, which means nothing to the new one, so that goes too. */
function go(store: GcpStore | null, state: GcpState): void {
  const u = new URL(location.href);
  const fromStore = new Set(state.segs.map((s) => s.seriesUID));
  for (const k of ["SeriesInstanceUIDs", "initialSeriesInstanceUID", "seriesUID"]) {
    const keep = (u.searchParams.get(k) ?? "").split(",").map((x) => x.trim()).filter((x) => x && !fromStore.has(x));
    if (keep.length) u.searchParams.set(k, keep.join(","));
    else u.searchParams.delete(k);
  }
  u.searchParams.delete("gcp");
  u.searchParams.delete("dicomweb");
  if (store) {
    session(skipKey(store), null);
    u.searchParams.set(storeParamName(store), gcpParamValue(store));
    if (store.study && !u.searchParams.get("StudyInstanceUIDs")) u.searchParams.set("StudyInstanceUIDs", store.study);
  }
  location.href = u.toString();
}

/** A dismissible banner under the toolbar about the store (as bir-browser's geometryNotice is
 *  about the series): it explains why segmentations a link promised are not on screen, so it
 *  stays up rather than passing through the status line. One at a time; a newer one replaces it. */
export function storeNotice(text: string, warn: boolean, action?: { label: string; run: () => void }): void {
  const viewer = document.getElementById("viewer");
  const bar0 = document.getElementById("bir-bar");
  if (!viewer || !bar0 || bar0.parentElement !== viewer) return;
  document.getElementById("gcp-notice")?.remove();
  const bar = document.createElement("div");
  bar.id = "gcp-notice";
  bar.style.cssText = "flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:7px 12px;" +
    `background:${warn ? "rgba(255,107,116,.12)" : "rgba(110,160,255,.11)"};` +
    `border-bottom:1px solid ${warn ? "rgba(255,107,116,.35)" : "rgba(110,160,255,.3)"};` +
    `color:${warn ? "#ff9aa1" : "#9fc0ff"};font:500 12px -apple-system,system-ui,sans-serif;line-height:1.45;`;
  const msg = document.createElement("div");
  msg.style.cssText = "flex:1 1 auto;min-width:0;overflow-wrap:anywhere;";
  msg.textContent = text;
  bar.appendChild(msg);
  if (action) {
    const b = document.createElement("button");
    b.textContent = action.label;
    b.style.cssText = "flex:0 0 auto;font:600 12px -apple-system,system-ui,sans-serif;color:inherit;" +
      "background:none;border:1px solid currentColor;border-radius:4px;padding:3px 10px;cursor:pointer;";
    b.addEventListener("click", action.run);
    bar.appendChild(b);
  }
  const x = document.createElement("button");
  x.textContent = "×";
  x.title = "Dismiss";
  x.style.cssText = "flex:0 0 auto;background:none;border:0;color:inherit;font:700 16px/1 system-ui;" +
    "cursor:pointer;opacity:.7;padding:0 2px;";
  const dismiss = () => {
    bar.remove();
    globalThis.dispatchEvent(new Event("resize")); // the views just got the space back
  };
  x.addEventListener("click", dismiss);
  bar.appendChild(x);
  bar0.insertAdjacentElement("afterend", bar);
  globalThis.dispatchEvent(new Event("resize"));
}

/** The banner for how the store's part of this page load went, if it needs one. */
export function noticeForState(state: GcpState, open: () => void): void {
  if (state.raw == null) return;
  const name = state.store?.label ?? "the segmentation store";
  const dlg = { label: "Data sources…", run: open };
  if (state.error) {
    storeNotice(`Segmentations from ${name} aren't shown — ${state.error}`, true, dlg);
  } else if (state.skipped) {
    storeNotice(`Not signed in to Google, so the segmentations in ${name} aren't shown.`, false, {
      label: "Sign in…",
      run: open,
    });
  } else if (!state.segs.length) {
    storeNotice(`${name} has no segmentations for this study.`, false, dlg);
  }
}

// ---- storage -------------------------------------------------------------------------------------

function recent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function setRecent(list: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  } catch { /* storage blocked */ }
}
function remember(store: GcpStore): void {
  const v = gcpParamValue(store);
  setRecent([v, ...recent().filter((x) => x !== v)]);
}
/** sessionStorage get (one arg), set (a string) or remove (null). */
function session(key: string, val?: string | null): string | null {
  try {
    if (val === undefined) return sessionStorage.getItem(key);
    if (val === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, val);
  } catch { /* storage blocked */ }
  return null;
}

// ---- modal chrome ----------------------------------------------------------------------------------

const STYLE = `
.gcp-card h3 { margin:0 0 8px; color:#fff; font-size:15px; }
.gcp-card p { margin:0 0 8px; color:#9fb3d0; line-height:1.45; }
.gcp-card code, .gcp-card .mono { font:12px ui-monospace,Menlo,monospace; color:#d6e2f2; word-break:break-all; }
.gcp-card .err { color:#ff6b74; }
.gcp-card .warn { color:#f0c674; }
.gcp-card .dim { color:#5a6b85; font-size:11px; }
.gcp-card .sec { border-top:1px solid #1b2740; padding-top:10px; margin-top:10px; }
.gcp-card .sec.first { border-top:none; padding-top:0; }
.gcp-card .lbl { color:#9fd0b3; font-weight:600; margin-bottom:4px; }
.gcp-card .row { display:flex; gap:6px; align-items:center; }
.gcp-card .actions { display:flex; gap:8px; justify-content:flex-end; margin-top:14px; }
.gcp-card button { font:600 12px -apple-system,system-ui,sans-serif; color:#d6e2f2; background:#1b2740;
  border:1px solid #33507e; border-radius:4px; padding:6px 12px; cursor:pointer; }
.gcp-card button.primary { background:#2b6cb0; border-color:#2b6cb0; color:#fff; }
.gcp-card button.link { background:none; border:none; color:#9fb3d0; padding:6px 4px; }
.gcp-card button:disabled { opacity:.45; cursor:default; }
.gcp-card input { flex:1; min-width:0; font:12px ui-monospace,Menlo,monospace; color:#d6e2f2;
  background:#0b0e16; border:1px solid #33507e; border-radius:4px; padding:6px 8px; }
.gcp-card .recent { margin-bottom:4px; }
.gcp-card .recent .pick { flex:1; min-width:0; text-align:left; font-weight:400; background:#0b0e16;
  border-color:#1b2740; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.gcp-card .recent .pick:hover { border-color:#33507e; }
`;

function modal(id: string, html: string): HTMLElement {
  if (!document.getElementById("gcp-style")) {
    const s = document.createElement("style");
    s.id = "gcp-style";
    s.textContent = STYLE;
    document.head.appendChild(s);
  }
  const ov = document.createElement("div");
  ov.id = id;
  ov.style.cssText = OVERLAY_CSS;
  ov.innerHTML = `<div class="gcp-card" style="${CARD_CSS}">${html}</div>`;
  document.body.appendChild(ov);
  return ov;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
