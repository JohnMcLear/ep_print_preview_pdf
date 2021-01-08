/* globals expect, it, describe, beforeEach, Stream, PredictorStream, Dict */

'use strict';

describe('stream', () => {
  beforeEach(function () {
    this.addMatchers({
      toMatchTypedArray(expected) {
        const actual = this.actual;
        if (actual.length !== expected.length) {
          return false;
        }
        for (let i = 0, ii = expected.length; i < ii; i++) {
          const a = actual[i]; const
            b = expected[i];
          if (a !== b) {
            return false;
          }
        }
        return true;
      },
    });
  });
  describe('PredictorStream', () => {
    it('should decode simple predictor data', () => {
      const dict = new Dict();
      dict.set('Predictor', 12);
      dict.set('Colors', 1);
      dict.set('BitsPerComponent', 8);
      dict.set('Columns', 2);

      const input = new Stream(new Uint8Array([2, 100, 3, 2, 1, 255, 2, 1, 255]),
          0, 9, dict);
      const predictor = new PredictorStream(input, /* length = */ 9, dict);
      const result = predictor.getBytes(6);

      expect(result).toMatchTypedArray(
          new Uint8Array([100, 3, 101, 2, 102, 1])
      );
    });
  });
});
