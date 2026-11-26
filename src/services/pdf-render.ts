import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = worker;

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
