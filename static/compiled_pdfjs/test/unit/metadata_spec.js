/* globals expect, it, describe, Metadata */

'use strict';

describe('metadata', () => {
  describe('incorrect_xmp', () => {
    it('should fix the incorrect XMP data', () => {
      const invalidXMP = '<x:xmpmeta xmlns:x=\'adobe:ns:meta/\'>' +
        '<rdf:RDF xmlns:rdf=\'http://www.w3.org/1999/02/22-rdf-syntax-ns#\'>' +
        '<rdf:Description xmlns:dc=\'http://purl.org/dc/elements/1.1/\'>' +
        '<dc:title>\\376\\377\\000P\\000D\\000F\\000&</dc:title>' +
        '</rdf:Description></rdf:RDF></x:xmpmeta>';
      const meta = new Metadata(invalidXMP);
      expect(meta.get('dc:title')).toEqual('PDF&');
    });
  });
});
