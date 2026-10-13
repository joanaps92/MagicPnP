import { describe, expect, it } from 'vitest';
import { A4_HEIGHT_MM, A4_WIDTH_MM, buildPagePlan, cardRects, mmToPoints } from '../src/layout.js';
import type { CardSlot } from '../src/model.js';

function cards(count: number): CardSlot[] {
  return Array.from({ length: count }, (_, slotIndex) => ({
    slotIndex,
    name: `Carta ${slotIndex + 1}`,
    frontAssetKey: `front-${slotIndex}`,
    backAssetKey: `back-${slotIndex}`,
    isDoubleFacedOrCustomBack: false,
  }));
}

describe('Soriano A4 layout', () => {
  it.each([[1, 2], [9, 2], [10, 4], [100, 24]])('creates %i fronts as %i interleaved pages', (count, expectedPages) => {
    const plan = buildPagePlan(cards(count), 'none');
    expect(plan).toHaveLength(expectedPages);
    expect(plan.map((page) => page.kind)).toEqual(plan.map((_, index) => index % 2 ? 'back' : 'front'));
    expect(plan.every((page) => page.placements.length === 9)).toBe(true);
  });

  it('keeps duplex pairs aligned when horizontal mirror is selected', () => {
    const [front, back] = buildPagePlan(cards(9), 'horizontal');
    expect(front?.placements[0]?.cardSlotIndex).toBe(0);
    expect(back?.placements[2]?.cardSlotIndex).toBe(0);
    expect(back?.placements[0]?.cardSlotIndex).toBe(2);
  });

  it('keeps empty positions fixed on the last sheet on both faces', () => {
    const [front, back] = buildPagePlan(cards(10), 'horizontal').slice(2);
    expect(front?.placements.map((entry) => entry.cardSlotIndex)).toEqual([9, null, null, null, null, null, null, null, null]);
    expect(back?.placements.map((entry) => entry.cardSlotIndex)).toEqual([null, null, 9, null, null, null, null, null, null]);
  });

  it('fits all 69 x 94 mm bleed boxes and exact 63 x 88 mm cut boxes on A4', () => {
    const rects = cardRects(3);
    expect(rects).toHaveLength(9);
    expect(rects[0]?.bleed).toMatchObject({ xMm: 1.5, yMm: 7.5, widthMm: 69, heightMm: 94 });
    expect(rects[8]?.bleed.xMm! + rects[8]?.bleed.widthMm!).toBeLessThanOrEqual(A4_WIDTH_MM);
    expect(rects[8]?.bleed.yMm! + rects[8]?.bleed.heightMm!).toBeLessThanOrEqual(A4_HEIGHT_MM);
    expect(rects.every(({ cut }) => cut.widthMm === 63 && cut.heightMm === 88)).toBe(true);
  });

  it('converts page dimensions to PDF points', () => {
    expect(mmToPoints(A4_WIDTH_MM)).toBeCloseTo(595.276, 2);
    expect(mmToPoints(A4_HEIGHT_MM)).toBeCloseTo(841.89, 2);
  });
});
