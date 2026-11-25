import { rgb, type PDFDocument, type PDFFont, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';
import { A4, GAP, PAGE_MARGIN } from './layout';

export type FooterLine = { label?: string; text: string; size?: number };
type FontBytes = [cyrillic: Uint8Array, latin: Uint8Array];

export type Options = {
  banner?: Uint8Array;
  bannerType?: string;
  footer: boolean;
  lines: FooterLine[];
  url: string;
  fonts?: { normal: FontBytes; bold: FontBytes };
  fontSize?: number;
  qrSize: number;
};

type TextRun = { text: string; font: PDFFont };
type Word = { text: string; bold: boolean };

function lineWidth(runs: TextRun[], size: number) {
  return runs.reduce(
    (width, run) => width + run.font.widthOfTextAtSize(run.text, size),
    0,
  );
}

async function embedFooterText(
  out: PDFDocument,
  fontBytes: NonNullable<Options['fonts']>,
  defaultSize: number,
) {
  const { default: fontkit } = await import('@pdf-lib/fontkit');
  out.registerFontkit(fontkit);

  async function embedFonts([cyrillic, latin]: FontBytes) {
    const fonts = await Promise.all(
      [latin, cyrillic].map((bytes) => out.embedFont(bytes, { subset: true })),
    );
    return fonts.map((font) => ({
      font,
      characters: new Set(font.getCharacterSet()),
    }));
  }

  const normal = await embedFonts(fontBytes.normal);
  const bold = await embedFonts(fontBytes.bold);
  function fontRuns(words: Word[]) {
    const runs: TextRun[] = [];
    for (const word of words) {
      const fonts = word.bold ? bold : normal;
      for (const char of word.text) {
        const code = char.codePointAt(0)!;
        const selected = fonts.find(({ characters }) => characters.has(code));
        if (!selected)
          throw new Error(`Шрифт не поддерживает символ «${char}».`);
        const previous = runs.at(-1);
        if (previous?.font === selected.font) previous.text += char;
        else runs.push({ text: char, font: selected.font });
      }
    }
    return runs;
  }

  return (lines: FooterLine[], textWidth: number) =>
    lines.flatMap(({ label, text, size = defaultSize }) => {
      const words: Word[] = [
        ...Array.from((label ?? '').matchAll(/\s*\S+/g), ([text]) => ({
          text,
          bold: true,
        })),
        ...Array.from(text.matchAll(/\s*\S+/g), ([text]) => ({
          text,
          bold: false,
        })),
      ];
      const original = fontRuns(words);
      if (lineWidth(original, size) <= textWidth)
        return [{ runs: original, size }];

      const wrapped: TextRun[][] = [];
      let line: Word[] = [];
      let runs: TextRun[] = [];
      for (const word of words) {
        const next = fontRuns([...line, word]);
        if (line.length && lineWidth(next, size) > textWidth) {
          wrapped.push(runs);
          line = [{ ...word, text: word.text.trimStart() }];
          runs = fontRuns(line);
        } else {
          line.push(word);
          runs = next;
        }
      }
      if (runs.length) wrapped.push(runs);
      return wrapped.map((runs) => ({ runs, size }));
    });
}

export async function prepareDecorations(out: PDFDocument, options: Options) {
  const banner = options.banner
    ? await (options.bannerType === 'image/png'
        ? out.embedPng(options.banner)
        : out.embedJpg(options.banner))
    : undefined;
  const size = options.fontSize ?? 9;
  const lineHeightMultiplier = 1.45;
  const qrOptions = { errorCorrectionLevel: 'M' as const, margin: 0 };
  const qrCode =
    options.footer && options.url
      ? QRCode.create(options.url, qrOptions)
      : undefined;
  const quietRatio = qrCode ? 4 / qrCode.modules.size : 0;
  const qr = qrCode
    ? await out.embedPng(
        await QRCode.toDataURL(options.url, {
          ...qrOptions,
          width: qrCode.modules.size * 24,
        }),
      )
    : undefined;
  const { lines: text } = options;
  const wrap =
    options.footer && text.length && options.fonts
      ? await embedFooterText(out, options.fonts, size)
      : undefined;

  function layoutText(width: number) {
    if (!wrap) return [];
    if (width <= 0) return undefined;
    const lines = wrap(text, width);
    return lines.every(({ runs, size }) => lineWidth(runs, size) <= width)
      ? lines
      : undefined;
  }

  return (frame = { left: PAGE_MARGIN, right: A4.width - PAGE_MARGIN }) => {
    const { left, right } = frame;
    const width = right - left;
    const qrSize = qrCode
      ? Math.min(
          options.qrSize,
          width,
          (A4.width - left) / (1 + quietRatio),
          right / (1 + quietRatio),
        )
      : 0;
    if (qrCode && (qrSize * 25.4) / (72 * qrCode.modules.size) < 0.28)
      throw new Error(
        'QR-код не помещается с читаемым размером. Проверьте ссылку или отключите QR.',
      );

    // Keep the scanning zone on the page, outside the QR image.
    const quiet = qrSize * quietRatio;
    const qrLeft = Math.min(right, A4.width - quiet) - qrSize;
    const alongside = layoutText(qr ? qrLeft - quiet - left : width);
    const textBottom = !alongside && qr ? qrSize + quiet : 0;
    const lines = alongside ?? layoutText(width);
    if (!lines)
      throw new Error(
        'Строка подвала не помещается по ширине счёта. Сократите текст или уменьшите размер шрифта.',
      );

    const head = banner ? (width / banner.width) * banner.height : 0;
    const upper = banner ? PAGE_MARGIN + head : 0;
    const textHeight = lines.reduce(
      (height, line) => height + line.size * lineHeightMultiplier,
      0,
    );
    const foot = Math.max(textBottom + textHeight, qrSize);
    const lower = foot ? PAGE_MARGIN + Math.max(foot, qrSize + quiet - GAP) : 0;

    return {
      upper,
      lower,
      draw(page: PDFPage) {
        if (upper + lower > A4.height)
          throw new Error(
            'Оформление не помещается на A4. Отключите баннер или подвал.',
          );
        if (banner)
          page.drawImage(banner, {
            x: left,
            y: A4.height - upper,
            width,
            height: head,
          });
        const ink = rgb(0.13, 0.13, 0.13);
        let lineTop = PAGE_MARGIN + textBottom + textHeight;
        for (const { runs, size } of lines) {
          let x = left;
          const y = lineTop - size;
          for (const run of runs) {
            page.drawText(run.text, { x, y, size, font: run.font, color: ink });
            x += run.font.widthOfTextAtSize(run.text, size);
          }
          lineTop -= size * lineHeightMultiplier;
        }
        if (qr)
          page.drawImage(qr, {
            x: qrLeft,
            y: PAGE_MARGIN,
            width: qrSize,
            height: qrSize,
          });
      },
    };
  };
}
