/* globals expect, it, describe, combineUrl, Dict, isDict, Name, PDFJS,
           stringToPDFString, isExternalLinkTargetSet, LinkTarget */

'use strict';

describe('util', () => {
  describe('combineUrl', () => {
    it('absolute url with protocol stays as is', () => {
      const baseUrl = 'http://server/index.html';
      const url = 'http://server2/test2.html';
      const result = combineUrl(baseUrl, url);
      const expected = 'http://server2/test2.html';
      expect(result).toEqual(expected);
    });

    it('absolute url without protocol uses prefix from base', () => {
      const baseUrl = 'http://server/index.html';
      const url = '/test2.html';
      const result = combineUrl(baseUrl, url);
      const expected = 'http://server/test2.html';
      expect(result).toEqual(expected);
    });

    it('combines relative url with base', () => {
      const baseUrl = 'http://server/index.html';
      const url = 'test2.html';
      const result = combineUrl(baseUrl, url);
      const expected = 'http://server/test2.html';
      expect(result).toEqual(expected);
    });

    it('combines relative url (w/hash) with base', () => {
      const baseUrl = 'http://server/index.html#!/test';
      const url = 'test2.html';
      const result = combineUrl(baseUrl, url);
      const expected = 'http://server/test2.html';
      expect(result).toEqual(expected);
    });

    it('combines relative url (w/query) with base', () => {
      const baseUrl = 'http://server/index.html?search=/test';
      const url = 'test2.html';
      const result = combineUrl(baseUrl, url);
      const expected = 'http://server/test2.html';
      expect(result).toEqual(expected);
    });

    it('returns base url when url is empty', () => {
      const baseUrl = 'http://server/index.html';
      const url = '';
      const result = combineUrl(baseUrl, url);
      const expected = 'http://server/index.html';
      expect(result).toEqual(expected);
    });

    it('returns base url when url is undefined', () => {
      const baseUrl = 'http://server/index.html';
      let url;
      const result = combineUrl(baseUrl, url);
      const expected = 'http://server/index.html';
      expect(result).toEqual(expected);
    });
  });

  describe('isDict', () => {
    it('handles empty dictionaries with type check', () => {
      const dict = new Dict();
      expect(isDict(dict, 'Page')).toEqual(false);
    });

    it('handles dictionaries with type check', () => {
      const dict = new Dict();
      dict.set('Type', Name.get('Page'));
      expect(isDict(dict, 'Page')).toEqual(true);
    });
  });

  describe('stringToPDFString', () => {
    it('handles ISO Latin 1 strings', () => {
      const str = '\x8Dstring\x8E';
      expect(stringToPDFString(str)).toEqual('\u201Cstring\u201D');
    });

    it('handles UTF-16BE strings', () => {
      const str = '\xFE\xFF\x00\x73\x00\x74\x00\x72\x00\x69\x00\x6E\x00\x67';
      expect(stringToPDFString(str)).toEqual('string');
    });

    it('handles empty strings', () => {
      // ISO Latin 1
      const str1 = '';
      expect(stringToPDFString(str1)).toEqual('');

      // UTF-16BE
      const str2 = '\xFE\xFF';
      expect(stringToPDFString(str2)).toEqual('');
    });
  });

  describe('isExternalLinkTargetSet', () => {
    // Save the current state, to avoid interfering with other tests.
    const previousExternalLinkTarget = PDFJS.externalLinkTarget;

    it('handles the predefined LinkTargets', () => {
      for (const key in LinkTarget) {
        const linkTarget = LinkTarget[key];
        PDFJS.externalLinkTarget = linkTarget;

        expect(isExternalLinkTargetSet()).toEqual(!!linkTarget);
      }
    });

    it('handles incorrect LinkTargets', () => {
      const targets = [true, '', false, -1, '_blank', null];

      for (let i = 0, ii = targets.length; i < ii; i++) {
        const linkTarget = targets[i];
        PDFJS.externalLinkTarget = linkTarget;

        expect(isExternalLinkTargetSet()).toEqual(false);
      }
    });

    // Reset the state.
    PDFJS.externalLinkTarget = previousExternalLinkTarget;
  });
});
