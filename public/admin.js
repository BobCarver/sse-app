// deno:https://jsr.io/@libs/qrcode/3.1.0/_png.ts
var COLORS = {
  transparent: "#00000000",
  black: "#000000",
  white: "#FFFFFF",
  gray: "#808080",
  grey: "#808080",
  brown: "#A52A2A",
  red: "#FF0000",
  orange: "#FFA500",
  yellow: "#FFFF00",
  green: "#008000",
  cyan: "#00FFFF",
  blue: "#0000FF",
  indigo: "#4B0082",
  violet: "#EE82EE",
  pink: "#FFC0CB",
  magenta: "#FF00FF",
  purple: "#800080",
  rebeccapurple: "#663399"
};
function color(value) {
  const hex = (COLORS[value.toLowerCase()] ?? value).replace(/^#/, "");
  if (/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) {
    const expanded = hex.length <= 4 ? [
      ...hex
    ].map((char) => char + char).join("") : hex;
    const channels = expanded.match(/../g).map((byte) => parseInt(byte, 16));
    return [
      channels[0],
      channels[1],
      channels[2],
      channels[3] ?? 255
    ];
  }
  const { document: document2, getComputedStyle } = globalThis;
  if (document2 && getComputedStyle) {
    const element = document2.createElement("span");
    element.style.color = "";
    element.style.color = value;
    if (element.style.color) {
      document2.documentElement.appendChild(element);
      const computed = getComputedStyle(element).color;
      element.remove();
      const channels = computed.match(/[\d.]+/g)?.map((value2, channel) => channel === 3 ? Math.round(Number(value2) * 255) : Math.round(Number(value2)));
      if (channels) {
        if (channels.length === 3) channels.push(255);
        return channels;
      }
    }
  }
  throw new TypeError(`Unsupported color for png output: "${value}" (use a hexadecimal value such as "#000000", a supported named color, or \u2014in browsers\u2014 any CSS color or custom property)`);
}
var CRC_TABLE = Array.from({
  length: 256
}, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let crc = 4294967295;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ crc >>> 8;
  return (crc ^ 4294967295) >>> 0;
}
function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; ) {
    const end = Math.min(i + 5552, bytes.length);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return (b << 16 | a) >>> 0;
}
function zlib(bytes) {
  const blocks = Math.ceil(bytes.length / 65535);
  const result = new Uint8Array(2 + bytes.length + blocks * 5 + 4);
  let offset = 0;
  result[offset++] = 120;
  result[offset++] = 1;
  for (let i = 0; i < bytes.length; i += 65535) {
    const length = Math.min(65535, bytes.length - i);
    result[offset++] = i + length >= bytes.length ? 1 : 0;
    result[offset++] = length & 255;
    result[offset++] = length >>> 8 & 255;
    result[offset++] = ~length & 255;
    result[offset++] = ~length >>> 8 & 255;
    result.set(bytes.subarray(i, i + length), offset);
    offset += length;
  }
  const adler = adler32(bytes);
  result[offset++] = adler >>> 24 & 255;
  result[offset++] = adler >>> 16 & 255;
  result[offset++] = adler >>> 8 & 255;
  result[offset] = adler & 255;
  return result;
}
function chunk(type, data) {
  const result = new Uint8Array(12 + data.length);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) result[4 + i] = type.charCodeAt(i);
  result.set(data, 8);
  view.setUint32(8 + data.length, crc32(result.subarray(4, 8 + data.length)));
  return result;
}
var signature = [
  137,
  80,
  78,
  71,
  13,
  10,
  26,
  10
];
function png({ get, size, light, dark, scale }) {
  const on = color(dark);
  const off = color(light);
  const dimension = size * scale;
  const stride = dimension * 4 + 1;
  const raw = new Uint8Array(stride * dimension);
  for (let y = 0; y < size; y++) {
    const scanline = new Uint8Array(stride);
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = get(x, y) ? on : off;
      for (let s = 0; s < scale; s++) {
        const offset2 = 1 + (x * scale + s) * 4;
        scanline[offset2] = r;
        scanline[offset2 + 1] = g;
        scanline[offset2 + 2] = b;
        scanline[offset2 + 3] = a;
      }
    }
    for (let s = 0; s < scale; s++) raw.set(scanline, (y * scale + s) * stride);
  }
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, dimension);
  header.setUint32(4, dimension);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const chunks = [
    new Uint8Array(signature),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib(raw)),
    chunk("IEND", new Uint8Array(0))
  ];
  const result = new Uint8Array(chunks.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of chunks) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

// deno:https://jsr.io/@libs/qrcode/3.1.0/_qrcode.ts
var encoder = new TextEncoder();
function qrcode(content, options) {
  return QrCode.from(content, options);
}
var QrCode = class _QrCode {
  /**
   * Returns a QR Code representing the given Unicode text string at the given error correction level.
   * As a conservative upper bound, this function is guaranteed to succeed for strings that have 738 or fewer Unicode code points (not UTF-16 code units) if the low error correction level is used.
   * The smallest possible QR Code version is automatically chosen for the output.
   * The ECC level of the result may be higher than the ecl argument if it can be done without increasing the version.
   */
  static from(content, { output = "array", border = 2, scale = 8, light = "white", dark = "black", ecl = "MEDIUM" } = {}) {
    border = Number.isFinite(border) ? Math.max(0, Math.floor(border)) : 0;
    scale = Number.isFinite(scale) ? Math.max(1, Math.floor(scale)) : 1;
    const qr = _QrCode.#encode(Segment.from(content instanceof URL ? content.href : content), {
      ecl
    });
    const size = qr.size + border * 2;
    switch (output) {
      case "svg": {
        const paths = [];
        for (let y = 0; y < qr.size; y++) {
          for (let x = 0; x < qr.size; x++) {
            if (qr.get({
              x,
              y
            })) paths.push(`M${x + border},${y + border}h1v1h-1z`);
          }
        }
        return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 ${size} ${size}" stroke="none"><rect width="100%" height="100%" fill="${escape(light)}"/><path d="${paths.join(" ")}" fill="${escape(dark)}"/></svg>`;
      }
      case "png": {
        return png({
          get: (x, y) => qr.get({
            x: x - border,
            y: y - border
          }),
          size,
          light,
          dark,
          scale
        });
      }
      case "console": {
        for (let y = 0; y < size; y++) {
          const line = "%c\u2588\u2588".repeat(size);
          const colors = [];
          for (let x = 0; x < size; x++) colors.push(`color: ${qr.get({
            x: x - border,
            y: y - border
          }) ? dark : light}`);
          console.log(line, ...colors);
        }
        return;
      }
      default: {
        const data = [];
        for (let y = 0; y < size; y++) {
          data[y] = new Array(size).fill(false);
          for (let x = 0; x < size; x++) data[y][x] = qr.get({
            x: x - border,
            y: y - border
          });
        }
        return data;
      }
    }
  }
  /**
   * Returns a QR Code representing the given segments with the given encoding parameters.
   * The smallest possible QR Code version within the given range is automatically chosen for the output.
   * Iff boostEcl is true, then the ECC level of the result may be higher than the ecl argument if it can be done without increasing the version.
   * The mask number is either between 0 to 7 (inclusive) to force that mask, or -1 to automatically choose an appropriate mask (which may be slow).
   * This function allows the user to create a custom sequence of segments that switches between modes (such as alphanumeric and byte) to encode text in less space.
   */
  static #encode(segments, { ecl }) {
    const ECL = _QrCode.ERROR_CORRECTION_LEVEL[ecl];
    let version = 1;
    let databits = 0;
    for (; ; version++) {
      const capacity2 = 8 * (Math.floor(_QrCode.#DATA_BITS[version] / 8) - ECL.ECC_PER_BLOCK[version] * ECL.ECC_BLOCKS[version]);
      let used = 0;
      for (const segment of segments) {
        const width = segment.width(version);
        if (segment.length >= 1 << width) used = Infinity;
        used += 4 + width + segment.data.length;
      }
      if (used <= capacity2) {
        databits = used;
        break;
      }
      if (version >= _QrCode.#VERSION_MAX) throw new RangeError("Data too long");
    }
    for (const level of [
      "MEDIUM",
      "QUARTILE",
      "HIGH"
    ]) {
      const ECL2 = _QrCode.ERROR_CORRECTION_LEVEL[level];
      if (databits <= 8 * (Math.floor(_QrCode.#DATA_BITS[version] / 8) - ECL2.ECC_PER_BLOCK[version] * ECL2.ECC_BLOCKS[version])) ecl = level;
    }
    const bits = [];
    for (const segment of segments) {
      append({
        bits,
        length: 4,
        value: segment.mode.id
      });
      append({
        bits,
        length: segment.width(version),
        value: segment.length
      });
      bits.push(...segment.data);
    }
    const capacity = 8 * (Math.floor(_QrCode.#DATA_BITS[version] / 8) - ECL.ECC_PER_BLOCK[version] * ECL.ECC_BLOCKS[version]);
    append({
      bits,
      length: Math.min(4, capacity - bits.length),
      value: 0
    });
    append({
      bits,
      length: (8 - bits.length % 8) % 8,
      value: 0
    });
    for (let padding = 236; bits.length < capacity; padding ^= 236 ^ 17) append({
      bits,
      length: 8,
      value: padding
    });
    const data = [];
    while (data.length * 8 < bits.length) data.push(0);
    bits.forEach((b, i) => data[i >>> 3] |= b << 7 - (i & 7));
    const mode = [
      "",
      "numeric",
      "alphanumeric",
      "",
      "bytes"
    ][segments[0]?.mode.id] ?? "";
    const length = segments.reduce((sum, segment) => sum + segment.length, 0);
    return new _QrCode({
      version,
      ecl,
      data,
      mode,
      length,
      databits
    });
  }
  /** Constructor. */
  constructor({ version, ecl, data, mode, length, databits }) {
    this.version = version;
    this.size = this.version * 4 + 17;
    this.ecl = ecl;
    this.mode = mode;
    this.length = length;
    this.databits = databits;
    this.#ecl = _QrCode.ERROR_CORRECTION_LEVEL[ecl];
    this.#modules = new Array(this.size).fill(null).map(() => new Array(this.size).fill(false));
    this.#functions = new Array(this.size).fill(null).map(() => new Array(this.size).fill(false));
    this.#drawPatterns();
    this.#drawData(this.#interleave(data));
    let mask = 0;
    let min = Infinity;
    for (let i = 0; i < 8; i++) {
      this.#mask({
        mask: i
      });
      this.#drawFormat({
        mask: i
      });
      const penalty = this.#penalty();
      if (penalty < min) {
        mask = i;
        min = penalty;
      }
      this.#mask({
        mask: i
      });
    }
    this.mask = mask;
    this.#mask(this);
    this.#drawFormat(this);
    this.#functions.length = 0;
  }
  /** Sets the color of a module and marks it as a function module. */
  #set({ x, y, color: color2 }) {
    this.#modules[y][x] = color2;
    this.#functions[y][x] = true;
  }
  /**
   * Returns the color of the module (pixel) at the given coordinates, which is false for light or true for dark.
   * The top left corner has the coordinates (x=0, y=0).
   * If the given coordinates are out of bounds, then false (light) is returned.
   */
  get({ x, y }) {
    return 0 <= x && x < this.size && 0 <= y && y < this.size && this.#modules[y][x];
  }
  /** Describes how a segment's data bits are interpreted. */
  mode;
  /** Number of characters count. */
  length;
  /** Number of data bits. */
  databits;
  /**
   * The version number of this QR Code, which is between 1 and 40 (inclusive).
   * This determines the size of this barcode.
   */
  version;
  /**
   * The width and height of this QR Code, measured in modules, between 21 and 177 (inclusive).
   * This is equal to version * 4 + 17.
   */
  size;
  /** The error correction level used in this QR Code. */
  ecl;
  /** The error correction level used in this QR Code. */
  #ecl;
  /**
   * The index of the mask pattern used in this QR Code, which is between 0 and 7 (inclusive).
   * Even if a QR Code is created with automatic masking requested (mask = -1),
   * the resulting object still has a mask value between 0 and 7.
   */
  mask;
  /** The modules of this QR Code (false = light, true = dark). */
  #modules;
  /** Indicates function modules that are not subjected to masking. */
  #functions;
  /** Reads this object's version field, and draws and marks all function modules. */
  #drawPatterns() {
    for (let i = 0; i < this.size; i++) {
      this.#set({
        x: 6,
        y: i,
        color: !(i % 2)
      });
      this.#set({
        x: i,
        y: 6,
        color: !(i % 2)
      });
    }
    this.#drawFinder({
      x: 3,
      y: 3
    });
    this.#drawFinder({
      x: this.size - 4,
      y: 3
    });
    this.#drawFinder({
      x: 3,
      y: this.size - 4
    });
    const alignments = _QrCode.#ALIGNEMENTS[this.version];
    for (let i = 0; i < alignments.length; i++) {
      for (let j = 0; j < alignments.length; j++) {
        if (!(i === 0 && j === 0 || i === 0 && j === alignments.length - 1 || i === alignments.length - 1 && j === 0)) this.#drawAlignment({
          x: alignments[i],
          y: alignments[j]
        });
      }
    }
    this.#drawFormat();
    this.#drawVersion();
  }
  /** Draws a 9*9 finder pattern including the border separator with the center module at (x, y). */
  #drawFinder({ x: ox, y: oy }) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = ox + dx;
        const y = oy + dy;
        if (0 <= x && x < this.size && 0 <= y && y < this.size) this.#set({
          x,
          y,
          color: d !== 2 && d !== 4
        });
      }
    }
  }
  /** Draws a 5*5 alignment pattern with the center module at (x, y). */
  #drawAlignment({ x, y }) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) this.#set({
        x: x + dx,
        y: y + dy,
        color: Math.max(Math.abs(dx), Math.abs(dy)) !== 1
      });
    }
  }
  /** Draws two copies of the format bits (with its own error correction code) based on the given mask and this object's error correction level field. */
  #drawFormat({ mask = 0 } = {}) {
    const data = this.#ecl.format << 3 | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = rem << 1 ^ (rem >>> 9) * 1335;
    const bits = (data << 10 | rem) ^ 21522;
    for (let i = 0; i <= 5; i++) this.#set({
      x: 8,
      y: i,
      color: bit(bits, i)
    });
    this.#set({
      x: 8,
      y: 7,
      color: bit(bits, 6)
    });
    this.#set({
      x: 8,
      y: 8,
      color: bit(bits, 7)
    });
    this.#set({
      x: 7,
      y: 8,
      color: bit(bits, 8)
    });
    for (let i = 9; i < 15; i++) this.#set({
      x: 14 - i,
      y: 8,
      color: bit(bits, i)
    });
    for (let i = 0; i < 8; i++) this.#set({
      x: this.size - 1 - i,
      y: 8,
      color: bit(bits, i)
    });
    for (let i = 8; i < 15; i++) this.#set({
      x: 8,
      y: this.size - 15 + i,
      color: bit(bits, i)
    });
    this.#set({
      x: 8,
      y: this.size - 8,
      color: true
    });
  }
  /** Draws two copies of the version bits (with its own error correction code) based on this object's version field, iff 7 <= version <= 40. */
  #drawVersion() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = rem << 1 ^ (rem >>> 11) * 7973;
    const bits = this.version << 12 | rem;
    for (let i = 0; i < 18; i++) {
      const color2 = bit(bits, i);
      const a = this.size - 11 + i % 3;
      const b = Math.floor(i / 3);
      this.#set({
        x: a,
        y: b,
        color: color2
      });
      this.#set({
        x: b,
        y: a,
        color: color2
      });
    }
  }
  /**
   * Returns a new byte string representing the given data with the appropriate error correction codewords appended to it, based on this object's version and error correction level.
   */
  #interleave(data) {
    const ecc = {
      blocks: this.#ecl.ECC_BLOCKS[this.version],
      length: this.#ecl.ECC_PER_BLOCK[this.version]
    };
    const codewords = Math.floor(_QrCode.#DATA_BITS[this.version] / 8);
    const short = {
      blocks: ecc.blocks - codewords % ecc.blocks,
      length: Math.floor(codewords / ecc.blocks)
    };
    const blocks = [];
    const divisor = divisorReedSolomon(ecc.length);
    for (let i = 0, k = 0; i < ecc.blocks; i++) {
      const block = data.slice(k, k + short.length - ecc.length + (i < short.blocks ? 0 : 1));
      k += block.length;
      const remainder = remainderReedSolomon(block, divisor);
      if (i < short.blocks) block.push(0);
      blocks.push(block.concat(remainder));
    }
    const result = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((block, j) => {
        if (i !== short.length - ecc.length || j >= short.blocks) result.push(block[i]);
      });
    }
    return result;
  }
  /**
   * Draws the given sequence of 8-bit codewords (data and error correction) onto the entire data area of this QR Code.
   * Function modules need to be marked off before this is called.
   */
  #drawData(data) {
    for (let i = 0, h = this.size - 1; h >= 1; h -= 2) {
      if (h === 6) h = 5;
      for (let v = 0; v < this.size; v++) {
        for (let j = 0; j < 2; j++) {
          const x = h - j;
          const y = !(h + 1 & 2) ? this.size - 1 - v : v;
          if (!this.#functions[y][x] && i < data.length * 8) {
            this.#modules[y][x] = bit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }
  /**
   * XORs the codeword modules in this QR Code with the given mask pattern.
   * The function modules must be marked and the codeword bits must be drawn before masking. Due to the arithmetic of XOR, calling applyMask() with the same mask value a second time will undo the mask.
   * A final well-formed QR Code needs exactly one (not zero, two, etc.) mask applied.
   */
  #mask({ mask }) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert = false;
        switch (mask) {
          case 0:
            invert = !((x + y) % 2);
            break;
          case 1:
            invert = !(y % 2);
            break;
          case 2:
            invert = !(x % 3);
            break;
          case 3:
            invert = !((x + y) % 3);
            break;
          case 4:
            invert = !((Math.floor(x / 3) + Math.floor(y / 2)) % 2);
            break;
          case 5:
            invert = !(x * y % 2 + x * y % 3);
            break;
          case 6:
            invert = !((x * y % 2 + x * y % 3) % 2);
            break;
          case 7:
            invert = !(((x + y) % 2 + x * y % 3) % 2);
            break;
        }
        if (invert && !this.#functions[y][x]) this.#modules[y][x] = !this.#modules[y][x];
      }
    }
  }
  /**
   * Calculates and returns the penalty score based on state of this QR Code's current modules.
   * This is used by the automatic mask choice algorithm to find the mask pattern that yields the lowest score.
   */
  #penalty() {
    let result = 0;
    for (let y = 0; y < this.size; y++) {
      let color2 = false;
      let xy = 0;
      const history = [
        0,
        0,
        0,
        0,
        0,
        0,
        0
      ];
      for (let x = 0; x < this.size; x++) {
        if (this.#modules[y][x] === color2) {
          xy++;
          if (xy === 5) result += _QrCode.#PENALTY[0];
          else if (xy > 5) result++;
        } else {
          this.#penaltyRegister({
            xy,
            history
          });
          if (!color2) result += this.#penaltyPatterns({
            history
          }) * _QrCode.#PENALTY[2];
          color2 = this.#modules[y][x];
          xy = 1;
        }
      }
      result += this.#penaltyCount({
        xy,
        color: color2,
        history
      }) * _QrCode.#PENALTY[2];
    }
    for (let x = 0; x < this.size; x++) {
      let color2 = false;
      let xy = 0;
      const history = [
        0,
        0,
        0,
        0,
        0,
        0,
        0
      ];
      for (let y = 0; y < this.size; y++) {
        if (this.#modules[y][x] === color2) {
          xy++;
          if (xy === 5) result += _QrCode.#PENALTY[0];
          else if (xy > 5) result++;
        } else {
          this.#penaltyRegister({
            xy,
            history
          });
          if (!color2) result += this.#penaltyPatterns({
            history
          }) * _QrCode.#PENALTY[2];
          color2 = this.#modules[y][x];
          xy = 1;
        }
      }
      result += this.#penaltyCount({
        xy,
        color: color2,
        history
      }) * _QrCode.#PENALTY[2];
    }
    for (let y = 0; y < this.size - 1; y++) {
      for (let x = 0; x < this.size - 1; x++) {
        const color2 = this.#modules[y][x];
        if (color2 === this.#modules[y][x + 1] && color2 === this.#modules[y + 1][x] && color2 === this.#modules[y + 1][x + 1]) result += _QrCode.#PENALTY[1];
      }
    }
    let dark = 0;
    for (const row of this.#modules) dark = row.reduce((sum, color2) => sum + (color2 ? 1 : 0), dark);
    const total = this.size * this.size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * _QrCode.#PENALTY[3];
    return result;
  }
  /** Can only be called immediately after a light run is added, and returns either 0, 1, or 2. */
  #penaltyPatterns({ history }) {
    const n = history[1];
    const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
    return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
  }
  /** Must be called at the end of a line (row or column) of modules. */
  #penaltyCount({ xy, color: color2, history }) {
    if (color2) {
      this.#penaltyRegister({
        xy,
        history
      });
      xy = 0;
    }
    xy += this.size;
    this.#penaltyRegister({
      xy,
      history
    });
    return this.#penaltyPatterns({
      history
    });
  }
  /** Pushes the given value to the front and drops the last value. */
  #penaltyRegister({ xy, history }) {
    if (history[0] === 0) xy += this.size;
    history.pop();
    history.unshift(xy);
  }
  /** The maximum version number supported in the QR Code Model 2 standard. */
  static #VERSION_MAX = 40;
  /**
   * The error correction level in a QR Code symbol.
   *
   * The QR Code can tolerate about:
   * - LOW: 7% erroneous codewords
   * - MEDIUM: 15% erroneous codewords
   * - QUARTILE: 25% erroneous codewords
   * - HIGH: 30% erroneous codewords
   */
  static ERROR_CORRECTION_LEVEL = {
    LOW: {
      ECC_PER_BLOCK: [
        NaN,
        7,
        10,
        15,
        20,
        26,
        18,
        20,
        24,
        30,
        18,
        20,
        24,
        26,
        30,
        22,
        24,
        28,
        30,
        28,
        28,
        28,
        28,
        30,
        30,
        26,
        28,
        30,
        30,
        30,
        30,
        30,
        30,
        30,
        30,
        30,
        30,
        30,
        30,
        30,
        30
      ],
      ECC_BLOCKS: [
        NaN,
        1,
        1,
        1,
        1,
        1,
        2,
        2,
        2,
        2,
        4,
        4,
        4,
        4,
        4,
        6,
        6,
        6,
        6,
        7,
        8,
        8,
        9,
        9,
        10,
        12,
        12,
        12,
        13,
        14,
        15,
        16,
        17,
        18,
        19,
        19,
        20,
        21,
        22,
        24,
        25
      ],
      format: 1
    },
    MEDIUM: {
      ECC_PER_BLOCK: [
        NaN,
        10,
        16,
        26,
        18,
        24,
        16,
        18,
        22,
        22,
        26,
        30,
        22,
        22,
        24,
        24,
        28,
        28,
        26,
        26,
        26,
        26,
        28,
        28,
        28,
        28,
        28,
        28,
        28,
        28,
        28,
        28,
        28,
        28,
        28,
        28,
        28,
        28,
        28,
        28,
        28
      ],
      ECC_BLOCKS: [
        NaN,
        1,
        1,
        1,
        2,
        2,
        4,
        4,
        4,
        5,
        5,
        5,
        8,
        9,
        9,
        10,
        10,
        11,
        13,
        14,
        16,
        17,
        17,
        18,
        20,
        21,
        23,
        25,
        26,
        28,
        29,
        31,
        33,
        35,
        37,
        38,
        40,
        43,
        45,
        47,
        49
      ],
      format: 0
    },
    QUARTILE: {
      ECC_PER_BLOCK: [
        NaN,
        13,
        22,
        18,
        26,
        18,
        24,
        18,
        22,
        20,
        24,
        28,
        26,
        24,
        20,
        30,
        24,
        28,
        28,
        26,
        30,
        28,
        30,
        30,
        30,
        30,
        28,
        30,
        30,
        30,
        30,
        30,
        30,
        30,
        30,
        30,
        30,
        30,
        30,
        30,
        30
      ],
      ECC_BLOCKS: [
        NaN,
        1,
        1,
        2,
        2,
        4,
        4,
        6,
        6,
        8,
        8,
        8,
        10,
        12,
        16,
        12,
        17,
        16,
        18,
        21,
        20,
        23,
        23,
        25,
        27,
        29,
        34,
        34,
        35,
        38,
        40,
        43,
        45,
        48,
        51,
        53,
        56,
        59,
        62,
        65,
        68
      ],
      format: 3
    },
    HIGH: {
      ECC_PER_BLOCK: [
        NaN,
        17,
        28,
        22,
        16,
        22,
        28,
        26,
        26,
        24,
        28,
        24,
        28,
        22,
        24,
        24,
        30,
        28,
        28,
        26,
        28,
        30,
        24,
        30,
        30,
        30,
        30,
        30,
        30,
        30,
        30,
        30,
        30,
        30,
        30,
        30,
        30,
        30,
        30,
        30,
        30
      ],
      ECC_BLOCKS: [
        NaN,
        1,
        1,
        2,
        4,
        4,
        4,
        5,
        6,
        8,
        8,
        11,
        11,
        16,
        16,
        18,
        16,
        19,
        21,
        25,
        25,
        25,
        34,
        30,
        32,
        35,
        37,
        40,
        42,
        45,
        48,
        51,
        54,
        57,
        60,
        63,
        66,
        70,
        74,
        77,
        81
      ],
      format: 2
    }
  };
  /**
   * Returns an ascending list of positions of alignment patterns for this version number.
   * Each position is in the range [0,177), and are used on both the x and y axes.
   */
  static #ALIGNEMENTS = [
    [],
    [],
    [
      6,
      18
    ],
    [
      6,
      22
    ],
    [
      6,
      26
    ],
    [
      6,
      30
    ],
    [
      6,
      34
    ],
    [
      6,
      22,
      38
    ],
    [
      6,
      24,
      42
    ],
    [
      6,
      26,
      46
    ],
    [
      6,
      28,
      50
    ],
    [
      6,
      30,
      54
    ],
    [
      6,
      32,
      58
    ],
    [
      6,
      34,
      62
    ],
    [
      6,
      26,
      46,
      66
    ],
    [
      6,
      26,
      48,
      70
    ],
    [
      6,
      26,
      50,
      74
    ],
    [
      6,
      30,
      54,
      78
    ],
    [
      6,
      30,
      56,
      82
    ],
    [
      6,
      30,
      58,
      86
    ],
    [
      6,
      34,
      62,
      90
    ],
    [
      6,
      28,
      50,
      72,
      94
    ],
    [
      6,
      26,
      50,
      74,
      98
    ],
    [
      6,
      30,
      54,
      78,
      102
    ],
    [
      6,
      28,
      54,
      80,
      106
    ],
    [
      6,
      32,
      58,
      84,
      110
    ],
    [
      6,
      30,
      58,
      86,
      114
    ],
    [
      6,
      34,
      62,
      90,
      118
    ],
    [
      6,
      26,
      50,
      74,
      98,
      122
    ],
    [
      6,
      30,
      54,
      78,
      102,
      126
    ],
    [
      6,
      26,
      52,
      78,
      104,
      130
    ],
    [
      6,
      30,
      56,
      82,
      108,
      134
    ],
    [
      6,
      34,
      60,
      86,
      112,
      138
    ],
    [
      6,
      30,
      58,
      86,
      114,
      142
    ],
    [
      6,
      34,
      62,
      90,
      118,
      146
    ],
    [
      6,
      30,
      54,
      78,
      102,
      126,
      150
    ],
    [
      6,
      24,
      50,
      76,
      102,
      128,
      154
    ],
    [
      6,
      28,
      54,
      80,
      106,
      132,
      158
    ],
    [
      6,
      32,
      58,
      84,
      110,
      136,
      162
    ],
    [
      6,
      26,
      54,
      82,
      110,
      138,
      166
    ],
    [
      6,
      30,
      58,
      86,
      114,
      142,
      170
    ]
  ];
  /**
   * Number of data bits that can be stored in a QR Code of the given version number, after all function modules are excluded.
   * This includes remainder bits, so it might not be a multiple of 8.
   */
  static #DATA_BITS = [
    NaN,
    208,
    359,
    567,
    807,
    1079,
    1383,
    1568,
    1936,
    2336,
    2768,
    3232,
    3728,
    4256,
    4651,
    5243,
    5867,
    6523,
    7211,
    7931,
    8683,
    9252,
    10068,
    10916,
    11796,
    12708,
    13652,
    14628,
    15371,
    16411,
    17483,
    18587,
    19723,
    20891,
    22091,
    23008,
    24272,
    25568,
    26896,
    28256,
    29648
  ];
  /** For use in penalty score, when evaluating which mask is best. */
  static #PENALTY = [
    3,
    3,
    40,
    10
  ];
};
var Segment = class _Segment {
  /** Returns a segment representing the given string of decimal digits encoded in numeric mode. */
  static #numeric(content) {
    const bits = [];
    for (let i = 0; i < content.length; ) {
      const n = Math.min(content.length - i, 3);
      append({
        bits,
        length: n * 3 + 1,
        value: parseInt(content.substring(i, i + n), 10)
      });
      i += n;
    }
    return new _Segment({
      mode: {
        id: 1,
        widths: [
          10,
          12,
          14
        ]
      },
      length: content.length,
      bits
    });
  }
  /**
   * Returns a segment representing the given text string encoded in alphanumeric mode.
   * The characters allowed are: 0 to 9, A to Z (uppercase only), space, dollar, percent, asterisk, plus, hyphen, period, slash, colon.
   */
  static #alphanumeric(content) {
    const charset = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
    const bits = [];
    let i;
    for (i = 0; i + 2 <= content.length; i += 2) append({
      bits,
      length: 11,
      value: charset.indexOf(content.charAt(i)) * 45 + charset.indexOf(content.charAt(i + 1))
    });
    if (i < content.length) append({
      bits,
      length: 6,
      value: charset.indexOf(content.charAt(i))
    });
    return new _Segment({
      mode: {
        id: 2,
        widths: [
          9,
          11,
          13
        ]
      },
      length: content.length,
      bits
    });
  }
  /**
   * Returns a segment representing the string data encoded in byte mode.
   * Any text string can be converted to UTF-8 bytes and encoded as a byte mode segment.
   */
  static #utfbytes(content) {
    return this.#bytes(encoder.encode(content));
  }
  /**
   * Returns a segment representing the given binary data encoded in byte mode.
   */
  static #bytes(content) {
    const bits = [];
    for (const byte of content) append({
      bits,
      length: 8,
      value: byte
    });
    return new _Segment({
      mode: {
        id: 4,
        widths: [
          8,
          16,
          16
        ]
      },
      length: content.length,
      bits
    });
  }
  /**
   * Returns a new mutable list of zero or more segments to represent the given Unicode text string.
   * The result may use various segment modes and switch modes to optimize the length of the bit stream.
   */
  static from(content) {
    if (content instanceof Uint8Array) return [
      _Segment.#bytes(content)
    ];
    switch (true) {
      case !content.length:
        return [];
      case /^[0-9]*$/.test(content):
        return [
          _Segment.#numeric(content)
        ];
      case /^[A-Z0-9 $%*+.\/:-]*$/.test(content):
        return [
          _Segment.#alphanumeric(content)
        ];
      default:
        return [
          _Segment.#utfbytes(content)
        ];
    }
  }
  /** Constructor. */
  constructor({ mode, length, bits }) {
    this.mode = mode;
    this.length = length;
    this.#bits = bits.slice();
  }
  /** The mode indicator of this segment. */
  mode;
  /**
   * The length of this segment's unencoded data. Measured in characters for numeric/alphanumeric/kanji mode, bytes for byte mode, and 0 for ECI mode.
   * Always zero or positive.
   * Not the same as the data's bit length.
   */
  length;
  /** The data bits of this segment. */
  #bits;
  /** Get a new copy of the data bits of this segment. */
  get data() {
    return this.#bits.slice();
  }
  /**
   * Returns the bit width of the character count field for a segment in this mode in a QR Code at the given version number.
   * The result is in the range [0, 16].
   */
  width(version) {
    return this.mode.widths[Math.floor((version + 7) / 17)];
  }
};
function divisorReedSolomon(degree) {
  const result = [
    ...new Array(degree - 1).fill(0),
    1
  ];
  for (let i = 0, root = 1; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = productReedSolomon(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = productReedSolomon(root, 2);
  }
  return result;
}
function remainderReedSolomon(data, divisor) {
  const result = divisor.map((_) => 0);
  for (const n of data) {
    const factor = n ^ result.shift();
    result.push(0);
    divisor.forEach((coefficient, i) => result[i] ^= productReedSolomon(coefficient, factor));
  }
  return result;
}
function productReedSolomon(a, b) {
  let r = 0;
  for (let i = 7; i >= 0; i--) {
    r = r << 1 ^ (r >>> 7) * 285;
    r ^= (b >>> i & 1) * a;
  }
  return r;
}
function bit(x, i) {
  return (x >>> i & 1) > 0;
}
function escape(value) {
  return value.replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;"
  })[char]);
}
function append({ bits, length, value }) {
  for (let i = length - 1; i >= 0; i--) bits.push(value >>> i & 1);
}

// app/frontend-src/html.ts
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}

// app/frontend-src/adminView.ts
var STATUS_LABEL = {
  upcoming: "Upcoming",
  in_progress: "In progress",
  finished: "Finished"
};
var badge = (s) => `<span class="badge ${s}">${STATUS_LABEL[s]}</span>`;
function fmtTime(iso) {
  return new Date(iso).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short"
  });
}
function section(key, dflt, state, cls, summary, body) {
  const open = state.isOpen(key, dflt) ? " open" : "";
  return `<details data-key="${escapeHtml(key)}" class="${cls}"${open}><summary>${summary}</summary>${body}</details>`;
}
function renderDevice(d, opts = {}) {
  const name = opts.label ?? d.name;
  const links = d.links.map((l) => `<span class="link-chip">link #${l.id}${l.label ? ` <small>${escapeHtml(l.label)}</small>` : ""} <button type="button" class="small danger" data-action="revoke" data-id="${l.id}" title="Lock this device out">Revoke</button></span>`).join("");
  return `<div class="device" data-client="${escapeHtml(d.client_id)}">
    <span class="dot ${d.connected ? "on" : "off"}" title="${d.connected ? "connected" : "not connected"}"></span>
    <b>${escapeHtml(name)}</b> <code>${escapeHtml(d.client_id)}</code>
    <button type="button" class="small" data-action="new-link" data-client="${escapeHtml(d.client_id)}" data-name="${escapeHtml(name)}" data-email="${escapeHtml(opts.email ?? "")}">New link</button>
    ${links || `<span class="muted">no active links</span>`}
  </div>`;
}
function liveText(s) {
  if (!s.live) return "";
  const where = s.live.competition_name ? ` \xB7 ${escapeHtml(s.live.competition_name)}${s.live.position >= 0 ? ` #${s.live.position + 1}` : ""}` : "";
  const wait = s.live.waiting_for.length ? ` \xB7 waiting for ${s.live.waiting_for.map(escapeHtml).join(", ")}` : "";
  return `<span class="live">${escapeHtml(s.live.phase)}${where}${wait}</span>`;
}
function audioButton(comp, c, kind) {
  const has = c.audio[kind];
  return `<label class="audio ${has ? "have" : "missing"}" title="${has ? "Replace" : "Upload"} ${kind} audio">${kind} ${has ? "\u2713" : "\u2717"}<input type="file" accept="audio/*" hidden data-action="upload" data-competition="${comp.id}" data-competitor="${c.id}" data-kind="${kind}"></label>`;
}
function renderCompetitor(comp, c) {
  return `<li class="competitor ${c.status}">
    <span class="order">${c.order}</span>
    <span class="cname">${escapeHtml(c.name)}</span>
    <span class="muted">${escapeHtml(c.type)}${c.duration ? ` \xB7 ${c.duration}s` : ""}</span>
    ${badge(c.status)}
    <span class="muted" title="judges who have scored this competitor">scored ${c.scored_by}/${comp.judges.length}</span>
    <span class="audios">${audioButton(comp, c, "announce")} ${audioButton(comp, c, "music")}</span>
  </li>`;
}
function renderCompetition(c, state) {
  const judges = c.judges.length ? `<span class="muted">judges: ${c.judges.map((j) => escapeHtml(j.name)).join(", ")}</span>` : `<span class="muted">no judges assigned</span>`;
  const summary = `<span class="name">${escapeHtml(c.name)}</span> ${badge(c.status)} <span class="muted">${c.competitors.length} competitor${c.competitors.length === 1 ? "" : "s"}</span> ${judges}`;
  const body = c.competitors.length ? `<ul class="competitors">${c.competitors.map((x) => renderCompetitor(c, x)).join("")}</ul>` : `<p class="muted">No competitors registered.</p>`;
  return section(`c${c.id}`, c.status === "in_progress", state, `competition ${c.status}`, summary, body);
}
function renderSession(s, state) {
  const closed = state.now >= new Date(s.audio_cutoff).getTime() || s.running;
  const controls = `<span class="controls">
    <button type="button" class="small primary" data-action="start" data-id="${s.id}" ${s.running ? "disabled" : ""}>${s.status === "finished" ? "Run again" : "Start"}</button>
    <button type="button" class="small" data-action="skip" data-id="${s.id}" ${s.running ? "" : "disabled"} title="Stop waiting for whatever the session is stuck on">Skip</button>
    <button type="button" class="small danger" data-action="abort" data-id="${s.id}" ${s.running ? "" : "disabled"}>Abort</button>
  </span>`;
  const summary = `<span class="name">${escapeHtml(s.name)}</span> ${badge(s.status)} <span class="muted">starts ${escapeHtml(fmtTime(s.start_time))}</span> ${liveText(s)} ${controls}`;
  const note = `<p class="muted audio-note">Audio uploads ${closed ? "are closed" : "close"} ${closed ? "" : escapeHtml(fmtTime(s.audio_cutoff))}${closed ? " (uploading replaces the file after a confirmation)" : ""}.</p>`;
  const body = note + (s.competitions.length ? s.competitions.map((c) => renderCompetition(c, state)).join("") : `<p class="muted">No competitions in this session.</p>`);
  return section(`s${s.id}`, s.status !== "finished", state, `session ${s.status}`, summary, body);
}
function renderTrack(t, state) {
  const devices = `<div class="devices">${t.devices.map((d) => renderDevice(d, {
    label: `${t.name} ${d.name}`
  })).join("")}</div>`;
  const sessions = t.sessions.length ? t.sessions.map((s) => renderSession(s, state)).join("") : `<p class="muted">No sessions on this track.</p>`;
  const summary = `<span class="name">${escapeHtml(t.name)}</span> <span class="muted">${escapeHtml(t.location)}</span>`;
  return section(`t${t.id}`, true, state, "track", summary, devices + sessions);
}
function renderOverview(o, state) {
  if (o.festivals.length === 0) {
    return `<p class="empty">No festivals yet. Load the demo data with <code>deno task demo:seed</code>, or add data to the database.</p>`;
  }
  return o.festivals.map((f) => section(`f${f.id}`, true, state, "festival", `<span class="name">${escapeHtml(f.name)}</span> <span class="muted">${f.tracks.length} track${f.tracks.length === 1 ? "" : "s"}</span>`, f.tracks.length ? f.tracks.map((t) => renderTrack(t, state)).join("") : `<p class="muted">No tracks.</p>`)).join("");
}
function renderJudge(j) {
  const judges = j.competitions.length ? j.competitions.map((c) => escapeHtml(c.name)).join(", ") : `<span class="muted">none</span>`;
  return `<li class="judge">
    ${renderDevice(j.device, {
    email: j.email
  })}
    <div class="muted">${j.email ? escapeHtml(j.email) : "no email on file"} \xB7 judges: ${judges}</div>
  </li>`;
}
function renderJudges(o) {
  return o.judges.length ? `<ul class="judges">${o.judges.map(renderJudge).join("")}</ul>` : `<p class="empty">No judges yet.</p>`;
}

// app/frontend-src/admin.ts
var OPEN_KEY = "admin-open";
var POLL_MS = 3e3;
function shareLinks(link, name, email) {
  const text = `Your link for ${name}. Open it on your device: ${link}`;
  return {
    mailto: `mailto:${encodeURIComponent(email ?? "")}?subject=${encodeURIComponent(`Your link: ${name}`)}&body=${encodeURIComponent(text)}`,
    sms: `sms:?&body=${encodeURIComponent(text)}`
  };
}
function qrSvg(text) {
  return qrcode(text, {
    output: "svg"
  }).replace(/^[\s\S]*?(?=<svg)/, "");
}
function readOpen() {
  try {
    return new Map(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]"));
  } catch {
    return /* @__PURE__ */ new Map();
  }
}
function startAdminPage(doc = document) {
  const $ = (id) => doc.getElementById(id);
  const login = $("login");
  const app = $("app");
  const tree = $("tree");
  const judges = $("judges");
  const toastEl = $("toast");
  const dialog = $("linkDialog");
  const open = readOpen();
  const state = {
    isOpen: (key, dflt) => open.get(key) ?? dflt,
    now: Date.now()
  };
  let last = "";
  let timer;
  let toastTimer;
  const toast = (text, bad = false) => {
    toastEl.textContent = text;
    toastEl.className = bad ? "bad" : "";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.textContent = "", 6e3);
  };
  async function api(method, path, body, json = false) {
    const headers = {
      "x-admin-request": "1"
    };
    if (json) headers["content-type"] = "application/json";
    const res = await fetch(path, {
      method,
      headers,
      body,
      credentials: "same-origin"
    });
    if (res.status === 401) showLogin();
    return res;
  }
  function showLogin() {
    clearTimeout(timer);
    app.hidden = true;
    login.hidden = false;
    $("token").focus();
  }
  function showApp() {
    login.hidden = true;
    app.hidden = false;
    void refresh();
  }
  async function refresh() {
    clearTimeout(timer);
    try {
      const res = await api("GET", "/admin/overview");
      if (res.ok) {
        const text = await res.text();
        if (text !== last) {
          last = text;
          const o = JSON.parse(text);
          state.now = Date.now();
          tree.innerHTML = renderOverview(o, state);
          judges.innerHTML = renderJudges(o);
        }
        $("conn").textContent = "";
      } else if (res.status !== 401) {
        $("conn").textContent = `server error (${res.status})`;
      }
    } catch {
      $("conn").textContent = "server unreachable";
    }
    if (!app.hidden) timer = setTimeout(refresh, POLL_MS);
  }
  login.onsubmit = async (e) => {
    e.preventDefault();
    const input = $("token");
    const res = await fetch("/admin/login", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        token: input.value
      }),
      credentials: "same-origin"
    });
    input.value = "";
    if (res.ok) {
      $("loginError").textContent = "";
      showApp();
    } else {
      $("loginError").textContent = res.status === 401 ? "Wrong token." : "Could not sign in.";
    }
  };
  $("logout").onclick = async () => {
    await api("POST", "/admin/logout");
    last = "";
    showLogin();
  };
  for (const tab of [
    "festival",
    "judges"
  ]) {
    $(`tab-${tab}`).onclick = () => {
      $("tree").hidden = tab !== "festival";
      $("judges").hidden = tab !== "judges";
      $("tab-festival").setAttribute("aria-selected", String(tab === "festival"));
      $("tab-judges").setAttribute("aria-selected", String(tab === "judges"));
    };
  }
  app.addEventListener("toggle", (e) => {
    const el = e.target;
    if (el.dataset?.key) {
      open.set(el.dataset.key, el.open);
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify([
          ...open
        ]));
      } catch {
      }
    }
  }, true);
  async function newLink(clientId, name, email) {
    const res = await api("POST", "/admin/credentials", JSON.stringify({
      client_id: clientId,
      label: `${name} (admin page)`
    }), true);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return toast(body.error ?? `Could not create a link (${res.status})`, true);
    }
    const share = shareLinks(body.link, name, email || void 0);
    $("linkTitle").textContent = `Link for ${name}`;
    $("linkText").value = body.link;
    $("qr").innerHTML = qrSvg(body.link);
    $("mailto").href = share.mailto;
    $("sms").href = share.sms;
    $("linkNote").textContent = email ? `Email goes to ${email}.` : "No email on file: your mail app will ask for the address.";
    dialog.showModal();
    last = "";
    void refresh();
  }
  async function copy() {
    const input = $("linkText");
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(input.value);
      else throw new Error("no clipboard api");
    } catch {
      input.select();
      doc.execCommand("copy");
    }
    toast("Link copied");
  }
  $("copy").onclick = copy;
  $("closeDialog").onclick = () => {
    dialog.close();
    $("linkText").value = "";
    $("qr").innerHTML = "";
  };
  async function act(method, path, label) {
    const res = await api(method, path);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return toast(`${label}: ${body.error ?? res.status}`, true);
    const missing = body.missing_audio?.length ? ` (${body.missing_audio.length} audio file(s) missing)` : "";
    toast(`${label}: ok${missing}`);
    last = "";
    void refresh();
  }
  async function upload(input) {
    const file = input.files?.[0];
    if (!file) return;
    const { competition, competitor, kind } = input.dataset;
    const path = `/admin/audio/${competition}/${competitor}/${kind}`;
    let res = await api("PUT", path, file);
    if (res.status === 409) {
      if (!confirm("Uploads are closed for this session. Replace the audio anyway?")) {
        input.value = "";
        return;
      }
      res = await api("PUT", `${path}?force=1`, file);
    }
    const body = await res.json().catch(() => ({}));
    input.value = "";
    if (!res.ok) {
      return toast(`Upload failed: ${body.error ?? res.status}`, true);
    }
    toast(`Uploaded ${kind} audio`);
    last = "";
    void refresh();
  }
  app.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el || el.tagName === "INPUT") return;
    const { action, id, client, name, email } = el.dataset;
    if (action === "new-link") void newLink(client, name, email ?? "");
    else if (action === "revoke") {
      if (confirm("Revoke this link? The device is locked out immediately.")) {
        void act("DELETE", `/admin/credentials/${id}`, "Revoke");
      }
    } else if (action === "start") {
      void act("POST", `/sessions/${id}/start`, "Start");
    } else if (action === "skip") {
      void act("POST", `/admin/sessions/${id}/skip`, "Skip");
    } else if (action === "abort") {
      if (confirm("Abort this session now?")) {
        void act("POST", `/admin/sessions/${id}/abort`, "Abort");
      }
    }
    if (el.closest("summary")) e.preventDefault();
  });
  app.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset?.action === "upload") void upload(t);
  });
  fetch("/admin/me", {
    credentials: "same-origin"
  }).then((r) => r.ok ? showApp() : showLogin()).catch(showLogin);
}

// app/frontend-src/main-admin.ts
startAdminPage();
/**
 * Generate a QR Code from specified content.
 *
 * Content may either be:
 * - A `string` (not necessarily a URL-like, any text can be used)
 * - A `URL` object (in which case {@link https://developer.mozilla.org/en-US/docs/Web/API/URL/href | URL.href} will be used as content)
 *
 * Output can be set to either `"svg"`, `"png"`, `"console"` or `"array"` and can be customized using supported {@link options}.
 *
 * ```ts
 * import { qrcode } from "jsr:@libs/qrcode"
 * const svg = qrcode("https://example.com", { output: "svg" })
 * console.assert(svg.includes("</svg>"))
 * ```
 *
 * @author Simon Lecoq (lowlighter)
 * @author Nayuki
 * @license MIT
 */
