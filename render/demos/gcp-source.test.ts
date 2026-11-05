// T1: the `?gcp=` / `?dicomweb=` secondary source — parsing every IDC viewer form and public
// DICOMweb roots, QIDO rows → SEG entries, the
// default segmentation choice, the strip's row actions, the share params, and the Part-10
// transfer-syntax sniff. Fixtures are shaped like the real GHC answers for cmb_mel MSB-01652.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  chooseSeg,
  type GcpSeg,
  gcpParamValue,
  gcpShareParams,
  orderSegs,
  parseDicomwebParam,
  parseGcpParam,
  parseStoreInput,
  part10TransferSyntax,
  qidoToSegs,
  segAction,
  storeParamName,
  stripSegs,
} from "./gcp-source.ts";

const PATH = "projects/idc-external-031/locations/northamerica-northeast1/datasets/terra-kyle-analysis/dicomStores/idc-segmentations-20261014";
const ROOT = `https://healthcare.googleapis.com/v1/${PATH}/dicomWeb`;
const ST = "1.3.6.1.4.1.14519.5.2.1.1.24853151934559037595356077023600365781";
const LUNG = "1.3.6.1.4.1.14519.5.2.1.1.21712092398839068620782996394613728646";
const MIP = "1.3.6.1.4.1.14519.5.2.1.1.99999999999999999999999999999999999991";

// --- parseGcpParam ---------------------------------------------------------------------------

Deno.test("parseGcpParam: the bare OHIF path", () => {
  const s = parseGcpParam(PATH);
  assertEquals(s.path, PATH);
  assertEquals(s.root, ROOT);
  assertEquals(s.label, "idc-segmentations-20261014");
  assertEquals(s.study, undefined);
  assertEquals(s.kind, "gcp");
  assertEquals(storeParamName(s), "gcp");
});

Deno.test("parseGcpParam: leading slash, trailing slash, whitespace", () => {
  assertEquals(parseGcpParam(` /${PATH}/ `).root, ROOT);
});

Deno.test("parseGcpParam: OHIF's /study/<uid>/series/<uid> suffix", () => {
  const s = parseGcpParam(`${PATH}/study/${ST}/series/${LUNG}`);
  assertEquals(s.path, PATH);
  assertEquals(s.study, ST);
  assertEquals(s.series, LUNG);
  assertEquals(parseGcpParam(`${PATH}/study/${ST}`).series, undefined);
});

Deno.test("parseGcpParam: Slim's absolute URL, with and without /dicomWeb", () => {
  assertEquals(parseGcpParam(`https://healthcare.googleapis.com/v1/${PATH}`).root, ROOT);
  assertEquals(parseGcpParam(`https://healthcare.googleapis.com/v1/${PATH}/dicomWeb`).root, ROOT);
  assertEquals(parseGcpParam(`https://healthcare.googleapis.com/v1/${PATH}/dicomWeb/`).path, PATH);
});

Deno.test("parseGcpParam: keeps a beta API version", () => {
  assertEquals(
    parseGcpParam(`https://healthcare.googleapis.com/v1beta1/${PATH}`).root,
    `https://healthcare.googleapis.com/v1beta1/${PATH}/dicomWeb`,
  );
});

Deno.test("gcpParamValue: the bare path for v1, the URL for a beta version", () => {
  assertEquals(gcpParamValue(parseGcpParam(`https://healthcare.googleapis.com/v1/${PATH}/dicomWeb`)), PATH);
  const beta = `https://healthcare.googleapis.com/v1beta1/${PATH}`;
  assertEquals(gcpParamValue(parseGcpParam(beta)), beta);
  assertEquals(parseGcpParam(gcpParamValue(parseGcpParam(beta))).root, parseGcpParam(beta).root);
});

Deno.test("parseGcpParam: domain-scoped project ids", () => {
  const p = "projects/google.com:my-proj/locations/us/datasets/d/dicomStores/s";
  assertEquals(parseGcpParam(p).path, p);
});

Deno.test("parseGcpParam: refuses every other host — the token only goes to Google's", () => {
  assertThrows(() => parseGcpParam(`https://evil.example.com/v1/${PATH}`), Error, "only Google Cloud Healthcare");
  assertThrows(() => parseGcpParam(`http://healthcare.googleapis.com/v1/${PATH}`), Error, "only Google Cloud Healthcare");
  assertThrows(() => parseGcpParam(`https://healthcare.googleapis.com.evil.com/v1/${PATH}`), Error, "only Google");
});

Deno.test("parseGcpParam: refuses malformed paths and smuggled query text", () => {
  assertThrows(() => parseGcpParam("projects/p/locations/l/datasets/d"), Error, "not a DICOM store path");
  assertThrows(() => parseGcpParam(`${PATH}?x=1`), Error, "not a DICOM store path");
  assertThrows(() => parseGcpParam(`${PATH}#x`), Error, "not a DICOM store path");
  assertThrows(() => parseGcpParam(`${PATH}/../../other`), Error, "not a DICOM store path");
  assertThrows(() => parseGcpParam(`https://healthcare.googleapis.com/v1/${PATH}?alt=media`), Error, "query");
  assertThrows(() => parseGcpParam(`https://healthcare.googleapis.com/v2/${PATH}`), Error, "not a Healthcare API path");
  assertThrows(() => parseGcpParam(""), Error);
});

// --- qidoToSegs ------------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
const row = (se: string, sop: string, o: { n?: number; inst?: number; desc?: string; type?: string; refs?: string[]; date?: string } = {}): any => ({
  "0020000E": { vr: "UI", Value: [se] },
  "00080018": { vr: "UI", Value: [sop] },
  "00080060": { vr: "CS", Value: ["SEG"] },
  ...(o.n != null ? { "00200011": { vr: "IS", Value: [o.n] } } : {}),
  ...(o.inst != null ? { "00200013": { vr: "IS", Value: [o.inst] } } : {}),
  ...(o.desc ? { "0008103E": { vr: "LO", Value: [o.desc] } } : {}),
  ...(o.type ? { "00620001": { vr: "CS", Value: [o.type] } } : {}),
  ...(o.date ? { "00080021": { vr: "DA", Value: [o.date] } } : {}),
  "00081115": {
    vr: "SQ",
    Value: (o.refs ?? [LUNG]).map((r) => ({
      "0008114A": { vr: "SQ", Value: [{ "00081155": { vr: "UI", Value: ["1.2.3"] } }] },
      "0020000E": { vr: "UI", Value: [r] },
    })),
  },
});

Deno.test("qidoToSegs: one entry per series, fields read from DICOM JSON", () => {
  const segs = qidoToSegs([
    row("9.911", "9.911.1", { n: 911, inst: 1, desc: "TotalSegmentator total", type: "binary" }),
    row("9.901", "9.901.1", { n: 901, inst: 1, desc: "MOOSE clin_ct_body" }),
  ]);
  assertEquals(segs.length, 2);
  assertEquals(segs[0], {
    seriesUID: "9.911", sopUID: "9.911.1", instances: 1, seriesNumber: 911,
    description: "TotalSegmentator total", when: "", type: "BINARY", refSeries: [LUNG],
  });
  assertEquals(segs[1].type, "");
});

Deno.test("qidoToSegs: a multi-instance series decodes its lowest InstanceNumber, refs unioned", () => {
  const [s] = qidoToSegs([
    row("9.1", "9.1.3", { inst: 3, refs: [LUNG] }),
    row("9.1", "9.1.1", { inst: 1, refs: [MIP] }),
    row("9.1", "9.1.2", { inst: 2, refs: [LUNG] }),
  ]);
  assertEquals(s.instances, 3);
  assertEquals(s.sopUID, "9.1.1");
  assertEquals(s.refSeries.sort(), [LUNG, MIP].sort());
});

Deno.test("qidoToSegs: rows without UIDs are skipped; no rows is no SEGs", () => {
  assertEquals(qidoToSegs([{ "00080060": { vr: "CS", Value: ["SEG"] } }]), []);
  assertEquals(qidoToSegs([]), []);
});

// --- ordering and the default choice ---------------------------------------------------------

const seg = (seriesUID: string, o: Partial<GcpSeg> = {}): GcpSeg => ({
  seriesUID, sopUID: seriesUID + ".1", instances: 1, seriesNumber: null, description: "",
  when: "", type: "BINARY", refSeries: [LUNG], ...o,
});
const IDC = { images: new Set([LUNG, MIP]), segs: new Set(["7.idcseg"]) };

Deno.test("orderSegs: SeriesNumber, then date, then UID; unnumbered last", () => {
  const out = orderSegs([
    seg("c", { seriesNumber: null }),
    seg("b", { seriesNumber: 911 }),
    seg("a2", { seriesNumber: 901, when: "20261014" }),
    seg("a1", { seriesNumber: 901, when: "20261013" }),
  ]).map((s) => s.seriesUID);
  assertEquals(out, ["a1", "a2", "b", "c"]);
});

Deno.test("chooseSeg: no URL choice → the first store SEG and the image it references", () => {
  const r = chooseSeg([seg("9.911", { seriesNumber: 911 }), seg("9.901", { seriesNumber: 901 })], [], IDC);
  assertEquals(r?.seg.seriesUID, "9.901");
  assertEquals(r?.image, LUNG);
});

Deno.test("chooseSeg: a store SEG named in the URL wins, over the image it references", () => {
  const r = chooseSeg([seg("9.901", { seriesNumber: 901 }), seg("9.911", { seriesNumber: 911 })], ["9.911"], IDC);
  assertEquals(r?.seg.seriesUID, "9.911");
  assertEquals(r?.image, LUNG);
});

Deno.test("chooseSeg: an image named alongside the SEG is kept", () => {
  assertEquals(chooseSeg([seg("9.911")], [MIP, "9.911"], IDC)?.image, MIP);
});

Deno.test("chooseSeg: only an image named → the first store SEG drawn on THAT image", () => {
  const segs = [seg("9.901", { seriesNumber: 901, refSeries: [LUNG] }), seg("9.902", { seriesNumber: 902, refSeries: [MIP] })];
  assertEquals(chooseSeg(segs, [MIP], IDC)?.seg.seriesUID, "9.902");
  assertEquals(chooseSeg([seg("9.901", { refSeries: [LUNG] })], [MIP], IDC), null);
});

Deno.test("chooseSeg: an IDC SEG named in the URL means no store SEG is chosen", () => {
  assertEquals(chooseSeg([seg("9.901")], [LUNG, "7.idcseg"], IDC), null);
});

Deno.test("chooseSeg: the default skips what can't be decoded or placed", () => {
  const r = chooseSeg([
    seg("9.1", { seriesNumber: 1, type: "FRACTIONAL" }),
    seg("9.2", { seriesNumber: 2, refSeries: ["1.2.not.in.idc"] }),
    seg("9.3", { seriesNumber: 3 }),
  ], [], IDC);
  assertEquals(r?.seg.seriesUID, "9.3");
  assertEquals(chooseSeg([seg("9.2", { refSeries: ["1.2.not.in.idc"] })], [], IDC), null);
  assertEquals(chooseSeg([], [], IDC), null);
});

Deno.test("chooseSeg: a named SEG with no IDC reference still opens, on the default image", () => {
  const r = chooseSeg([seg("9.2", { refSeries: ["1.2.not.in.idc"] })], ["9.2"], IDC);
  assertEquals(r?.seg.seriesUID, "9.2");
  assertEquals(r?.image, null);
});

// --- strip rows ------------------------------------------------------------------------------

Deno.test("segAction: swap over the open series, navigate to another, refuse the rest", () => {
  const imgs = new Set([LUNG, MIP]);
  assertEquals(segAction(seg("9.1", { refSeries: [LUNG] }), LUNG, imgs), { kind: "swap" });
  assertEquals(segAction(seg("9.1", { refSeries: [MIP] }), LUNG, imgs), { kind: "navigate", image: MIP });
  assertEquals(segAction(seg("9.1", { refSeries: [] }), LUNG, imgs), { kind: "swap" });
  assertEquals(segAction(seg("9.1", { refSeries: ["1.2.x"] }), LUNG, imgs).kind, "none");
  const fr = segAction(seg("9.1", { type: "FRACTIONAL" }), LUNG, imgs);
  assert(fr.kind === "none" && fr.why.includes("FRACTIONAL"));
});

Deno.test("stripSegs: ordered, and a series IDC also holds is left to the IDC row", () => {
  const out = stripSegs([seg("9.2", { seriesNumber: 2 }), seg("7.idcseg", { seriesNumber: 0 }), seg("9.1", { seriesNumber: 1 })], new Set(["7.idcseg", LUNG]));
  assertEquals(out.map((s) => s.seriesUID), ["9.1", "9.2"]);
});

// --- share ------------------------------------------------------------------------------------

Deno.test("gcpShareParams: OHIF form + store, round-trips through parseGcpParam", () => {
  const q = gcpShareParams(ST, LUNG, "9.911", PATH);
  assertEquals(q.get("StudyInstanceUIDs"), ST);
  assertEquals(q.get("SeriesInstanceUIDs"), `${LUNG},9.911`);
  assertEquals(q.has("series"), false);
  const back = new URLSearchParams(q.toString());
  assertEquals(parseGcpParam(back.get("gcp")!).path, PATH);
  assertEquals(gcpShareParams(ST, LUNG, undefined, PATH).get("SeriesInstanceUIDs"), LUNG);
});

// --- ?dicomweb= -----------------------------------------------------------------------------

const PROXY = "https://northamerica-northeast1-idc-external-031.cloudfunctions.net/cloudsegmentator_proxy";

Deno.test("parseDicomwebParam: a public proxy root — kind, root, label, param", () => {
  const s = parseDicomwebParam(PROXY);
  assertEquals(s.kind, "dicomweb");
  assertEquals(s.root, PROXY);
  assertEquals(s.path, PROXY);
  assertEquals(s.label, "cloudsegmentator_proxy");
  assertEquals(storeParamName(s), "dicomweb");
  assertEquals(gcpParamValue(s), PROXY);
  assertEquals(parseDicomwebParam(` ${PROXY}/ `).root, PROXY);
});

Deno.test("parseDicomwebParam: the label skips service segments, falls back to the host", () => {
  assertEquals(parseDicomwebParam("https://pacs.example.org/orthanc/dicom-web").label, "orthanc");
  assertEquals(parseDicomwebParam("https://pacs.example.org/store1/dicomWeb/").label, "store1");
  assertEquals(parseDicomwebParam("https://pacs.example.org/rs").label, "pacs.example.org");
  assertEquals(parseDicomwebParam("https://pacs.example.org").root, "https://pacs.example.org");
});

Deno.test("parseDicomwebParam: https only, http just for localhost", () => {
  assertThrows(() => parseDicomwebParam("http://pacs.example.org/dicomweb"), Error, "https://");
  assertThrows(() => parseDicomwebParam("ftp://pacs.example.org/dicomweb"), Error, "https://");
  assertEquals(parseDicomwebParam("http://localhost:8080").root, "http://localhost:8080");
  assertEquals(parseDicomwebParam("http://127.0.0.1:8089/x").label, "x");
});

Deno.test("parseDicomwebParam: refuses Google Healthcare, queries, fragments, credentials", () => {
  assertThrows(() => parseDicomwebParam(ROOT), Error, "?gcp=");
  assertThrows(() => parseDicomwebParam(`${PROXY}?x=1`), Error, "query");
  assertThrows(() => parseDicomwebParam(`${PROXY}#x`), Error, "query");
  assertThrows(() => parseDicomwebParam("https://user:pw@pacs.example.org/dicomweb"), Error, "user name");
  assertThrows(() => parseDicomwebParam(PATH), Error, "not a valid URL");
});

Deno.test("parseStoreInput: Google paths and URLs are ?gcp=, any other URL is ?dicomweb=", () => {
  assertEquals(parseStoreInput(PATH).kind, "gcp");
  assertEquals(parseStoreInput(ROOT).kind, "gcp");
  assertEquals(parseStoreInput(PROXY).kind, "dicomweb");
  assertThrows(() => parseStoreInput("http://pacs.example.org"), Error, "https://");
});

Deno.test("gcpShareParams: ?dicomweb= form round-trips through parseDicomwebParam", () => {
  const q = gcpShareParams(ST, LUNG, "9.911", PROXY, "dicomweb");
  assertEquals(q.has("gcp"), false);
  const back = new URLSearchParams(q.toString());
  assertEquals(parseDicomwebParam(back.get("dicomweb")!).root, PROXY);
  assertEquals(back.get("SeriesInstanceUIDs"), `${LUNG},9.911`);
});

// --- part10TransferSyntax ---------------------------------------------------------------------

/** A Part-10 preamble + meta group: (0002,0001) OB, (0002,0002) UI, (0002,0010) UI. */
function part10(ts: string, trailing = true): ArrayBuffer {
  const parts: number[] = new Array(128).fill(0);
  parts.push(..."DICM".split("").map((c) => c.charCodeAt(0)));
  const el = (g: number, e: number, vr: string, val: number[]) => {
    const long = vr === "OB";
    const out = [g & 0xff, g >> 8, e & 0xff, e >> 8, vr.charCodeAt(0), vr.charCodeAt(1)];
    if (long) out.push(0, 0, val.length & 0xff, (val.length >> 8) & 0xff, 0, 0);
    else out.push(val.length & 0xff, val.length >> 8);
    return [...out, ...val];
  };
  const txt = (s: string) => {
    const b = s.split("").map((c) => c.charCodeAt(0));
    if (b.length % 2) b.push(0);
    return b;
  };
  parts.push(...el(2, 1, "OB", [0, 1]));
  parts.push(...el(2, 2, "UI", txt("1.2.840.10008.5.1.4.1.1.66.4")));
  parts.push(...el(2, 0x10, "UI", txt(ts)));
  if (trailing) parts.push(...el(8, 0x16, "UI", txt("1.2.840.10008.5.1.4.1.1.66.4")));
  return new Uint8Array(parts).buffer;
}

Deno.test("part10TransferSyntax: reads (0002,0010), odd-length padding stripped", () => {
  assertEquals(part10TransferSyntax(part10("1.2.840.10008.1.2.1.99")), "1.2.840.10008.1.2.1.99");
  assertEquals(part10TransferSyntax(part10("1.2.840.10008.1.2.1")), "1.2.840.10008.1.2.1");
  assertEquals(part10TransferSyntax(part10("1.2.840.10008.1.2.5", false)), "1.2.840.10008.1.2.5");
});

Deno.test("part10TransferSyntax: not Part 10 → null", () => {
  assertEquals(part10TransferSyntax(new ArrayBuffer(200)), null);
  assertEquals(part10TransferSyntax(new ArrayBuffer(10)), null);
});
