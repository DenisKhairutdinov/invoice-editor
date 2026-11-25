export function bindChoicePicker(
  select: HTMLSelectElement,
  picker: HTMLDetailsElement,
) {
  const summary = picker.querySelector('summary')!;
  picker.addEventListener('click', (event) => {
    const choice = (event.target as HTMLElement).closest('button');
    if (!choice) return;
    select.value = choice.value;
    picker.open = false;
    summary.focus();
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  picker.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && picker.open) {
      picker.open = false;
      summary.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    picker.open = true;
    const choices = [...picker.querySelectorAll('button')];
    const current = choices.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const last = choices.length - 1;
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : event.key === 'ArrowUp'
            ? current <= 0
              ? last
              : current - 1
            : current === last
              ? 0
              : current + 1;
    choices[next]?.focus();
  });
  document.addEventListener('click', (event) => {
    if (!picker.contains(event.target as Node)) picker.open = false;
  });
  picker.addEventListener('focusout', (event) => {
    if (!picker.contains(event.relatedTarget as Node | null))
      picker.open = false;
  });
}
