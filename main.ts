// PNG squeeze: lossless PNG recompressor for 1280x720 RGBA screenshots.
// Strategy (from the competition spec): reduce colour type (palette / grey /
// RGB / grey+alpha / RGBA, with tRNS where a single transparent value allows
// it), try several per-row filter strategies, screen each candidate with
// zlib level 6, re-try the best few at level 9, keep the smallest file.
// Deterministic: no clock, no randomness, no environment-dependent choices.
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

// ---------- CRC32 ----------
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
}

// ---------- PNG decoding ----------
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

type Decoded = { width: number; height: number; rgba: Uint8Array };

function decodePng(buf: Buffer): Decoded {
  if (
    buf.length < 8 ||
    buf.readUInt32BE(0) !== 0x89504e47 ||
    buf.readUInt32BE(4) !== 0x0d0a1a0a
  ) {
    throw new Error("bad png signature");
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let plte: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "PLTE") {
      plte = Buffer.from(data);
    } else if (type === "tRNS") {
      trns = Buffer.from(data);
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error("only bit depth 8 supported");
  const channels =
    colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (channels === 0) throw new Error("unsupported colour type " + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rowBytes = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    const srcOff = y * (rowBytes + 1);
    const filter = raw[srcOff];
    const row = new Uint8Array(rowBytes);
    for (let x = 0; x < rowBytes; x++) {
      const v = raw[srcOff + 1 + x];
      const a = x >= channels ? row[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let r: number;
      if (filter === 0) r = v;
      else if (filter === 1) r = v + a;
      else if (filter === 2) r = v + b;
      else if (filter === 3) r = v + ((a + b) >> 1);
      else if (filter === 4) r = v + paeth(a, b, c);
      else throw new Error("bad filter " + filter);
      row[x] = r & 0xff;
    }
    prev = row;
    const dst = y * width * 4;
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      if (colorType === 0) {
        const g = row[s];
        rgba[dst + x * 4] = g;
        rgba[dst + x * 4 + 1] = g;
        rgba[dst + x * 4 + 2] = g;
        rgba[dst + x * 4 + 3] = trns && trns.length >= 2 && g === trns.readUInt16BE(0) ? 0 : 255;
      } else if (colorType === 2) {
        rgba[dst + x * 4] = row[s];
        rgba[dst + x * 4 + 1] = row[s + 1];
        rgba[dst + x * 4 + 2] = row[s + 2];
        rgba[dst + x * 4 + 3] =
          trns && trns.length >= 6 && row[s] === trns.readUInt16BE(0) && row[s + 1] === trns.readUInt16BE(2) && row[s + 2] === trns.readUInt16BE(4)
            ? 0
            : 255;
      } else if (colorType === 3) {
        const idx = row[s];
        const p = idx * 3;
        rgba[dst + x * 4] = plte ? plte[p] : 0;
        rgba[dst + x * 4 + 1] = plte ? plte[p + 1] : 0;
        rgba[dst + x * 4 + 2] = plte ? plte[p + 2] : 0;
        rgba[dst + x * 4 + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (colorType === 4) {
        const g = row[s];
        rgba[dst + x * 4] = g;
        rgba[dst + x * 4 + 1] = g;
        rgba[dst + x * 4 + 2] = g;
        rgba[dst + x * 4 + 3] = row[s + 1];
      } else {
        rgba[dst + x * 4] = row[s];
        rgba[dst + x * 4 + 1] = row[s + 1];
        rgba[dst + x * 4 + 2] = row[s + 2];
        rgba[dst + x * 4 + 3] = row[s + 3];
      }
    }
  }
  return { width, height, rgba };
}

// ---------- Analysis and colour-type reduction ----------
type Form = {
  colorType: number;
  bpp: number;
  plte: Buffer | null;
  trns: Buffer | null;
  rows: Buffer; // unfiltered scanline bytes, height * width * bpp
};

function analyse(rgba: Uint8Array, width: number, height: number): Form[] {
  const n = width * height;
  const distinct = new Map<number, number>();
  let allGrey = true;
  let allOpaque = true;
  const transparentValues = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    if (r !== g || g !== b) allGrey = false;
    if (a !== 255) {
      allOpaque = false;
      const key = (r << 16) | (g << 8) | b;
      transparentValues.set(key, (transparentValues.get(key) ?? 0) + 1);
    }
    const key = ((r * 256 + g) * 256 + b) * 256 + a;
    distinct.set(key, (distinct.get(key) ?? 0) + 1);
  }
  const forms: Form[] = [];

  // Palette (type 3): at most 256 distinct RGBA tuples.
  if (distinct.size <= 256) {
    const entries = [...distinct.entries()];
    // Order by count desc, then luminance asc, then RGBA tuple (deterministic).
    entries.sort((x, y) => {
      if (y[1] !== x[1]) return y[1] - x[1];
      const xr = (x[0] >>> 24) & 0xff;
      const xg = (x[0] >>> 16) & 0xff;
      const xb = (x[0] >>> 8) & 0xff;
      const yr = (y[0] >>> 24) & 0xff;
      const yg = (y[0] >>> 16) & 0xff;
      const yb = (y[0] >>> 8) & 0xff;
      const xl = 2126 * xr + 7152 * xg + 722 * xb;
      const yl = 2126 * yr + 7152 * yg + 722 * yb;
      if (xl !== yl) return xl - yl;
      return x[0] - y[0];
    });
    const indexOf = new Map<number, number>();
    const plte = Buffer.alloc(entries.length * 3);
    const alphas = new Uint8Array(entries.length);
    entries.forEach(([key], idx) => {
      indexOf.set(key, idx);
      plte[idx * 3] = (key >>> 24) & 0xff;
      plte[idx * 3 + 1] = (key >>> 16) & 0xff;
      plte[idx * 3 + 2] = (key >>> 8) & 0xff;
      alphas[idx] = key & 0xff;
    });
    const rows = Buffer.alloc(n);
    for (let i = 0; i < n; i++) {
      const key = ((rgba[i * 4] * 256 + rgba[i * 4 + 1]) * 256 + rgba[i * 4 + 2]) * 256 + rgba[i * 4 + 3];
      rows[i] = indexOf.get(key)!;
    }
    let trns: Buffer | null = null;
    let lastOpaque = entries.length;
    while (lastOpaque > 0 && alphas[lastOpaque - 1] === 255) lastOpaque--;
    if (lastOpaque > 0) trns = Buffer.from(alphas.subarray(0, lastOpaque));
    forms.push({ colorType: 3, bpp: 1, plte, trns, rows });
  }

  // Grey (type 0) with optional tRNS key, or grey+alpha (type 4).
  if (allGrey) {
    if (allOpaque) {
      const rows = Buffer.alloc(n);
      for (let i = 0; i < n; i++) rows[i] = rgba[i * 4];
      forms.push({ colorType: 0, bpp: 1, plte: null, trns: null, rows });
    } else if (transparentValues.size === 1) {
      // Single transparent grey value, everything else opaque: tRNS key.
      const key = [...transparentValues.keys()][0];
      const gv = (key >> 16) & 0xff;
      const rows = Buffer.alloc(n);
      for (let i = 0; i < n; i++) rows[i] = rgba[i * 4];
      const trns = Buffer.alloc(2);
      trns.writeUInt16BE(gv, 0);
      forms.push({ colorType: 0, bpp: 1, plte: null, trns, rows });
    } else {
      const rows = Buffer.alloc(n * 2);
      for (let i = 0; i < n; i++) {
        rows[i * 2] = rgba[i * 4];
        rows[i * 2 + 1] = rgba[i * 4 + 3];
      }
      forms.push({ colorType: 4, bpp: 2, plte: null, trns: null, rows });
    }
  }

  // RGB (type 2) when opaque, or with a single transparent colour key.
  if (allOpaque) {
    const rows = Buffer.alloc(n * 3);
    for (let i = 0; i < n; i++) {
      rows[i * 3] = rgba[i * 4];
      rows[i * 3 + 1] = rgba[i * 4 + 1];
      rows[i * 3 + 2] = rgba[i * 4 + 2];
    }
    forms.push({ colorType: 2, bpp: 3, plte: null, trns: null, rows });
  } else if (transparentValues.size === 1) {
    const key = [...transparentValues.keys()][0];
    const rows = Buffer.alloc(n * 3);
    for (let i = 0; i < n; i++) {
      rows[i * 3] = rgba[i * 4];
      rows[i * 3 + 1] = rgba[i * 4 + 1];
      rows[i * 3 + 2] = rgba[i * 4 + 2];
    }
    const trns = Buffer.alloc(6);
    trns.writeUInt16BE((key >> 16) & 0xff, 0);
    trns.writeUInt16BE((key >> 8) & 0xff, 2);
    trns.writeUInt16BE(key & 0xff, 4);
    forms.push({ colorType: 2, bpp: 3, plte: null, trns, rows });
  }

  // RGBA (type 6) always works.
  const rows6 = Buffer.from(rgba);
  forms.push({ colorType: 6, bpp: 4, plte: null, trns: null, rows: rows6 });
  return forms;
}

// ---------- Row filters ----------
// Each row is filtered with all 5 PNG filters exactly once; every strategy
// then picks per row (or per image) from those precomputed variants.
function filterRowData(
  out: Buffer,
  outOff: number,
  row: Buffer,
  rowOff: number,
  prev: Buffer | null,
  prevOff: number,
  rowBytes: number,
  bpp: number,
  filter: number,
): void {
  for (let x = 0; x < rowBytes; x++) {
    const v = row[rowOff + x];
    const a = x >= bpp ? row[rowOff + x - bpp] : 0;
    const b = prev ? prev[prevOff + x] : 0;
    const c = prev && x >= bpp ? prev[prevOff + x - bpp] : 0;
    let p: number;
    if (filter === 0) p = v;
    else if (filter === 1) p = v - a;
    else if (filter === 2) p = v - b;
    else if (filter === 3) p = v - ((a + b) >> 1);
    else p = v - paeth(a, b, c);
    out[outOff + x] = p & 0xff;
  }
}

function rowVariants(form: Form, width: number, height: number): Buffer[] {
  const rowBytes = width * form.bpp;
  const vars: Buffer[] = [];
  for (let f = 0; f < 5; f++) vars.push(Buffer.alloc(height * rowBytes));
  for (let y = 0; y < height; y++) {
    const rowOff = y * rowBytes;
    const prev = y > 0 ? form.rows : null;
    const prevOff = (y - 1) * rowBytes;
    for (let f = 0; f < 5; f++) {
      filterRowData(vars[f], rowOff, form.rows, rowOff, prev, prevOff, rowBytes, form.bpp, f);
    }
  }
  return vars;
}

function signedAbsSum(buf: Buffer, off: number, len: number): number {
  let s = 0;
  for (let i = 0; i < len; i++) {
    const v = buf[off + i];
    s += v > 127 ? 256 - v : v;
  }
  return s;
}

const PAIR_STAMP = new Uint32Array(65536);
let pairMark = 0;

function distinctPairs(buf: Buffer, off: number, len: number): number {
  pairMark++;
  if (pairMark === 0xffffffff) {
    PAIR_STAMP.fill(0);
    pairMark = 1;
  }
  let count = 0;
  let prev = 0;
  for (let i = 0; i < len; i++) {
    const v = buf[off + i];
    const key = (prev << 8) | v;
    if (PAIR_STAMP[key] !== pairMark) {
      PAIR_STAMP[key] = pairMark;
      count++;
    }
    prev = v;
  }
  return count;
}

function assemble(vars: Buffer[], width: number, height: number, bpp: number, picks: Uint8Array): Buffer {
  const rowBytes = width * bpp;
  const out = Buffer.alloc(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    const f = picks[y];
    out[y * (rowBytes + 1)] = f;
    vars[f].copy(out, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  return out;
}

function fixedPicks(height: number, f: number): Uint8Array {
  const picks = new Uint8Array(height);
  picks.fill(f);
  return picks;
}

// Greedy per-row choice by real zlib cost (level 4) with the previous 32 KiB
// of the stream being built as dictionary. Returns the assembled stream.
function bruteStream(vars: Buffer[], width: number, height: number, bpp: number): Buffer {
  const rowBytes = width * bpp;
  const stream = Buffer.alloc(height * (rowBytes + 1));
  const probe = Buffer.alloc(rowBytes + 1);
  for (let y = 0; y < height; y++) {
    const built = y * (rowBytes + 1);
    const dictStart = Math.max(0, built - 32768);
    const dict = stream.subarray(dictStart, built);
    let bestF = 0;
    let bestLen = Infinity;
    for (let f = 0; f < 5; f++) {
      probe[0] = f;
      vars[f].copy(probe, 1, y * rowBytes, (y + 1) * rowBytes);
      const len = zlib.deflateSync(probe, { level: 4, dictionary: dict }).length;
      if (len < bestLen) {
        bestLen = len;
        bestF = f;
      }
    }
    stream[built] = bestF;
    vars[bestF].copy(stream, built + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  return stream;
}

// All strategy streams for one colour form. Brute (per-row real zlib cost)
// is only run for 1-byte-per-pixel forms: on RGB/RGBA it costs far more
// than it saves, while on palette/grey it is the biggest single win.
function strategyStreams(form: Form, width: number, height: number): { name: string; buf: Buffer }[] {
  const vars = rowVariants(form, width, height);
  const rowBytes = width * form.bpp;
  const out: { name: string; buf: Buffer }[] = [];
  for (const f of [0, 1, 2, 4]) {
    out.push({ name: "fixed" + f, buf: assemble(vars, width, height, form.bpp, fixedPicks(height, f)) });
  }
  // Minsum: per row, filter with the smallest sum of |signed byte|.
  {
    const picks = new Uint8Array(height);
    for (let y = 0; y < height; y++) {
      let bestF = 0;
      let bestCost = Infinity;
      for (let f = 0; f < 5; f++) {
        const cost = signedAbsSum(vars[f], y * rowBytes, rowBytes);
        if (cost < bestCost) {
          bestCost = cost;
          bestF = f;
        }
      }
      picks[y] = bestF;
    }
    out.push({ name: "minsum", buf: assemble(vars, width, height, form.bpp, picks) });
  }
  // Pairs: per row, filter with the fewest distinct adjacent byte pairs.
  {
    const picks = new Uint8Array(height);
    for (let y = 0; y < height; y++) {
      let bestF = 0;
      let bestCost = Infinity;
      for (let f = 0; f < 5; f++) {
        const cost = distinctPairs(vars[f], y * rowBytes, rowBytes);
        if (cost < bestCost) {
          bestCost = cost;
          bestF = f;
        }
      }
      picks[y] = bestF;
    }
    out.push({ name: "pairs", buf: assemble(vars, width, height, form.bpp, picks) });
  }
  if (form.bpp === 1) out.push({ name: "brute", buf: bruteStream(vars, width, height, form.bpp) });
  return out;
}

// ---------- Candidate evaluation and encoding ----------
function fileOverhead(form: Form): number {
  // Signature + IHDR chunk + IEND chunk, plus PLTE / tRNS chunks.
  let n = 8 + 25 + 12;
  if (form.plte) n += 12 + form.plte.length;
  if (form.trns) n += 12 + form.trns.length;
  return n;
}

function encodePng(form: Form, width: number, height: number, filtered: Buffer, level: number): Buffer {
  const compressed = zlib.deflateSync(filtered, { level });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = form.colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const parts: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr)];
  if (form.plte) parts.push(chunk("PLTE", form.plte));
  if (form.trns) parts.push(chunk("tRNS", form.trns));
  parts.push(chunk("IDAT", compressed));
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function squeezeOne(inputPath: string, outputPath: string): number {
  const { width, height, rgba } = decodePng(fs.readFileSync(inputPath));
  const forms = analyse(rgba, width, height);
  type Cand = { form: Form; name: string; filtered: Buffer; total6: number };
  const cands: Cand[] = [];
  for (const form of forms) {
    const overhead = fileOverhead(form);
    for (const s of strategyStreams(form, width, height)) {
      const size6 = zlib.deflateSync(s.buf, { level: 6 }).length;
      cands.push({ form, name: s.name, filtered: s.buf, total6: overhead + 12 + size6 });
    }
  }
  cands.sort((a, b) => a.total6 - b.total6);
  // Re-try the best few at level 9 (level 6 ranking is not level 9 ranking).
  let best: { form: Form; name: string; filtered: Buffer; level: number; total: number } | null = null;
  const consider = (form: Form, name: string, filtered: Buffer, level: number): void => {
    const total = fileOverhead(form) + 12 + zlib.deflateSync(filtered, { level }).length;
    if (best === null || total < best.total) best = { form, name, filtered, level, total };
  };
  consider(cands[0].form, cands[0].name, cands[0].filtered, 6);
  const top = cands.slice(0, Math.min(2, cands.length));
  for (const c of top) consider(c.form, c.name, c.filtered, 9);
  const chosen = best!;
  const out = encodePng(chosen.form, width, height, chosen.filtered, chosen.level);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, out);
  console.error(`  winner: type ${chosen.form.colorType} ${chosen.name} level ${chosen.level}`);
  return out.length;
}

// ---------- Main ----------
function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  const ids = ["i001", "i002", "i003", "i004", "i005", "i006", "i007", "i008"];
  for (const id of ids) {
    const bytes = squeezeOne(path.join(inputDir, id, "image.png"), path.join(outputDir, id, "image.png"));
    console.error(`${id}: ${bytes} bytes`);
  }
}

main();
