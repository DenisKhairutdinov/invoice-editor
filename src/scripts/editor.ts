import type { PreparedPdf } from '../services/pdf';
import type { ExportFormat } from '../services/formats';
import { MAX_FILE_BYTES, releaseCanvas } from '../services/document-resources';
import type { FooterLine } from '../services/decorations';
import { createGallery } from './gallery';
import { bindChoicePicker } from './choice-picker';
import { createSettings } from './settings';
import { deleteInvoice, readInvoice, saveInvoice } from './invoice-storage';
import sans from '@fontsource/noto-sans/files/noto-sans-cyrillic-400-normal.woff?url';
import sansLatin from '@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff?url';
import sansBold from '@fontsource/noto-sans/files/noto-sans-cyrillic-700-normal.woff?url';
import sansLatinBold from '@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff?url';

const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const input = (id: string) => element<HTMLInputElement>(id);
const button = (id: string) => element<HTMLButtonElement>(id);
const value = (id: string) =>
  element<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(id).value;
const checked = (id: string) => input(id).checked;
const mm = (id: string) => (Number(value(id)) * 72) / 25.4;

const form = element<HTMLFormElement>('editor');
const status = element('status');
const storageStatus = element('storage-status');
const preview = element('preview');
const previewUpload = button('preview-upload');
const gallery = createGallery(element('builtin'), element('banner-picker'));
const format = element<HTMLSelectElement>('format');
const formatPicker = element<HTMLDetailsElement>('format-picker');
const formatSummary = formatPicker.querySelector('summary')!;
bindChoicePicker(format, formatPicker);
const settings = createSettings(form);
const fonts = new Map<string, Uint8Array>();

let source:
  | { prepared: PreparedPdf; bytes: Uint8Array; importedWord: boolean }
  | undefined;
let result: Uint8Array | undefined;
let previewBytes: Uint8Array | undefined;
let filename = '';
let pageNumber = 1;
let revision = 0;
let pageRevision = 0;
let wheelDelta = 0;
let timer: number | undefined;
let importing = false;
let loadRevision = 0;
let exporting = false;
let galleryBusy = false;
let queue = Promise.resolve();
let downloadUrl: string | undefined;
let downloadTimer: number | undefined;
let pan:
  | { pointerId: number; x: number; y: number; left: number; top: number }
  | undefined;

function run(job: () => Promise<void>) {
  queue = queue.then(job).catch((error: unknown) => {
    status.textContent = message(error);
  });
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function storageWarning(text: string) {
  storageStatus.textContent = text;
  storageStatus.hidden = !text;
}

function syncControls() {
  const total = source?.prepared.pages.length ?? 0;
  element('pageNumber').textContent = total
    ? `${pageNumber} / ${total}`
    : '0 / 0';
  button('previous').disabled = !previewBytes || pageNumber <= 1;
  button('next').disabled = !previewBytes || pageNumber >= total;
  button('download').disabled = !result || exporting || importing;
  button('clear').disabled = !filename;
  button('preview-upload').disabled = input('source').disabled || importing;
  button('removeBanner').disabled =
    galleryBusy || !gallery.canRemove(value('builtin'));
  previewUpload.hidden = Boolean(source) || importing;
}

function endPan(event?: PointerEvent) {
  if (!pan || (event && event.pointerId !== pan.pointerId)) return;
  const { pointerId } = pan;
  pan = undefined;
  preview.classList.remove('is-panning');
  if (preview.hasPointerCapture(pointerId))
    preview.releasePointerCapture(pointerId);
}

function canPan() {
  return (
    preview.scrollHeight > preview.clientHeight ||
    preview.scrollWidth > preview.clientWidth
  );
}

const panObserver = new ResizeObserver(() => {
  const scrollable = canPan();
  preview.classList.toggle('can-pan', scrollable);
  if (!scrollable) endPan();
});
panObserver.observe(preview);

preview.addEventListener('pointerdown', (event) => {
  if (event.pointerType !== 'mouse' || event.button !== 0 || !canPan()) return;
  const bounds = preview.getBoundingClientRect();
  if (
    event.clientX - bounds.left >= preview.clientWidth ||
    event.clientY - bounds.top >= preview.clientHeight
  )
    return;
  event.preventDefault();
  pan = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    left: preview.scrollLeft,
    top: preview.scrollTop,
  };
  preview.setPointerCapture(event.pointerId);
  preview.classList.add('is-panning');
});
preview.addEventListener('pointermove', (event) => {
  if (!pan || event.pointerId !== pan.pointerId) return;
  if (!(event.buttons & 1)) {
    endPan(event);
    return;
  }
  preview.scrollLeft = pan.left + pan.x - event.clientX;
  preview.scrollTop = pan.top + pan.y - event.clientY;
});
preview.addEventListener('pointerup', endPan);
preview.addEventListener('pointercancel', endPan);
preview.addEventListener('lostpointercapture', endPan);

function clearPreview(canvas?: HTMLCanvasElement) {
  endPan();
  const previous = preview.querySelector('canvas');
  if (previous) {
    panObserver.unobserve(previous);
    releaseCanvas(previous);
  }
  preview.replaceChildren();
  if (canvas) {
    canvas.setAttribute('aria-label', `Предпросмотр страницы ${pageNumber}`);
    canvas.setAttribute('role', 'img');
    preview.append(canvas);
    panObserver.observe(canvas);
  }
  preview.classList.toggle('can-pan', canPan());
}

async function showPage(bytes: Uint8Array, page: number, current: number) {
  const render = ++pageRevision;
  const { renderPdfPage } = await import('../services/formats');
  const canvas = await renderPdfPage(bytes, page);
  if (render !== pageRevision || current !== revision) {
    releaseCanvas(canvas);
    return false;
  }
  clearPreview(canvas);
  previewBytes = bytes;
  return true;
}

function updatePreviewSettings() {
  preview.style.setProperty('--zoom', String(Number(value('zoom')) / 100));
  element('zoomValue').textContent = value('zoom') + '%';
  const label = format.selectedOptions[0].text;
  if (formatSummary.textContent === label) return;
  formatSummary.textContent = label;
  formatSummary.setAttribute('aria-label', `Формат скачивания: ${label}`);
  for (const option of formatPicker.querySelectorAll('button'))
    option.setAttribute('aria-pressed', String(option.value === format.value));
}

preview.parentElement!.addEventListener(
  'wheel',
  (event) => {
    if (
      !previewBytes ||
      event.shiftKey ||
      !event.deltaY ||
      Math.abs(event.deltaX) > Math.abs(event.deltaY)
    )
      return;
    event.preventDefault();

    const unit =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? preview.clientHeight
          : 1;
    const delta = event.deltaY * unit;
    if (wheelDelta * delta < 0) wheelDelta = 0;
    wheelDelta += delta;
    const steps = Math.trunc(wheelDelta / 80);
    if (!steps) return;
    wheelDelta %= 80;

    const zoom = input('zoom');
    const next = Math.min(
      Number(zoom.max),
      Math.max(Number(zoom.min), zoom.valueAsNumber - steps * 5),
    );
    if (next === zoom.valueAsNumber) return;
    zoom.valueAsNumber = next;
    zoom.dispatchEvent(new Event('change', { bubbles: true }));
  },
  { passive: false },
);

async function fetchFont(url: string) {
  const cached = fonts.get(url);
  if (cached) return cached;
  const response = await fetch(url);
  if (!response.ok) throw new Error('Не удалось загрузить локальный шрифт.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  fonts.set(url, bytes);
  return bytes;
}

async function generate(current: number) {
  const document = source;
  if (!document || current !== revision || importing) return;
  const { prepared, importedWord } = document;
  const wordNotice = importedWord
    ? 'Проверьте оформление: импорт Word может отличаться от оригинала.'
    : '';
  status.textContent = 'Формирование документа…';
  try {
    const footer = checked('footerEnabled');
    if (footer && !form.checkValidity())
      throw new Error('Проверьте значения настроек.');
    const url = footer ? value('url').trim() : '';
    if (
      url &&
      (url.length > 240 || !['https:', 'http:'].includes(new URL(url).protocol))
    ) {
      throw new Error(
        'Введите ссылку QR с протоколом HTTP или HTTPS, до 240 символов.',
      );
    }
    const [inn, kpp, ogrn, phone, email, website] = [
      'inn',
      'kpp',
      'ogrn',
      'phone',
      'email',
      'website',
    ].map((id) => value(id).trim());
    const taxLabel = inn && kpp ? 'ИНН/КПП:' : inn ? 'ИНН:' : 'КПП:';
    const fontSize = Number(value('fontSize'));
    const lines: FooterLine[] = [
      { label: value('company').trim(), text: '', size: fontSize + 2 },
      ...[
        [taxLabel, [inn, kpp].filter(Boolean).join('/')],
        ['ОГРН:', ogrn],
        ['Тел.:', phone],
        ['E-mail:', email],
        ['Сайт:', website],
      ]
        .filter(([, text]) => text)
        .map(([label, text]) => ({ label, text: ' ' + text })),
    ].filter(({ label }) => label);
    const hasText = footer && lines.length;
    const [banner, normalFonts, boldFonts] = await Promise.all([
      checked('bannerEnabled') ? gallery.getBlob(value('builtin')) : undefined,
      hasText
        ? Promise.all([fetchFont(sans), fetchFont(sansLatin)])
        : undefined,
      hasText
        ? Promise.all([fetchFont(sansBold), fetchFont(sansLatinBold)])
        : undefined,
    ]);
    const { compose } = await import('../services/pdf');
    if (current !== revision) return;
    const bytes = await compose(prepared, {
      banner,
      footer,
      lines,
      url,
      fonts:
        normalFonts && boldFonts
          ? { normal: normalFonts, bold: boldFonts }
          : undefined,
      fontSize,
      qrSize: mm('qrSize'),
    });
    if (current !== revision || !(await showPage(bytes, pageNumber, current)))
      return;
    result = bytes;
    status.textContent = [
      `Готово · ${prepared.pages.length} стр. A4.`,
      wordNotice,
    ]
      .filter(Boolean)
      .join(' ');
  } catch (error) {
    if (current !== revision) return;
    const reason = message(error);
    try {
      if (await showPage(document.bytes, pageNumber, current)) {
        status.textContent = [
          reason,
          'Предпросмотр без оформления. Скачивание заблокировано.',
          wordNotice,
        ]
          .filter(Boolean)
          .join(' ');
      }
    } catch (previewError) {
      if (current === revision) {
        clearPreview();
        status.textContent = `${reason} Не удалось показать исходную страницу. ${message(previewError)}`;
      }
    }
  } finally {
    syncControls();
  }
}

function invalidate() {
  revision++;
  pageRevision++;
  wheelDelta = 0;
  result = undefined;
  previewBytes = undefined;
  window.clearTimeout(timer);
  syncControls();
  return revision;
}

function refresh(immediate = false) {
  const current = invalidate();
  if (source && !importing) {
    if (immediate) run(() => generate(current));
    else timer = window.setTimeout(() => run(() => generate(current)), 80);
  }
}

function changeSettings(persisted = settings.commit()) {
  if (!persisted) storageWarning('Браузер не разрешил сохранить настройки.');
  updatePreviewSettings();
  gallery.syncSelection();
  refresh(true);
}

function load(file: File, restoring = false) {
  invalidate();
  const current = ++loadRevision;
  source = undefined;
  importing = true;
  filename = file.name.replace(/\.[^.]+$/, '');
  pageNumber = 1;
  clearPreview();
  element('filename').textContent = file.name;
  status.textContent = 'Чтение и анализ файла…';
  syncControls();
  run(async () => {
    if (current !== loadRevision) return;
    try {
      if (file.size > MAX_FILE_BYTES)
        throw new Error('Допускается файл до 20 МБ.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const isWord = /\.docx$/i.test(file.name);
      if (
        !isWord &&
        (!/\.pdf$/i.test(file.name) ||
          new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-')
      ) {
        throw new Error('Выберите PDF или DOCX.');
      }
      const pdfBytes = isWord
        ? await (await import('../services/docx-import')).importDocx(bytes)
        : bytes;
      if (current !== loadRevision) return;
      const { preparePdf } = await import('../services/pdf');
      const prepared = await preparePdf(pdfBytes, isWord);
      if (current !== loadRevision) return;
      source = { prepared, bytes: pdfBytes, importedWord: isWord };
      if (!restoring) {
        try {
          await saveInvoice(file);
        } catch {
          if (current === loadRevision)
            storageWarning(
              'Браузер не сохранил счёт для восстановления после перезагрузки.',
            );
        }
      }
    } catch (error) {
      if (current === loadRevision)
        status.textContent = `Не удалось открыть счёт. ${message(error)}`;
    } finally {
      if (current === loadRevision) {
        importing = false;
        syncControls();
      }
    }
    if (current === loadRevision && source) refresh(true);
  });
}

function pickPage(delta: number) {
  const bytes = previewBytes;
  if (!bytes || !source) return;
  const page = pageNumber + delta;
  if (page < 1 || page > source.prepared.pages.length) return;
  const current = revision;
  run(async () => {
    if (current !== revision) return;
    const previous = pageNumber;
    pageNumber = page;
    try {
      await showPage(bytes, page, current);
    } catch (error) {
      if (current === revision) pageNumber = previous;
      throw error;
    } finally {
      syncControls();
    }
  });
}

const idleStatus = status.textContent;
const idleFilename = element('filename').textContent;
button('clear').addEventListener('click', () => {
  const current = ++loadRevision;
  source = undefined;
  importing = true;
  filename = '';
  pageNumber = 1;
  invalidate();
  input('source').value = '';
  element('filename').textContent = idleFilename;
  status.textContent = 'Закрытие счёта…';
  clearPreview();
  run(async () => {
    try {
      await deleteInvoice();
    } catch {
      storageWarning('Не удалось удалить локальную копию счёта.');
    } finally {
      if (current === loadRevision) {
        importing = false;
        status.textContent = idleStatus;
        syncControls();
      }
    }
  });
});
input('source').addEventListener('change', () => {
  const file = input('source').files?.[0];
  input('source').value = '';
  if (file && !importing) load(file);
});
previewUpload.addEventListener('click', () => input('source').click());
for (const target of [element('drop'), previewUpload]) {
  target.addEventListener('dragover', (event) => event.preventDefault());
  target.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files[0];
    if (file && !importing && !input('source').disabled) load(file);
  });
}

async function editGallery(edit: () => Promise<void>) {
  if (galleryBusy) return;
  galleryBusy = true;
  input('banner').disabled = true;
  syncControls();
  try {
    await edit();
    changeSettings();
  } catch (error) {
    storageWarning(message(error));
  } finally {
    galleryBusy = false;
    input('banner').disabled = false;
    syncControls();
  }
}

input('banner').addEventListener('change', () => {
  const file = input('banner').files?.[0];
  input('banner').value = '';
  if (file)
    void editGallery(async () => {
      await gallery.add(file);
      input('bannerEnabled').checked = true;
    });
});
button('removeBanner').addEventListener(
  'click',
  () => void editGallery(() => gallery.remove(value('builtin'))),
);
form.addEventListener('change', (event) => {
  if (event.target instanceof HTMLInputElement && event.target.type === 'file')
    return;
  const id = (event.target as HTMLElement).id;
  if (['zoom', 'format'].includes(id)) {
    settings.commit();
    updatePreviewSettings();
    syncControls();
  } else {
    changeSettings();
  }
});
form.addEventListener('input', (event) => {
  const field = event.target;
  if (field instanceof HTMLInputElement && field.id === 'zoom') {
    updatePreviewSettings();
  } else if (
    field instanceof HTMLTextAreaElement ||
    (field instanceof HTMLInputElement &&
      ['text', 'number', 'tel', 'email', 'url'].includes(field.type))
  ) {
    refresh();
  }
});
form.addEventListener('submit', (event) => {
  event.preventDefault();
  refresh(true);
});
button('reset').addEventListener('click', () => {
  settings.reset();
  changeSettings();
});
button('previous').addEventListener('click', () => pickPage(-1));
button('next').addEventListener('click', () => pickPage(1));

function releaseDownload() {
  window.clearTimeout(downloadTimer);
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = undefined;
}

button('download').addEventListener('click', () => {
  if (!result || exporting) return;
  const bytes = result;
  const current = revision;
  const name = filename + '_branded';
  const format = value('format') as ExportFormat;
  exporting = true;
  syncControls();
  run(async () => {
    try {
      if (current !== revision) return;
      status.textContent = 'Подготовка скачивания…';
      const { exportFile } = await import('../services/formats');
      if (current !== revision) return;
      const output = await exportFile(bytes, format, name, (index, total) => {
        if (current === revision)
          status.textContent = `Экспорт страницы ${index} из ${total}…`;
      });
      if (current !== revision) return;
      releaseDownload();
      downloadUrl = URL.createObjectURL(output.blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = output.name;
      document.body.append(link);
      link.click();
      link.remove();
      downloadTimer = window.setTimeout(releaseDownload, 30_000);
      status.textContent =
        `Файл ${output.name} подготовлен.` +
        (format === 'docx' ? ' Страницы Word сохранены как изображения.' : '');
    } catch (error) {
      if (current === revision) status.textContent = message(error);
    } finally {
      exporting = false;
      syncControls();
    }
  });
});

window.addEventListener('pagehide', releaseDownload);

async function init() {
  input('source').disabled = true;
  input('banner').disabled = true;
  try {
    await gallery.init();
  } catch {
    storageWarning('Локальное хранилище баннеров недоступно.');
  }
  try {
    settings.restore();
  } catch {
    storageWarning('Локальные настройки недоступны.');
  }
  let saved: File | undefined;
  try {
    saved = await readInvoice();
  } catch {
    storageWarning('Восстановление счёта из локального хранилища недоступно.');
  }
  input('source').disabled = false;
  input('banner').disabled = false;
  updatePreviewSettings();
  gallery.syncSelection();
  syncControls();
  if (saved) load(saved, true);
}

void init().catch((error: unknown) => storageWarning(message(error)));
