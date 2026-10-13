import type { CardSlot, PrintPage, PrintRect } from './model.js';

export const A4_WIDTH_MM = 210;
export const A4_HEIGHT_MM = 297;
export const CUT_WIDTH_MM = 63;
export const CUT_HEIGHT_MM = 88;
export const GRID_CAPACITY = 9;
export const MM_TO_PT = 72 / 25.4;

export function cardRects(bleedMm: 0 | 2 | 3): Array<{ gridIndex: number; bleed: PrintRect; cut: PrintRect; safe: PrintRect }> {
  const frameWidth = CUT_WIDTH_MM + 2 * bleedMm;
  const frameHeight = CUT_HEIGHT_MM + 2 * bleedMm;
  const gridWidth = frameWidth * 3;
  const gridHeight = frameHeight * 3;
  if (gridWidth > A4_WIDTH_MM || gridHeight > A4_HEIGHT_MM) {
    throw new RangeError('La cuadrícula con este sangrado no cabe en A4.');
  }
  const left = (A4_WIDTH_MM - gridWidth) / 2;
  const top = (A4_HEIGHT_MM - gridHeight) / 2;
  return Array.from({ length: GRID_CAPACITY }, (_, gridIndex) => {
    const col = gridIndex % 3;
    const row = Math.floor(gridIndex / 3);
    const xMm = left + col * frameWidth;
    const yMm = top + row * frameHeight;
    const bleed = { xMm, yMm, widthMm: frameWidth, heightMm: frameHeight };
    const cut = { xMm: xMm + bleedMm, yMm: yMm + bleedMm, widthMm: CUT_WIDTH_MM, heightMm: CUT_HEIGHT_MM };
    const safe = { xMm: cut.xMm + 3, yMm: cut.yMm + 3, widthMm: CUT_WIDTH_MM - 6, heightMm: CUT_HEIGHT_MM - 6 };
    return { gridIndex, bleed, cut, safe };
  });
}

function mirrorIndex(index: number, mode: 'none' | 'horizontal' | 'vertical'): number {
  const row = Math.floor(index / 3);
  const col = index % 3;
  if (mode === 'horizontal') return row * 3 + (2 - col);
  if (mode === 'vertical') return (2 - row) * 3 + col;
  return index;
}

/** Returns a fixed nine-position front/back page pair for each sheet. */
export function buildPagePlan(cards: CardSlot[], duplexMirror: 'none' | 'horizontal' | 'vertical'): PrintPage[] {
  const pageCount = Math.ceil(cards.length / GRID_CAPACITY);
  const pages: PrintPage[] = [];
  for (let sheetIndex = 0; sheetIndex < pageCount; sheetIndex += 1) {
    const frontPage: PrintPage = {
      kind: 'front',
      sheetIndex,
      placements: Array.from({ length: GRID_CAPACITY }, (_, gridIndex) => {
        const card = cards[sheetIndex * GRID_CAPACITY + gridIndex];
        return { gridIndex, cardSlotIndex: card?.slotIndex ?? null, assetKey: card?.frontAssetKey ?? null };
      }),
    };
    const backPlacements: PrintPage['placements'] = Array.from({ length: GRID_CAPACITY }, (_, gridIndex) => ({
      gridIndex,
      cardSlotIndex: null,
      assetKey: null,
    }));
    for (let frontIndex = 0; frontIndex < GRID_CAPACITY; frontIndex += 1) {
      const card = cards[sheetIndex * GRID_CAPACITY + frontIndex];
      const targetIndex = mirrorIndex(frontIndex, duplexMirror);
      backPlacements[targetIndex] = {
        gridIndex: targetIndex,
        cardSlotIndex: card?.slotIndex ?? null,
        assetKey: card?.backAssetKey ?? null,
      };
    }
    pages.push(frontPage, { kind: 'back', sheetIndex, placements: backPlacements });
  }
  return pages;
}

export function mmToPoints(mm: number): number {
  return mm * MM_TO_PT;
}
