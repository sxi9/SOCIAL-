// Hand-rolled QR encoder (v0.9 — API.md §1.71/§1.73, ADR-021). Byte mode,
// ECC level M, versions 1–10 (≤ 213 bytes — the login-link URL and otpauth
// URIs are well inside that). Emits an inline-SVG path; NO dependency, by
// decision: ADR-021 sanctions exactly one dependency exception
// (@simplewebauthn) and QR rendering is not it. Both QR surfaces keep their
// no-QR fallback permanently visible (display code / manual key), so a
// payload that overflows these tables simply returns null and the fallback
// carries the feature.
//
// Implements ISO/IEC 18004 for the subset we need: byte-mode segments,
// Reed–Solomon EC over GF(256) (poly 0x11d), block interleaving, all eight
// mask patterns with the four standard penalty rules, format info
// (BCH(15,5) ⊕ 0x5412) and version info (BCH(18,6)) for versions ≥ 7.

// ---- GF(256) arithmetic -----------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** Reed–Solomon generator polynomial of degree `ecLen` (coefficients, leading 1). */
function rsGenerator(ecLen: number): number[] {
  let poly = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** RS error-correction codewords for one block. */
function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGenerator(ecLen);
  const buf = data.concat(new Array<number>(ecLen).fill(0));
  for (let i = 0; i < data.length; i++) {
    const coef = buf[i];
    if (coef === 0) continue;
    for (let j = 1; j < gen.length; j++) buf[i + j] ^= gfMul(gen[j], coef);
    buf[i] = 0;
  }
  return buf.slice(data.length);
}

// ---- Version tables (ECC level M, versions 1–10) ---------------------------

interface VersionSpec {
  /** EC codewords per block. */
  ec: number;
  /** Block groups: [count, dataCodewordsPerBlock][] */
  groups: [number, number][];
}

const VERSIONS: VersionSpec[] = [
  { ec: 10, groups: [[1, 16]] },
  { ec: 16, groups: [[1, 28]] },
  { ec: 26, groups: [[1, 44]] },
  { ec: 18, groups: [[2, 32]] },
  { ec: 24, groups: [[2, 43]] },
  { ec: 16, groups: [[4, 27]] },
  { ec: 18, groups: [[4, 31]] },
  {
    ec: 22,
    groups: [
      [2, 38],
      [2, 39],
    ],
  },
  {
    ec: 22,
    groups: [
      [3, 36],
      [2, 37],
    ],
  },
  {
    ec: 26,
    groups: [
      [4, 43],
      [1, 44],
    ],
  },
];

/** Alignment-pattern center coordinates per version (1-indexed version - 1). */
const ALIGN: number[][] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

function dataCodewords(spec: VersionSpec): number {
  return spec.groups.reduce((sum, [n, k]) => sum + n * k, 0);
}

// ---- Bit buffer -------------------------------------------------------------

class BitBuffer {
  bytes: number[] = [];
  length = 0;

  put(value: number, bits: number): void {
    for (let i = bits - 1; i >= 0; i--) this.putBit(((value >>> i) & 1) === 1);
  }

  putBit(bit: boolean): void {
    const byteIndex = this.length >> 3;
    if (this.bytes.length <= byteIndex) this.bytes.push(0);
    if (bit) this.bytes[byteIndex] |= 0x80 >>> (this.length & 7);
    this.length++;
  }
}

// ---- Matrix build -----------------------------------------------------------

type Cell = boolean | null;

function placeFinder(m: Cell[][], row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || rr >= m.length || cc < 0 || cc >= m.length) continue;
      const dark =
        (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
        (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
        (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      m[rr][cc] = dark;
    }
  }
}

function placeAlignment(m: Cell[][], version: number): void {
  const pos = ALIGN[version - 1];
  for (const row of pos) {
    for (const col of pos) {
      if (m[row][col] !== null) continue; // overlaps a finder
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          m[row + r][col + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
        }
      }
    }
  }
}

function placeTiming(m: Cell[][]): void {
  const size = m.length;
  for (let i = 8; i < size - 8; i++) {
    if (m[i][6] === null) m[i][6] = i % 2 === 0;
    if (m[6][i] === null) m[6][i] = i % 2 === 0;
  }
}

function bch15(data: number): number {
  const G = 0b10100110111; // x^10 + x^8 + x^5 + x^4 + x^2 + x + 1
  let d = data << 10;
  while (32 - Math.clz32(d) >= 11) d ^= G << (32 - Math.clz32(d) - 11);
  return ((data << 10) | d) ^ 0b101010000010010;
}

function bch18(version: number): number {
  const G = 0b1111100100101; // x^12 + x^11 + x^10 + x^9 + x^8 + x^5 + x^2 + 1
  let d = version << 12;
  while (32 - Math.clz32(d) >= 13) d ^= G << (32 - Math.clz32(d) - 13);
  return (version << 12) | d;
}

/** Format info for ECC M (indicator 00) + mask id, both copies. */
function placeFormat(m: Cell[][], mask: number): void {
  const size = m.length;
  const bits = bch15((0b00 << 3) | mask);
  for (let i = 0; i < 15; i++) {
    const mod = ((bits >> i) & 1) === 1;
    // copy 1, around the top-left finder (vertical then horizontal arm)
    if (i < 6) m[i][8] = mod;
    else if (i < 8) m[i + 1][8] = mod;
    else m[size - 15 + i][8] = mod;
    if (i < 8) m[8][size - i - 1] = mod;
    else if (i < 9) m[8][15 - i - 1 + 1] = mod;
    else m[8][15 - i - 1] = mod;
  }
  m[size - 8][8] = true; // dark module
}

function placeVersionInfo(m: Cell[][], version: number): void {
  if (version < 7) return;
  const size = m.length;
  const bits = bch18(version);
  for (let i = 0; i < 18; i++) {
    const mod = ((bits >> i) & 1) === 1;
    m[Math.floor(i / 3)][(i % 3) + size - 11] = mod;
    m[(i % 3) + size - 11][Math.floor(i / 3)] = mod;
  }
}

type MaskFn = (r: number, c: number) => boolean;

const MASKS: MaskFn[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r * c) % 3) + ((r + c) % 2)) % 2 === 0,
];

/** Zig-zag data placement with the mask applied to data modules. */
function mapData(m: Cell[][], data: number[], mask: MaskFn): void {
  const size = m.length;
  let inc = -1;
  let row = size - 1;
  let bitIndex = 7;
  let byteIndex = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        if (m[row][col - c] === null) {
          let dark = false;
          if (byteIndex < data.length) dark = ((data[byteIndex] >>> bitIndex) & 1) === 1;
          if (mask(row, col - c)) dark = !dark;
          m[row][col - c] = dark;
          bitIndex--;
          if (bitIndex === -1) {
            byteIndex++;
            bitIndex = 7;
          }
        }
      }
      row += inc;
      if (row < 0 || row >= size) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }
}

/** The four standard mask penalty rules (lower is better). */
function penalty(m: boolean[][]): number {
  const size = m.length;
  let score = 0;
  // N1: runs of ≥5 same-colored modules, rows and columns.
  for (let axis = 0; axis < 2; axis++) {
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const cur = axis === 0 ? m[i][j] : m[j][i];
        const prev = axis === 0 ? m[i][j - 1] : m[j - 1][i];
        if (cur === prev) {
          run++;
          if (j === size - 1 && run >= 5) score += run - 2;
        } else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
    }
  }
  // N2: 2x2 blocks of one color.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (m[r][c + 1] === v && m[r + 1][c] === v && m[r + 1][c + 1] === v) score += 3;
    }
  }
  // N3: finder-like 1:1:3:1:1 pattern with 4 light modules on either side.
  const PAT_A = [true, false, true, true, true, false, true, false, false, false, false];
  const PAT_B = [false, false, false, false, true, false, true, true, true, false, true];
  for (let axis = 0; axis < 2; axis++) {
    for (let i = 0; i < size; i++) {
      for (let j = 0; j <= size - 11; j++) {
        let matchA = true;
        let matchB = true;
        for (let k = 0; k < 11; k++) {
          const v = axis === 0 ? m[i][j + k] : m[j + k][i];
          if (v !== PAT_A[k]) matchA = false;
          if (v !== PAT_B[k]) matchB = false;
          if (!matchA && !matchB) break;
        }
        if (matchA || matchB) score += 40;
      }
    }
  }
  // N4: dark-module proportion deviation from 50%, in 5% steps.
  let dark = 0;
  for (const row of m) for (const cell of row) if (cell) dark++;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

// ---- Public API -------------------------------------------------------------

/**
 * Encode `text` (UTF-8, byte mode, ECC M) into a module matrix.
 * Returns null when the payload exceeds version 10 (~213 bytes) — callers
 * fall back to the always-visible text form (display code / manual key).
 */
export function encodeQr(text: string): boolean[][] | null {
  const bytes = Array.from(new TextEncoder().encode(text));

  let version = 0;
  for (let v = 1; v <= VERSIONS.length; v++) {
    const capacityBits = dataCodewords(VERSIONS[v - 1]) * 8;
    const needed = 4 + (v <= 9 ? 8 : 16) + bytes.length * 8;
    if (needed <= capacityBits) {
      version = v;
      break;
    }
  }
  if (version === 0) return null;
  const spec = VERSIONS[version - 1];
  const totalData = dataCodewords(spec);

  // Data bit stream: mode (0100) + count + bytes + terminator + pad.
  const bits = new BitBuffer();
  bits.put(0b0100, 4);
  bits.put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) bits.put(b, 8);
  const capacity = totalData * 8;
  bits.put(0, Math.min(4, capacity - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.putBit(false);
  const PAD = [0xec, 0x11];
  for (let i = 0; bits.length < capacity; i++) bits.put(PAD[i % 2], 8);

  // Split into blocks, compute EC, interleave.
  const blocks: { data: number[]; ec: number[] }[] = [];
  let offset = 0;
  for (const [count, k] of spec.groups) {
    for (let b = 0; b < count; b++) {
      const data = bits.bytes.slice(offset, offset + k);
      offset += k;
      blocks.push({ data, ec: rsEncode(data, spec.ec) });
    }
  }
  const interleaved: number[] = [];
  const maxLen = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxLen; i++) {
    for (const b of blocks) if (i < b.data.length) interleaved.push(b.data[i]);
  }
  for (let i = 0; i < spec.ec; i++) {
    for (const b of blocks) interleaved.push(b.ec[i]);
  }

  // Try all 8 masks; keep the lowest-penalty matrix.
  const size = 17 + version * 4;
  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m: Cell[][] = Array.from({ length: size }, () => new Array<Cell>(size).fill(null));
    placeFinder(m, 0, 0);
    placeFinder(m, 0, size - 7);
    placeFinder(m, size - 7, 0);
    placeAlignment(m, version);
    placeTiming(m);
    placeFormat(m, mask);
    placeVersionInfo(m, version);
    mapData(m, interleaved, MASKS[mask]);
    const full = m.map((row) => row.map((c) => c === true));
    const score = penalty(full);
    if (score < bestScore) {
      bestScore = score;
      best = full;
    }
  }
  return best;
}

export interface QrSvg {
  /** Modules per side (excluding the quiet zone). */
  size: number;
  /** SVG path data drawing every dark module as a unit square at (col, row). */
  path: string;
}

/** Encode to an SVG path spec (null = payload too large; show the fallback). */
export function qrSvg(text: string): QrSvg | null {
  const matrix = encodeQr(text);
  if (!matrix) return null;
  const size = matrix.length;
  let path = '';
  for (let r = 0; r < size; r++) {
    // Merge horizontal runs into one rect each — smaller path, no hairline seams.
    let c = 0;
    while (c < size) {
      if (!matrix[r][c]) {
        c++;
        continue;
      }
      let end = c;
      while (end < size && matrix[r][end]) end++;
      path += `M${c} ${r}h${end - c}v1h${c - end}z`;
      c = end;
    }
  }
  return { size, path };
}
