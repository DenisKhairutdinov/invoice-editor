import { PDFDocument, PDFName, PDFObjectCopier, PDFStream } from 'pdf-lib';
import {
  A4,
  GAP,
  PAGE_MARGIN,
  findInkBounds,
  place,
  type Bounds,
} from './layout';
import {
  createCanvas,
  MAX_FILE_BYTES,
  MAX_PAGES,
  openPdf,
  releaseCanvas,
} from './pdf-render';
import { prepareDecorations, type Options } from './decorations';

type PageAnalysis = {
  body?: { bounds: Bounds; left: number; right: number; top: number };
  view: number[];
};
export type PreparedPdf = { source: PDFDocument; pages: PageAnalysis[] };

export async function preparePdf(
  bytes: Uint8Array,
  converted = false,
): Promise<PreparedPdf> {
  if (!converted && bytes.byteLength > MAX_FILE_BYTES)
    throw new Error('Максимум 20 МБ.');
  const source = await PDFDocument.load(bytes, {
    throwOnInvalidObject: true,
    updateMetadata: false,
  });
  const count = source.getPageCount();
  if (count < 1 || count > MAX_PAGES)
    throw new Error('Допускается от 1 до 30 страниц.');
  if (
    ['AcroForm', 'OCProperties', 'OutputIntents'].some((key) =>
      source.catalog.has(PDFName.of(key)),
    )
  ) {
    throw new Error(
      'PDF содержит интерактивные поля, слои или профиль печати. Сохраните плоский PDF из 1С.',
    );
  }

  const task = openPdf(bytes);
  try {
    const pdf = await task.promise;
    if (pdf.numPages !== count)
      throw new Error('Не удалось согласовать структуру страниц PDF.');
    const pages: PageAnalysis[] = [];
    for (let index = 0; index < count; index++) {
      const original = source.getPage(index);
      const page = await pdf.getPage(index + 1);
      if (
        page.userUnit !== 1 ||
        page.rotate !== 0 ||
        original.getRotation().angle !== 0
      ) {
        throw new Error(
          'PDF с поворотом страницы или нестандартной единицей размера не поддерживается.',
        );
      }
      if (
        original.node.Annots()?.size() ||
        (await page.getAnnotations()).length
      ) {
        throw new Error(
          'PDF содержит аннотации или поля. Сохраните плоский PDF из 1С.',
        );
      }
      const scale = 2;
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(viewport.width, viewport.height);
      try {
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Canvas недоступен.');
        await page.render({
          canvasContext: context,
          viewport,
          background: '#fff',
        }).promise;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        const ink = findInkBounds(pixels.data, canvas.width, canvas.height);
        const margin = 4;
        const body = ink && {
          left: ink.left / scale,
          right: Math.min(viewport.width / scale, ink.right / scale),
          top: ink.top / scale,
          bounds: {
            left: Math.max(0, ink.left / scale - margin),
            top: Math.max(0, ink.top / scale - margin),
            right: Math.min(viewport.width / scale, ink.right / scale + margin),
            bottom: Math.min(
              viewport.height / scale,
              ink.bottom / scale + margin,
            ),
          },
        };
        pages.push({ body, view: page.view });
      } finally {
        releaseCanvas(canvas);
        page.cleanup();
      }
    }
    return { source, pages };
  } finally {
    await task.destroy();
  }
}

export async function compose(prepared: PreparedPdf, options: Options) {
  const { source, pages } = prepared;
  const out = await PDFDocument.create();
  const copier = PDFObjectCopier.for(source.context, out.context);
  const decorate = await prepareDecorations(out, options);

  for (const [index, { body, view }] of pages.entries()) {
    try {
      const page = out.addPage([A4.width, A4.height]);
      const position = body && place(body.bounds, 0, 0, 0);
      const offset = body && position ? position.x - body.bounds.left : 0;
      const decoration = decorate(
        body
          ? { left: body.left + offset, right: body.right + offset }
          : undefined,
      );
      const { upper, lower } = decoration;
      if (body && position) {
        const { bounds } = body;
        const gap = upper || lower ? GAP : 0;
        const available = A4.height - position.height - lower - 2 * gap;
        const topPadding = body.top - bounds.top;
        const header =
          upper ||
          Math.min(
            Math.max(0, PAGE_MARGIN - gap - topPadding),
            Math.max(0, available),
          );
        const { y } = place(bounds, header, lower, gap);
        const [left, , , top] = view;
        const original = source.getPage(index);
        const embedded = await out.embedPage(original, {
          left: left + bounds.left,
          right: left + bounds.right,
          bottom: top - bounds.bottom,
          top: top - bounds.top,
        });
        const group = original.node.get(PDFName.of('Group'));
        if (group) {
          await embedded.embed();
          out.context
            .lookup(embedded.ref, PDFStream)
            .dict.set(PDFName.of('Group'), copier.copy(group));
        }
        page.drawPage(embedded, { x: position.x, y, xScale: 1, yScale: 1 });
      }
      decoration.draw(page);
    } catch (error) {
      throw new Error(
        `Страница ${index + 1}. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return out.save();
}
