type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
type Snapshot = Record<string, string | boolean>;
const STORAGE_KEY = 'invoice-settings-v1';
const SETTINGS_VERSION = 5;
const companyDefaults = ['company', 'inn', 'kpp', 'ogrn', 'phone'];
const legacyFooterSize = {
  footer: '52',
  fontSize: '10',
  padding: '6',
  qrSize: '21',
};
const legacyFooterLayout = {
  ...legacyFooterSize,
  font: 'sans',
  footerY: '0',
  qrX: '0',
  qrY: '0',
};
const previousCompactFooter = {
  footer: '28',
  fontSize: '9',
  padding: '2.5',
  qrSize: '18',
  qrX: '0',
  qrY: '0',
};

export function createSettings(form: HTMLFormElement) {
  const fields = Array.from(
    form.querySelectorAll<Field>('input:not([type=file]), textarea, select'),
  );
  const snapshot = (): Snapshot =>
    Object.fromEntries(
      fields.map((field) => [
        field.id,
        field instanceof HTMLInputElement && field.type === 'checkbox'
          ? field.checked
          : field.value,
      ]),
    );
  const defaults = snapshot();

  function apply(value: object) {
    const next = value as Record<string, unknown>;
    for (const field of fields) {
      const value = next[field.id];
      if (field instanceof HTMLInputElement && field.type === 'checkbox') {
        if (typeof value === 'boolean') field.checked = value;
      } else if (typeof value === 'string') {
        if (
          field instanceof HTMLSelectElement &&
          !Array.from(field.options).some((option) => option.value === value)
        ) {
          field.value = String(defaults[field.id]);
        } else {
          field.value =
            field instanceof HTMLTextAreaElement
              ? value.slice(0, field.maxLength)
              : value;
          if (
            !field.validity.valid ||
            (field instanceof HTMLInputElement &&
              field.type === 'number' &&
              !field.value)
          ) {
            field.value = String(defaults[field.id]);
          }
        }
      }
    }
  }

  return {
    restore() {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed: unknown = JSON.parse(stored);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const saved = parsed as Record<string, unknown>;
          const version = typeof saved.version === 'number' ? saved.version : 1;
          if (
            version < 2 &&
            Object.entries(legacyFooterLayout).every(
              ([id, initial]) =>
                !Object.hasOwn(saved, id) || saved[id] === initial,
            )
          ) {
            for (const id of Object.keys(legacyFooterSize)) delete saved[id];
          }
          if (
            version < 3 &&
            Object.entries(previousCompactFooter).every(
              ([id, initial]) => saved[id] === initial,
            )
          ) {
            delete saved.qrSize;
          }
          if (!Object.hasOwn(saved, 'ogrn')) {
            const hasCustomCompany = [
              ...companyDefaults,
              'email',
              'website',
            ].some((id) => {
              const oldDefault = id === 'website' ? defaults.website : '';
              return (
                typeof saved[id] === 'string' && saved[id].trim() !== oldDefault
              );
            });
            for (const id of companyDefaults) {
              if (hasCustomCompany) saved[id] ??= '';
              else delete saved[id];
            }
          }
          if (
            version < 4 &&
            saved.phone === '+7 904 808 18 04, 8 800 101 22 00'
          )
            saved.phone = defaults.phone;
          if (version < 5 && saved.qrSize === '23') delete saved.qrSize;
          if (version < 2) {
            const usesDefaultCompany = companyDefaults.every(
              (id) => !Object.hasOwn(saved, id) || saved[id] === defaults[id],
            );
            if (usesDefaultCompany && saved.email === '') delete saved.email;
            if (!usesDefaultCompany && !Object.hasOwn(saved, 'email'))
              saved.email = '';
          }
          apply(saved);
        }
      }
    },
    commit() {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ ...snapshot(), version: SETTINGS_VERSION }),
        );
        return true;
      } catch {
        return false;
      }
    },
    reset() {
      apply(defaults);
    },
  };
}
