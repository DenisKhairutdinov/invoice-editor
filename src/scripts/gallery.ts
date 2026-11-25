import { get, set } from 'idb-keyval';
import { validateImage } from '../services/images';
import noBannerIcon from 'lucide-static/icons/image-off.svg?url';
import { bindChoicePicker } from './choice-picker';

const STORAGE_KEY = 'invoice-banners';
const builtIn = import.meta.glob(
  '../../assets/banners/*.{png,jpg,jpeg,PNG,JPG,JPEG}',
  {
    eager: true,
    query: '?url',
    import: 'default',
  },
) as Record<string, string>;
type Banner = { id: string; name: string; blob: Blob };

export function createGallery(
  select: HTMLSelectElement,
  picker: HTMLDetailsElement,
) {
  const summary = picker.querySelector('summary')!;
  const options = picker.querySelector('#banner-options')!;
  let banners: Banner[] = [];
  let previewUrls: string[] = [];
  bindChoicePicker(select, picker);

  function syncSelection() {
    for (const choice of options.querySelectorAll('button')) {
      const selected = choice.value === select.value;
      choice.setAttribute('aria-pressed', String(selected));
      if (!selected) continue;
      summary.setAttribute('aria-label', choice.getAttribute('aria-label')!);
      const image = choice.querySelector('img')!;
      if (summary.querySelector('img')?.src === image.src) continue;
      const thumbnail = image.cloneNode() as HTMLImageElement;
      thumbnail.loading = 'eager';
      summary.replaceChildren(thumbnail);
    }
  }

  function refresh() {
    const previous = select.value;
    for (const url of previewUrls) URL.revokeObjectURL(url);
    previewUrls = [];
    const items = [
      { id: '', name: 'Без баннера', url: noBannerIcon },
      ...Object.keys(builtIn)
        .sort()
        .map((id) => ({
          id,
          name: id.split('/').pop() ?? id,
          url: builtIn[id],
        })),
      ...banners.map(({ id, name, blob }) => {
        const url = URL.createObjectURL(blob);
        previewUrls.push(url);
        return { id, name, url };
      }),
    ];
    select.replaceChildren(
      ...items.map(({ name, id }) => new Option(name, id)),
    );
    options.replaceChildren();
    for (const { id, name, url } of items) {
      const choice = document.createElement('button');
      choice.type = 'button';
      choice.value = id;
      choice.setAttribute('aria-label', name);
      const image = document.createElement('img');
      image.alt = '';
      image.loading = 'lazy';
      image.src = url;
      image.className = id ? 'banner-thumbnail' : 'banner-placeholder';
      choice.append(image);
      options.append(choice);
    }
    select.value = items.some(({ id }) => id === previous) ? previous : '';
    syncSelection();
  }

  async function getBlob(id: string) {
    const banner = banners.find((item) => item.id === id);
    if (banner) return banner.blob;
    if (!Object.hasOwn(builtIn, id)) return undefined;
    const response = await fetch(builtIn[id]);
    if (!response.ok) throw new Error('Не удалось загрузить баннер.');
    return await validateImage(await response.blob());
  }

  return {
    getBlob,
    syncSelection,
    canRemove(id: string) {
      return banners.some((banner) => banner.id === id);
    },
    async init() {
      try {
        const saved: unknown = await get(STORAGE_KEY);
        if (Array.isArray(saved)) {
          banners = saved
            .filter((item): item is Banner =>
              Boolean(
                item &&
                typeof item.id === 'string' &&
                typeof item.name === 'string' &&
                item.blob instanceof Blob &&
                item.blob.size <= 10 * 1024 * 1024,
              ),
            )
            .slice(0, 20);
        }
      } finally {
        refresh();
      }
    },
    async add(file: File) {
      if (
        banners.length >= 20 ||
        banners.reduce((sum, item) => sum + item.blob.size, file.size) >
          40 * 1024 * 1024
      ) {
        throw new Error(
          'Хранилище баннеров заполнено. Удалите ненужный баннер.',
        );
      }
      const blob = await validateImage(file);
      const banner = { id: crypto.randomUUID(), name: file.name, blob };
      const next = [...banners, banner];
      await set(STORAGE_KEY, next);
      banners = next;
      refresh();
      select.value = banner.id;
    },
    async remove(id: string) {
      if (!banners.some((item) => item.id === id))
        throw new Error('Выберите пользовательский баннер.');
      const next = banners.filter((item) => item.id !== id);
      await set(STORAGE_KEY, next);
      banners = next;
      refresh();
    },
  };
}
