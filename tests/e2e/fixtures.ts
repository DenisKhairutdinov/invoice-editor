import { readFile } from 'node:fs/promises';
import { createCanvas } from '@napi-rs/canvas';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb } from 'pdf-lib';
import { Document, Packer, Paragraph, Table, TableCell, TableRow } from 'docx';
import { A4 } from '../../src/services/layout';

export async function invoice(
  options: {
    lines?: number;
    pages?: number;
    stamp?: boolean;
    tall?: boolean;
    fullPage?: boolean;
    oversized?: boolean;
    crop?: boolean;
    scan?: boolean;
  } = {},
) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const cyrillic = await pdf.embedFont(
    await readFile(
      'node_modules/@fontsource/noto-sans/files/noto-sans-cyrillic-400-normal.woff',
    ),
    { subset: true },
  );
  for (let index = 0; index < (options.pages ?? 1); index++) {
    const page = pdf.addPage([options.oversized ? 720 : A4.width, A4.height]);
    if (options.crop) {
      page.setMediaBox(-20, -30, A4.width + 40, A4.height + 60);
      page.setCropBox(12, 34, A4.width - 24, A4.height - 68);
    }
    if (options.scan) {
      const canvas = createCanvas(500, 400);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#f7f6f3';
      ctx.fillRect(0, 0, 500, 400);
      ctx.fillStyle = '#111';
      ctx.font = '24px sans-serif';
      ctx.fillText('Синтетический скан счёта', 30, 65);
      ctx.strokeRect(30, 90, 440, 180);
      page.drawImage(await pdf.embedPng(canvas.toBuffer('image/png')), {
        x: 35,
        y: 365,
        width: 500,
        height: 400,
      });
      continue;
    }
    const heading =
      index % 2 ? 'Вторая страница' : 'Синтетический счёт на оплату';
    page.drawText(heading, { x: 42, y: 754, size: 16, font: cyrillic });
    page.drawText('Поставщик и покупатель', {
      x: 42,
      y: 719,
      size: 10,
      font: cyrillic,
    });
    const rows = options.lines ?? 1;
    page.drawRectangle({
      x: 42,
      y: 692 - 24 * (rows + 1),
      width: 500,
      height: 24 * (rows + 1),
      borderWidth: 0.5,
      borderColor: rgb(0, 0, 0),
    });
    for (let row = 0; row <= rows; row++) {
      const y = 692 - 24 * row;
      page.drawLine({
        start: { x: 42, y },
        end: { x: 542, y },
        thickness: 0.5,
      });
      page.drawText(row ? 'Синтетическая позиция' : 'Наименование', {
        x: 53,
        y: y - 16,
        size: 10,
        font: cyrillic,
      });
    }
    page.drawText('Итого к оплате', {
      x: 42,
      y: 626 - 24 * rows,
      size: 11,
      font: cyrillic,
    });
    if (options.stamp) {
      page.drawCircle({
        x: 160,
        y: 440,
        size: 36,
        borderWidth: 0.6,
        borderColor: rgb(0.88, 0.89, 0.97),
      });
      page.drawSvgPath('M 0 30 C 20 -30 20 45 120 5', {
        x: 200,
        y: 455,
        borderColor: rgb(0.21, 0.3, 0.7),
        borderWidth: 0.8,
      });
    }
    if (options.tall) {
      page.drawLine({
        start: { x: 42, y: 190 },
        end: { x: 42, y: 750 },
        color: rgb(0.8, 0.81, 0.83),
        thickness: 0.35,
      });
    }
    if (options.fullPage || options.oversized) {
      page.drawRectangle({
        x: 1,
        y: 1,
        width: page.getWidth() - 2,
        height: page.getHeight() - 2,
        borderColor: rgb(0.94, 0.95, 0.963),
        borderWidth: 0.2,
      });
    }
  }
  return Buffer.from(await pdf.save());
}

export async function wordInvoice(multipage = false) {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph('Синтетический счёт на оплату'),
          new Table({
            rows: ['Наименование', 'Синтетическая позиция'].map(
              (text) =>
                new TableRow({
                  children: ['Количество', text].map(
                    (value) =>
                      new TableCell({ children: [new Paragraph(value)] }),
                  ),
                }),
            ),
          }),
          new Paragraph('Итого к оплате'),
          ...(multipage
            ? [
                new Paragraph({
                  text: 'Вторая страница Word',
                  pageBreakBefore: true,
                }),
              ]
            : []),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

export function banner() {
  const canvas = createCanvas(700, 110);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#17366f';
  ctx.fillRect(0, 0, 700, 110);
  return canvas.toBuffer('image/png');
}
