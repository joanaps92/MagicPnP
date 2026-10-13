export type AssetState = 'pending' | 'downloading' | 'ready' | 'failed' | 'replaced';
export type AssetProvider = 'google-drive' | 'manual' | 'unknown';

export interface AssetReference {
  key: string;
  provider: AssetProvider;
  externalId?: string;
  sourceName?: string;
  mime?: string;
  widthPx?: number;
  heightPx?: number;
  state: AssetState;
  error?: string;
}

export interface CardSlot {
  slotIndex: number;
  name: string;
  query?: string;
  frontAssetKey: string | null;
  backAssetKey: string | null;
  isDoubleFacedOrCustomBack: boolean;
}

export interface ImportProject {
  cards: CardSlot[];
  assets: Record<string, AssetReference>;
  warnings: string[];
  declaredQuantity?: number;
}

export interface PrintSettings {
  bleedMm: 0 | 2 | 3;
  cutMarks: boolean;
  duplexMirror: 'none' | 'horizontal' | 'vertical';
  backMode: 'xml' | 'custom';
  sourceIncludesBleed: boolean;
}

export interface PrintRect {
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}

export interface PrintPage {
  kind: 'front' | 'back';
  sheetIndex: number;
  placements: Array<{
    gridIndex: number;
    cardSlotIndex: number | null;
    assetKey: string | null;
  }>;
}
