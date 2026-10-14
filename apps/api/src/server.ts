import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import sharp from 'sharp';
import { PDFDocument, rgb, clip, endPath, popGraphicsState, pushGraphicsState, rectangle } from 'pdf-lib';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { buildPagePlan, cardRects, mmToPoints, parseMpcFillXml, type AssetReference, type CardSlot, type ImportProject, type PrintSettings } from '@magicpnp/core';

const MAX_XML_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MEBIBYTE = 1024 * 1024;
function configuredMebibytes(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback * MEBIBYTE;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} debe ser un número entero de MiB.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 16_384) {
    throw new Error(`${name} debe estar entre 1 y 16384 MiB.`);
  }
  return value * MEBIBYTE;
}
const MAX_PROJECT_IMAGE_BYTES = configuredMebibytes('MAX_PROJECT_IMAGE_MIB', 1024);
const MAX_IMAGE_PIXELS = 25_000_000;
const MAX_TOTAL_IMAGE_BYTES = configuredMebibytes('MAX_TOTAL_IMAGE_MIB', 2048);
const MAX_EXPORT_BYTES = configuredMebibytes('MAX_EXPORT_MIB', 1_024);
const MAX_TOTAL_EXPORT_BYTES = configuredMebibytes('MAX_TOTAL_EXPORT_MIB', 2_048);
const MAX_CARDS_PER_EXPORT = 1_000;
const MAX_DRIVE_ASSETS_PER_JOB = 1_000;
const PROJECT_TTL_MS = 2 * 60 * 60 * 1000;
const EXPORT_TTL_MS = 30 * 60 * 1000;
const DRIVE_ID = /^[-A-Za-z0-9_]{10,200}$/;
const DRIVE_HOSTS = new Set(['www.googleapis.com', 'drive.google.com', 'drive.usercontent.google.com']);
const settingsPatchSchema = z.object({
  bleedMm: z.union([z.literal(0), z.literal(2), z.literal(3)]).optional(),
  cutMarks: z.boolean().optional(),
  duplexMirror: z.enum(['none', 'horizontal', 'vertical']).optional(),
  backMode: z.enum(['xml', 'custom']).optional(),
  sourceIncludesBleed: z.boolean().optional(),
}).strict();

interface StoredImage {
  buffer: Buffer;
  mime: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
  byteLength: number;
  colorConverted: boolean;
}

interface ExportArtifact {
  buffer: Buffer;
  report: ValidationReport;
  createdAt: number;
}

interface ValidationReport {
  createdAt: string;
  pageCount: number;
  pageSizeMm: { width: 210; height: 297 };
  cutSizeMm: { width: 63; height: 88 };
  bleedMm: number;
  sourceIncludesBleed: boolean;
  backMode: PrintSettings['backMode'];
  duplexMirror: PrintSettings['duplexMirror'];
  duplexVerified: false;
  warnings: string[];
  assets: Array<{ key: string; name?: string; widthPx: number; heightPx: number; effectivePpi: number; colorConverted: boolean }>;
  copyrightReminder: string;
}

interface StoredProject {
  id: string;
  token: string;
  imported: ImportProject;
  originalCards: CardSlot[];
  customBackKey: string | null;
  settings: PrintSettings;
  images: Map<string, StoredImage>;
  exports: Map<string, ExportArtifact>;
  downloadController: AbortController | null;
  exportInProgress: boolean;
  createdAt: number;
}

const projects = new Map<string, StoredProject>();
const importWindows = new Map<string, { start: number; count: number }>();

const app = Fastify({ logger: false, bodyLimit: MAX_XML_BYTES + 1024, requestTimeout: 30_000, trustProxy: process.env.TRUST_PROXY === '1' });
await app.register(multipart, { limits: { files: 1, fileSize: MAX_IMAGE_BYTES, fields: 4 } });

function publicProject(project: StoredProject) {
  const cards = project.originalCards.map((card) => project.settings.backMode === 'custom' && project.customBackKey && card.frontAssetKey && !card.isDoubleFacedOrCustomBack
    ? { ...card, backAssetKey: project.customBackKey }
    : card);
  return {
    id: project.id,
    imported: { ...project.imported, cards },
    settings: project.settings,
    customBackAvailable: !!project.customBackKey,
    assetStatus: Object.fromEntries(Object.entries(project.imported.assets).map(([key, asset]) => {
      const image = project.images.get(key);
      return [key, image ? { state: 'ready', mime: image.mime, widthPx: image.width, heightPx: image.height } : { state: asset.state, error: asset.error }];
    })),
  };
}

function validToken(project: StoredProject, supplied: unknown): boolean {
  if (typeof supplied !== 'string') return false;
  const expected = Buffer.from(project.token);
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function getProject(request: FastifyRequest, reply: FastifyReply): StoredProject | undefined {
  const params = request.params as { projectId?: string };
  const project = params.projectId ? projects.get(params.projectId) : undefined;
  if (!project) {
    void reply.code(404).send({ error: 'No se encontró el proyecto temporal.' });
    return undefined;
  }
  if (!validToken(project, request.headers['x-project-token'])) {
    void reply.code(401).send({ error: 'Token de proyecto no válido.' });
    return undefined;
  }
  project.createdAt = Date.now();
  return project;
}

function isDriveRedirectHost(hostname: string): boolean {
  return DRIVE_HOSTS.has(hostname) || hostname.endsWith('.googleusercontent.com');
}

async function readLimitedBody(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_IMAGE_BYTES) throw new Error('La descarga supera el límite de 25 MiB.');
  if (!response.body) throw new Error('El proveedor devolvió una respuesta vacía.');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_IMAGE_BYTES) throw new Error('La descarga supera el límite de 25 MiB.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

async function inspectImage(input: Buffer): Promise<StoredImage> {
  if (input.byteLength === 0 || input.byteLength > MAX_IMAGE_BYTES) throw new Error('El archivo está vacío o supera 25 MiB.');
  const image = sharp(input, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' });
  const metadata = await image.metadata();
  if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '')) throw new Error('El contenido no es una imagen JPEG, PNG o WebP válida.');
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS) throw new Error('Las dimensiones de la imagen superan el límite permitido.');
  let normalized = input;
  let mime: StoredImage['mime'];
  let colorConverted = false;
  if (metadata.format === 'webp') {
    normalized = await image.rotate().png().toBuffer();
    mime = 'image/png';
  } else if (metadata.format === 'png') {
    normalized = metadata.orientation && metadata.orientation !== 1 ? await image.rotate().png().toBuffer() : input;
    mime = 'image/png';
  } else {
    const needsColorConversion = metadata.space !== 'srgb';
    colorConverted = needsColorConversion;
    normalized = metadata.orientation && metadata.orientation !== 1 || needsColorConversion
      ? await image.rotate().toColorspace('srgb').jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer()
      : input;
    mime = 'image/jpeg';
  }
  const decoded = await sharp(normalized, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' }).metadata();
  if (!decoded.width || !decoded.height || decoded.width * decoded.height > MAX_IMAGE_PIXELS) throw new Error('No se pudo decodificar la imagen de forma segura.');
  await sharp(normalized, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' }).resize({ width: 1, height: 1 }).toBuffer();
  if (normalized.byteLength > MAX_IMAGE_BYTES) throw new Error('La imagen normalizada supera 25 MiB.');
  return { buffer: normalized, mime, width: decoded.width, height: decoded.height, byteLength: normalized.byteLength, colorConverted };
}

async function fetchDriveImage(asset: AssetReference, apiKey: string, parentSignal?: AbortSignal): Promise<StoredImage> {
  if (asset.provider !== 'google-drive' || !asset.externalId || !DRIVE_ID.test(asset.externalId)) {
    throw new Error('La referencia no es un identificador de Google Drive admitido.');
  }
  const start = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(asset.externalId)}`);
  start.searchParams.set('alt', 'media');
  start.searchParams.set('key', apiKey);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const cancelFromParent = () => controller.abort();
    if (parentSignal?.aborted) controller.abort();
    else parentSignal?.addEventListener('abort', cancelFromParent, { once: true });
    try {
      let current = start;
      let response: Response | undefined;
      for (let redirect = 0; redirect <= 3; redirect += 1) {
        if (current.protocol !== 'https:' || !isDriveRedirectHost(current.hostname)) throw new Error('Google Drive respondió con una redirección fuera de los hosts permitidos.');
        response = await fetch(current, { redirect: 'manual', signal: controller.signal, headers: { Accept: 'image/jpeg,image/png,image/webp,application/octet-stream' } });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        if (redirect === 3) throw new Error('Google Drive excedió el límite de redirecciones.');
        const location = response.headers.get('location');
        if (!location) throw new Error('Google Drive devolvió una redirección inválida.');
        current = new URL(location, current);
      }
      if (!response) throw new Error('Google Drive no devolvió una respuesta.');
      if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
        await response.body?.cancel();
        await delay(250 * (2 ** attempt) + Math.floor(Math.random() * 200));
        continue;
      }
      if (!response.ok) throw new Error(`Google Drive respondió HTTP ${response.status}. Comprueba permisos y acceso al archivo.`);
      const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (!contentType.startsWith('image/') && contentType !== 'application/octet-stream') {
        await response.body?.cancel();
        throw new Error('Google Drive no devolvió una imagen (podría ser una página HTML de acceso denegado).');
      }
      const buffer = await readLimitedBody(response);
      const image = await inspectImage(buffer);
      if (contentType === 'image/svg+xml') throw new Error('SVG no está admitido.');
      return image;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('La descarga de Google Drive agotó el tiempo límite de 15 segundos.');
      if (attempt === 2 || (error instanceof Error && !/HTTP 429|HTTP 5\d\d/.test(error.message))) throw error;
      await delay(250 * (2 ** attempt) + Math.floor(Math.random() * 200));
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', cancelFromParent);
    }
  }
  throw new Error('No se pudo descargar la imagen tras tres intentos.');
}

function ensureImageCapacity(project: StoredProject, key: string, newSize: number) {
  const replacingSize = project.images.get(key)?.byteLength ?? 0;
  const projectSize = [...project.images.values()].reduce((sum, image) => sum + image.byteLength, 0) - replacingSize + newSize;
  if (projectSize > MAX_PROJECT_IMAGE_BYTES) throw new Error(`El total de imágenes del proyecto supera ${Math.floor(MAX_PROJECT_IMAGE_BYTES / MEBIBYTE)} MiB.`);
  const total = [...projects.values()].reduce((sum, candidate) => sum + [...candidate.images.values()].reduce((inner, image) => inner + image.byteLength, 0), 0) - replacingSize + newSize;
  if (total > MAX_TOTAL_IMAGE_BYTES) throw new Error(`El almacenamiento temporal supera ${Math.floor(MAX_TOTAL_IMAGE_BYTES / MEBIBYTE)} MiB.`);
}

function applyImage(project: StoredProject, key: string, image: StoredImage) {
  ensureImageCapacity(project, key, image.byteLength);
  project.images.set(key, image);
  const asset = project.imported.assets[key];
  if (asset) {
    asset.state = 'ready';
    asset.provider = 'manual';
    asset.mime = image.mime;
    asset.widthPx = image.width;
    asset.heightPx = image.height;
    delete asset.error;
  }
}

function ppiFor(image: StoredImage, settings: PrintSettings): number {
  const widthMm = settings.sourceIncludesBleed ? 63 + 2 * settings.bleedMm : 63;
  const heightMm = settings.sourceIncludesBleed ? 88 + 2 * settings.bleedMm : 88;
  return Math.min(image.width / (widthMm / 25.4), image.height / (heightMm / 25.4));
}

async function extendEdgeForBleed(image: StoredImage, bleedMm: 0 | 2 | 3): Promise<StoredImage> {
  if (bleedMm === 0) return image;
  const cutRatio = 63 / 88;
  const sourceRatio = image.width / image.height;
  const cropWidth = sourceRatio > cutRatio ? Math.max(1, Math.floor(image.height * cutRatio)) : image.width;
  const cropHeight = sourceRatio < cutRatio ? Math.max(1, Math.floor(image.width / cutRatio)) : image.height;
  const cropLeft = Math.floor((image.width - cropWidth) / 2);
  const cropTop = Math.floor((image.height - cropHeight) / 2);
  const center = await sharp(image.buffer, { limitInputPixels: MAX_IMAGE_PIXELS })
    .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
    .png().toBuffer();
  const borderX = Math.max(1, Math.round(cropWidth * bleedMm / 63));
  const borderY = Math.max(1, Math.round(cropHeight * bleedMm / 88));
  const expandedWidth = cropWidth + borderX * 2;
  const expandedHeight = cropHeight + borderY * 2;
  const side = (left: number, top: number, width: number, height: number, outWidth: number, outHeight: number) => sharp(center)
    .extract({ left, top, width, height }).resize({ width: outWidth, height: outHeight, fit: 'fill', kernel: 'nearest' }).png().toBuffer();
  const [left, right, top, bottom, topLeft, topRight, bottomLeft, bottomRight] = await Promise.all([
    side(0, 0, 1, cropHeight, borderX, cropHeight),
    side(cropWidth - 1, 0, 1, cropHeight, borderX, cropHeight),
    side(0, 0, cropWidth, 1, cropWidth, borderY),
    side(0, cropHeight - 1, cropWidth, 1, cropWidth, borderY),
    side(0, 0, 1, 1, borderX, borderY),
    side(cropWidth - 1, 0, 1, 1, borderX, borderY),
    side(0, cropHeight - 1, 1, 1, borderX, borderY),
    side(cropWidth - 1, cropHeight - 1, 1, 1, borderX, borderY),
  ]);
  const buffer = await sharp({ create: { width: expandedWidth, height: expandedHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: center, left: borderX, top: borderY },
      { input: left, left: 0, top: borderY }, { input: right, left: borderX + cropWidth, top: borderY },
      { input: top, left: borderX, top: 0 }, { input: bottom, left: borderX, top: borderY + cropHeight },
      { input: topLeft, left: 0, top: 0 }, { input: topRight, left: borderX + cropWidth, top: 0 },
      { input: bottomLeft, left: 0, top: borderY + cropHeight }, { input: bottomRight, left: borderX + cropWidth, top: borderY + cropHeight },
    ]).png().toBuffer();
  if (buffer.byteLength > 100 * 1024 * 1024) throw new Error('La imagen preparada para sangrado superaría 100 MiB. Reduce su tamaño.');
  return { buffer, mime: 'image/png', width: expandedWidth, height: expandedHeight, byteLength: buffer.byteLength, colorConverted: image.colorConverted };
}

function drawCutMarks(page: Awaited<ReturnType<PDFDocument['addPage']>>, cut: { xMm: number; yMm: number; widthMm: number; heightMm: number }, gridIndex: number, bleedMm: number) {
  const pageHeight = mmToPoints(297);
  const left = mmToPoints(cut.xMm);
  const right = mmToPoints(cut.xMm + cut.widthMm);
  const top = pageHeight - mmToPoints(cut.yMm);
  const bottom = pageHeight - mmToPoints(cut.yMm + cut.heightMm);
  const length = mmToPoints(2);
  const width = mmToPoints(0.15);
  const lineColor = rgb(0.15, 0.15, 0.15);
  const col = gridIndex % 3;
  const row = Math.floor(gridIndex / 3);
  const marks = [
    { x: left, y: top, horizontalDirection: -1, verticalDirection: 1, horizontal: bleedMm >= 2 || col === 0, vertical: bleedMm >= 2 || row === 0 },
    { x: right, y: top, horizontalDirection: 1, verticalDirection: 1, horizontal: bleedMm >= 2 || col === 2, vertical: bleedMm >= 2 || row === 0 },
    { x: left, y: bottom, horizontalDirection: -1, verticalDirection: -1, horizontal: bleedMm >= 2 || col === 0, vertical: bleedMm >= 2 || row === 2 },
    { x: right, y: bottom, horizontalDirection: 1, verticalDirection: -1, horizontal: bleedMm >= 2 || col === 2, vertical: bleedMm >= 2 || row === 2 },
  ];
  for (const mark of marks) {
    if (mark.horizontal) page.drawLine({ start: { x: mark.x, y: mark.y }, end: { x: mark.x + mark.horizontalDirection * length, y: mark.y }, thickness: width, color: lineColor });
    if (mark.vertical) page.drawLine({ start: { x: mark.x, y: mark.y }, end: { x: mark.x, y: mark.y + mark.verticalDirection * length }, thickness: width, color: lineColor });
  }
}

async function createPdf(project: StoredProject, allowLowResolution: boolean) {
  const warnings = [...project.imported.warnings];
  const printCards = project.originalCards.map((card) => project.settings.backMode === 'custom' && project.customBackKey && card.frontAssetKey && !card.isDoubleFacedOrCustomBack
    ? { ...card, backAssetKey: project.customBackKey }
    : card);
  if (printCards.length > MAX_CARDS_PER_EXPORT) throw new Error(`La exportación está limitada a ${MAX_CARDS_PER_EXPORT} posiciones físicas por PDF.`);
  for (const card of printCards) {
    if (card.frontAssetKey && !project.images.has(card.frontAssetKey)) throw new Error(`Falta el anverso de la posición ${card.slotIndex}. Sustitúyelo antes de exportar.`);
    if (card.frontAssetKey && !card.backAssetKey) throw new Error(`Falta el reverso de la posición ${card.slotIndex}. Elige un reverso común o sube uno para esa carta.`);
    if (card.backAssetKey && !project.images.has(card.backAssetKey)) throw new Error(`Falta el reverso de la posición ${card.slotIndex}. Sustitúyelo antes de exportar.`);
  }
  const imageKeys = new Set(printCards.flatMap((card) => [card.frontAssetKey, card.backAssetKey].filter((key): key is string => !!key)));
  const resolutions = [...imageKeys].map((key) => {
    const image = project.images.get(key)!;
    const ppi = ppiFor(image, project.settings);
    const reference = project.imported.assets[key];
    return { key, name: reference?.sourceName, widthPx: image.width, heightPx: image.height, effectivePpi: Math.round(ppi), colorConverted: image.colorConverted };
  });
  const lowResolution = resolutions.filter((asset) => asset.effectivePpi < 300);
  if (lowResolution.length) {
    warnings.push(`${lowResolution.length} arte(s) quedan por debajo de 300 ppp al tamaño de impresión.`);
    if (!allowLowResolution) throw new Error('Hay imágenes por debajo de 300 ppp. Confirma explícitamente si quieres continuar.');
  }
  if (project.settings.bleedMm < 2) warnings.push('El sangrado está por debajo de los 2 mm recomendados por Soriano.');
  if (project.settings.bleedMm > 0 && !project.settings.sourceIncludesBleed) warnings.push('Los artes se tratarán como imágenes sin sangrado: el borde exterior se extenderá automáticamente. Esa extensión no equivale a sangrado artístico real.');
  if (resolutions.some((asset) => asset.colorConverted)) warnings.push('Al menos una imagen se convirtió a RGB al normalizar su perfil de color.');
  if (project.settings.duplexMirror === 'none') warnings.push('El reverso está en modo «ninguno». Comprueba la orientación con una hoja numerada antes del pedido.');
  warnings.push('La alineación dúplex no está verificada físicamente con Soriano.');
  const report: ValidationReport = {
    createdAt: new Date().toISOString(),
    pageCount: Math.ceil(printCards.length / 9) * 2,
    pageSizeMm: { width: 210, height: 297 },
    cutSizeMm: { width: 63, height: 88 },
    bleedMm: project.settings.bleedMm,
    sourceIncludesBleed: project.settings.sourceIncludesBleed,
    backMode: project.settings.backMode,
    duplexMirror: project.settings.duplexMirror,
    duplexVerified: false,
    warnings,
    assets: resolutions,
    copyrightReminder: 'Confirma que tienes permiso para reproducir e imprimir los artes seleccionados.',
  };

  const pdf = await PDFDocument.create();
  pdf.setTitle('MagicPnP · Perfil A4 9-up');
  pdf.setSubject('PDF de cartas A4 a doble cara; revisar la orientación dúplex antes de imprimir.');
  const pageWidth = mmToPoints(210);
  const pageHeight = mmToPoints(297);
  const pagePlan = buildPagePlan(printCards, project.settings.duplexMirror);
  const rects = cardRects(project.settings.bleedMm);
  const embedded = new Map<string, Awaited<ReturnType<PDFDocument['embedJpg']>>>();
  const printImages = new Map<string, StoredImage>();
  for (const key of imageKeys) {
    const source = project.images.get(key)!;
    const image = project.settings.bleedMm > 0 && !project.settings.sourceIncludesBleed
      ? await extendEdgeForBleed(source, project.settings.bleedMm)
      : source;
    printImages.set(key, image);
    const ref = image.mime === 'image/png' ? await pdf.embedPng(image.buffer) : await pdf.embedJpg(image.buffer);
    embedded.set(key, ref);
  }
  for (const plannedPage of pagePlan) {
    const page = pdf.addPage([pageWidth, pageHeight]);
    for (const placement of plannedPage.placements) {
      if (!placement.assetKey) continue;
      const frame = rects[placement.gridIndex]!.bleed;
      const image = embedded.get(placement.assetKey)!;
      const dimensions = printImages.get(placement.assetKey)!;
      const frameX = mmToPoints(frame.xMm);
      const frameY = pageHeight - mmToPoints(frame.yMm + frame.heightMm);
      const frameW = mmToPoints(frame.widthMm);
      const frameH = mmToPoints(frame.heightMm);
      const scale = Math.max(frameW / dimensions.width, frameH / dimensions.height);
      const drawW = dimensions.width * scale;
      const drawH = dimensions.height * scale;
      page.pushOperators(pushGraphicsState(), rectangle(frameX, frameY, frameW, frameH), clip(), endPath());
      page.drawImage(image, { x: frameX + (frameW - drawW) / 2, y: frameY + (frameH - drawH) / 2, width: drawW, height: drawH });
      page.pushOperators(popGraphicsState());
    }
    if (project.settings.cutMarks) {
      for (const rect of rects) drawCutMarks(page, rect.cut, rect.gridIndex, project.settings.bleedMm);
    }
  }
  return { buffer: Buffer.from(await pdf.save()), report };
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, project] of projects) {
    if (now - project.createdAt > PROJECT_TTL_MS) projects.delete(id);
    else for (const [exportId, artifact] of project.exports) if (now - artifact.createdAt > EXPORT_TTL_MS) project.exports.delete(exportId);
  }
}, 5 * 60 * 1000);
cleanupTimer.unref();

app.get('/api/health', async () => ({ ok: true }));

app.post('/api/projects/import', async (request, reply) => {
  const now = Date.now();
  const window = importWindows.get(request.ip);
  if (!window || now - window.start > 10 * 60 * 1000) importWindows.set(request.ip, { start: now, count: 0 });
  const currentWindow = importWindows.get(request.ip)!;
  if (currentWindow.count >= 20) return reply.code(429).send({ error: 'Límite temporal de importaciones alcanzado; inténtalo dentro de unos minutos.' });
  currentWindow.count += 1;
  if (importWindows.size > 1000) for (const [ip, item] of importWindows) if (now - item.start > 10 * 60 * 1000) importWindows.delete(ip);
  const body = request.body as { xml?: unknown } | undefined;
  if (!body || typeof body.xml !== 'string') return reply.code(400).send({ error: 'Envía el XML en el campo «xml».' });
  if (Buffer.byteLength(body.xml, 'utf8') > MAX_XML_BYTES) return reply.code(413).send({ error: 'El XML supera 2 MiB.' });
  let imported: ImportProject;
  try { imported = parseMpcFillXml(body.xml); }
  catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : 'XML no válido.' }); }
  if (projects.size >= 10) return reply.code(429).send({ error: 'Hay demasiados proyectos temporales activos. Inténtalo más tarde.' });
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const project: StoredProject = {
    id,
    token,
    imported,
    originalCards: structuredClone(imported.cards),
    customBackKey: null,
    settings: { bleedMm: 3, cutMarks: true, duplexMirror: 'none', backMode: 'xml', sourceIncludesBleed: false },
    images: new Map(),
    exports: new Map(),
    downloadController: null,
    exportInProgress: false,
    createdAt: Date.now(),
  };
  projects.set(id, project);
  return reply.code(201).send({ project: publicProject(project), projectToken: token });
});

app.get('/api/projects/:projectId', async (request, reply) => {
  const project = getProject(request, reply);
  return project ? publicProject(project) : undefined;
});

app.get('/api/projects/:projectId/assets/:assetKey/preview', async (request, reply) => {
  const project = getProject(request, reply);
  if (!project) return undefined;
  const { assetKey } = request.params as { assetKey: string };
  const image = project.images.get(assetKey);
  if (!image) return reply.code(404).send({ error: 'La imagen todavía no está disponible.' });
  return reply.type(image.mime).header('cache-control', 'private, max-age=60').send(image.buffer);
});

app.delete('/api/projects/:projectId', async (request, reply) => {
  const project = getProject(request, reply);
  if (!project) return undefined;
  projects.delete(project.id);
  return reply.code(204).send();
});

app.post('/api/projects/:projectId/assets/download', async (request, reply) => {
  const project = getProject(request, reply);
  if (!project) return undefined;
  if (project.exportInProgress) return reply.code(409).send({ error: 'No se pueden cambiar artes mientras se genera el PDF.' });
  if (project.downloadController) return reply.code(409).send({ error: 'Ya hay una descarga activa para este proyecto.' });
  const apiKey = process.env.GOOGLE_DRIVE_API_KEY;
  const targets = Object.entries(project.imported.assets).filter(([key, asset]) => asset.provider === 'google-drive' && !project.images.has(key));
  if (targets.length > MAX_DRIVE_ASSETS_PER_JOB) return reply.code(413).send({ error: `Una descarga está limitada a ${MAX_DRIVE_ASSETS_PER_JOB} imágenes.` });
  if (!apiKey) {
    for (const [, asset] of targets) {
      asset.state = 'failed';
      asset.error = 'Falta configurar GOOGLE_DRIVE_API_KEY; puedes sustituir esta imagen con un archivo local.';
    }
    return reply.code(200).send({ downloaded: 0, failed: targets.length, results: targets.map(([key, asset]) => ({ key, ok: false, error: asset.error })) });
  }
  const controller = new AbortController();
  project.downloadController = controller;
  const results: Array<{ key: string; ok: boolean; error?: string }> = [];
  try {
    for (let offset = 0; offset < targets.length; offset += 3) {
      if (controller.signal.aborted) break;
      const batch = targets.slice(offset, offset + 3);
      results.push(...await Promise.all(batch.map(async ([key, asset]) => {
        asset.state = 'downloading';
        try {
          const image = await fetchDriveImage(asset, apiKey, controller.signal);
          ensureImageCapacity(project, key, image.byteLength);
          project.images.set(key, image);
          asset.state = 'ready';
          asset.mime = image.mime;
          asset.widthPx = image.width;
          asset.heightPx = image.height;
          delete asset.error;
          return { key, ok: true };
        } catch (error) {
          asset.state = controller.signal.aborted ? 'pending' : 'failed';
          asset.error = controller.signal.aborted ? 'Descarga cancelada; puedes reintentar.' : error instanceof Error ? error.message : 'No se pudo descargar la imagen.';
          return { key, ok: false, error: asset.error };
        }
      })));
    }
  } finally {
    project.downloadController = null;
  }
  return { downloaded: results.filter((result) => result.ok).length, failed: results.filter((result) => !result.ok).length, cancelled: controller.signal.aborted, results };
});

app.post('/api/projects/:projectId/assets/download/cancel', async (request, reply) => {
  const project = getProject(request, reply);
  if (!project) return undefined;
  project.downloadController?.abort();
  return { cancelled: !!project.downloadController };
});

app.post('/api/projects/:projectId/assets/:assetKey/download', async (request, reply) => {
  const project = getProject(request, reply);
  if (!project) return undefined;
  if (project.exportInProgress) return reply.code(409).send({ error: 'No se pueden cambiar artes mientras se genera el PDF.' });
  const { assetKey } = request.params as { assetKey: string };
  const asset = project.imported.assets[assetKey];
  if (!asset || asset.provider !== 'google-drive') return reply.code(404).send({ error: 'La referencia no es descargable desde Google Drive.' });
  if (project.downloadController) return reply.code(409).send({ error: 'Ya hay una descarga activa para este proyecto.' });
  const apiKey = process.env.GOOGLE_DRIVE_API_KEY;
  if (!apiKey) return reply.code(503).send({ error: 'Falta GOOGLE_DRIVE_API_KEY; puedes sustituir esta imagen con un archivo local.' });
  const controller = new AbortController();
  project.downloadController = controller;
  asset.state = 'downloading';
  try {
    const image = await fetchDriveImage(asset, apiKey, controller.signal);
    ensureImageCapacity(project, assetKey, image.byteLength);
    project.images.set(assetKey, image);
    asset.state = 'ready';
    asset.mime = image.mime;
    asset.widthPx = image.width;
    asset.heightPx = image.height;
    delete asset.error;
    return { key: assetKey, ok: true };
  } catch (error) {
    asset.state = controller.signal.aborted ? 'pending' : 'failed';
    asset.error = controller.signal.aborted ? 'Descarga cancelada; puedes reintentar.' : error instanceof Error ? error.message : 'No se pudo descargar la imagen.';
    return reply.code(502).send({ error: asset.error });
  } finally {
    project.downloadController = null;
  }
});

app.post('/api/projects/:projectId/assets/:assetKey/replace', async (request, reply) => {
  const project = getProject(request, reply);
  if (!project) return undefined;
  if (project.exportInProgress) return reply.code(409).send({ error: 'No se pueden cambiar artes mientras se genera el PDF.' });
  const { assetKey } = request.params as { assetKey: string };
  if (!project.imported.assets[assetKey]) return reply.code(404).send({ error: 'La referencia de arte no pertenece a este proyecto.' });
  let file;
  try { file = await request.file(); }
  catch { return reply.code(400).send({ error: 'Sube una imagen JPEG, PNG o WebP.' }); }
  if (!file) return reply.code(400).send({ error: 'No se recibió una imagen.' });
  try {
    const image = await inspectImage(await file.toBuffer());
    ensureImageCapacity(project, assetKey, image.byteLength);
    applyImage(project, assetKey, image);
    return { key: assetKey, state: 'replaced', mime: image.mime, widthPx: image.width, heightPx: image.height };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'No se pudo procesar la imagen.';
    return reply.code(422).send({ error: message });
  }
});

app.post('/api/projects/:projectId/back/replace', async (request, reply) => {
  const project = getProject(request, reply);
  if (!project) return undefined;
  if (project.exportInProgress) return reply.code(409).send({ error: 'No se pueden cambiar artes mientras se genera el PDF.' });
  let file;
  try { file = await request.file(); }
  catch { return reply.code(400).send({ error: 'Sube una imagen JPEG, PNG o WebP.' }); }
  if (!file) return reply.code(400).send({ error: 'No se recibió una imagen.' });
  try {
    const image = await inspectImage(await file.toBuffer());
    const key = project.customBackKey ?? `manual:custom-back:${randomUUID()}`;
    const asset: AssetReference = { key, provider: 'manual', sourceName: file.filename, mime: image.mime, widthPx: image.width, heightPx: image.height, state: 'replaced' };
    ensureImageCapacity(project, key, image.byteLength);
    project.imported.assets[key] = asset;
    project.images.set(key, image);
    project.customBackKey = key;
    project.settings.backMode = 'custom';
    return { key, state: 'replaced', mime: image.mime, widthPx: image.width, heightPx: image.height };
  } catch (error) {
    return reply.code(422).send({ error: error instanceof Error ? error.message : 'No se pudo procesar la imagen.' });
  }
});

app.patch('/api/projects/:projectId/settings', async (request, reply) => {
  const project = getProject(request, reply);
  if (!project) return undefined;
  if (project.exportInProgress) return reply.code(409).send({ error: 'No se pueden cambiar ajustes mientras se genera el PDF.' });
  const parsed = settingsPatchSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'Ajustes de impresión no válidos.' });
  }
  const body = parsed.data;
  if (body.backMode === 'custom' && !project.customBackKey) return reply.code(400).send({ error: 'Sube un reverso personalizado antes de seleccionarlo.' });
  project.settings = { ...project.settings, ...body };
  return { settings: project.settings };
});

app.post('/api/projects/:projectId/export', async (request, reply) => {
  const project = getProject(request, reply);
  if (!project) return undefined;
  const body = request.body as { allowLowResolution?: unknown } | undefined;
  if (body?.allowLowResolution !== undefined && typeof body.allowLowResolution !== 'boolean') return reply.code(400).send({ error: 'allowLowResolution debe ser booleano.' });
  if (project.exportInProgress) return reply.code(409).send({ error: 'Ya hay una exportación activa para este proyecto.' });
  project.exportInProgress = true;
  try {
    const artifact = await createPdf(project, body?.allowLowResolution === true);
    if (artifact.buffer.byteLength > MAX_EXPORT_BYTES) {
      const exportMiB = Math.ceil(artifact.buffer.byteLength / MEBIBYTE);
      const limitMiB = Math.floor(MAX_EXPORT_BYTES / MEBIBYTE);
      return reply.code(413).send({ error: `El PDF generado ocupa ${exportMiB} MiB y supera el límite temporal de ${limitMiB} MiB.` });
    }
    const previousBytes = [...project.exports.values()].reduce((sum, item) => sum + item.buffer.byteLength, 0);
    const totalExportBytes = [...projects.values()].reduce((sum, candidate) => sum + [...candidate.exports.values()].reduce((inner, item) => inner + item.buffer.byteLength, 0), 0);
    if (totalExportBytes - previousBytes + artifact.buffer.byteLength > MAX_TOTAL_EXPORT_BYTES) {
      const limitMiB = Math.floor(MAX_TOTAL_EXPORT_BYTES / MEBIBYTE);
      return reply.code(429).send({ error: `El almacenamiento temporal de PDF supera el límite total de ${limitMiB} MiB. Descarga y elimina los proyectos activos antes de reintentar.` });
    }
    project.exports.clear();
    const exportId = randomUUID();
    project.exports.set(exportId, { ...artifact, createdAt: Date.now() });
    return reply.code(201).send({ exportId, report: artifact.report });
  } catch (error) {
    return reply.code(422).send({ error: error instanceof Error ? error.message : 'No se pudo generar el PDF.' });
  } finally {
    project.exportInProgress = false;
  }
});

app.get('/api/projects/:projectId/export/:exportId', async (request, reply) => {
  const project = getProject(request, reply);
  if (!project) return undefined;
  const { exportId } = request.params as { exportId: string };
  const artifact = project.exports.get(exportId);
  if (!artifact) return reply.code(404).send({ error: 'La exportación temporal ha caducado.' });
  return reply.type('application/pdf').header('content-disposition', 'attachment; filename="magicpnp-soriano-a4.pdf"').send(artifact.buffer);
});

app.get('/api/projects/:projectId/export/:exportId/report', async (request, reply) => {
  const project = getProject(request, reply);
  if (!project) return undefined;
  const { exportId } = request.params as { exportId: string };
  const artifact = project.exports.get(exportId);
  if (!artifact) return reply.code(404).send({ error: 'El reporte temporal ha caducado.' });
  return reply.type('application/json').header('content-disposition', 'attachment; filename="magicpnp-validation-report.json"').send(artifact.report);
});

app.setErrorHandler((error, request, reply) => {
  const candidate = error && typeof error === 'object' && 'statusCode' in error ? Number((error as { statusCode?: unknown }).statusCode) : 500;
  if (candidate === 413) return reply.code(413).send({ error: 'La solicitud supera el límite permitido.' });
  const clientError = Number.isInteger(candidate) && candidate > 0 && candidate < 500;
  const message = error instanceof Error ? error.message : 'Solicitud no válida.';
  return reply.code(clientError ? candidate : 500).send({ error: clientError ? message : 'Error interno del servidor.' });
});

const port = Number(process.env.PORT ?? 3000);
export { app };

const desktopMimeTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export async function startDesktopServer(webRoot: string): Promise<string> {
  const root = resolve(webRoot);
  const indexFile = resolve(root, 'index.html');

  app.setNotFoundHandler(async (request, reply) => {
    const pathname = new URL(request.raw.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Ruta API no encontrada.' });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply.code(404).send({ error: 'No se encontró el recurso.' });
    }

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      return reply.code(400).send({ error: 'Ruta de archivo no válida.' });
    }
    const requestedFile = resolve(root, `.${decodedPath}`);
    const requestedRelativePath = relative(root, requestedFile);
    if (requestedRelativePath === '..' || requestedRelativePath.startsWith(`..${sep}`) || isAbsolute(requestedRelativePath)) {
      return reply.code(400).send({ error: 'Ruta de archivo no válida.' });
    }

    let file = indexFile;
    try {
      if ((await stat(requestedFile)).isFile()) file = requestedFile;
    } catch {
      // Las rutas de Angular que no son archivos se resuelven con index.html.
    }
    return reply.type(desktopMimeTypes[extname(file).toLowerCase()] ?? 'application/octet-stream')
      .header('cache-control', file === indexFile ? 'no-cache' : 'public, max-age=3600')
      .send(createReadStream(file));
  });

  return app.listen({ host: '127.0.0.1', port: 0 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
}
