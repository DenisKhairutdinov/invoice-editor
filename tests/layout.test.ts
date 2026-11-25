import { describe, expect, it } from 'vitest';
import { A4, findInkBounds, place } from '../src/services/layout';
import { imageType } from '../src/services/images';

describe('A4', () => {
  it('preserves dimensions', () => {
    const placed = place(
      { left: 20, right: 520, top: 30, bottom: 530 },
      80,
      80,
    );
    expect(placed.width).toBe(500);
    expect(placed.height).toBe(500);
    expect(placed.y + 500).toBeCloseTo(A4.height - 88);
  });

  it('rejects overflow', () => {
    expect(() =>
      place({ left: 0, right: 590, top: 0, bottom: 800 }, 80, 80),
    ).toThrow();
  });

  it('fits an undecorated A4 page with no available margin', () => {
    expect(
      place({ left: 0, top: 0, right: A4.width, bottom: A4.height }, 0, 0, 0),
    ).toEqual({
      x: 0,
      y: 0,
      ...A4,
    });
  });

  it('retains pale pixels at both edges using exclusive right and bottom bounds', () => {
    const image = new Uint8ClampedArray(5 * 3 * 4).fill(255);
    expect(findInkBounds(image, 5, 3)).toBeUndefined();
    image[(1 * 5 + 1) * 4] = 254;
    image[(2 * 5 + 4) * 4 + 2] = 253;
    expect(findInkBounds(image, 5, 3)).toEqual({
      left: 1,
      top: 1,
      right: 5,
      bottom: 3,
    });
  });
});

describe('image limits', () => {
  it('checks binary signatures and PNG dimensions before decoding', () => {
    expect(() => imageType(new TextEncoder().encode('<svg/>'))).toThrow(
      'PNG или JPEG',
    );
    const header = new Uint8Array(24);
    const view = new DataView(header.buffer);
    [0x89504e47, 0x0d0a1a0a, 13, 0x49484452, 700, 110].forEach((value, index) =>
      view.setUint32(index * 4, value),
    );
    expect(imageType(header)).toBe('image/png');
    view.setUint32(16, 100_000);
    expect(() => imageType(header)).toThrow('Слишком большие размеры');
  });
});
