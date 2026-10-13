import { describe, expect, it } from 'vitest';
import { parseMpcFillXml, XmlImportError } from '../src/xml.js';

const sample = (fronts: string, extras = '') => `<order><details><quantity>3</quantity></details><fronts>${fronts}</fronts>${extras}</order>`;

describe('parseMpcFillXml', () => {
  it('parses one physical card and a common back', () => {
    const project = parseMpcFillXml(sample('<card><id>DRIVE_FILE_ID_AA</id><slot>0</slot><name>Una carta.png</name></card>', '<cardback>DRIVE_FILE_BACK1</cardback>'));
    expect(project.cards).toHaveLength(1);
    expect(project.cards[0]).toMatchObject({ slotIndex: 0, name: 'Una carta.png', frontAssetKey: 'drive:DRIVE_FILE_ID_AA', backAssetKey: 'drive:DRIVE_FILE_BACK1' });
    expect(project.warnings).toContain('El pedido declara 3 unidades, pero los slots abarcan 1 posiciones físicas. Se conserva el orden de slots.');
  });

  it('expands grouped slots, retains gaps and sorts by physical slot', () => {
    const xml = sample('<card><id>DRIVE_FILE_AAAAA</id><slots>0, 2, 5</slots><name>A.png</name><query>carta a</query></card><card><id>DRIVE_FILE_BBBBB</id><slots>1,3,4</slots><name>B.png</name></card>');
    const project = parseMpcFillXml(xml);
    expect(project.cards.map((card) => card.slotIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(project.cards.map((card) => card.name)).toEqual(['A.png', 'B.png', 'A.png', 'B.png', 'B.png', 'A.png']);
    expect(project.cards[0]?.query).toBe('carta a');
    expect(project.cards).toHaveLength(6);
  });

  it('warns about a missing physical slot without compacting later cards', () => {
    const project = parseMpcFillXml(sample('<card><id>DRIVE_FILE_AAAAA</id><slots>0,2</slots><name>A.png</name></card>', '<cardback>DRIVE_FILE_COMMON1</cardback>'));
    expect(project.cards.map((card) => card.slotIndex)).toEqual([0, 1, 2]);
    expect(project.cards[1]?.frontAssetKey).toBeNull();
    expect(project.cards[1]?.backAssetKey).toBeNull();
    expect(project.warnings).toContain('Falta el anverso de la posición 1; se conserva el hueco.');
  });

  it('keeps distinct art with duplicate file names separate', () => {
    const project = parseMpcFillXml(sample('<card><id>DRIVE_FILE_AAAAA</id><slot>0</slot><name>same.png</name></card><card><id>DRIVE_FILE_BBBBB</id><slot>1</slot><name>same.png</name></card>'));
    expect(project.cards[0]?.frontAssetKey).not.toBe(project.cards[1]?.frontAssetKey);
  });

  it('associates specific backs by slot and does not infer them from names', () => {
    const project = parseMpcFillXml(sample(
      '<card><id>DRIVE_FILE_AAAAA</id><slots>0,1</slots><name>Back.png</name></card>',
      '<backs><card><id>DRIVE_FILE_CCCCC</id><slot>1</slot><name>Personal reverse</name></card></backs><cardback>DRIVE_FILE_COMMON1</cardback>',
    ));
    expect(project.cards[0]?.backAssetKey).toBe('drive:DRIVE_FILE_COMMON1');
    expect(project.cards[1]?.backAssetKey).toBe('drive:DRIVE_FILE_CCCCC');
    expect(project.cards[1]?.isDoubleFacedOrCustomBack).toBe(true);
  });

  it('accepts singular slot, whitespace and out-of-order records', () => {
    const project = parseMpcFillXml(sample('<card><id>DRIVE_FILE_BBBBB</id><slot> 2 </slot><name>Third</name></card><card><id>DRIVE_FILE_AAAAA</id><slots>0, 1</slots><name>First</name></card>'));
    expect(project.cards.map((card) => card.slotIndex)).toEqual([0, 1, 2]);
  });

  it('accepts IDs and slot fields stored as XML attributes', () => {
    const project = parseMpcFillXml('<order><fronts><card id="DRIVE_FILE_ATTR1" slot="0" name="Attribute.png" query="sample" /></fronts><cardback>DRIVE_FILE_BACK01</cardback></order>');
    expect(project.cards[0]).toMatchObject({ name: 'Attribute.png', query: 'sample', frontAssetKey: 'drive:DRIVE_FILE_ATTR1' });
  });

  it('rejects conflicting artwork for the same slot', () => {
    expect(() => parseMpcFillXml(sample('<card><id>DRIVE_FILE_AAAAA</id><slot>1</slot></card><card><id>DRIVE_FILE_BBBBB</id><slot>1</slot></card>'))).toThrow(/Conflicto en la posición 1/);
  });

  it('rejects DTDs and malformed XML', () => {
    const entity = '<!DOCTYPE order [<!ENTITY x SYSTEM "file:///etc/passwd">]><order><fronts><card><id>&x;</id><slot>0</slot></card></fronts></order>';
    expect(() => parseMpcFillXml(entity)).toThrow(XmlImportError);
    expect(() => parseMpcFillXml('<order><fronts>')).toThrow(/No se pudo leer el XML/);
  });

  it('permits an art reference to be replaced when its ID is missing', () => {
    const project = parseMpcFillXml(sample('<card><slot>0</slot><name>Missing ID</name></card>'));
    const key = project.cards[0]?.frontAssetKey;
    expect(key).toBe('manual:anverso:0');
    expect(project.assets[key!]?.state).toBe('failed');
  });
});
