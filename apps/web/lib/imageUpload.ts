// v1.0a (#91): iPhones shoot HEIC by default, and the server's sharp build
// (prebuilt libvips, no HEVC codec) cannot decode it — uploads used to be
// stored verbatim with no thumbnail and render broken everywhere: the
// owner's "can't add photos" bug. The fix is two-sided: the server now
// rejects undecodable images (415 image_undecodable), and THIS helper
// converts HEIC/HEIF to JPEG in the browser before upload. Safari — the
// browser HEICs actually come from — decodes HEIC natively, so the
// conversion succeeds exactly where the format occurs in the wild.
// Everything that is not HEIC/HEIF passes through untouched.

const HEIC_TYPES = ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'];

function isHeic(file: File): boolean {
  return HEIC_TYPES.includes(file.type.toLowerCase()) || /\.hei[cf]$/i.test(file.name);
}

async function decodeToBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  try {
    return await createImageBitmap(file);
  } catch {
    // Older Safari: createImageBitmap can fail where <img> decode works.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/** Thrown when this browser cannot decode a HEIC file (non-Safari). */
export class HeicUnreadableError extends Error {
  constructor() {
    super('This browser can’t read that photo format (HEIC) — convert it to JPEG and retry.');
    this.name = 'HeicUnreadableError';
  }
}

/**
 * Convert a HEIC/HEIF image to JPEG client-side; return any other file as-is.
 * Throws HeicUnreadableError when the browser cannot decode it.
 */
export async function maybeConvertImage(file: File): Promise<File> {
  if (!isHeic(file)) return file;
  let source: ImageBitmap | HTMLImageElement;
  try {
    source = await decodeToBitmap(file);
  } catch {
    throw new HeicUnreadableError();
  }
  const width = 'naturalWidth' in source ? source.naturalWidth : source.width;
  const height = 'naturalHeight' in source ? source.naturalHeight : source.height;
  if (!width || !height) throw new HeicUnreadableError();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new HeicUnreadableError();
  ctx.drawImage(source, 0, 0);
  if ('close' in source) source.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.9),
  );
  if (!blob) throw new HeicUnreadableError();
  const name = file.name.replace(/\.hei[cf]$/i, '') + '.jpg';
  return new File([blob], name, { type: 'image/jpeg' });
}
