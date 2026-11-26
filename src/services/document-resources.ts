export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_PAGES = 30;

export function createCanvas(width: number, height: number) {
  width = Math.ceil(width);
  height = Math.ceil(height);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 16_000_000 ||
    Math.max(width, height) > 8192
  ) {
    throw new Error('Слишком большие размеры страницы или изображения.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function releaseCanvas(canvas: HTMLCanvasElement) {
  canvas.width = 0;
  canvas.height = 0;
}
