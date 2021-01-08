/* globals expect, it, describe, StringStream, CMapFactory, Name, CMap,
           IdentityCMap */

'use strict';

const cMapUrl = '../../external/bcmaps/';
const cMapPacked = true;

describe('cmap', () => {
  it('parses beginbfchar', () => {
    const str = '2 beginbfchar\n' +
              '<03> <00>\n' +
              '<04> <01>\n' +
              'endbfchar\n';
    const stream = new StringStream(str);
    const cmap = CMapFactory.create(stream);
    expect(cmap.lookup(0x03)).toEqual(String.fromCharCode(0x00));
    expect(cmap.lookup(0x04)).toEqual(String.fromCharCode(0x01));
    expect(cmap.lookup(0x05)).toBeUndefined();
  });
  it('parses beginbfrange with range', () => {
    const str = '1 beginbfrange\n' +
              '<06> <0B> 0\n' +
              'endbfrange\n';
    const stream = new StringStream(str);
    const cmap = CMapFactory.create(stream);
    expect(cmap.lookup(0x05)).toBeUndefined();
    expect(cmap.lookup(0x06)).toEqual(String.fromCharCode(0x00));
    expect(cmap.lookup(0x0B)).toEqual(String.fromCharCode(0x05));
    expect(cmap.lookup(0x0C)).toBeUndefined();
  });
  it('parses beginbfrange with array', () => {
    const str = '1 beginbfrange\n' +
              '<0D> <12> [ 0 1 2 3 4 5 ]\n' +
              'endbfrange\n';
    const stream = new StringStream(str);
    const cmap = CMapFactory.create(stream);
    expect(cmap.lookup(0x0C)).toBeUndefined();
    expect(cmap.lookup(0x0D)).toEqual(0x00);
    expect(cmap.lookup(0x12)).toEqual(0x05);
    expect(cmap.lookup(0x13)).toBeUndefined();
  });
  it('parses begincidchar', () => {
    const str = '1 begincidchar\n' +
              '<14> 0\n' +
              'endcidchar\n';
    const stream = new StringStream(str);
    const cmap = CMapFactory.create(stream);
    expect(cmap.lookup(0x14)).toEqual(0x00);
    expect(cmap.lookup(0x15)).toBeUndefined();
  });
  it('parses begincidrange', () => {
    const str = '1 begincidrange\n' +
              '<0016> <001B>   0\n' +
              'endcidrange\n';
    const stream = new StringStream(str);
    const cmap = CMapFactory.create(stream);
    expect(cmap.lookup(0x15)).toBeUndefined();
    expect(cmap.lookup(0x16)).toEqual(0x00);
    expect(cmap.lookup(0x1B)).toEqual(0x05);
    expect(cmap.lookup(0x1C)).toBeUndefined();
  });
  it('decodes codespace ranges', () => {
    const str = '1 begincodespacerange\n' +
              '<01> <02>\n' +
              '<00000003> <00000004>\n' +
              'endcodespacerange\n';
    const stream = new StringStream(str);
    const cmap = CMapFactory.create(stream);
    const c = {};
    cmap.readCharCode(String.fromCharCode(1), 0, c);
    expect(c.charcode).toEqual(1);
    expect(c.length).toEqual(1);
    cmap.readCharCode(String.fromCharCode(0, 0, 0, 3), 0, c);
    expect(c.charcode).toEqual(3);
    expect(c.length).toEqual(4);
  });
  it('decodes 4 byte codespace ranges', () => {
    const str = '1 begincodespacerange\n' +
              '<8EA1A1A1> <8EA1FEFE>\n' +
              'endcodespacerange\n';
    const stream = new StringStream(str);
    const cmap = CMapFactory.create(stream);
    const c = {};
    cmap.readCharCode(String.fromCharCode(0x8E, 0xA1, 0xA1, 0xA1), 0, c);
    expect(c.charcode).toEqual(0x8EA1A1A1);
    expect(c.length).toEqual(4);
  });
  it('read usecmap', () => {
    const str = '/Adobe-Japan1-1 usecmap\n';
    const stream = new StringStream(str);
    const cmap = CMapFactory.create(stream,
        {url: cMapUrl, packed: cMapPacked}, null);
    expect(cmap instanceof CMap).toEqual(true);
    expect(cmap.useCMap).not.toBeNull();
    expect(cmap.builtInCMap).toBeFalsy();
    expect(cmap.length).toEqual(0x20A7);
    expect(cmap.isIdentityCMap).toEqual(false);
  });
  it('parses cmapname', () => {
    const str = '/CMapName /Identity-H def\n';
    const stream = new StringStream(str);
    const cmap = CMapFactory.create(stream);
    expect(cmap.name).toEqual('Identity-H');
  });
  it('parses wmode', () => {
    const str = '/WMode 1 def\n';
    const stream = new StringStream(str);
    const cmap = CMapFactory.create(stream);
    expect(cmap.vertical).toEqual(true);
  });
  it('loads built in cmap', () => {
    const cmap = CMapFactory.create(new Name('Adobe-Japan1-1'),
        {url: cMapUrl, packed: cMapPacked}, null);
    expect(cmap instanceof CMap).toEqual(true);
    expect(cmap.useCMap).toBeNull();
    expect(cmap.builtInCMap).toBeTruthy();
    expect(cmap.length).toEqual(0x20A7);
    expect(cmap.isIdentityCMap).toEqual(false);
  });
  it('loads built in identity cmap', () => {
    const cmap = CMapFactory.create(new Name('Identity-H'),
        {url: cMapUrl, packed: cMapPacked}, null);
    expect(cmap instanceof IdentityCMap).toEqual(true);
    expect(cmap.vertical).toEqual(false);
    expect(cmap.length).toEqual(0x10000);
    expect(() => cmap.isIdentityCMap).toThrow(
        new Error('should not access .isIdentityCMap'));
  });
});
