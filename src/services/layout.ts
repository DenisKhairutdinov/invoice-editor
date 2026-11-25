export const A4 = { width: (210 * 72) / 25.4, height: (297 * 72) / 25.4 };
export const PAGE_MARGIN = (10 * 72) / 25.4;
export const GAP = 8;
export const EPSILON = 0.000001;
export type Bounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export function place(
  bounds: Bounds,
  header: number,
  footer: number,
  gap = GAP,
) {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  if (
    ![...Object.values(bounds), header, footer, gap].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0 ||
    Math.min(header, footer, gap) < 0
  ) {
    throw new Error('Некорректные размеры');
  }
  if (
    width > A4.width + EPSILON ||
    height + header + footer + 2 * gap > A4.height + EPSILON
  ) {
    throw new Error(
      'Недостаточно места на A4 без изменения масштаба. Отключите баннер или подвал.',
    );
  }
  return {
    x: Math.max(0, Math.min(bounds.left, A4.width - width)),
    y: A4.height - header - gap - height,
    width,
    height,
  };
}

export function findInkBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
) {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if (
        data[offset] !== 255 ||
        data[offset + 1] !== 255 ||
        data[offset + 2] !== 255
      ) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }
  return right < 0
    ? undefined
    : { left, top, right: right + 1, bottom: bottom + 1 };
}
