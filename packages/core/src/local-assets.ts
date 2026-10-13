import type { AssetReference } from './model.js';

export interface LocalAssetMatch {
  assetKey: string;
  fileIndex: number;
}

export interface LocalAssetMatchResult {
  matches: LocalAssetMatch[];
  missingAssetKeys: string[];
  ambiguousAssetKeys: string[];
}

function normalizeName(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
}

function sourceStem(name: string): string {
  return normalizeName(name).replace(/\.[^.]+$/, '');
}

/** Matches a user's downloaded image folder to XML assets by Drive ID, then exact source filename. */
export function matchLocalAssetFiles(
  assets: Record<string, AssetReference>,
  fileNames: string[],
): LocalAssetMatchResult {
  const entries = Object.entries(assets).filter(([, asset]) => asset.provider !== 'manual' || asset.sourceName);
  const matches: LocalAssetMatch[] = [];
  const missingAssetKeys: string[] = [];
  const ambiguousAssetKeys = new Set<string>();
  const usedFiles = new Set<number>();
  const pendingNameMatches: Array<[string, AssetReference]> = [];

  for (const [assetKey, asset] of entries) {
    if (!asset.externalId) {
      pendingNameMatches.push([assetKey, asset]);
      continue;
    }
    const candidates = fileNames.flatMap((name, fileIndex) => name.includes(asset.externalId!) ? [fileIndex] : []);
    if (candidates.length === 1 && !usedFiles.has(candidates[0]!)) {
      matches.push({ assetKey, fileIndex: candidates[0]! });
      usedFiles.add(candidates[0]!);
      continue;
    }
    if (candidates.length > 1) {
      const expectedStem = asset.sourceName ? sourceStem(asset.sourceName) : '';
      const preferred = expectedStem
        ? candidates.filter((fileIndex) => sourceStem(fileNames[fileIndex]!.replace(asset.externalId!, '')).includes(expectedStem))
        : [];
      if (preferred.length === 1 && !usedFiles.has(preferred[0]!)) {
        matches.push({ assetKey, fileIndex: preferred[0]! });
        usedFiles.add(preferred[0]!);
      } else {
        ambiguousAssetKeys.add(assetKey);
      }
      continue;
    }
    pendingNameMatches.push([assetKey, asset]);
  }

  const assetsByName = new Map<string, string[]>();
  for (const [assetKey, asset] of pendingNameMatches) {
    const normalized = asset.sourceName ? normalizeName(asset.sourceName) : '';
    if (normalized) assetsByName.set(normalized, [...(assetsByName.get(normalized) ?? []), assetKey]);
  }

  for (const [assetKey, asset] of pendingNameMatches) {
    const normalized = asset.sourceName ? normalizeName(asset.sourceName) : '';
    if (!normalized) {
      missingAssetKeys.push(assetKey);
      continue;
    }
    const candidates = fileNames.flatMap((name, fileIndex) => normalizeName(name) === normalized ? [fileIndex] : []);
    const sameNameAssets = assetsByName.get(normalized) ?? [];
    if (candidates.length === 1 && sameNameAssets.length === 1 && !usedFiles.has(candidates[0]!)) {
      matches.push({ assetKey, fileIndex: candidates[0]! });
      usedFiles.add(candidates[0]!);
    } else if (candidates.length || sameNameAssets.length > 1) {
      ambiguousAssetKeys.add(assetKey);
    } else {
      missingAssetKeys.push(assetKey);
    }
  }

  return { matches, missingAssetKeys, ambiguousAssetKeys: [...ambiguousAssetKeys] };
}
