import { getDocument, GlobalWorkerOptions, PDFWorker } from 'pdfjs-dist';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = worker;
let renderer: PDFWorker | undefined;

export function openPdf(bytes: Uint8Array) {
  return getDocument({
    worker: (renderer ??= new PDFWorker()),
    data: bytes.slice(),
    isEvalSupported: false,
    enableXfa: false,
    stopAtErrors: true,
    maxImageSize: 24_000_000,
    useSystemFonts: true,
  });
}
