export function imageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length >= 24 &&
    data.getUint32(0) === 0x89504e47 &&
    data.getUint32(4) === 0x0d0a1a0a &&
    data.getUint32(8) === 13 &&
    data.getUint32(12) === 0x49484452
  ) {
    checkDimensions(data.getUint32(16), data.getUint32(20));
    return 'image/png';
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length && bytes[offset++] === 255) {
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (offset + 2 > bytes.length || marker === 0xda || marker === 0xd9)
        break;
      const length = data.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
        checkDimensions(data.getUint16(offset + 5), data.getUint16(offset + 3));
        return 'image/jpeg';
      }
      offset += length;
    }
  }
  throw new Error('Изображение должно быть PNG или JPEG.');
}

function checkDimensions(width: number, height: number) {
  if (
    !width ||
    !height ||
    width * height > 16_000_000 ||
    Math.max(width, height) > 8192
  ) {
    throw new Error('Слишком большие размеры изображения.');
  }
}

export async function validateImage(blob: Blob) {
  if (blob.size > 10 * 1024 * 1024)
    throw new Error('Допускается изображение до 10 МБ.');
  const buffer = await blob.arrayBuffer();
  const type = imageType(new Uint8Array(buffer));
  const validated = new Blob([buffer], { type });
  const bitmap = await createImageBitmap(validated);
  try {
    checkDimensions(bitmap.width, bitmap.height);
    return validated;
  } finally {
    bitmap.close();
  }
}
