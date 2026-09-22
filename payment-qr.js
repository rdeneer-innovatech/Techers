// Prompt: remove the Electron app and create browser-based QR payment information.
// Reason: provide scannable SEPA payment QR codes directly from the website.
// --- GF(256) arithmetic for Reed-Solomon, primitive polynomial 0x11D ---
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// Generator polynomial for `degree` error-correction codewords.
const rsGenerator = degree => {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
};

// Remainder of data * x^degree divided by the generator — the EC codewords.
const rsEncode = (data, degree) => {
  const gen = rsGenerator(degree);
  const result = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.shift();
    result.push(0);
    for (let i = 0; i < degree; i += 1) result[i] ^= gfMul(gen[i + 1], factor);
  }
  return result;
};

// --- Version tables (levels L, M, Q, H order) ---
// Total codewords and the per-block structure, for versions 1-10.
const EC_LEVEL_M = 1;
const VERSIONS = {
  1: { total: 26, ecPerBlock: 10, blocks: 1 },
  2: { total: 44, ecPerBlock: 16, blocks: 1 },
  3: { total: 70, ecPerBlock: 26, blocks: 1 },
  4: { total: 100, ecPerBlock: 18, blocks: 2 },
  5: { total: 134, ecPerBlock: 24, blocks: 2 },
  6: { total: 172, ecPerBlock: 16, blocks: 4 },
  7: { total: 196, ecPerBlock: 18, blocks: 4 },
  8: { total: 242, ecPerBlock: 22, blocks: 4 },
  9: { total: 292, ecPerBlock: 22, blocks: 5 },
  10: { total: 346, ecPerBlock: 26, blocks: 5 }
};

// Characters of the EPC payload counted in byte mode.
const charCountBits = version => (version < 10 ? 8 : 16);

// Alignment pattern centres per version.
const ALIGNMENT = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
};

const buildDataCodewords = (text, version) => {
  const bytes = [...new TextEncoder().encode(text)];
  const spec = VERSIONS[version];
  const dataCodewords = spec.total - spec.ecPerBlock * spec.blocks;

  // Mode indicator 0100 (byte), then the character count.
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, charCountBits(version));
  bytes.forEach(byte => push(byte, 8));

  // Terminator, then pad to a whole codeword.
  const capacity = dataCodewords * 8;
  for (let i = 0; i < 4 && bits.length < capacity; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  // Pad codewords alternate 0xEC / 0x11 until the data capacity is reached.
  const PAD = [0xec, 0x11];
  let padIndex = 0;
  while (codewords.length < dataCodewords) {
    codewords.push(PAD[padIndex % 2]);
    padIndex += 1;
  }
  return codewords;
};

// Split into blocks, add EC codewords, then interleave as the standard requires.
const interleave = (dataCodewords, version) => {
  const spec = VERSIONS[version];
  const totalBlocks = spec.blocks;
  const ecPer = spec.ecPerBlock;
  const dataPerBlock = Math.floor(dataCodewords.length / totalBlocks);
  const remainder = dataCodewords.length % totalBlocks;

  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let i = 0; i < totalBlocks; i += 1) {
    const size = dataPerBlock + (i >= totalBlocks - remainder ? 1 : 0);
    const block = dataCodewords.slice(offset, offset + size);
    offset += size;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecPer));
  }

  const out = [];
  const longest = Math.max(...dataBlocks.map(block => block.length));
  for (let i = 0; i < longest; i += 1) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecPer; i += 1) {
    for (const block of ecBlocks) out.push(block[i]);
  }
  return out;
};

const buildMatrix = (version, codewords) => {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(null));

  const finder = (row, col) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark = inRing && (r === 0 || r === 6 || c === 0 || c === 6 ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        modules[rr][cc] = dark ? 1 : 0;
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // Timing patterns.
  for (let i = 8; i < size - 8; i += 1) {
    modules[6][i] = i % 2 === 0 ? 1 : 0;
    modules[i][6] = i % 2 === 0 ? 1 : 0;
  }

  // Alignment patterns, skipping the three finder corners.
  const centres = ALIGNMENT[version];
  for (const row of centres) {
    for (const col of centres) {
      if ((row <= 8 && col <= 8) || (row <= 8 && col >= size - 9) || (row >= size - 9 && col <= 8)) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
          modules[row + r][col + c] = dark ? 1 : 0;
        }
      }
    }
  }

  // Version information, for version 7 and up. A reader counts finder patterns to
  // establish orientation, but it cannot measure the symbol's size without a
  // reference, so from v7 the version is written into the symbol as an 18-bit
  // BCH-protected code. Without it a v7+ symbol is unreadable however correct the
  // rest is: the reader has no way to tell which version's grid to lay over the
  // image, so it discards the symbol. That is why the data region appears to have
  // 36 spare modules at these versions — those cells are this block, not remainder.
  if (version >= 7) {
    let value = version << 12;
    for (let i = 17; i >= 12; i -= 1) {
      if ((value >> i) & 1) value ^= 0b1111100100101 << (i - 12);
    }
    const bits = (version << 12) | value;
    // Two copies: one above the bottom-left finder, one left of the top-right
    // finder. Bit 0 is the least significant and sits nearest each finder.
    for (let i = 0; i < 18; i += 1) {
      const bit = (bits >> i) & 1;
      const row = Math.floor(i / 3);
      const col = (i % 3) + size - 11;
      modules[row][col] = bit;
      modules[col][row] = bit;
    }
  }

  // Reserve the format area so the data walker skips it.
  for (let i = 0; i < 9; i += 1) {
    if (modules[8][i] === null) modules[8][i] = 0;
    if (modules[i][8] === null) modules[i][8] = 0;
  }
  for (let i = 0; i < 8; i += 1) {
    if (modules[8][size - 1 - i] === null) modules[8][size - 1 - i] = 0;
    if (modules[size - 1 - i][8] === null) modules[size - 1 - i][8] = 0;
  }
  modules[size - 8][8] = 1; // the always-dark module

  // Place data bits in the zigzag order, skipping the vertical timing column.
  const bits = [];
  for (const codeword of codewords) {
    for (let i = 7; i >= 0; i -= 1) bits.push((codeword >> i) & 1);
  }
  let bitIndex = 0;
  let upward = true;
  // Walk two columns at a time from the right, ending on the pair (1,0). The vertical
  // timing column is part of the walk but never a placement target, so when the pair
  // start reaches it the walk shifts down one, turning that step into the pair (5,4).
  // Treating 6 as a skippable module instead — leaving the step at 6 and filtering it
  // inside the inner loop — kept the wrong parity for every later step, so the final
  // pair was (2,1) and column 0 was never filled. Those modules stayed null, and a
  // symbol with two empty columns is rejected by every reader.
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const cc of [col, col - 1]) {
        if (modules[row][cc] !== null) continue;
        modules[row][cc] = bitIndex < bits.length ? bits[bitIndex] : 0;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
  return { modules, size };
};

// Format information: level M with the given mask, BCH protected.
const applyFormat = (modules, size, mask) => {
  // Level M is 00 in the format field.
  const data = (0b00 << 3) | mask;
  let value = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if ((value >> i) & 1) value ^= 0b10100110111 << (i - 10);
  }
  const format = ((data << 10) | value) ^ 0b101010000010010;

  // Bit 0 is the least significant. The two copies lay the same 15 bits down in
  // opposite directions, and mixing the axes or the direction up leaves the reader
  // with two contradictory copies, so it discards the symbol. The primary copy walks
  // bit 0 upwards: column 8 rows 0-5, then across the timing row, then row 8 right to
  // left. The duplicate walks bit 14 downwards: column 8 from the bottom edge up to
  // (size-8, 8), then row 8 left to right. Both sequences are near-reversals of one
  // another, so a copy written the wrong way round still looks plausible on its own;
  // only comparing the two exposes it.
  for (let i = 0; i < 15; i += 1) {
    const bit = (format >> i) & 1;
    // Primary copy, around the top-left finder.
    if (i < 6) modules[i][8] = bit;
    else if (i === 6) modules[7][8] = bit;
    else if (i === 7) modules[8][8] = bit;
    else if (i === 8) modules[8][7] = bit;
    else modules[8][14 - i] = bit;
    // Duplicate copy. Bit 14 lands on the bottom edge and the walk ascends, so the
    // position for bit i is mirrored about the middle of the strip. The column run
    // covers seven modules (bits 14-8, rows size-1 up to size-7) and the row run
    // covers eight (bits 7-0, columns size-8 through size-1). Splitting them 8/7 puts
    // bit 7 on the column instead of the dark module at (size-8, 8), which is the
    // boundary the reader uses to orient itself.
    const mirrored = 14 - i;
    if (mirrored < 7) modules[size - 1 - mirrored][8] = bit;
    else modules[8][size - 15 + mirrored] = bit;
  }
  modules[size - 8][8] = 1;
};

// The eight data masks from the standard, applied to data modules only.
const maskFn = (mask, row, col) => {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
};

const isFunctionModule = (version, size, row, col) => {
  if (row === 6 || col === 6) return true;
  const inFinder = (r0, c0) => row >= r0 && row <= r0 + 7 && col >= c0 && col <= c0 + 7;
  if (inFinder(0, 0) || inFinder(0, size - 8) || inFinder(size - 8, 0)) return true;
  if (row === 8 && (col <= 8 || col >= size - 8)) return true;
  if (col === 8 && (row <= 8 || row >= size - 8)) return true;
  // The version-information blocks, from v7. These sit in the data region but are
  // not data: masking them would corrupt the version the reader depends on, so they
  // must be excluded here even though the block is drawn before the mask is chosen.
  if (version >= 7 &&
      ((row < 6 && col >= size - 11 && col < size - 8) ||
       (col < 6 && row >= size - 11 && row < size - 8))) return true;
  const centres = ALIGNMENT[version];
  for (const r of centres) {
    for (const c of centres) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      if (Math.abs(row - r) <= 2 && Math.abs(col - c) <= 2) return true;
    }
  }
  return false;
};

// Penalty rules 1-4, used to pick the mask that scans most reliably.
const penalty = modules => {
  const size = modules.length;
  let score = 0;
  // Rule 1: runs of five or more same-colour modules in a row or column.
  for (let i = 0; i < size; i += 1) {
    for (const read of [j => modules[i][j], j => modules[j][i]]) {
      let run = 1;
      for (let j = 1; j < size; j += 1) {
        if (read(j) === read(j - 1)) run += 1;
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }
  // Rule 2: every 2x2 block of one colour.
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) score += 3;
    }
  }
  // Rule 3: finder-like 1:1:3:1:1 patterns in a row or column.
  const PATTERN = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const PATTERN_REV = [...PATTERN].reverse();
  for (let i = 0; i < size; i += 1) {
    for (const read of [j => modules[i][j], j => modules[j][i]]) {
      const line = [];
      for (let j = 0; j < size; j += 1) line.push(read(j));
      for (let j = 0; j + PATTERN.length <= size; j += 1) {
        const slice = line.slice(j, j + PATTERN.length);
        if (PATTERN.every((v, k) => v === slice[k]) || PATTERN_REV.every((v, k) => v === slice[k])) score += 40;
      }
    }
  }
  // Rule 4: deviation from an even balance of dark and light.
  const dark = modules.flat().filter(v => v === 1).length;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
};

const chooseVersion = byteLength => {
  for (let version = 1; version <= 10; version += 1) {
    const spec = VERSIONS[version];
    const dataCodewords = spec.total - spec.ecPerBlock * spec.blocks;
    const neededBits = 4 + charCountBits(version) + byteLength * 8;
    if (neededBits <= dataCodewords * 8) return version;
  }
  throw new Error('The payment details are too long to encode in a QR code.');
};

const makeMatrix = text => {
  const byteLength = new TextEncoder().encode(text).length;
  const version = chooseVersion(byteLength);
  const data = buildDataCodewords(text, version);
  const codewords = interleave(data, version);
  const { modules, size } = buildMatrix(version, codewords);

  // Try every mask and keep the lowest penalty, as the standard prescribes.
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = modules.map(row => [...row]);
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        if (isFunctionModule(version, size, row, col)) continue;
        if (maskFn(mask, row, col)) candidate[row][col] ^= 1;
      }
    }
    applyFormat(candidate, size, mask);
    const score = penalty(candidate);
    if (!best || score < best.score) best = { score, modules: candidate };
  }
  return best.modules;
};

const svg = (text, { scale = 4, margin = 4 } = {}) => {
  const modules = makeMatrix(text);
  const size = modules.length;
  const extent = (size + margin * 2) * scale;
  const parts = [];
  for (let row = 0; row < size; row += 1) {
    let runStart = null;
    for (let col = 0; col <= size; col += 1) {
      const dark = col < size && modules[row][col] === 1;
      if (dark && runStart === null) runStart = col;
      if (!dark && runStart !== null) {
        // One rect per horizontal run keeps the element count down.
        parts.push(`<rect x="${(runStart + margin) * scale}" y="${(row + margin) * scale}"`
          + ` width="${(col - runStart) * scale}" height="${scale}"/>`);
        runStart = null;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${extent} ${extent}"`
    + ` width="${extent}" height="${extent}" shape-rendering="crispEdges">`
    + `<rect width="${extent}" height="${extent}" fill="#fff"/>`
    + `<g fill="#000">${parts.join('')}</g></svg>`;
};

const qrTarget = typeof window === 'undefined' ? globalThis : window;
qrTarget.TechersQr = { svg, EC_LEVEL_M, VERSIONS, chooseVersion, makeMatrix };
