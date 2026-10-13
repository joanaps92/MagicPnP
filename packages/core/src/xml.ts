import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { AssetReference, CardSlot, ImportProject } from './model.js';

const MAX_XML_BYTES = 2 * 1024 * 1024;
const MAX_PHYSICAL_SLOTS = 10_000;
const MAX_XML_NODES = 40_000;
const MAX_XML_DEPTH = 64;
const DRIVE_ID = /^[-A-Za-z0-9_]{10,200}$/;

export class XmlImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlImportError';
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  allowBooleanAttributes: false,
  stopNodes: [],
});

function text(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') {
    const result = String(value).trim();
    return result || undefined;
  }
  if (Array.isArray(value)) return text(value[0]);
  if (value && typeof value === 'object' && '#text' in value) return text((value as { '#text': unknown })['#text']);
  return undefined;
}

function records(value: unknown): Array<Record<string, unknown>> {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object');
}

function field(record: Record<string, unknown>, name: string): unknown {
  return record[name] ?? record[`@_${name}`];
}

function slotIndices(card: Record<string, unknown>, label: string): number[] {
  const raw = text(field(card, 'slots')) ?? text(field(card, 'slot'));
  if (!raw) throw new XmlImportError(`${label} no contiene <slot> ni <slots>.`);
  const parts = raw.split(/[\s,]+/).filter(Boolean);
  if (!parts.length) throw new XmlImportError(`${label} no contiene posiciones válidas.`);
  const indices = parts.map((part) => {
    if (!/^\d+$/.test(part)) throw new XmlImportError(`Posición no válida en ${label}: «${part}».`);
    const index = Number(part);
    if (!Number.isSafeInteger(index) || index >= MAX_PHYSICAL_SLOTS) {
      throw new XmlImportError(`La posición ${part} está fuera del límite admitido (0–${MAX_PHYSICAL_SLOTS - 1}).`);
    }
    return index;
  });
  return [...new Set(indices)];
}

function assetFrom(idValue: unknown, sourceName: string | undefined, keyHint: string): AssetReference {
  const id = text(idValue);
  if (!id || !DRIVE_ID.test(id)) {
    return {
      key: `manual:${keyHint}`,
      provider: 'unknown',
      sourceName,
      state: 'failed',
      error: id ? 'El identificador no tiene el formato admitido.' : 'El XML no contiene un identificador utilizable.',
    };
  }
  return {
    key: `drive:${id}`,
    provider: 'google-drive',
    externalId: id,
    sourceName,
    state: 'pending',
  };
}

interface IndexedArt {
  asset: AssetReference;
  name?: string;
  query?: string;
}

function collectArt(sectionValue: unknown, label: 'anverso' | 'reverso', warnings: string[]): Map<number, IndexedArt> {
  const sections = records(sectionValue);
  const cards = sections.flatMap((section) => records(section.card));
  const bySlot = new Map<number, IndexedArt>();
  cards.forEach((card, cardNumber) => {
    const name = text(field(card, 'name'));
    let indices: number[];
    try {
      indices = slotIndices(card, `${label} ${cardNumber + 1}`);
    } catch (error) {
      if (label === 'reverso') {
        warnings.push(error instanceof Error ? error.message : `Reverso ${cardNumber + 1} sin posición válida.`);
        return;
      }
      throw error;
    }
    const asset = assetFrom(field(card, 'id'), name, `${label}:${cardNumber}`);
    if (asset.provider === 'unknown') warnings.push(`${label} ${cardNumber + 1}: ${asset.error} Se puede sustituir con un archivo local.`);
    const entry = { asset, name, query: text(field(card, 'query')) };
    for (const index of indices) {
      const previous = bySlot.get(index);
      if (previous && previous.asset.key !== asset.key) {
        throw new XmlImportError(`Conflicto en la posición ${index}: hay dos artes de ${label} diferentes.`);
      }
      bySlot.set(index, previous ?? entry);
    }
  });
  return bySlot;
}

/** Parse an MPC Fill export without resolving any URL from XML text. */
export function parseMpcFillXml(xml: string): ImportProject {
  if (new TextEncoder().encode(xml).byteLength > MAX_XML_BYTES) {
    throw new XmlImportError(`El XML supera el límite de ${MAX_XML_BYTES / 1024 / 1024} MiB.`);
  }
  if (!xml.trim()) throw new XmlImportError('El archivo XML está vacío.');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new XmlImportError('El XML contiene una declaración DTD o de entidad, que no está permitida.');
  }
  const structuralXml = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g, '');
  const tags = structuralXml.match(/<[^>]+>/g) ?? [];
  if (tags.length > MAX_XML_NODES) throw new XmlImportError(`El XML supera el límite de ${MAX_XML_NODES} elementos.`);
  let depth = 0;
  for (const tag of tags) {
    if (/^<\//.test(tag)) depth -= 1;
    else if (!/^<!/.test(tag) && !/\/\s*>$/.test(tag)) depth += 1;
    if (depth > MAX_XML_DEPTH) throw new XmlImportError(`El XML supera el límite de anidamiento (${MAX_XML_DEPTH}).`);
  }
  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (validation !== true) {
    const detail = typeof validation === 'object' ? validation.err.msg : 'XML mal formado.';
    throw new XmlImportError(`No se pudo leer el XML: ${detail}`);
  }
  let document: Record<string, unknown>;
  try {
    document = parser.parse(xml) as Record<string, unknown>;
  } catch {
    throw new XmlImportError('No se pudo interpretar el XML.');
  }
  const order = records(document.order)[0];
  if (!order) throw new XmlImportError('El documento no contiene el elemento <order>.');

  const warnings: string[] = [];
  const fronts = collectArt(order.fronts, 'anverso', warnings);
  if (!fronts.size) throw new XmlImportError('El XML no contiene anversos con posiciones válidas.');
  const backs = collectArt(order.backs, 'reverso', warnings);
  const commonBackId = text(field(order, 'cardback'));
  const commonBack = commonBackId ? assetFrom(commonBackId, 'Reverso común', 'common-back') : undefined;
  if (commonBack?.provider === 'unknown') warnings.push(`Reverso común: ${commonBack.error} Se puede sustituir con un archivo local.`);

  const assets: Record<string, AssetReference> = {};
  for (const art of [...fronts.values(), ...backs.values()]) assets[art.asset.key] = art.asset;
  if (commonBack) assets[commonBack.key] = commonBack;

  const lastSlot = Math.max(...fronts.keys());
  const cards: CardSlot[] = [];
  for (let slotIndex = 0; slotIndex <= lastSlot; slotIndex += 1) {
    const front = fronts.get(slotIndex);
    const specialBack = backs.get(slotIndex);
    if (!front) warnings.push(`Falta el anverso de la posición ${slotIndex}; se conserva el hueco.`);
    const backKey = front ? (specialBack?.asset.key ?? commonBack?.key ?? null) : null;
    cards.push({
      slotIndex,
      name: front?.name ?? `Hueco ${slotIndex + 1}`,
      query: front?.query,
      frontAssetKey: front?.asset.key ?? null,
      backAssetKey: backKey,
      isDoubleFacedOrCustomBack: !!front && !!specialBack,
    });
  }

  const details = records(order.details)[0];
  const quantityText = text(details ? field(details, 'quantity') : undefined);
  const declaredQuantity = quantityText && /^\d+$/.test(quantityText) ? Number(quantityText) : undefined;
  const physicalSlotCount = lastSlot + 1;
  if (declaredQuantity !== undefined && declaredQuantity !== physicalSlotCount) {
    warnings.push(`El pedido declara ${declaredQuantity} unidades, pero los slots abarcan ${physicalSlotCount} posiciones físicas. Se conserva el orden de slots.`);
  }
  if (!commonBack && backs.size === 0) warnings.push('No se encontró un reverso común ni reversos específicos.');
  return { cards, assets, warnings, declaredQuantity };
}
