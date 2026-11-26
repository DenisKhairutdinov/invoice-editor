import { PDFDocument } from 'pdf-lib';
import { renderAsync } from 'docx-preview';
import html2canvas from 'html2canvas';
import JSZip from 'jszip';
import {
  createCanvas,
  MAX_FILE_BYTES,
  MAX_PAGES,
  releaseCanvas,
} from './document-resources';
import { imageType } from './images';

const MAX_UNPACKED_BYTES = 80 * 1024 * 1024;
const MAX_PART_BYTES = 12 * 1024 * 1024;
const DOCUMENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

function readPart(entry: JSZip.JSZipObject, limit: number) {
  return new Promise<Uint8Array>((resolve, reject) => {
    const stream = (
      entry as JSZip.JSZipObject & {
        internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
      }
    ).internalStream('uint8array');
    const chunks: Uint8Array[] = [];
    let size = 0;
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        stream.pause();
        reject(new Error('DOCX слишком большой после распаковки.'));
      } else {
        chunks.push(chunk);
      }
    });
    stream.on('error', reject);
    stream.on('end', () => {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(bytes);
    });
    stream.resume();
  });
}

function normalizePageBreaks(doc: XMLDocument) {
  const namespace = doc.documentElement.namespaceURI;
  const body = doc.getElementsByTagNameNS(namespace, 'body')[0];
  if (!body || !namespace) return;
  let changed = false;
  for (const paragraph of Array.from(body.children)) {
    if (paragraph.localName !== 'p') continue;
    const properties = paragraph.firstElementChild;
    if (properties?.localName !== 'pPr') continue;
    const before = Array.from(properties.children).find(
      (node) => node.localName === 'pageBreakBefore',
    );
    if (
      !before ||
      ['0', 'false', 'off'].includes(
        before.getAttributeNS(namespace, 'val') ?? '',
      )
    )
      continue;
    const previous = paragraph.previousElementSibling;
    if (!previous) continue;
    const last = previous.lastElementChild?.lastElementChild;
    if (
      last?.localName === 'lastRenderedPageBreak' ||
      (last?.localName === 'br' &&
        last.getAttributeNS(namespace, 'type') === 'page')
    )
      continue;
    // docx-preview splits on explicit runs but ignores pageBreakBefore in direct paragraph formatting.
    const run = doc.createElementNS(namespace, 'w:r');
    const pageBreak = doc.createElementNS(namespace, 'w:br');
    pageBreak.setAttributeNS(namespace, 'w:type', 'page');
    run.append(pageBreak);
    if (previous.localName === 'p') {
      previous.append(run);
    } else {
      const separator = doc.createElementNS(namespace, 'w:p');
      separator.append(run);
      body.insertBefore(separator, paragraph);
    }
    changed = true;
  }
  if (changed) return new XMLSerializer().serializeToString(doc);
}

function validateXml(name: string, bytes: Uint8Array) {
  const decoder =
    bytes[0] === 255 && bytes[1] === 254
      ? 'utf-16le'
      : bytes[0] === 254 && bytes[1] === 255
        ? 'utf-16be'
        : 'utf-8';
  const xml = new TextDecoder(decoder, { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error('DOCX содержит неподдерживаемый XML.');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length)
    throw new Error('Повреждённый XML в DOCX.');
  if (
    name === '[Content_Types].xml' &&
    !Array.from(doc.getElementsByTagNameNS('*', 'Override')).some(
      (node) =>
        node.getAttribute('PartName') === '/word/document.xml' &&
        node.getAttribute('ContentType') === DOCUMENT_TYPE,
    )
  ) {
    throw new Error('Файл не является документом DOCX.');
  }
  if (
    name === 'word/document.xml' &&
    doc.documentElement.localName !== 'document'
  ) {
    throw new Error('Файл не является документом DOCX.');
  }
  if (/\.rels$/i.test(name)) {
    for (const node of doc.getElementsByTagNameNS('*', 'Relationship')) {
      const target = node.getAttribute('Target')?.trim() ?? '';
      if (
        node.getAttribute('TargetMode')?.trim().toLowerCase() === 'external' ||
        /^(?:[a-z][a-z\d+.-]*:|[/\\]{2})/i.test(target)
      ) {
        throw new Error('DOCX содержит внешние ссылки. Сохраните счёт в PDF.');
      }
    }
  }
  for (const tag of ['altChunk', 'object', 'control']) {
    if (doc.getElementsByTagNameNS('*', tag).length) {
      throw new Error('DOCX содержит неподдерживаемый вложенный объект.');
    }
  }
  for (const node of doc.getElementsByTagNameNS(
    'urn:schemas-microsoft-com:vml',
    '*',
  )) {
    if (
      ['style', 'fillcolor', 'color'].some((name) =>
        /[()\\]|\/\*/.test(node.getAttribute(name) ?? ''),
      )
    ) {
      throw new Error(
        'DOCX содержит неподдерживаемое оформление вложенной графики.',
      );
    }
  }
  if (name === 'word/document.xml') return normalizePageBreaks(doc);
}

async function validateDocx(bytes: Uint8Array) {
  if (
    bytes.byteLength > MAX_FILE_BYTES ||
    bytes[0] !== 80 ||
    bytes[1] !== 75 ||
    bytes[2] !== 3 ||
    bytes[3] !== 4
  ) {
    throw new Error('Требуется файл DOCX до 20 МБ.');
  }
  const zip = await JSZip.loadAsync(bytes);
  if (
    !zip.file('[Content_Types].xml') ||
    !zip.file('word/document.xml') ||
    !zip.file('_rels/.rels')
  ) {
    throw new Error('Файл не является документом DOCX.');
  }
  const entries = Object.values(zip.files);
  if (entries.length > 500)
    throw new Error('DOCX содержит слишком много частей.');
  let remaining = MAX_UNPACKED_BYTES;
  let changed = false;
  for (const entry of entries) {
    if (entry.dir) continue;
    if (
      entry.unsafeOriginalName !== entry.name ||
      /(?:^|\/)(?:embeddings|activeX)\/|\.(?:bin|svg|html?)$/i.test(entry.name)
    ) {
      throw new Error('DOCX содержит неподдерживаемый вложенный объект.');
    }
    const data = await readPart(entry, Math.min(remaining, MAX_PART_BYTES));
    remaining -= data.byteLength;
    if (/\.(?:xml|rels)$/i.test(entry.name)) {
      const normalized = validateXml(entry.name, data);
      if (normalized) {
        zip.file(entry.name, normalized);
        changed = true;
      }
    }
    if (entry.name.startsWith('word/media/')) imageType(data);
  }
  return changed ? await zip.generateAsync({ type: 'uint8array' }) : bytes;
}

export async function importDocx(bytes: Uint8Array) {
  const validated = await validateDocx(bytes);
  const frame = document.createElement('iframe');
  frame.title = 'Временная область импорта Word';
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.sandbox.add('allow-same-origin');
  frame.style.cssText =
    'position:fixed;left:-15000px;top:0;width:1200px;height:1400px;pointer-events:none';
  const loaded = new Promise<void>((resolve) =>
    frame.addEventListener('load', () => resolve(), { once: true }),
  );
  frame.srcdoc = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'">
    </head><body style="margin:0"></body></html>`;
  document.body.append(frame);
  try {
    await loaded;
    const doc = frame.contentDocument;
    if (!doc) throw new Error('Не удалось открыть изолированную область Word.');
    const styleHost = doc.createElement('div');
    const contentHost = doc.createElement('div');
    doc.body.append(styleHost, contentHost);
    await renderAsync(validated, contentHost, styleHost, {
      inWrapper: false,
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      ignoreFonts: true,
      renderAltChunks: false,
      useBase64URL: true,
    });
    await doc.fonts.ready;
    const pages = Array.from(
      contentHost.querySelectorAll<HTMLElement>('section.docx'),
    );
    if (!pages.length || pages.length > MAX_PAGES)
      throw new Error('Допускается от 1 до 30 страниц Word.');
    const pdf = await PDFDocument.create();
    let imageBytes = 0;
    for (const page of pages) {
      const width = Math.max(page.offsetWidth, page.scrollWidth);
      const height = Math.max(page.offsetHeight, page.scrollHeight);
      const canvas = createCanvas(width * 3, height * 3);
      try {
        await html2canvas(page, {
          canvas,
          width,
          height,
          scale: 3,
          backgroundColor: '#fff',
          logging: false,
          allowTaint: false,
          useCORS: false,
          removeContainer: true,
        });
        const image = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((value) =>
            value
              ? resolve(value)
              : reject(new Error('Не удалось отрисовать страницу Word.')),
          );
        });
        imageBytes += image.size;
        if (imageBytes > MAX_UNPACKED_BYTES)
          throw new Error('Страницы Word превышают лимит обработки.');
        const png = await pdf.embedPng(await image.arrayBuffer());
        const result = pdf.addPage([width * 0.75, height * 0.75]);
        result.drawImage(png, {
          x: 0,
          y: 0,
          width: result.getWidth(),
          height: result.getHeight(),
        });
      } finally {
        releaseCanvas(canvas);
      }
    }
    return await pdf.save();
  } finally {
    frame.remove();
  }
}
