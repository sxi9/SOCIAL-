// Minimal blurhash decoder (hand-rolled; keeps deps lean).
const B83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

function decode83(str: string): number {
  let value = 0;
  for (const c of str) {
    const idx = B83.indexOf(c);
    if (idx === -1) return -1;
    value = value * 83 + idx;
  }
  return value;
}

function srgbToLinear(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(value: number): number {
  const v = Math.max(0, Math.min(1, value));
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

function signPow(value: number, exp: number): number {
  return Math.sign(value) * Math.pow(Math.abs(value), exp);
}

export function decodeBlurhash(hash: string, width: number, height: number): Uint8ClampedArray | null {
  if (!hash || hash.length < 6) return null;
  const sizeFlag = decode83(hash[0]);
  if (sizeFlag < 0) return null;
  const numY = Math.floor(sizeFlag / 9) + 1;
  const numX = (sizeFlag % 9) + 1;
  if (hash.length !== 4 + 2 * numX * numY) return null;

  const quantMax = decode83(hash[1]);
  if (quantMax < 0) return null;
  const maxValue = (quantMax + 1) / 166;

  const colors: Array<[number, number, number]> = [];
  const dc = decode83(hash.substring(2, 6));
  if (dc < 0) return null;
  colors.push([srgbToLinear((dc >> 16) & 255), srgbToLinear((dc >> 8) & 255), srgbToLinear(dc & 255)]);

  for (let i = 1; i < numX * numY; i++) {
    const value = decode83(hash.substring(4 + i * 2, 6 + i * 2));
    if (value < 0) return null;
    const quantR = Math.floor(value / (19 * 19));
    const quantG = Math.floor(value / 19) % 19;
    const quantB = value % 19;
    colors.push([
      signPow((quantR - 9) / 9, 2) * maxValue,
      signPow((quantG - 9) / 9, 2) * maxValue,
      signPow((quantB - 9) / 9, 2) * maxValue,
    ]);
  }

  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < numY; j++) {
        for (let i = 0; i < numX; i++) {
          const basis = Math.cos((Math.PI * x * i) / width) * Math.cos((Math.PI * y * j) / height);
          const color = colors[i + j * numX];
          r += color[0] * basis;
          g += color[1] * basis;
          b += color[2] * basis;
        }
      }
      const p = (y * width + x) * 4;
      pixels[p] = linearToSrgb(r);
      pixels[p + 1] = linearToSrgb(g);
      pixels[p + 2] = linearToSrgb(b);
      pixels[p + 3] = 255;
    }
  }
  return pixels;
}
