import { describe, expect, it } from 'vitest';
import { matchLocalAssetFiles } from '../src/local-assets.js';
import type { AssetReference } from '../src/model.js';

const driveAsset = (externalId: string, sourceName: string): AssetReference => ({
  key: `drive:${externalId}`, provider: 'google-drive', externalId, sourceName, state: 'pending',
});

describe('local image folder matching', () => {
  it('matches MPC Autofill filenames containing the Drive ID', () => {
    const assets = { 'drive:id-123': driveAsset('id-123', 'Forest (25).jpg') };
    const result = matchLocalAssetFiles(assets, ['Forest (25) (id-123).jpg']);
    expect(result).toEqual({ matches: [{ assetKey: 'drive:id-123', fileIndex: 0 }], missingAssetKeys: [], ambiguousAssetKeys: [] });
  });

  it('falls back to one exact filename when the local name has no Drive ID', () => {
    const assets = { 'drive:id-123': driveAsset('id-123', 'Forest (25).jpg') };
    expect(matchLocalAssetFiles(assets, ['Forest (25).jpg']).matches).toEqual([{ assetKey: 'drive:id-123', fileIndex: 0 }]);
  });

  it('reports missing files and refuses ambiguous duplicate names', () => {
    const assets = {
      first: driveAsset('id-123', 'Same.jpg'),
      second: driveAsset('id-456', 'Same.jpg'),
      third: driveAsset('id-789', 'Missing.jpg'),
    };
    const result = matchLocalAssetFiles(assets, ['Same.jpg']);
    expect(result.matches).toEqual([]);
    expect(result.ambiguousAssetKeys).toEqual(['first', 'second']);
    expect(result.missingAssetKeys).toEqual(['third']);
  });

  it('uses the XML source name to resolve multiple files for the same ID', () => {
    const assets = { 'drive:id-123': driveAsset('id-123', 'Forest (25).jpg') };
    const result = matchLocalAssetFiles(assets, ['Other (id-123).jpg', 'Forest (25) (id-123).jpg']);
    expect(result.matches).toEqual([{ assetKey: 'drive:id-123', fileIndex: 1 }]);
    expect(result.ambiguousAssetKeys).toEqual([]);
  });
});
