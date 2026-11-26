import { MAX_FILE_BYTES } from '../services/document-resources';

const entry = `invoice-editor-${encodeURIComponent(import.meta.env.BASE_URL)}.draft`;
const headerLength = 4;
const maxNameBytes = 4096;

function isMissing(error: unknown) {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

export async function readInvoice() {
  const root = await navigator.storage.getDirectory();
  try {
    const file = await (await root.getFileHandle(entry)).getFile();
    if (
      file.size < headerLength ||
      file.size > MAX_FILE_BYTES + maxNameBytes + headerLength
    )
      throw new Error('Неверный размер сохранённого счёта.');
    const header = await file.slice(0, headerLength).arrayBuffer();
    const nameLength = new DataView(header).getUint32(0);
    const dataStart = headerLength + nameLength;
    if (!nameLength || nameLength > maxNameBytes || dataStart >= file.size)
      throw new Error('Не удалось прочитать имя сохранённого счёта.');
    const name = await file.slice(headerLength, dataStart).text();
    return new File([file.slice(dataStart)], name);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export async function saveInvoice(file: File) {
  const name = new TextEncoder().encode(file.name);
  if (name.byteLength > maxNameBytes)
    throw new Error('Слишком длинное имя файла.');
  const header = new ArrayBuffer(headerLength);
  new DataView(header).setUint32(0, name.byteLength);
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(entry, { create: true });
  const writer = await handle.createWritable();
  try {
    await writer.write(new Blob([header, name, file]));
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => undefined);
    throw error;
  }
}

export async function deleteInvoice() {
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(entry);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}
