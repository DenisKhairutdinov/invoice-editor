import { A4 } from './layout';
import { createCanvas, MAX_PAGES, releaseCanvas } from './document-resources';
import { openPdf } from './pdf-render';

export type ExportFormat = 'pdf' | 'jpeg' | 'docx';

export async function renderPdfPage(bytes: Uint8Array, index: number) {
  const task = openPdf(bytes);
  try {
    const pdf = await task.promise;
    return await drawPage(await pdf.getPage(index), false);
  } finally {
    await task.destroy();
  }
}

async function drawPage(
  page: Awaited<
    ReturnType<Awaited<ReturnType<typeof openPdf>['promise']>['getPage']>
  >,
  print: boolean,
) {
  const viewport = page.getViewport({ scale: (print ? 300 : 120) / 72 });
  const canvas = print
    ? createCanvas(2480, 3508)
    : createCanvas(viewport.width, viewport.height);
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas недоступен.');
    await page.render({
      canvasContext: context,
      viewport,
      transform: print
        ? [
            canvas.width / viewport.width,
            0,
            0,
            canvas.height / viewport.height,
            0,
            0,
          ]
        : undefined,
      background: '#fff',
    }).promise;
    return canvas;
  } catch (error) {
    releaseCanvas(canvas);
    throw error;
  } finally {
    page.cleanup();
  }
}

async function jpeg(canvas: HTMLCanvasElement) {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (value) =>
        value ? resolve(value) : reject(new Error('Не удалось создать JPEG.')),
      'image/jpeg',
      0.95,
    );
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes[0] !== 255 || bytes[1] !== 216)
    throw new Error('JPEG недоступен в этом браузере.');
  if (
    bytes[2] === 255 &&
    bytes[3] === 224 &&
    String.fromCharCode(...bytes.subarray(6, 11)) === 'JFIF\0'
  ) {
    bytes.set([1, 1, 44, 1, 44], 13);
    return bytes;
  }
  const jfif = Uint8Array.of(
    255,
    224,
    0,
    16,
    74,
    70,
    73,
    70,
    0,
    1,
    1,
    1,
    1,
    44,
    1,
    44,
    0,
    0,
  );
  const output = new Uint8Array(bytes.length + jfif.length);
  output.set(bytes.subarray(0, 2));
  output.set(jfif, 2);
  output.set(bytes.subarray(2), 2 + jfif.length);
  return output;
}

export async function exportFile(
  bytes: Uint8Array,
  format: ExportFormat,
  name: string,
  onProgress: (index: number, total: number) => void,
) {
  if (format === 'pdf')
    return {
      blob: new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }),
      name: name + '.pdf',
    };
  const task = openPdf(bytes);
  const images: Uint8Array<ArrayBuffer>[] = [];
  try {
    const pdf = await task.promise;
    if (pdf.numPages > MAX_PAGES)
      throw new Error('Допускается максимум 30 страниц.');
    let outputSize = 0;
    for (let index = 1; index <= pdf.numPages; index++) {
      onProgress(index, pdf.numPages);
      const canvas = await drawPage(await pdf.getPage(index), true);
      try {
        const image = await jpeg(canvas);
        outputSize += image.length;
        if (outputSize > 80 * 1024 * 1024)
          throw new Error('Изображения превышают лимит 80 МБ. Скачайте PDF.');
        images.push(image);
      } finally {
        releaseCanvas(canvas);
      }
    }
  } finally {
    await task.destroy();
  }

  if (format === 'jpeg') {
    if (images.length === 1)
      return {
        blob: new Blob(images, { type: 'image/jpeg' }),
        name: name + '.jpg',
      };
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    images.forEach((image, index) =>
      zip.file(`${name}_${index + 1}.jpg`, image),
    );
    return {
      blob: await zip.generateAsync({ type: 'blob' }),
      name: name + '.zip',
    };
  }

  const { Document, ImageRun, Packer, Paragraph } = await import('docx');
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            size: {
              width: Math.round(A4.width * 20),
              height: Math.round(A4.height * 20),
            },
            margin: {
              top: 0,
              bottom: 0,
              left: 0,
              right: 0,
              header: 0,
              footer: 0,
            },
          },
        },
        children: images.map(
          (data, index) =>
            new Paragraph({
              pageBreakBefore: index > 0,
              spacing: { before: 0, after: 0 },
              children: [
                new ImageRun({
                  type: 'jpg',
                  data,
                  transformation: {
                    width: A4.width / 0.75,
                    height: A4.height / 0.75,
                  },
                  floating: {
                    horizontalPosition: { relative: 'page', offset: 0 },
                    verticalPosition: { relative: 'page', offset: 0 },
                  },
                }),
              ],
            }),
        ),
      },
    ],
  });
  return { blob: await Packer.toBlob(doc), name: name + '.docx' };
}
