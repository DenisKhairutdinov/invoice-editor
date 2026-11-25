import { readFile, writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import jsQR from 'jsqr';
import JSZip from 'jszip';
import { A4 } from '../../src/services/layout';
import { banner, invoice, wordInvoice } from './fixtures';

async function upload(
  page: Page,
  data: Buffer,
  name = 'Синтетический счёт.pdf',
  mimeType = 'application/pdf',
) {
  await page.locator('#source').setInputFiles({ name, mimeType, buffer: data });
}

async function pickBanner(page: Page, name = 'playwright-banner.png') {
  const picker = page.locator('#banner-picker');
  await picker.locator('summary').click();
  await picker.getByRole('button', { name, exact: true }).click();
}

async function download(page: Page, format: string) {
  if ((await page.locator('#format').inputValue()) !== format) {
    const picker = page.locator('#format-picker');
    await picker.locator('summary').click();
    await picker.locator(`button[value="${format}"]`).click();
  }
  const ready = page.waitForEvent('download');
  await page.locator('#download').click();
  const file = await ready;
  return {
    name: file.suggestedFilename(),
    bytes: await readFile(await file.path()),
  };
}

async function inspectPdf(data: Buffer, index: number) {
  const task = getDocument({
    data: new Uint8Array(data),
    isEvalSupported: false,
    useSystemFonts: true,
  });
  try {
    const document = await task.promise;
    const page = await document.getPage(index);
    const { items } = await page.getTextContent();
    const operators = await page.getOperatorList();
    const viewport = page.getViewport({ scale: 2 });
    const canvas = createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height),
    );
    await page.render({
      canvasContext: canvas.getContext(
        '2d',
      ) as unknown as CanvasRenderingContext2D,
      viewport,
      background: '#fff',
    }).promise;
    return {
      text: items
        .filter((item) => 'str' in item && item.str.trim())
        .map((item) => {
          if (!('str' in item)) throw new Error('Expected text item');
          return {
            value: item.str,
            matrix: item.transform,
            width: item.width,
            font: item.fontName,
          };
        }),
      operators: operators.fnArray,
      canvas,
    };
  } finally {
    await task.destroy();
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#source')).toBeEnabled();
});

test('one-position PDF and shifted CropBox preserve Cyrillic text, vectors and geometry', async ({
  page,
}) => {
  const original = await invoice({ crop: true, stamp: true });
  await page.locator('#footerEnabled').uncheck();
  await upload(page, original);
  await expect(page.locator('#status')).toContainText('Готово');
  const output = await download(page, 'pdf');
  expect(output.name).toBe('Синтетический счёт_branded.pdf');
  const file = await PDFDocument.load(output.bytes);
  expect(file.getPageCount()).toBe(1);
  expect(file.getPage(0).getWidth()).toBeCloseTo(A4.width, 6);
  expect(file.getPage(0).getHeight()).toBeCloseTo(A4.height, 6);

  const before = await inspectPdf(original, 1);
  const after = await inspectPdf(output.bytes, 1);
  expect(after.operators).not.toContain(OPS.paintImageXObject);
  expect(after.text.map((item) => item.value)).toEqual(
    before.text.map((item) => item.value),
  );
  expect(after.text[0].value).toBe('Синтетический счёт на оплату');
  const dx = after.text[0].matrix[4] - before.text[0].matrix[4];
  const dy = after.text[0].matrix[5] - before.text[0].matrix[5];
  after.text.forEach((item, i) => {
    expect(item.matrix.slice(0, 4)).toEqual(before.text[i].matrix.slice(0, 4));
    expect(item.matrix[4] - before.text[i].matrix[4]).toBeCloseTo(dx, 5);
    expect(item.matrix[5] - before.text[i].matrix[5]).toBeCloseTo(dy, 5);
    expect(item.width).toBeCloseTo(before.text[i].width, 5);
  });

  const [x, y, width, height] = [46, 90, 1030, 690];
  const a = before.canvas
    .getContext('2d')
    .getImageData(x, y, width, height).data;
  const b = after.canvas
    .getContext('2d')
    .getImageData(
      x + Math.round((dx + 12) * 2),
      y + Math.round((-dy + 34) * 2),
      width,
      height,
    ).data;
  const mean =
    a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length;
  expect(mean).toBeLessThan(2);
});

test('five-row multipage PDF, navigation, single preview canvas, JPEG ZIP and DOCX', async ({
  page,
}, testInfo) => {
  await upload(page, await invoice({ lines: 5, pages: 2 }));
  await expect(page.locator('#status')).toContainText('Готово · 2 стр.');
  await page.locator('#next').click();
  await expect(page.locator('#pageNumber')).toHaveText('2 / 2');
  await expect(page.locator('#preview canvas')).toHaveCount(1);
  await page.locator('#previous').click();
  await expect(page.locator('#pageNumber')).toHaveText('1 / 2');

  const pdf = await download(page, 'pdf');
  const branded = await PDFDocument.load(pdf.bytes);
  expect(branded.getPageCount()).toBe(2);
  const pdfSecond = await inspectPdf(pdf.bytes, 2);
  expect(pdfSecond.text.some(({ value }) => value === 'Вторая страница')).toBe(
    true,
  );
  const footerText = pdfSecond.text
    .map(({ value }) => value)
    .join('')
    .replace(/\s+/g, '');
  for (const line of [
    'ООО «Энергомаш»',
    'ИНН/КПП: 7415011651/165001001',
    'ОГРН: 1027401995455',
    'Тел.: +7 (904) 808-18-04',
    'E-mail: 1@bik55.ru',
    'Сайт: https://bik55.ru/',
  ]) {
    expect(footerText).toContain(line.replace(/\s+/g, ''));
  }
  expect(footerText).not.toContain('Челябинск');
  expect(footerText).not.toContain('Мисяш');
  const company = pdfSecond.text.find(({ value }) =>
    value.includes('Энергомаш'),
  )!;
  const registration = pdfSecond.text.find(({ value }) =>
    value.includes('ИНН'),
  )!;
  const siteLabel = pdfSecond.text.find(({ value }) => value.includes('Сайт'))!;
  const website = pdfSecond.text.find(({ value }) =>
    value.includes('https://bik55.ru/'),
  )!;
  expect(registration.font).toBe(company.font);
  expect(company.matrix[0]).toBeCloseTo(11, 5);
  expect(registration.matrix[0]).toBeCloseTo(9, 5);
  expect(siteLabel.font).toBe(company.font);
  expect(website.font).not.toBe(company.font);
  expect(registration.matrix[5]).toBeLessThan(company.matrix[5]);
  expect(siteLabel.matrix[4]).toBeCloseTo(registration.matrix[4], 5);
  expect(website.matrix[5]).toBeCloseTo((10 * 72) / 25.4 + 9 * 0.45, 5);
  await expect(page.locator('#qrSize')).toHaveValue('24');
  const pdfQr = pdfSecond.canvas
    .getContext('2d')
    .getImageData(930, 1420, 260, 264);
  expect(jsQR(pdfQr.data, pdfQr.width, pdfQr.height)?.data).toBe(
    'https://bik55.ru/',
  );

  const jpeg = await download(page, 'jpeg');
  expect(jpeg.name).toBe('Синтетический счёт_branded.zip');
  const zip = await JSZip.loadAsync(jpeg.bytes);
  const images = Object.values(zip.files);
  expect(images).toHaveLength(2);
  for (const entry of images) {
    const bytes = await entry.async('nodebuffer');
    expect(Array.from(bytes.subarray(13, 18))).toEqual([1, 1, 44, 1, 44]);
    const image = await loadImage(bytes);
    expect([image.width, image.height]).toEqual([2480, 3508]);
    const canvas = createCanvas(1100, 500);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 1380, 3008, 1100, 500, 0, 0, 1100, 500);
    expect(jsQR(ctx.getImageData(0, 0, 1100, 500).data, 1100, 500)?.data).toBe(
      'https://bik55.ru/',
    );
  }

  const word = await download(page, 'docx');
  if (testInfo.project.name === 'chromium') {
    await writeFile(testInfo.outputPath('synthetic-branded.docx'), word.bytes);
  }
  const doc = await JSZip.loadAsync(word.bytes);
  const xml = await doc.file('word/document.xml')!.async('string');
  expect(xml).toContain('w:w="11906" w:h="16838"');
  expect(xml.match(/<wp:anchor\b/g)).toHaveLength(2);
  expect(xml.match(/<w:pageBreakBefore\b/g)).toHaveLength(1);
  expect(xml).toMatch(/w:top="0" w:right="0" w:bottom="0" w:left="0"/);
});

test('fills near-edge PDF only when decorations fit and handles invalid and scanned documents', async ({
  page,
}) => {
  await upload(page, await invoice({ fullPage: true }));
  await expect(page.locator('#status')).toContainText('Недостаточно места');
  await expect(page.locator('#download')).toBeDisabled();
  await page.locator('#footerEnabled').uncheck();
  await expect(page.locator('#status')).toContainText('Готово');
  await pickBanner(page);
  await upload(page, await invoice({ fullPage: true, pages: 2 }));
  await expect(page.locator('#status')).toContainText('Недостаточно места');
  await expect(page.locator('#status')).toContainText(
    'Предпросмотр без оформления',
  );
  await expect(page.locator('#download')).toBeDisabled();
  await expect(page.locator('#preview canvas')).toBeVisible();
  await page.locator('#next').click();
  await expect(
    page.getByRole('img', { name: 'Предпросмотр страницы 2' }),
  ).toBeVisible();
  await pickBanner(page, 'Без баннера');
  await expect(page.locator('#status')).toContainText('Готово · 2');
  await expect(page.locator('#download')).toBeEnabled();
  await upload(page, await invoice({ oversized: true }));
  await expect(page.locator('#status')).toContainText('Недостаточно места');
  await expect(page.locator('#download')).toBeDisabled();
  await upload(page, Buffer.from('%PDF-1.7\ncorrupt'));
  await expect(page.locator('#status')).toContainText('Не удалось открыть');
  await expect(page.locator('#preview canvas')).toHaveCount(0);
  await upload(page, await invoice({ scan: true }));
  await expect(page.locator('#status')).toContainText('Готово');
  const file = await download(page, 'jpeg');
  expect(file.name).toMatch(/_branded\.jpg$/);
  const image = await loadImage(file.bytes);
  expect([image.width, image.height]).toEqual([2480, 3508]);
});

test('imports a Cyrillic table and rejects external relationships without network traffic', async ({
  page,
}) => {
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    if (
      /^https?:/.test(request.url()) &&
      new URL(request.url()).origin !== new URL(page.url()).origin
    ) {
      externalRequests.push(request.url());
    }
  });
  const original = await wordInvoice(true);
  await upload(
    page,
    original,
    'Синтетический.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
  await expect(page.locator('#status')).toContainText(
    'импорт Word может отличаться',
    { timeout: 20_000 },
  );
  const file = await download(page, 'pdf');
  expect((await PDFDocument.load(file.bytes)).getPageCount()).toBe(2);
  const result = await inspectPdf(file.bytes, 1);
  expect(result.operators).toContain(OPS.paintImageXObject);
  const ink = result.canvas
    .getContext('2d')
    .getImageData(95, 15, 940, 600).data;
  expect(
    ink.filter((channel, index) => index % 4 !== 3 && channel < 80).length,
  ).toBeGreaterThan(900);
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#filename')).toHaveText('Синтетический.docx');
  await expect(page.locator('#status')).toContainText(
    'импорт Word может отличаться',
    { timeout: 20_000 },
  );
  await expect(page.locator('#pageNumber')).toHaveText('1 / 2');

  const zip = await JSZip.loadAsync(original);
  const name = 'word/_rels/document.xml.rels';
  const rels = await zip.file(name)!.async('string');
  zip.file(
    name,
    rels.replace(
      '</Relationships>',
      '<Relationship Id="rIdExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.invalid/image.png" TargetMode="External"/></Relationships>',
    ),
  );
  await upload(
    page,
    await zip.generateAsync({ type: 'nodebuffer' }),
    'external.docx',
  );
  await expect(page.locator('#status')).toContainText(
    'содержит внешние ссылки',
  );
  expect(externalRequests).toEqual([]);
});

test('banner storage, drop, preview settings, reset and accessibility', async ({
  page,
}) => {
  await page.locator('#banner').setInputFiles({
    name: 'demo.png',
    mimeType: 'image/png',
    buffer: banner(),
  });
  await expect(page.locator('#banner-picker summary')).toHaveAttribute(
    'aria-label',
    'demo.png',
  );
  const company = page.locator('#company');
  await page.locator('#footer-settings').click();
  await expect(company).toBeVisible();
  await company.fill('Синтетическая компания');
  await page.locator('#close-footer').click();
  await expect(page.locator('#footer-dialog')).toBeHidden();
  await expect(page.locator('#lines, #undo, #redo')).toHaveCount(0);
  await page.reload();
  await expect(company).toHaveValue('Синтетическая компания');
  await expect(page.locator('#banner-picker summary')).toHaveAttribute(
    'aria-label',
    'demo.png',
  );

  const bytes = Array.from(await invoice());
  await page.locator('#preview-upload').evaluate((element, data) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([new Uint8Array(data)], 'drop.pdf', { type: 'application/pdf' }),
    );
    element.dispatchEvent(
      new DragEvent('drop', {
        dataTransfer: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, bytes);
  await expect(page.locator('#status')).toContainText('Готово');
  await page.reload();
  await expect(page.locator('#preview canvas')).toBeVisible();
  await expect(page.locator('#filename')).toHaveText('drop.pdf');
  await upload(page, await invoice({ pages: 2 }), 'replacement.pdf');
  await expect(page.locator('#status')).toContainText('Готово · 2');
  await page.reload();
  await expect(page.locator('#filename')).toHaveText('replacement.pdf');
  await expect(page.locator('#status')).toContainText('Готово · 2');
  await expect(page.locator('#guides')).toHaveCount(0);
  await expect(page.locator('#preview canvas')).toHaveCSS(
    'outline-style',
    'none',
  );
  await page.locator('#zoom').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#zoomValue')).toHaveText('91%');

  const ownAssets = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((resource) => resource.name)
      .filter((resource) => resource.includes('/_astro/')),
  );
  expect(
    ownAssets.every((path) => path.includes('/invoice-editor/_astro/')),
  ).toBe(true);
  expect(ownAssets.some((path) => path.includes('pdf.worker'))).toBe(true);
  expect(ownAssets.some((path) => path.includes('inter-cyrillic'))).toBe(true);
  expect(ownAssets.some((path) => path.includes('noto-sans-cyrillic'))).toBe(
    true,
  );

  await page.locator('#removeBanner').click();
  await page.locator('#banner-picker summary').click();
  await expect(
    page.getByRole('button', { name: 'demo.png', exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole('button', { name: 'playwright-banner.png', exact: true })
      .locator('img'),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('#reset').click();
  await expect(company).toHaveValue('ООО «Энергомаш»');
  await expect(page.locator('#url')).toHaveValue('https://bik55.ru/');
  await page.locator('#clear').click();
  await expect(page.locator('#download')).toBeDisabled();
  await expect(page.locator('#preview canvas')).toHaveCount(0);
  await expect(page.locator('#preview-upload')).toBeVisible();
  await page.reload();
  await expect(page.locator('#preview-upload')).toBeEnabled();
  await expect(page.locator('#preview canvas')).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([
    'invoice-settings-v1',
  ]);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(
    accessibility.violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map((node) => node.target),
    })),
  ).toEqual([]);
});

test('fills a legacy empty footer and preserves a customized one', async ({
  page,
}) => {
  const restoreLegacy = async (company: string, height: string, email = '') => {
    await page.evaluate(
      ({ company, height, email }) => {
        localStorage.setItem(
          'invoice-settings-v1',
          JSON.stringify({
            company,
            address: '',
            inn: '',
            kpp: '',
            phone: '',
            zoom: '110',
            footer: height,
            fontSize: '10',
            padding: '6',
            qrSize: '21',
            email,
          }),
        );
      },
      { company, height, email },
    );
    await page.reload();
    await expect(page.locator('#source')).toBeEnabled();
  };

  await restoreLegacy('', '52');
  await expect(page.locator('#company')).toHaveValue('ООО «Энергомаш»');
  await expect(page.locator('#ogrn')).toHaveValue('1027401995455');
  await expect(page.locator('#email')).toHaveValue('1@bik55.ru');
  await expect(page.locator('#zoom')).toHaveValue('110');
  await expect(page.locator('#fontSize')).toHaveValue('9');
  await expect(page.locator('#qrSize')).toHaveValue('24');

  await restoreLegacy('Синтетическая компания', '58');
  await expect(page.locator('#company')).toHaveValue('Синтетическая компания');
  await expect(page.locator('#ogrn')).toHaveValue('');
  await expect(page.locator('#email')).toHaveValue('');
  await expect(page.locator('#fontSize')).toHaveValue('10');
  await restoreLegacy('Синтетическая компания', '58', 'office@example.test');
  await expect(page.locator('#email')).toHaveValue('office@example.test');

  for (const [previous, expected] of [
    ['23', '24'],
    ['27', '27'],
  ]) {
    await page.evaluate((qrSize) => {
      localStorage.setItem(
        'invoice-settings-v1',
        JSON.stringify({ version: 4, qrSize }),
      );
    }, previous);
    await page.reload();
    await expect(page.locator('#source')).toBeEnabled();
    await expect(page.locator('#qrSize')).toHaveValue(expected);
  }
  await page.locator('#reset').click();
  await expect(page.locator('#company')).toHaveValue('ООО «Энергомаш»');
  await expect(page.locator('#ogrn')).toHaveValue('1027401995455');
  await expect(page.locator('#email')).toHaveValue('1@bik55.ru');
  await expect(page.locator('#phone')).toHaveValue('+7 (904) 808-18-04');
  await expect(page.locator('#fontSize')).toHaveValue('9');
  await expect(page.locator('#qrSize')).toHaveValue('24');
});

test('bundled banners resolve under the Pages prefix', async ({ page }) => {
  const summary = page.locator('#banner-picker summary');
  const icon = summary.locator('.banner-placeholder');
  const bounds = (await summary.boundingBox())!;
  const placeholder = (await icon.boundingBox())!;
  expect(placeholder.x + placeholder.width / 2).toBeCloseTo(
    bounds.x + bounds.width / 2,
    1,
  );
  await summary.click();
  const option = page.getByRole('button', {
    name: 'playwright-banner.png',
    exact: true,
  });
  const image = option.locator('img');
  await expect(image).toBeVisible();
  await expect(page.locator('#banner-options')).toHaveCSS('padding', '0px');
  await expect(option).toHaveCSS('padding', '0px');
  expect((await image.boundingBox())!.width).toBeCloseTo(
    (await option.boundingBox())!.width,
    1,
  );
  await expect
    .poll(() => image.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  const accessibility = await new AxeBuilder({ page })
    .include('#banner-picker')
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await expect(option).toHaveText('');
  await option.click();
  await expect(summary).toHaveText('');
  await expect(summary).toHaveCSS('padding', '0px');
  const selected = summary.locator('.banner-thumbnail');
  await expect(selected).toBeVisible();
  const selectedBounds = (await selected.boundingBox())!;
  const summaryBounds = (await summary.boundingBox())!;
  expect(selectedBounds.width).toBeCloseTo(summaryBounds.width - 2, 1);
  expect(selectedBounds.height).toBeCloseTo(summaryBounds.height - 2, 1);
  const resources = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((resource) => resource.name),
  );
  expect(
    resources.some((path) =>
      path.includes('/invoice-editor/_astro/playwright-banner'),
    ),
  ).toBe(true);
});

test('aligns banner, footer and QR to the visible body of each page', async ({
  page,
}) => {
  await page.evaluate(() =>
    localStorage.setItem(
      'invoice-settings-v1',
      JSON.stringify({ version: 3, lines: 'Устаревший дополнительный текст' }),
    ),
  );
  await page.reload();
  await pickBanner(page);
  const source = await PDFDocument.create();
  const frames = [
    { left: 50, right: 515 },
    { left: 82, right: 457 },
    { left: 100, right: 236 },
  ];
  for (const { left, right } of frames) {
    source.addPage([A4.width, A4.height]).drawRectangle({
      x: left,
      y: 690,
      width: right - left,
      height: 30,
    });
  }
  await upload(page, Buffer.from(await source.save()));
  await expect(page.locator('#download')).toBeEnabled();
  const output = await download(page, 'pdf');
  const topMargin = (10 * 72 * 2) / 25.4;
  const qrSize = (24 * 72 * 2) / 25.4;
  const isBanner = (value: number, index: number) =>
    index % 4 === 0 && value === 23;

  for (const [index, { left, right }] of frames.entries()) {
    const { canvas, text } = await inspectPdf(output.bytes, index + 1);
    const registration = text.find(({ value }) => value.includes('ИНН'))!;
    expect(registration.matrix[4]).toBeCloseTo(left, 5);
    expect(text.map(({ value }) => value).join(' ')).not.toContain(
      'Устаревший',
    );
    const ctx = canvas.getContext('2d');
    const row = ctx.getImageData(
      0,
      Math.ceil(topMargin + 12),
      canvas.width,
      1,
    ).data;
    expect(Math.abs(row.findIndex(isBanner) / 4 - left * 2)).toBeLessThan(2);
    expect(
      Math.abs(row.findLastIndex(isBanner) / 4 + 1 - right * 2),
    ).toBeLessThan(2);
    const middle = ctx.getImageData(
      Math.floor(left + right),
      0,
      1,
      canvas.height,
    ).data;
    const bannerHeight = ((right - left) * 2 * 110) / 700;
    expect(
      Math.abs(
        middle.findLastIndex(isBanner) / 4 + 1 - topMargin - bannerHeight,
      ),
    ).toBeLessThan(2);
    const qrCorner = ctx.getImageData(
      Math.ceil(right * 2 - qrSize) + 1,
      Math.ceil(A4.height * 2 - topMargin - qrSize) + 1,
      1,
      1,
    ).data;
    expect([...qrCorner]).toEqual([0, 0, 0, 255]);
  }
  await pickBanner(page, 'Без баннера');
  for (const footerEnabled of [true, false]) {
    await page.locator('#footerEnabled').setChecked(footerEnabled);
    await expect(page.locator('#download')).toBeEnabled();
    const withoutBanner = await download(page, 'pdf');
    const { canvas } = await inspectPdf(withoutBanner.bytes, 1);
    const column = canvas
      .getContext('2d')
      .getImageData(2 * frames[0].left + 10, 0, 1, canvas.height).data;
    const firstInk = column.findIndex(
      (value, index) => index % 4 === 0 && value < 100,
    );
    expect(Math.abs(firstInk / 4 - topMargin)).toBeLessThan(2);
  }
});

test('keeps the zoom slider in place across two- and three-digit values', async ({
  page,
}) => {
  const zoom = page.locator('#zoom');
  const zoomValue = page.locator('#zoomValue');
  await page.evaluate(() => document.fonts.ready);

  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 360, height: 640 },
  ]) {
    await page.setViewportSize(viewport);
    await zoom.fill('99');
    await expect(zoomValue).toHaveText('99%');
    const initial = await zoom.boundingBox();

    await zoom.press('ArrowRight');
    await expect(zoomValue).toHaveText('100%');
    expect(await zoom.boundingBox()).toEqual(initial);

    await zoom.press('End');
    await expect(zoomValue).toHaveText('150%');
    expect(await zoom.boundingBox()).toEqual(initial);
  }

  await page.setViewportSize({ width: 1280, height: 720 });
  await zoom.fill('100');
  await upload(page, await invoice());
  const canvas = page.locator('#preview canvas');
  await expect(canvas).toBeVisible();
  const originalWidth = (await canvas.boundingBox())!.width;
  await page.locator('.stage').hover({ position: { x: 10, y: 10 } });
  await page.mouse.wheel(0, -120);
  await expect(zoom).toHaveValue('105');
  await expect(zoomValue).toHaveText('105%');
  expect((await canvas.boundingBox())!.width).toBeGreaterThan(originalWidth);

  await page.mouse.wheel(0, 120);
  await expect(zoom).toHaveValue('100');
  await page.mouse.wheel(0, -1600);
  await expect(zoom).toHaveValue('150');
  const preview = page.locator('#preview');
  await expect(preview).toHaveCSS('cursor', 'grab');
  const { x, y, width, height } = (await preview.boundingBox())!;
  const initialScroll = await preview.evaluate((element) => element.scrollTop);
  await page.mouse.move(x + width / 2, y + height / 2);
  await page.mouse.down();
  await expect(preview).toHaveCSS('cursor', 'grabbing');
  await page.mouse.move(x + width / 2, y + height / 2 - 85);
  await expect
    .poll(() => preview.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(initialScroll);
  await page.mouse.up();
  await expect(preview).toHaveCSS('cursor', 'grab');
  await page.mouse.wheel(0, 2400);
  await expect(zoom).toHaveValue('40');
  await expect(preview).not.toHaveCSS('cursor', 'grab');
  await expect(page.locator('.stage')).toHaveCSS(
    'background-color',
    'rgb(230, 230, 230)',
  );
});

test('keeps the editor and settings within the desktop and mobile viewports', async ({
  page,
}) => {
  const expectNoScroll = async (locator: ReturnType<Page['locator']>) => {
    expect(
      await locator.evaluate((element) => ({
        vertical: element.scrollHeight - element.clientHeight,
        horizontal: element.scrollWidth - element.clientWidth,
      })),
    ).toEqual({ vertical: 0, horizontal: 0 });
  };

  await page.setViewportSize({ width: 1280, height: 720 });
  expect(
    (await page.locator('#editor-panel').boundingBox())!.width,
  ).toBeCloseTo(358.4, 0);
  const format = page.locator('#format-picker summary');
  await expect(format).toHaveCSS('cursor', 'pointer');
  for (const field of [format, page.locator('#fontSize')]) {
    const border = await field.evaluate(
      (element) => getComputedStyle(element).borderColor,
    );
    await field.focus();
    await expect(field).toHaveCSS('outline-style', 'none');
    await expect(field).toHaveCSS('border-color', border);
    await expect(field).toHaveCSS('box-shadow', 'none');
  }
  await format.press('ArrowDown');
  await expect(
    page.getByRole('button', { name: 'PDF', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const jpeg = page.getByRole('button', { name: 'JPEG', exact: true });
  await expect(jpeg).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(format).toHaveText('JPEG');
  await page.reload();
  await expect(format).toHaveText('JPEG');
  await format.click();
  await expect(jpeg).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.top h1').click();
  await expect(jpeg).toBeHidden();
  await page.locator('#banner').setInputFiles({
    name: 'demo.png',
    mimeType: 'image/png',
    buffer: banner(),
  });
  await expect(page.locator('#banner-picker summary')).toHaveAttribute(
    'aria-label',
    'demo.png',
  );
  expect(
    await page
      .locator('#editor-panel')
      .evaluate((panel) => panel.scrollWidth - panel.clientWidth),
  ).toBe(0);
  await expectNoScroll(page.locator('html'));

  await page.setViewportSize({ width: 360, height: 640 });
  await expect(page.locator('#editor-panel')).toBeHidden();
  const paper = page.locator('#preview-upload');
  expect(
    await page.locator('.stage').evaluate((stage) => {
      const { left, top } = stage.getBoundingClientRect();
      return Boolean(
        document
          .elementFromPoint(left + 3, top + 3)
          ?.closest('#preview-upload'),
      );
    }),
  ).toBe(false);
  await paper.hover();
  await expect(paper).toHaveCSS('background-color', 'rgb(248, 248, 248)');
  await expect(paper).toHaveCSS('border-top-width', '0px');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('#preview-upload').click({ position: { x: 8, y: 8 } }),
  ]);
  await chooser.setFiles({
    name: 'mobile.pdf',
    mimeType: 'application/pdf',
    buffer: await invoice(),
  });
  await expect(page.locator('#preview canvas')).toBeVisible();
  await expectNoScroll(page.locator('#preview'));
  await expectNoScroll(page.locator('html'));

  await page.locator('#toggle-panel').click();
  expect(
    await page
      .locator('#editor-panel')
      .evaluate((panel) => panel.scrollWidth - panel.clientWidth),
  ).toBe(0);
  await page.locator('#footerEnabled').uncheck();
  await expect(page.locator('#fontSize')).toBeVisible();
  await expect(page.locator('#qrSize')).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const footerSettings = page.locator('#footer-settings');
  const dialog = page.getByRole('dialog');
  await footerSettings.click();
  await expect(page.locator('#company')).toBeVisible();
  await expect(dialog).toHaveCSS('transform', 'none');
  await expectNoScroll(dialog);
  await dialog.click({ position: { x: 8, y: 8 } });
  await expect(dialog).toBeVisible();
  const bounds = (await dialog.boundingBox())!;
  await page.mouse.move(bounds.x + 25, bounds.y + 25);
  await page.mouse.down();
  await page.mouse.move(4, 4);
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(dialog).toBeHidden();
  await footerSettings.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toHaveAttribute('data-motion');
  await page.keyboard.press('Escape');
  await page.locator('#toggle-panel').click();
  await expect(page.locator('#preview canvas')).toBeVisible();
  await expectNoScroll(page.locator('html'));
});

test('receives tall PDF with banner and compact footer at its original scale', async ({
  page,
}) => {
  await pickBanner(page);
  const original = await invoice({ tall: true, pages: 2 });
  await upload(page, original);
  await expect(page.locator('#status')).toContainText('Готово · 2');
  await expect(page.locator('#download')).toBeEnabled();
  await expect(
    page.locator(
      '#address, #font, #color, #background, #bodyX, #bodyY, #autoFit, #footer, #padding, #footerY, #qrX, #qrY',
    ),
  ).toHaveCount(0);
  const output = await download(page, 'pdf');
  for (const index of [1, 2]) {
    const before = await inspectPdf(original, index);
    const after = await inspectPdf(output.bytes, index);
    expect(after.text[0].matrix.slice(0, 4)).toEqual(
      before.text[0].matrix.slice(0, 4),
    );
    expect(after.text[0].width).toBeCloseTo(before.text[0].width, 5);
    const inset = Math.ceil((10 * 72 * 2) / 25.4) + 2;
    for (const x of [86, 1082]) {
      expect([
        ...after.canvas.getContext('2d').getImageData(x, inset, 1, 1).data,
      ]).toEqual([23, 54, 111, 255]);
    }
    expect(
      after.operators.filter((op) => op === OPS.paintImageXObject),
    ).toHaveLength(2);
  }
});

test('handles 30 pages with one preview canvas and reports invalid file size or type', async ({
  page,
}, testInfo) => {
  const large = await invoice({ pages: 30, lines: 5 });
  const started = performance.now();
  await upload(page, large);
  await expect(page.locator('#status')).toContainText('Готово · 30 стр.', {
    timeout: 20_000,
  });
  testInfo.annotations.push({
    type: 'performance',
    description: `30 pages to first preview: ${Math.round(performance.now() - started)} ms`,
  });
  await expect(page.locator('#preview canvas')).toHaveCount(1);
  await page.locator('#next').click();
  await expect(page.locator('#pageNumber')).toHaveText('2 / 30');
  const output = await download(page, 'pdf');
  expect((await PDFDocument.load(output.bytes)).getPageCount()).toBe(30);
  await upload(page, Buffer.alloc(20 * 1024 * 1024 + 1));
  await expect(page.locator('#status')).toContainText('до 20 МБ');
  await upload(page, Buffer.from('<svg/>'), 'incorrect.pdf');
  await expect(page.locator('#status')).toContainText('Выберите PDF или DOCX');
  await page.locator('#clear').click();
  await expect(page.locator('#status')).toContainText(
    'Загрузите исходный счёт',
  );
});
