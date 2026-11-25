import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = worker;

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_PAGES = 30;

export function openPdf(bytes: Uint8Array) {
  return getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    enableXfa: false,
    stopAtErrors: true,
    maxImageSize: 24_000_000,
    useSystemFonts: true,
  });
}

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
