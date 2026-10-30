// gcp-source.ts — a Google Cloud Healthcare DICOM store as a SECONDARY source of segmentations.
//
// The images still come from IDC's public buckets (bir-browser.ts). The store only contributes
// DICOM SEG objects for the same study — the arrangement ImagingDataCommons/ohif-gcp-extension
// and Slim use for `?gcp=`: the store is named by its resource path, its SEGs are merged into the
// IDC study by StudyInstanceUID, and each one is matched to its images by ReferencedSeriesSequence.
//
// Everything above the fetch wrappers is pure, so gcp-source.test.ts can pin it down without a
// network. The wrappers take the fetch to use, so the token stays in gcp-auth.ts.

/** A parsed `?gcp=` value. */
export interface GcpStore {
  /** `projects/P/locations/L/datasets/D/dicomStores/S` — what `?gcp=` carries in links. */
  path: string;
  /** The store's DICOMweb root, `https://healthcare.googleapis.com/<ver>/<path>/dicomWeb`. */
  root: string;
  /** The store id, for labels. */
  label: string;
  /** From an OHIF-style `/study/<uid>[/series/<uid>]` suffix, when the value carried one. */
  study?: string;
  series?: string;
}

/** One SEG series in the store, from the instance-level QIDO (one request per study). */
export interface GcpSeg {
  seriesUID: string;
  /** The instance that is decoded — the lowest InstanceNumber. */
  sopUID: string;
  /** SEG instances in the series. Only the first is decoded (the same limit as the S3 path). */
  instances: number;
  seriesNumber: number | null;
  description: string;
  /** SeriesDate + SeriesTime, as one sortable string ("" when absent). */
  when: string;
  /** SegmentationType, upper-cased: BINARY, FRACTIONAL or LABELMAP ("" when absent). */
  type: string;
  /** SeriesInstanceUIDs from ReferencedSeriesSequence: the image series it was drawn on. */
  refSeries: string[];
}

export const GHC_ORIGIN = "https://healthcare.googleapis.com";

// Resource ids: GCP project ids are lowercase letters, digits and hyphens, with an optional
// `domain:` prefix for domain-scoped projects; dataset and store ids allow letters, digits,
// underscores, hyphens and periods. Nothing here may carry `?`, `#` or `%`, which would change
// what the URL built from it means.
const ID = "[A-Za-z0-9._:-]+";
const PATH_RE = new RegExp(
  `^projects/(${ID})/locations/(${ID})/datasets/(${ID})/dicomStores/(${ID})` +
    `(?:/dicomWeb)?(?:/study/([0-9.]+)(?:/series/([0-9.]+))?)?$`,
);
const UID_RE = /^[0-9.]{1,64}$/;

/** Parse every `?gcp=` form IDC's viewers accept:
 *   projects/P/locations/L/datasets/D/dicomStores/S            (OHIF, ohif-gcp-extension)
 *   /projects/…/dicomStores/S/study/<uid>[/series/<uid>]       (OHIF's optional suffix)
 *   https://healthcare.googleapis.com/v1/projects/…/dicomStores/S[/dicomWeb]   (Slim)
 *  Throws with a readable message for anything else, including any host but Google's — the
 *  token is only ever sent to healthcare.googleapis.com, so no other host can be a store. */
export function parseGcpParam(raw: string): GcpStore {
  let s = raw.trim().replace(/\/+$/, "");
  let ver = "v1";
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      throw new Error(`not a valid URL: ${raw}`);
    }
    if (u.origin !== GHC_ORIGIN) {
      throw new Error(`only Google Cloud Healthcare stores (${GHC_ORIGIN}) are supported, not ${u.origin}`);
    }
    if (u.search || u.hash) throw new Error("a store URL can't carry a query or a fragment");
    const m = u.pathname.match(/^\/(v1(?:beta1|alpha2)?)\/(.+)$/);
    if (!m) throw new Error(`not a Healthcare API path: ${u.pathname}`);
    ver = m[1];
    s = m[2].replace(/\/+$/, "");
  }
  s = s.replace(/^\/+/, "");
  const m = s.match(PATH_RE);
  if (!m) {
    throw new Error(
      `not a DICOM store path: ${raw} — expected projects/<p>/locations/<l>/datasets/<d>/dicomStores/<s>`,
    );
  }
  const path = `projects/${m[1]}/locations/${m[2]}/datasets/${m[3]}/dicomStores/${m[4]}`;
  return {
    path,
    root: `${GHC_ORIGIN}/${ver}/${path}/dicomWeb`,
    label: m[4],
    ...(m[5] ? { study: m[5] } : {}),
    ...(m[6] ? { series: m[6] } : {}),
  };
}

/** The canonical `?gcp=` value for a store: the bare path for v1 (what OHIF links carry), the
 *  absolute URL when the store was named under a beta API version. */
export function gcpParamValue(store: GcpStore): string {
  return store.root === `${GHC_ORIGIN}/v1/${store.path}/dicomWeb`
    ? store.path
    : store.root.replace(/\/dicomWeb$/, "");
}

// The instance-level QIDO's fields. GHC returns only the default attributes unless asked, and the
// two that decide everything — what a SEG was drawn on and whether it is BINARY — are not among
// them. Both are small and top-level, so QIDO returns them (unlike per-frame groups, which GHC
// drops from metadata past ~1 MiB).
export const QIDO_FIELDS = [
  "00081115", // ReferencedSeriesSequence
  "00620001", // SegmentationType
  "0008103E", // SeriesDescription
  "00200011", // SeriesNumber
  "00200013", // InstanceNumber
  "00080021", // SeriesDate
  "00080031", // SeriesTime
];

// deno-lint-ignore no-explicit-any
type DicomJson = Record<string, { vr?: string; Value?: any[] }>;
const val = (o: DicomJson, tag: string) => o?.[tag]?.Value?.[0];
const str = (o: DicomJson, tag: string) => {
  const v = val(o, tag);
  return v == null ? "" : String(v).trim();
};
const num = (o: DicomJson, tag: string) => {
  const n = Number.parseInt(str(o, tag), 10);
  return Number.isFinite(n) ? n : null;
};

/** QIDO instance rows (DICOM JSON) → one entry per SEG series. */
export function qidoToSegs(rows: DicomJson[]): GcpSeg[] {
  const by = new Map<string, { seg: GcpSeg; first: number }>();
  for (const r of rows) {
    const se = str(r, "0020000E"), sop = str(r, "00080018");
    if (!se || !sop) continue;
    const inst = num(r, "00200013") ?? Number.MAX_SAFE_INTEGER;
    const refs = (r["00081115"]?.Value ?? [])
      .map((it: DicomJson) => str(it, "0020000E"))
      .filter(Boolean);
    const hit = by.get(se);
    if (hit) {
      hit.seg.instances++;
      for (const x of refs) if (!hit.seg.refSeries.includes(x)) hit.seg.refSeries.push(x);
      if (inst < hit.first) {
        hit.first = inst;
        hit.seg.sopUID = sop;
      }
      continue;
    }
    by.set(se, {
      first: inst,
      seg: {
        seriesUID: se,
        sopUID: sop,
        instances: 1,
        seriesNumber: num(r, "00200011"),
        description: str(r, "0008103E"),
        when: str(r, "00080021") + str(r, "00080031"),
        type: str(r, "00620001").toUpperCase(),
        refSeries: [...new Set(refs)] as string[],
      },
    });
  }
  return [...by.values()].map((x) => x.seg);
}

/** Strip order: SeriesNumber, then date, then UID — the order OHIF lists a study in, and stable
 *  between loads, which the default choice depends on. */
export function orderSegs(segs: GcpSeg[]): GcpSeg[] {
  const n = (s: GcpSeg) => s.seriesNumber ?? Number.MAX_SAFE_INTEGER;
  return segs.slice().sort((a, b) =>
    n(a) - n(b) || a.when.localeCompare(b.when) || a.seriesUID.localeCompare(b.seriesUID)
  );
}

/** What IDC holds for the study, as far as choosing a segmentation needs to know. */
export interface IdcStudy {
  /** SeriesInstanceUIDs of the image series the reader can open. */
  images: Set<string>;
  /** SeriesInstanceUIDs of IDC's own SEG series. */
  segs: Set<string>;
}

/** Which store SEG to show when the page opens, and over which image series.
 *
 *  - A store SEG named in the URL wins. Its image is the one the URL also names, else the first
 *    it references that IDC has, else null (let the reader pick its default image).
 *  - An IDC SEG named in the URL wins over every store SEG: nothing is chosen here.
 *  - Otherwise the first store SEG in strip order that is decodable and was drawn on an IDC image
 *    series — on the image the URL names, when it names one.
 *  Returns null when no store SEG should be shown. */
export function chooseSeg(
  segs: GcpSeg[],
  want: string[],
  idc: IdcStudy,
): { seg: GcpSeg; image: string | null } | null {
  if (want.some((u) => idc.segs.has(u))) return null;
  const wantImg = want.find((u) => idc.images.has(u)) ?? null;
  const named = segs.find((s) => want.includes(s.seriesUID));
  if (named) return { seg: named, image: wantImg ?? named.refSeries.find((r) => idc.images.has(r)) ?? null };
  for (const s of orderSegs(segs)) {
    if (!decodable(s)) continue;
    const refs = s.refSeries.filter((r) => idc.images.has(r));
    if (wantImg ? refs.includes(wantImg) : refs.length) return { seg: s, image: wantImg ?? refs[0] };
  }
  return null;
}

/** BINARY is what the decoder reads. A missing SegmentationType is let through (it decodes as
 *  BINARY, as it always has); FRACTIONAL and LABELMAP are not bitmasks. */
export const decodable = (s: GcpSeg) => !s.type || s.type === "BINARY";

/** What a click on a store SEG's strip row does, given the image series on screen. */
export type SegAction =
  | { kind: "swap" }                     // drawn on the open series: swap the overlay in place
  | { kind: "navigate"; image: string }  // drawn on another IDC series: open that one with it
  | { kind: "none"; why: string };       // nothing sensible to do — the row says why

export function segAction(seg: GcpSeg, current: string | undefined, idcImages: Set<string>): SegAction {
  if (!decodable(seg)) return { kind: "none", why: `${seg.type} segmentations are not supported yet` };
  // No references at all: placement is by patient coordinates anyway, so try it over what's open.
  if (!seg.refSeries.length || (current && seg.refSeries.includes(current))) return { kind: "swap" };
  const other = seg.refSeries.find((r) => idcImages.has(r));
  if (other) return { kind: "navigate", image: other };
  return { kind: "none", why: "drawn on an image series that isn't in IDC" };
}

/** The store's SEGs for the strip: in order, minus any series IDC itself also holds (same
 *  SeriesInstanceUID — the IDC row is kept, since it needs no sign-in). */
export function stripSegs(segs: GcpSeg[], idcSeries: Set<string>): GcpSeg[] {
  return orderSegs(segs).filter((s) => !idcSeries.has(s.seriesUID));
}

/** Share-link params when a store is in use. The direct-S3 `series=` form can't name a SEG that
 *  lives outside IDC and drops the series strip, so the link is the OHIF form plus the store. */
export function gcpShareParams(st: string, sid: string | undefined, sgid: string | undefined, gcp: string): URLSearchParams {
  const q = new URLSearchParams();
  q.set("StudyInstanceUIDs", st);
  const sel = [sid, sgid].filter(Boolean).join(",");
  if (sel) q.set("SeriesInstanceUIDs", sel);
  q.set("gcp", gcp);
  return q;
}

// Transfer syntaxes the decode worker reads without a codec (dcmjs inflates the deflated one).
export const NATIVE_TS = new Set([
  "1.2.840.10008.1.2",      // implicit VR little endian
  "1.2.840.10008.1.2.1",    // explicit VR little endian
  "1.2.840.10008.1.2.1.99", // deflated explicit VR little endian
  "1.2.840.10008.1.2.2",    // explicit VR big endian (retired)
]);
export const EXPLICIT_LE = "1.2.840.10008.1.2.1";

/** TransferSyntaxUID (0002,0010) from a Part-10 file's meta header, or null if it isn't one.
 *  The meta group is always explicit VR little endian, so this needs no DICOM library. */
export function part10TransferSyntax(buf: ArrayBuffer): string | null {
  const b = new Uint8Array(buf);
  if (b.length < 144 || String.fromCharCode(b[128], b[129], b[130], b[131]) !== "DICM") return null;
  const dv = new DataView(buf);
  const LONG = new Set(["OB", "OW", "OF", "SQ", "UT", "UN", "OD", "OL", "OV", "UC", "UR"]);
  let o = 132;
  while (o + 8 <= b.length) {
    const group = dv.getUint16(o, true), elem = dv.getUint16(o + 2, true);
    if (group !== 0x0002) return null;
    const vr = String.fromCharCode(b[o + 4], b[o + 5]);
    let len: number, at: number;
    if (LONG.has(vr)) {
      len = dv.getUint32(o + 8, true);
      at = o + 12;
    } else {
      len = dv.getUint16(o + 6, true);
      at = o + 8;
    }
    if (at + len > b.length) return null;
    if (elem === 0x0010) {
      return String.fromCharCode(...b.subarray(at, at + len)).replace(/[\0 ]+$/, "");
    }
    o = at + len;
  }
  return null;
}

// ---- fetch wrappers ---------------------------------------------------------------------------

export type GFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Every SEG series the store holds for a study, in one instance-level QIDO. */
export async function listSegs(store: GcpStore, studyUID: string, gfetch: GFetch): Promise<GcpSeg[]> {
  if (!UID_RE.test(studyUID)) throw new Error(`not a DICOM UID: ${studyUID}`);
  const q = new URLSearchParams({ Modality: "SEG", limit: "5000" });
  for (const f of QIDO_FIELDS) q.append("includefield", f);
  const r = await gfetch(`${store.root}/studies/${studyUID}/instances?${q}`, {
    headers: { Accept: "application/dicom+json" },
  });
  // GHC answers an empty search with 204 and no body, not an empty array.
  if (r.status === 204 || r.status === 404) return [];
  if (!r.ok) throw new Error(await httpError(r, "searching the store"));
  const rows = await r.json();
  return qidoToSegs(Array.isArray(rows) ? rows : []);
}

/** One SEG instance as a Part-10 ArrayBuffer.
 *
 *  Asks for the STORED transfer syntax first: a deflated SEG is a few hundred KB as stored and
 *  tens of MB once GHC transcodes it (TotalSegmentator's 88-segment SEG: 268 KB vs 61.5 MB), and
 *  the worker reads deflate itself. Only a stored syntax the worker can't decode (an encapsulated
 *  one, such as RLE or JPEG 2000) costs a second request, transcoded to explicit VR LE. */
export async function fetchSegInstance(
  store: GcpStore,
  studyUID: string,
  seg: GcpSeg,
  gfetch: GFetch,
  onProgress?: (p: { msg: string; frac?: number }) => void,
): Promise<ArrayBuffer> {
  for (const u of [studyUID, seg.seriesUID, seg.sopUID]) {
    if (!UID_RE.test(u)) throw new Error(`not a DICOM UID: ${u}`);
  }
  const url = `${store.root}/studies/${studyUID}/series/${seg.seriesUID}/instances/${seg.sopUID}`;
  const get = async (ts: string) => {
    const r = await gfetch(url, { headers: { Accept: `application/dicom; transfer-syntax=${ts}` } });
    if (!r.ok) throw Object.assign(new Error(await httpError(r, "fetching the segmentation")), { status: r.status });
    return await readWithProgress(r, onProgress);
  };
  let buf: ArrayBuffer;
  try {
    buf = await get("*");
  } catch (e) {
    if ((e as { status?: number }).status !== 406) throw e;
    buf = await get(EXPLICIT_LE);
  }
  const ts = part10TransferSyntax(buf);
  if (ts && !NATIVE_TS.has(ts)) {
    onProgress?.({ msg: `stored as ${ts}; asking the store to decompress it…` });
    buf = await get(EXPLICIT_LE);
  }
  return buf;
}

async function readWithProgress(
  r: Response,
  onProgress?: (p: { msg: string; frac?: number }) => void,
): Promise<ArrayBuffer> {
  const total = Number(r.headers.get("Content-Length")) || 0;
  if (!r.body || !onProgress) return await r.arrayBuffer();
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.byteLength;
    const mb = (got / 1e6).toFixed(1);
    // Content-Length is the compressed size when the store gzips the answer, so clamp.
    onProgress(total ? { msg: `downloading SEG ${mb} MB`, frac: Math.min(1, got / total) } : { msg: `downloading SEG ${mb} MB` });
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out.buffer;
}

async function httpError(r: Response, what: string): Promise<string> {
  let detail = "";
  try {
    const t = await r.text();
    try {
      detail = JSON.parse(t)?.error?.message ?? t;
    } catch {
      detail = t;
    }
  } catch { /* no body */ }
  const hint = r.status === 403
    ? " — your Google account needs read access to this store (roles/healthcare.dicomViewer)"
    : r.status === 404
    ? " — check the store path"
    : "";
  return `Google Healthcare ${r.status} ${what}${hint}${detail ? `: ${detail.slice(0, 200)}` : ""}`;
}
