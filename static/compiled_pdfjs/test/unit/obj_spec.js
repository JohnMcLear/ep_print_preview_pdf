/* globals expect, it, describe, beforeEach, Name, Dict, Ref, RefSet, Cmd,
           jasmine */

'use strict';

describe('obj', () => {
  describe('Name', () => {
    it('should retain the given name', () => {
      const givenName = 'Font';
      const name = Name.get(givenName);
      expect(name.name).toEqual(givenName);
    });
  });

  describe('Cmd', () => {
    it('should retain the given cmd name', () => {
      const givenCmd = 'BT';
      const cmd = new Cmd(givenCmd);
      expect(cmd.cmd).toEqual(givenCmd);
    });

    it('should create only one object for a command and cache it', () => {
      const firstBT = Cmd.get('BT');
      const secondBT = Cmd.get('BT');
      const firstET = Cmd.get('ET');
      const secondET = Cmd.get('ET');
      expect(firstBT).toBe(secondBT);
      expect(firstET).toBe(secondET);
      expect(firstBT).not.toBe(firstET);
    });
  });

  describe('Dict', () => {
    const checkInvalidHasValues = function (dict) {
      expect(dict.has()).toBeFalsy();
      expect(dict.has('Prev')).toBeFalsy();
    };

    const checkInvalidKeyValues = function (dict) {
      expect(dict.get()).toBeUndefined();
      expect(dict.get('Prev')).toBeUndefined();
      expect(dict.get('Decode', 'D')).toBeUndefined();

      // Note that the getter with three arguments breaks the pattern here.
      expect(dict.get('FontFile', 'FontFile2', 'FontFile3')).toBeNull();
    };

    let emptyDict, dictWithSizeKey, dictWithManyKeys;
    const storedSize = 42;
    const testFontFile = 'file1';
    const testFontFile2 = 'file2';
    const testFontFile3 = 'file3';

    beforeEach(() => {
      emptyDict = new Dict();

      dictWithSizeKey = new Dict();
      dictWithSizeKey.set('Size', storedSize);

      dictWithManyKeys = new Dict();
      dictWithManyKeys.set('FontFile', testFontFile);
      dictWithManyKeys.set('FontFile2', testFontFile2);
      dictWithManyKeys.set('FontFile3', testFontFile3);
    });

    it('should return invalid values for unknown keys', () => {
      checkInvalidHasValues(emptyDict);
      checkInvalidKeyValues(emptyDict);
    });

    it('should return correct value for stored Size key', () => {
      expect(dictWithSizeKey.has('Size')).toBeTruthy();

      expect(dictWithSizeKey.get('Size')).toEqual(storedSize);
      expect(dictWithSizeKey.get('Prev', 'Size')).toEqual(storedSize);
      expect(dictWithSizeKey.get('Prev', 'Root', 'Size')).toEqual(storedSize);
    });

    it('should return invalid values for unknown keys when Size key is stored',
        () => {
          checkInvalidHasValues(dictWithSizeKey);
          checkInvalidKeyValues(dictWithSizeKey);
        });

    it('should return correct value for stored Size key with undefined value',
        () => {
          const dict = new Dict();
          dict.set('Size');

          expect(dict.has('Size')).toBeTruthy();

          checkInvalidKeyValues(dict);
        });

    it('should return correct values for multiple stored keys', () => {
      expect(dictWithManyKeys.has('FontFile')).toBeTruthy();
      expect(dictWithManyKeys.has('FontFile2')).toBeTruthy();
      expect(dictWithManyKeys.has('FontFile3')).toBeTruthy();

      expect(dictWithManyKeys.get('FontFile3')).toEqual(testFontFile3);
      expect(dictWithManyKeys.get('FontFile2', 'FontFile3'))
          .toEqual(testFontFile2);
      expect(dictWithManyKeys.get('FontFile', 'FontFile2', 'FontFile3'))
          .toEqual(testFontFile);
    });

    it('should callback for each stored key', () => {
      const callbackSpy = jasmine.createSpy('spy on callback in dictionary');

      dictWithManyKeys.forEach(callbackSpy);

      expect(callbackSpy).wasCalled();
      expect(callbackSpy.argsForCall[0]).toEqual(['FontFile', testFontFile]);
      expect(callbackSpy.argsForCall[1]).toEqual(['FontFile2', testFontFile2]);
      expect(callbackSpy.argsForCall[2]).toEqual(['FontFile3', testFontFile3]);
      expect(callbackSpy.callCount).toEqual(3);
    });
  });

  describe('Ref', () => {
    it('should retain the stored values', () => {
      const storedNum = 4;
      const storedGen = 2;
      const ref = new Ref(storedNum, storedGen);
      expect(ref.num).toEqual(storedNum);
      expect(ref.gen).toEqual(storedGen);
    });
  });

  describe('RefSet', () => {
    it('should have a stored value', () => {
      const ref = new Ref(4, 2);
      const refset = new RefSet();
      refset.put(ref);
      expect(refset.has(ref)).toBeTruthy();
    });
    it('should not have an unknown value', () => {
      const ref = new Ref(4, 2);
      const refset = new RefSet();
      expect(refset.has(ref)).toBeFalsy();

      refset.put(ref);
      const anotherRef = new Ref(2, 4);
      expect(refset.has(anotherRef)).toBeFalsy();
    });
  });
});
