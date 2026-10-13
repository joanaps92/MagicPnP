import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { mmToPoints } from '@magicpnp/core';
import { app } from '../src/server.js';

let projectId = '';
let projectToken = '';
let front0 = '';
let front1 = '';
let specificBack = '';
let commonBack = '';

const auth = () => ({ 'x-project-token': projectToken });
const projectPath = () => `/api/projects/${projectId}`;

async function upload(key: string, filename: string, png: Buffer) {
  const boundary = `magicpnp-${Math.random().toString(16).slice(2)}`;
  const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`);
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const response = await app.inject({
    method: 'POST',
    url: `${projectPath()}/assets/${encodeURIComponent(key)}/replace`,
    headers: { ...auth(), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([header, png, footer]),
  });
  expect(response.statusCode).toBe(200);
}

describe('MPC Fill API and PDF export', () => {
  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('requires the project token and imports physical fronts and backs by slot', async () => {
    const xml = `<order><details><quantity>2</quantity></details><fronts><card><id>DRIVE_FILE_FRONT1</id><slot>0</slot><name>Front 1.png</name></card><card><id>DRIVE_FILE_FRONT2</id><slot>1</slot><name>Front 2.png</name></card></fronts><backs><card><id>DRIVE_FILE_BACK01</id><slot>0</slot><name>Special back.png</name></card></backs><cardback>DRIVE_FILE_COMMON1</cardback></order>`;
    const response = await app.inject({ method: 'POST', url: '/api/projects/import', payload: { xml } });
    expect(response.statusCode).toBe(201);
    const data = response.json();
    projectId = data.project.id;
    projectToken = data.projectToken;
    front0 = data.project.imported.cards[0].frontAssetKey;
    front1 = data.project.imported.cards[1].frontAssetKey;
    specificBack = data.project.imported.cards[0].backAssetKey;
    commonBack = data.project.imported.cards[1].backAssetKey;
    expect(specificBack).toBe('drive:DRIVE_FILE_BACK01');
    expect(commonBack).toBe('drive:DRIVE_FILE_COMMON1');
    const denied = await app.inject({ method: 'GET', url: projectPath() });
    expect(denied.statusCode).toBe(401);
    const dtd = await app.inject({
      method: 'POST', url: '/api/projects/import', payload: { xml: '<!DOCTYPE order [<!ENTITY x SYSTEM "file:///etc/passwd">]><order><fronts><card><id>&x;</id><slot>0</slot></card></fronts></order>' },
    });
    expect(dtd.statusCode).toBe(422);
    const incompleteExport = await app.inject({
      method: 'POST', url: `${projectPath()}/export`, headers: { ...auth(), 'content-type': 'application/json' }, payload: { allowLowResolution: true },
    });
    expect(incompleteExport.statusCode).toBe(422);
    expect(incompleteExport.json().error).toContain('Falta el anverso');
  });

  it('replaces art, preserves special backs, confirms low resolution and exports A4 pages', async () => {
    const png = await sharp({ create: { width: 320, height: 448, channels: 3, background: { r: 30, g: 90, b: 65 } } }).png().toBuffer();
    await upload(front0, 'front-0.png', png);
    await upload(front1, 'front-1.png', png);
    await upload(specificBack, 'specific-back.png', png);
    await upload(commonBack, 'common-back.png', png);

    const boundary = 'magicpnp-custom-back';
    const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="custom-back.png"\r\nContent-Type: image/png\r\n\r\n`);
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const customResponse = await app.inject({
      method: 'POST', url: `${projectPath()}/back/replace`, headers: { ...auth(), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([header, png, footer]),
    });
    expect(customResponse.statusCode).toBe(200);
    const customKey = customResponse.json().key as string;
    const customProject = await app.inject({ method: 'GET', url: projectPath(), headers: auth() });
    const customState = customProject.json();
    expect(customState.settings.backMode).toBe('custom');
    expect(customState.imported.cards[0].backAssetKey).toBe(specificBack);
    expect(customState.imported.cards[1].backAssetKey).toBe(customKey);

    const settings = await app.inject({
      method: 'PATCH', url: `${projectPath()}/settings`, headers: { ...auth(), 'content-type': 'application/json' },
      payload: { backMode: 'xml', bleedMm: 3, cutMarks: true, duplexMirror: 'horizontal', sourceIncludesBleed: false },
    });
    expect(settings.statusCode).toBe(200);
    const xmlBackState = await app.inject({ method: 'GET', url: projectPath(), headers: auth() });
    expect(xmlBackState.json().imported.cards[1].backAssetKey).toBe(commonBack);

    const blocked = await app.inject({
      method: 'POST', url: `${projectPath()}/export`, headers: { ...auth(), 'content-type': 'application/json' }, payload: { allowLowResolution: false },
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error).toContain('300 ppp');

    const exported = await app.inject({
      method: 'POST', url: `${projectPath()}/export`, headers: { ...auth(), 'content-type': 'application/json' }, payload: { allowLowResolution: true },
    });
    expect(exported.statusCode).toBe(201);
    const result = exported.json();
    expect(result.report.pageCount).toBe(2);
    expect(result.report.pageSizeMm).toEqual({ width: 210, height: 297 });
    expect(result.report.cutSizeMm).toEqual({ width: 63, height: 88 });
    expect(result.report.duplexVerified).toBe(false);
    expect(result.report.warnings.some((warning: string) => warning.includes('no equivale a sangrado artístico real'))).toBe(true);

    const download = await app.inject({ method: 'GET', url: `${projectPath()}/export/${result.exportId}`, headers: auth() });
    expect(download.statusCode).toBe(200);
    const pdf = await PDFDocument.load(new Uint8Array(download.rawPayload));
    expect(pdf.getPageCount()).toBe(2);
    for (const page of pdf.getPages()) {
      const size = page.getSize();
      expect(size.width).toBeCloseTo(mmToPoints(210), 2);
      expect(size.height).toBeCloseTo(mmToPoints(297), 2);
    }
  }, 15_000);
});
