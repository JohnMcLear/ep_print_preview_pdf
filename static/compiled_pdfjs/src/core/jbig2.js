/* Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* globals ArithmeticDecoder, error, log2, readInt8, readUint16, readUint32,
           shadow */

'use strict';

const Jbig2Image = (function Jbig2ImageClosure() {
  // Utility data structures
  function ContextCache() {}

  ContextCache.prototype = {
    getContexts(id) {
      if (id in this) {
        return this[id];
      }
      return (this[id] = new Int8Array(1 << 16));
    },
  };

  function DecodingContext(data, start, end) {
    this.data = data;
    this.start = start;
    this.end = end;
  }

  DecodingContext.prototype = {
    get decoder() {
      const decoder = new ArithmeticDecoder(this.data, this.start, this.end);
      return shadow(this, 'decoder', decoder);
    },
    get contextCache() {
      const cache = new ContextCache();
      return shadow(this, 'contextCache', cache);
    },
  };

  // Annex A. Arithmetic Integer Decoding Procedure
  // A.2 Procedure for decoding values
  function decodeInteger(contextCache, procedure, decoder) {
    const contexts = contextCache.getContexts(procedure);
    let prev = 1;

    function readBits(length) {
      let v = 0;
      for (let i = 0; i < length; i++) {
        const bit = decoder.readBit(contexts, prev);
        prev = (prev < 256 ? (prev << 1) | bit
          : (((prev << 1) | bit) & 511) | 256);
        v = (v << 1) | bit;
      }
      return v >>> 0;
    }

    const sign = readBits(1);
    const value = readBits(1)
      ? (readBits(1)
          ? (readBits(1)
              ? (readBits(1)
                  ? (readBits(1)
                      ? (readBits(32) + 4436)
                      : readBits(12) + 340)
                  : readBits(8) + 84)
              : readBits(6) + 20)
          : readBits(4) + 4)
      : readBits(2);
    return (sign === 0 ? value : (value > 0 ? -value : null));
  }

  // A.3 The IAID decoding procedure
  function decodeIAID(contextCache, decoder, codeLength) {
    const contexts = contextCache.getContexts('IAID');

    let prev = 1;
    for (let i = 0; i < codeLength; i++) {
      const bit = decoder.readBit(contexts, prev);
      prev = (prev << 1) | bit;
    }
    if (codeLength < 31) {
      return prev & ((1 << codeLength) - 1);
    }
    return prev & 0x7FFFFFFF;
  }

  // 7.3 Segment types
  const SegmentTypes = [
    'SymbolDictionary',
    null,
    null,
    null,
    'IntermediateTextRegion',
    null,
    'ImmediateTextRegion',
    'ImmediateLosslessTextRegion',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    'patternDictionary',
    null,
    null,
    null,
    'IntermediateHalftoneRegion',
    null,
    'ImmediateHalftoneRegion',
    'ImmediateLosslessHalftoneRegion',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    'IntermediateGenericRegion',
    null,
    'ImmediateGenericRegion',
    'ImmediateLosslessGenericRegion',
    'IntermediateGenericRefinementRegion',
    null,
    'ImmediateGenericRefinementRegion',
    'ImmediateLosslessGenericRefinementRegion',
    null,
    null,
    null,
    null,
    'PageInformation',
    'EndOfPage',
    'EndOfStripe',
    'EndOfFile',
    'Profiles',
    'Tables',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    'Extension',
  ];

  const CodingTemplates = [
    [{x: -1, y: -2},
      {x: 0, y: -2},
      {x: 1, y: -2},
      {x: -2, y: -1},
      {x: -1, y: -1},
      {x: 0, y: -1},
      {x: 1, y: -1},
      {x: 2, y: -1},
      {x: -4, y: 0},
      {x: -3, y: 0},
      {x: -2, y: 0},
      {x: -1, y: 0}],
    [{x: -1, y: -2},
      {x: 0, y: -2},
      {x: 1, y: -2},
      {x: 2, y: -2},
      {x: -2, y: -1},
      {x: -1, y: -1},
      {x: 0, y: -1},
      {x: 1, y: -1},
      {x: 2, y: -1},
      {x: -3, y: 0},
      {x: -2, y: 0},
      {x: -1, y: 0}],
    [{x: -1, y: -2},
      {x: 0, y: -2},
      {x: 1, y: -2},
      {x: -2, y: -1},
      {x: -1, y: -1},
      {x: 0, y: -1},
      {x: 1, y: -1},
      {x: -2, y: 0},
      {x: -1, y: 0}],
    [{x: -3, y: -1},
      {x: -2, y: -1},
      {x: -1, y: -1},
      {x: 0, y: -1},
      {x: 1, y: -1},
      {x: -4, y: 0},
      {x: -3, y: 0},
      {x: -2, y: 0},
      {x: -1, y: 0}],
  ];

  const RefinementTemplates = [
    {
      coding: [{x: 0, y: -1}, {x: 1, y: -1}, {x: -1, y: 0}],
      reference: [{x: 0, y: -1},
        {x: 1, y: -1},
        {x: -1, y: 0},
        {x: 0, y: 0},
        {x: 1, y: 0},
        {x: -1, y: 1},
        {x: 0, y: 1},
        {x: 1, y: 1}],
    },
    {
      coding: [{x: -1, y: -1}, {x: 0, y: -1}, {x: 1, y: -1}, {x: -1, y: 0}],
      reference: [{x: 0, y: -1},
        {x: -1, y: 0},
        {x: 0, y: 0},
        {x: 1, y: 0},
        {x: 0, y: 1},
        {x: 1, y: 1}],
    },
  ];

  // See 6.2.5.7 Decoding the bitmap.
  const ReusedContexts = [
    0x9B25, // 10011 0110010 0101
    0x0795, // 0011 110010 101
    0x00E5, // 001 11001 01
    0x0195, // 011001 0101
  ];

  const RefinementReusedContexts = [
    0x0020, // '000' + '0' (coding) + '00010000' + '0' (reference)
    0x0008, // '0000' + '001000'
  ];

  function decodeBitmapTemplate0(width, height, decodingContext) {
    const decoder = decodingContext.decoder;
    const contexts = decodingContext.contextCache.getContexts('GB');
    let contextLabel; let i; let j; let pixel; let row; let row1; let row2; const
      bitmap = [];

    // ...ooooo....
    // ..ooooooo... Context template for current pixel (X)
    // .ooooX...... (concatenate values of 'o'-pixels to get contextLabel)
    const OLD_PIXEL_MASK = 0x7BF7; // 01111 0111111 0111

    for (i = 0; i < height; i++) {
      row = bitmap[i] = new Uint8Array(width);
      row1 = (i < 1) ? row : bitmap[i - 1];
      row2 = (i < 2) ? row : bitmap[i - 2];

      // At the beginning of each row:
      // Fill contextLabel with pixels that are above/right of (X)
      contextLabel = (row2[0] << 13) | (row2[1] << 12) | (row2[2] << 11) |
                     (row1[0] << 7) | (row1[1] << 6) | (row1[2] << 5) |
                     (row1[3] << 4);

      for (j = 0; j < width; j++) {
        row[j] = pixel = decoder.readBit(contexts, contextLabel);

        // At each pixel: Clear contextLabel pixels that are shifted
        // out of the context, then add new ones.
        contextLabel = ((contextLabel & OLD_PIXEL_MASK) << 1) |
                       (j + 3 < width ? row2[j + 3] << 11 : 0) |
                       (j + 4 < width ? row1[j + 4] << 4 : 0) | pixel;
      }
    }

    return bitmap;
  }

  // 6.2 Generic Region Decoding Procedure
  function decodeBitmap(mmr, width, height, templateIndex, prediction, skip, at,
      decodingContext) {
    if (mmr) {
      error('JBIG2 error: MMR encoding is not supported');
    }

    // Use optimized version for the most common case
    if (templateIndex === 0 && !skip && !prediction && at.length === 4 &&
        at[0].x === 3 && at[0].y === -1 && at[1].x === -3 && at[1].y === -1 &&
        at[2].x === 2 && at[2].y === -2 && at[3].x === -2 && at[3].y === -2) {
      return decodeBitmapTemplate0(width, height, decodingContext);
    }

    const useskip = !!skip;
    const template = CodingTemplates[templateIndex].concat(at);

    // Sorting is non-standard, and it is not required. But sorting increases
    // the number of template bits that can be reused from the previous
    // contextLabel in the main loop.
    template.sort((a, b) => (a.y - b.y) || (a.x - b.x));

    const templateLength = template.length;
    const templateX = new Int8Array(templateLength);
    const templateY = new Int8Array(templateLength);
    const changingTemplateEntries = [];
    let reuseMask = 0; let minX = 0; let maxX = 0; let
      minY = 0;
    let c, k;

    for (k = 0; k < templateLength; k++) {
      templateX[k] = template[k].x;
      templateY[k] = template[k].y;
      minX = Math.min(minX, template[k].x);
      maxX = Math.max(maxX, template[k].x);
      minY = Math.min(minY, template[k].y);
      // Check if the template pixel appears in two consecutive context labels,
      // so it can be reused. Otherwise, we add it to the list of changing
      // template entries.
      if (k < templateLength - 1 &&
          template[k].y === template[k + 1].y &&
          template[k].x === template[k + 1].x - 1) {
        reuseMask |= 1 << (templateLength - 1 - k);
      } else {
        changingTemplateEntries.push(k);
      }
    }
    const changingEntriesLength = changingTemplateEntries.length;

    const changingTemplateX = new Int8Array(changingEntriesLength);
    const changingTemplateY = new Int8Array(changingEntriesLength);
    const changingTemplateBit = new Uint16Array(changingEntriesLength);
    for (c = 0; c < changingEntriesLength; c++) {
      k = changingTemplateEntries[c];
      changingTemplateX[c] = template[k].x;
      changingTemplateY[c] = template[k].y;
      changingTemplateBit[c] = 1 << (templateLength - 1 - k);
    }

    // Get the safe bounding box edges from the width, height, minX, maxX, minY
    const sbb_left = -minX;
    const sbb_top = -minY;
    const sbb_right = width - maxX;

    const pseudoPixelContext = ReusedContexts[templateIndex];
    let row = new Uint8Array(width);
    const bitmap = [];

    const decoder = decodingContext.decoder;
    const contexts = decodingContext.contextCache.getContexts('GB');

    let ltp = 0; let j; let i0; let j0; let contextLabel = 0; let bit; let shift;
    for (let i = 0; i < height; i++) {
      if (prediction) {
        const sltp = decoder.readBit(contexts, pseudoPixelContext);
        ltp ^= sltp;
        if (ltp) {
          bitmap.push(row); // duplicate previous row
          continue;
        }
      }
      row = new Uint8Array(row);
      bitmap.push(row);
      for (j = 0; j < width; j++) {
        if (useskip && skip[i][j]) {
          row[j] = 0;
          continue;
        }
        // Are we in the middle of a scanline, so we can reuse contextLabel
        // bits?
        if (j >= sbb_left && j < sbb_right && i >= sbb_top) {
          // If yes, we can just shift the bits that are reusable and only
          // fetch the remaining ones.
          contextLabel = (contextLabel << 1) & reuseMask;
          for (k = 0; k < changingEntriesLength; k++) {
            i0 = i + changingTemplateY[k];
            j0 = j + changingTemplateX[k];
            bit = bitmap[i0][j0];
            if (bit) {
              bit = changingTemplateBit[k];
              contextLabel |= bit;
            }
          }
        } else {
          // compute the contextLabel from scratch
          contextLabel = 0;
          shift = templateLength - 1;
          for (k = 0; k < templateLength; k++, shift--) {
            j0 = j + templateX[k];
            if (j0 >= 0 && j0 < width) {
              i0 = i + templateY[k];
              if (i0 >= 0) {
                bit = bitmap[i0][j0];
                if (bit) {
                  contextLabel |= bit << shift;
                }
              }
            }
          }
        }
        const pixel = decoder.readBit(contexts, contextLabel);
        row[j] = pixel;
      }
    }
    return bitmap;
  }

  // 6.3.2 Generic Refinement Region Decoding Procedure
  function decodeRefinement(width, height, templateIndex, referenceBitmap,
      offsetX, offsetY, prediction, at,
      decodingContext) {
    let codingTemplate = RefinementTemplates[templateIndex].coding;
    if (templateIndex === 0) {
      codingTemplate = codingTemplate.concat([at[0]]);
    }
    const codingTemplateLength = codingTemplate.length;
    const codingTemplateX = new Int32Array(codingTemplateLength);
    const codingTemplateY = new Int32Array(codingTemplateLength);
    let k;
    for (k = 0; k < codingTemplateLength; k++) {
      codingTemplateX[k] = codingTemplate[k].x;
      codingTemplateY[k] = codingTemplate[k].y;
    }

    let referenceTemplate = RefinementTemplates[templateIndex].reference;
    if (templateIndex === 0) {
      referenceTemplate = referenceTemplate.concat([at[1]]);
    }
    const referenceTemplateLength = referenceTemplate.length;
    const referenceTemplateX = new Int32Array(referenceTemplateLength);
    const referenceTemplateY = new Int32Array(referenceTemplateLength);
    for (k = 0; k < referenceTemplateLength; k++) {
      referenceTemplateX[k] = referenceTemplate[k].x;
      referenceTemplateY[k] = referenceTemplate[k].y;
    }
    const referenceWidth = referenceBitmap[0].length;
    const referenceHeight = referenceBitmap.length;

    const pseudoPixelContext = RefinementReusedContexts[templateIndex];
    const bitmap = [];

    const decoder = decodingContext.decoder;
    const contexts = decodingContext.contextCache.getContexts('GR');

    let ltp = 0;
    for (let i = 0; i < height; i++) {
      if (prediction) {
        const sltp = decoder.readBit(contexts, pseudoPixelContext);
        ltp ^= sltp;
        if (ltp) {
          error('JBIG2 error: prediction is not supported');
        }
      }
      const row = new Uint8Array(width);
      bitmap.push(row);
      for (let j = 0; j < width; j++) {
        var i0, j0;
        let contextLabel = 0;
        for (k = 0; k < codingTemplateLength; k++) {
          i0 = i + codingTemplateY[k];
          j0 = j + codingTemplateX[k];
          if (i0 < 0 || j0 < 0 || j0 >= width) {
            contextLabel <<= 1; // out of bound pixel
          } else {
            contextLabel = (contextLabel << 1) | bitmap[i0][j0];
          }
        }
        for (k = 0; k < referenceTemplateLength; k++) {
          i0 = i + referenceTemplateY[k] + offsetY;
          j0 = j + referenceTemplateX[k] + offsetX;
          if (i0 < 0 || i0 >= referenceHeight || j0 < 0 ||
              j0 >= referenceWidth) {
            contextLabel <<= 1; // out of bound pixel
          } else {
            contextLabel = (contextLabel << 1) | referenceBitmap[i0][j0];
          }
        }
        const pixel = decoder.readBit(contexts, contextLabel);
        row[j] = pixel;
      }
    }

    return bitmap;
  }

  // 6.5.5 Decoding the symbol dictionary
  function decodeSymbolDictionary(huffman, refinement, symbols,
      numberOfNewSymbols, numberOfExportedSymbols,
      huffmanTables, templateIndex, at,
      refinementTemplateIndex, refinementAt,
      decodingContext) {
    if (huffman) {
      error('JBIG2 error: huffman is not supported');
    }

    const newSymbols = [];
    let currentHeight = 0;
    const symbolCodeLength = log2(symbols.length + numberOfNewSymbols);

    const decoder = decodingContext.decoder;
    const contextCache = decodingContext.contextCache;

    while (newSymbols.length < numberOfNewSymbols) {
      const deltaHeight = decodeInteger(contextCache, 'IADH', decoder); // 6.5.6
      currentHeight += deltaHeight;
      let currentWidth = 0;
      let totalWidth = 0;
      while (true) {
        const deltaWidth = decodeInteger(contextCache, 'IADW', decoder); // 6.5.7
        if (deltaWidth === null) {
          break; // OOB
        }
        currentWidth += deltaWidth;
        totalWidth += currentWidth;
        var bitmap;
        if (refinement) {
          // 6.5.8.2 Refinement/aggregate-coded symbol bitmap
          const numberOfInstances = decodeInteger(contextCache, 'IAAI', decoder);
          if (numberOfInstances > 1) {
            bitmap = decodeTextRegion(huffman, refinement,
                currentWidth, currentHeight, 0,
                numberOfInstances, 1, // strip size
                symbols.concat(newSymbols),
                symbolCodeLength,
                0, // transposed
                0, // ds offset
                1, // top left 7.4.3.1.1
                0, // OR operator
                huffmanTables,
                refinementTemplateIndex, refinementAt,
                decodingContext);
          } else {
            const symbolId = decodeIAID(contextCache, decoder, symbolCodeLength);
            const rdx = decodeInteger(contextCache, 'IARDX', decoder); // 6.4.11.3
            const rdy = decodeInteger(contextCache, 'IARDY', decoder); // 6.4.11.4
            const symbol = (symbolId < symbols.length ? symbols[symbolId]
              : newSymbols[symbolId - symbols.length]);
            bitmap = decodeRefinement(currentWidth, currentHeight,
                refinementTemplateIndex, symbol, rdx, rdy, false, refinementAt,
                decodingContext);
          }
        } else {
          // 6.5.8.1 Direct-coded symbol bitmap
          bitmap = decodeBitmap(false, currentWidth, currentHeight,
              templateIndex, false, null, at, decodingContext);
        }
        newSymbols.push(bitmap);
      }
    }
    // 6.5.10 Exported symbols
    const exportedSymbols = [];
    const flags = []; let
      currentFlag = false;
    const totalSymbolsLength = symbols.length + numberOfNewSymbols;
    while (flags.length < totalSymbolsLength) {
      let runLength = decodeInteger(contextCache, 'IAEX', decoder);
      while (runLength--) {
        flags.push(currentFlag);
      }
      currentFlag = !currentFlag;
    }
    for (var i = 0, ii = symbols.length; i < ii; i++) {
      if (flags[i]) {
        exportedSymbols.push(symbols[i]);
      }
    }
    for (let j = 0; j < numberOfNewSymbols; i++, j++) {
      if (flags[i]) {
        exportedSymbols.push(newSymbols[j]);
      }
    }
    return exportedSymbols;
  }

  function decodeTextRegion(huffman, refinement, width, height,
      defaultPixelValue, numberOfSymbolInstances,
      stripSize, inputSymbols, symbolCodeLength,
      transposed, dsOffset, referenceCorner,
      combinationOperator, huffmanTables,
      refinementTemplateIndex, refinementAt,
      decodingContext) {
    if (huffman) {
      error('JBIG2 error: huffman is not supported');
    }

    // Prepare bitmap
    const bitmap = [];
    let i, row;
    for (i = 0; i < height; i++) {
      row = new Uint8Array(width);
      if (defaultPixelValue) {
        for (let j = 0; j < width; j++) {
          row[j] = defaultPixelValue;
        }
      }
      bitmap.push(row);
    }

    const decoder = decodingContext.decoder;
    const contextCache = decodingContext.contextCache;
    let stripT = -decodeInteger(contextCache, 'IADT', decoder); // 6.4.6
    let firstS = 0;
    i = 0;
    while (i < numberOfSymbolInstances) {
      const deltaT = decodeInteger(contextCache, 'IADT', decoder); // 6.4.6
      stripT += deltaT;

      const deltaFirstS = decodeInteger(contextCache, 'IAFS', decoder); // 6.4.7
      firstS += deltaFirstS;
      let currentS = firstS;
      do {
        const currentT = (stripSize === 1 ? 0
          : decodeInteger(contextCache, 'IAIT', decoder)); // 6.4.9
        const t = stripSize * stripT + currentT;
        const symbolId = decodeIAID(contextCache, decoder, symbolCodeLength);
        const applyRefinement = (refinement &&
                               decodeInteger(contextCache, 'IARI', decoder));
        let symbolBitmap = inputSymbols[symbolId];
        let symbolWidth = symbolBitmap[0].length;
        let symbolHeight = symbolBitmap.length;
        if (applyRefinement) {
          const rdw = decodeInteger(contextCache, 'IARDW', decoder); // 6.4.11.1
          const rdh = decodeInteger(contextCache, 'IARDH', decoder); // 6.4.11.2
          const rdx = decodeInteger(contextCache, 'IARDX', decoder); // 6.4.11.3
          const rdy = decodeInteger(contextCache, 'IARDY', decoder); // 6.4.11.4
          symbolWidth += rdw;
          symbolHeight += rdh;
          symbolBitmap = decodeRefinement(symbolWidth, symbolHeight,
              refinementTemplateIndex, symbolBitmap, (rdw >> 1) + rdx,
              (rdh >> 1) + rdy, false, refinementAt,
              decodingContext);
        }
        const offsetT = t - ((referenceCorner & 1) ? 0 : symbolHeight);
        const offsetS = currentS - ((referenceCorner & 2) ? symbolWidth : 0);
        var s2, t2, symbolRow;
        if (transposed) {
          // Place Symbol Bitmap from T1,S1
          for (s2 = 0; s2 < symbolHeight; s2++) {
            row = bitmap[offsetS + s2];
            if (!row) {
              continue;
            }
            symbolRow = symbolBitmap[s2];
            // To ignore Parts of Symbol bitmap which goes
            // outside bitmap region
            const maxWidth = Math.min(width - offsetT, symbolWidth);
            switch (combinationOperator) {
              case 0: // OR
                for (t2 = 0; t2 < maxWidth; t2++) {
                  row[offsetT + t2] |= symbolRow[t2];
                }
                break;
              case 2: // XOR
                for (t2 = 0; t2 < maxWidth; t2++) {
                  row[offsetT + t2] ^= symbolRow[t2];
                }
                break;
              default:
                error(`JBIG2 error: operator ${combinationOperator
                } is not supported`);
            }
          }
          currentS += symbolHeight - 1;
        } else {
          for (t2 = 0; t2 < symbolHeight; t2++) {
            row = bitmap[offsetT + t2];
            if (!row) {
              continue;
            }
            symbolRow = symbolBitmap[t2];
            switch (combinationOperator) {
              case 0: // OR
                for (s2 = 0; s2 < symbolWidth; s2++) {
                  row[offsetS + s2] |= symbolRow[s2];
                }
                break;
              case 2: // XOR
                for (s2 = 0; s2 < symbolWidth; s2++) {
                  row[offsetS + s2] ^= symbolRow[s2];
                }
                break;
              default:
                error(`JBIG2 error: operator ${combinationOperator
                } is not supported`);
            }
          }
          currentS += symbolWidth - 1;
        }
        i++;
        const deltaS = decodeInteger(contextCache, 'IADS', decoder); // 6.4.8
        if (deltaS === null) {
          break; // OOB
        }
        currentS += deltaS + dsOffset;
      } while (true);
    }
    return bitmap;
  }

  function readSegmentHeader(data, start) {
    const segmentHeader = {};
    segmentHeader.number = readUint32(data, start);
    const flags = data[start + 4];
    const segmentType = flags & 0x3F;
    if (!SegmentTypes[segmentType]) {
      error(`JBIG2 error: invalid segment type: ${segmentType}`);
    }
    segmentHeader.type = segmentType;
    segmentHeader.typeName = SegmentTypes[segmentType];
    segmentHeader.deferredNonRetain = !!(flags & 0x80);

    const pageAssociationFieldSize = !!(flags & 0x40);
    const referredFlags = data[start + 5];
    let referredToCount = (referredFlags >> 5) & 7;
    const retainBits = [referredFlags & 31];
    let position = start + 6;
    if (referredFlags === 7) {
      referredToCount = readUint32(data, position - 1) & 0x1FFFFFFF;
      position += 3;
      let bytes = (referredToCount + 7) >> 3;
      retainBits[0] = data[position++];
      while (--bytes > 0) {
        retainBits.push(data[position++]);
      }
    } else if (referredFlags === 5 || referredFlags === 6) {
      error('JBIG2 error: invalid referred-to flags');
    }

    segmentHeader.retainBits = retainBits;
    const referredToSegmentNumberSize = (segmentHeader.number <= 256 ? 1
      : (segmentHeader.number <= 65536 ? 2 : 4));
    const referredTo = [];
    let i, ii;
    for (i = 0; i < referredToCount; i++) {
      const number = (referredToSegmentNumberSize === 1 ? data[position]
        : (referredToSegmentNumberSize === 2 ? readUint16(data, position)
          : readUint32(data, position)));
      referredTo.push(number);
      position += referredToSegmentNumberSize;
    }
    segmentHeader.referredTo = referredTo;
    if (!pageAssociationFieldSize) {
      segmentHeader.pageAssociation = data[position++];
    } else {
      segmentHeader.pageAssociation = readUint32(data, position);
      position += 4;
    }
    segmentHeader.length = readUint32(data, position);
    position += 4;

    if (segmentHeader.length === 0xFFFFFFFF) {
      // 7.2.7 Segment data length, unknown segment length
      if (segmentType === 38) { // ImmediateGenericRegion
        const genericRegionInfo = readRegionSegmentInformation(data, position);
        const genericRegionSegmentFlags = data[position +
          RegionSegmentInformationFieldLength];
        const genericRegionMmr = !!(genericRegionSegmentFlags & 1);
        // searching for the segment end
        const searchPatternLength = 6;
        const searchPattern = new Uint8Array(searchPatternLength);
        if (!genericRegionMmr) {
          searchPattern[0] = 0xFF;
          searchPattern[1] = 0xAC;
        }
        searchPattern[2] = (genericRegionInfo.height >>> 24) & 0xFF;
        searchPattern[3] = (genericRegionInfo.height >> 16) & 0xFF;
        searchPattern[4] = (genericRegionInfo.height >> 8) & 0xFF;
        searchPattern[5] = genericRegionInfo.height & 0xFF;
        for (i = position, ii = data.length; i < ii; i++) {
          let j = 0;
          while (j < searchPatternLength && searchPattern[j] === data[i + j]) {
            j++;
          }
          if (j === searchPatternLength) {
            segmentHeader.length = i + searchPatternLength;
            break;
          }
        }
        if (segmentHeader.length === 0xFFFFFFFF) {
          error('JBIG2 error: segment end was not found');
        }
      } else {
        error('JBIG2 error: invalid unknown segment length');
      }
    }
    segmentHeader.headerEnd = position;
    return segmentHeader;
  }

  function readSegments(header, data, start, end) {
    const segments = [];
    let position = start;
    while (position < end) {
      const segmentHeader = readSegmentHeader(data, position);
      position = segmentHeader.headerEnd;
      const segment = {
        header: segmentHeader,
        data,
      };
      if (!header.randomAccess) {
        segment.start = position;
        position += segmentHeader.length;
        segment.end = position;
      }
      segments.push(segment);
      if (segmentHeader.type === 51) {
        break; // end of file is found
      }
    }
    if (header.randomAccess) {
      for (let i = 0, ii = segments.length; i < ii; i++) {
        segments[i].start = position;
        position += segments[i].header.length;
        segments[i].end = position;
      }
    }
    return segments;
  }

  // 7.4.1 Region segment information field
  function readRegionSegmentInformation(data, start) {
    return {
      width: readUint32(data, start),
      height: readUint32(data, start + 4),
      x: readUint32(data, start + 8),
      y: readUint32(data, start + 12),
      combinationOperator: data[start + 16] & 7,
    };
  }
  var RegionSegmentInformationFieldLength = 17;

  function processSegment(segment, visitor) {
    const header = segment.header;

    const data = segment.data; let position = segment.start; const
      end = segment.end;
    let args, at, i, atLength;
    switch (header.type) {
      case 0: // SymbolDictionary
        // 7.4.2 Symbol dictionary segment syntax
        var dictionary = {};
        var dictionaryFlags = readUint16(data, position); // 7.4.2.1.1
        dictionary.huffman = !!(dictionaryFlags & 1);
        dictionary.refinement = !!(dictionaryFlags & 2);
        dictionary.huffmanDHSelector = (dictionaryFlags >> 2) & 3;
        dictionary.huffmanDWSelector = (dictionaryFlags >> 4) & 3;
        dictionary.bitmapSizeSelector = (dictionaryFlags >> 6) & 1;
        dictionary.aggregationInstancesSelector = (dictionaryFlags >> 7) & 1;
        dictionary.bitmapCodingContextUsed = !!(dictionaryFlags & 256);
        dictionary.bitmapCodingContextRetained = !!(dictionaryFlags & 512);
        dictionary.template = (dictionaryFlags >> 10) & 3;
        dictionary.refinementTemplate = (dictionaryFlags >> 12) & 1;
        position += 2;
        if (!dictionary.huffman) {
          atLength = dictionary.template === 0 ? 4 : 1;
          at = [];
          for (i = 0; i < atLength; i++) {
            at.push({
              x: readInt8(data, position),
              y: readInt8(data, position + 1),
            });
            position += 2;
          }
          dictionary.at = at;
        }
        if (dictionary.refinement && !dictionary.refinementTemplate) {
          at = [];
          for (i = 0; i < 2; i++) {
            at.push({
              x: readInt8(data, position),
              y: readInt8(data, position + 1),
            });
            position += 2;
          }
          dictionary.refinementAt = at;
        }
        dictionary.numberOfExportedSymbols = readUint32(data, position);
        position += 4;
        dictionary.numberOfNewSymbols = readUint32(data, position);
        position += 4;
        args = [dictionary,
          header.number,
          header.referredTo,
          data,
          position,
          end];
        break;
      case 6: // ImmediateTextRegion
      case 7: // ImmediateLosslessTextRegion
        var textRegion = {};
        textRegion.info = readRegionSegmentInformation(data, position);
        position += RegionSegmentInformationFieldLength;
        var textRegionSegmentFlags = readUint16(data, position);
        position += 2;
        textRegion.huffman = !!(textRegionSegmentFlags & 1);
        textRegion.refinement = !!(textRegionSegmentFlags & 2);
        textRegion.stripSize = 1 << ((textRegionSegmentFlags >> 2) & 3);
        textRegion.referenceCorner = (textRegionSegmentFlags >> 4) & 3;
        textRegion.transposed = !!(textRegionSegmentFlags & 64);
        textRegion.combinationOperator = (textRegionSegmentFlags >> 7) & 3;
        textRegion.defaultPixelValue = (textRegionSegmentFlags >> 9) & 1;
        textRegion.dsOffset = (textRegionSegmentFlags << 17) >> 27;
        textRegion.refinementTemplate = (textRegionSegmentFlags >> 15) & 1;
        if (textRegion.huffman) {
          const textRegionHuffmanFlags = readUint16(data, position);
          position += 2;
          textRegion.huffmanFS = (textRegionHuffmanFlags) & 3;
          textRegion.huffmanDS = (textRegionHuffmanFlags >> 2) & 3;
          textRegion.huffmanDT = (textRegionHuffmanFlags >> 4) & 3;
          textRegion.huffmanRefinementDW = (textRegionHuffmanFlags >> 6) & 3;
          textRegion.huffmanRefinementDH = (textRegionHuffmanFlags >> 8) & 3;
          textRegion.huffmanRefinementDX = (textRegionHuffmanFlags >> 10) & 3;
          textRegion.huffmanRefinementDY = (textRegionHuffmanFlags >> 12) & 3;
          textRegion.huffmanRefinementSizeSelector =
            !!(textRegionHuffmanFlags & 14);
        }
        if (textRegion.refinement && !textRegion.refinementTemplate) {
          at = [];
          for (i = 0; i < 2; i++) {
            at.push({
              x: readInt8(data, position),
              y: readInt8(data, position + 1),
            });
            position += 2;
          }
          textRegion.refinementAt = at;
        }
        textRegion.numberOfSymbolInstances = readUint32(data, position);
        position += 4;
        // TODO 7.4.3.1.7 Symbol ID Huffman table decoding
        if (textRegion.huffman) {
          error('JBIG2 error: huffman is not supported');
        }
        args = [textRegion, header.referredTo, data, position, end];
        break;
      case 38: // ImmediateGenericRegion
      case 39: // ImmediateLosslessGenericRegion
        var genericRegion = {};
        genericRegion.info = readRegionSegmentInformation(data, position);
        position += RegionSegmentInformationFieldLength;
        var genericRegionSegmentFlags = data[position++];
        genericRegion.mmr = !!(genericRegionSegmentFlags & 1);
        genericRegion.template = (genericRegionSegmentFlags >> 1) & 3;
        genericRegion.prediction = !!(genericRegionSegmentFlags & 8);
        if (!genericRegion.mmr) {
          atLength = genericRegion.template === 0 ? 4 : 1;
          at = [];
          for (i = 0; i < atLength; i++) {
            at.push({
              x: readInt8(data, position),
              y: readInt8(data, position + 1),
            });
            position += 2;
          }
          genericRegion.at = at;
        }
        args = [genericRegion, data, position, end];
        break;
      case 48: // PageInformation
        var pageInfo = {
          width: readUint32(data, position),
          height: readUint32(data, position + 4),
          resolutionX: readUint32(data, position + 8),
          resolutionY: readUint32(data, position + 12),
        };
        if (pageInfo.height === 0xFFFFFFFF) {
          delete pageInfo.height;
        }
        var pageSegmentFlags = data[position + 16];
        var pageStripingInformatiom = readUint16(data, position + 17);
        pageInfo.lossless = !!(pageSegmentFlags & 1);
        pageInfo.refinement = !!(pageSegmentFlags & 2);
        pageInfo.defaultPixelValue = (pageSegmentFlags >> 2) & 1;
        pageInfo.combinationOperator = (pageSegmentFlags >> 3) & 3;
        pageInfo.requiresBuffer = !!(pageSegmentFlags & 32);
        pageInfo.combinationOperatorOverride = !!(pageSegmentFlags & 64);
        args = [pageInfo];
        break;
      case 49: // EndOfPage
        break;
      case 50: // EndOfStripe
        break;
      case 51: // EndOfFile
        break;
      case 62: // 7.4.15 defines 2 extension types which
        // are comments and can be ignored.
        break;
      default:
        error(`JBIG2 error: segment type ${header.typeName}(${
          header.type}) is not implemented`);
    }
    const callbackName = `on${header.typeName}`;
    if (callbackName in visitor) {
      visitor[callbackName].apply(visitor, args);
    }
  }

  function processSegments(segments, visitor) {
    for (let i = 0, ii = segments.length; i < ii; i++) {
      processSegment(segments[i], visitor);
    }
  }

  function parseJbig2(data, start, end) {
    let position = start;
    if (data[position] !== 0x97 || data[position + 1] !== 0x4A ||
        data[position + 2] !== 0x42 || data[position + 3] !== 0x32 ||
        data[position + 4] !== 0x0D || data[position + 5] !== 0x0A ||
        data[position + 6] !== 0x1A || data[position + 7] !== 0x0A) {
      error('JBIG2 error: invalid header');
    }
    const header = {};
    position += 8;
    const flags = data[position++];
    header.randomAccess = !(flags & 1);
    if (!(flags & 2)) {
      header.numberOfPages = readUint32(data, position);
      position += 4;
    }
    const segments = readSegments(header, data, position, end);
    error('Not implemented');
    // processSegments(segments, new SimpleSegmentVisitor());
  }

  function parseJbig2Chunks(chunks) {
    const visitor = new SimpleSegmentVisitor();
    for (let i = 0, ii = chunks.length; i < ii; i++) {
      const chunk = chunks[i];
      const segments = readSegments({}, chunk.data, chunk.start, chunk.end);
      processSegments(segments, visitor);
    }
    return visitor.buffer;
  }

  function SimpleSegmentVisitor() {}

  SimpleSegmentVisitor.prototype = {
    onPageInformation: function SimpleSegmentVisitor_onPageInformation(info) {
      this.currentPageInfo = info;
      const rowSize = (info.width + 7) >> 3;
      const buffer = new Uint8Array(rowSize * info.height);
      // The contents of ArrayBuffers are initialized to 0.
      // Fill the buffer with 0xFF only if info.defaultPixelValue is set
      if (info.defaultPixelValue) {
        for (let i = 0, ii = buffer.length; i < ii; i++) {
          buffer[i] = 0xFF;
        }
      }
      this.buffer = buffer;
    },
    drawBitmap: function SimpleSegmentVisitor_drawBitmap(regionInfo, bitmap) {
      const pageInfo = this.currentPageInfo;
      const width = regionInfo.width; const
        height = regionInfo.height;
      const rowSize = (pageInfo.width + 7) >> 3;
      const combinationOperator = pageInfo.combinationOperatorOverride
        ? regionInfo.combinationOperator : pageInfo.combinationOperator;
      const buffer = this.buffer;
      const mask0 = 128 >> (regionInfo.x & 7);
      let offset0 = regionInfo.y * rowSize + (regionInfo.x >> 3);
      let i, j, mask, offset;
      switch (combinationOperator) {
        case 0: // OR
          for (i = 0; i < height; i++) {
            mask = mask0;
            offset = offset0;
            for (j = 0; j < width; j++) {
              if (bitmap[i][j]) {
                buffer[offset] |= mask;
              }
              mask >>= 1;
              if (!mask) {
                mask = 128;
                offset++;
              }
            }
            offset0 += rowSize;
          }
          break;
        case 2: // XOR
          for (i = 0; i < height; i++) {
            mask = mask0;
            offset = offset0;
            for (j = 0; j < width; j++) {
              if (bitmap[i][j]) {
                buffer[offset] ^= mask;
              }
              mask >>= 1;
              if (!mask) {
                mask = 128;
                offset++;
              }
            }
            offset0 += rowSize;
          }
          break;
        default:
          error(`JBIG2 error: operator ${combinationOperator
          } is not supported`);
      }
    },
    onImmediateGenericRegion:
      function SimpleSegmentVisitor_onImmediateGenericRegion(region, data,
          start, end) {
        const regionInfo = region.info;
        const decodingContext = new DecodingContext(data, start, end);
        const bitmap = decodeBitmap(region.mmr, regionInfo.width, regionInfo.height,
            region.template, region.prediction, null,
            region.at, decodingContext);
        this.drawBitmap(regionInfo, bitmap);
      },
    onImmediateLosslessGenericRegion:
      function SimpleSegmentVisitor_onImmediateLosslessGenericRegion() {
        this.onImmediateGenericRegion.apply(this, arguments);
      },
    onSymbolDictionary:
      function SimpleSegmentVisitor_onSymbolDictionary(dictionary,
          currentSegment,
          referredSegments,
          data, start, end) {
        let huffmanTables;
        if (dictionary.huffman) {
          error('JBIG2 error: huffman is not supported');
        }

        // Combines exported symbols from all referred segments
        let symbols = this.symbols;
        if (!symbols) {
          this.symbols = symbols = {};
        }

        let inputSymbols = [];
        for (let i = 0, ii = referredSegments.length; i < ii; i++) {
          inputSymbols = inputSymbols.concat(symbols[referredSegments[i]]);
        }

        const decodingContext = new DecodingContext(data, start, end);
        symbols[currentSegment] = decodeSymbolDictionary(dictionary.huffman,
            dictionary.refinement, inputSymbols, dictionary.numberOfNewSymbols,
            dictionary.numberOfExportedSymbols, huffmanTables,
            dictionary.template, dictionary.at,
            dictionary.refinementTemplate, dictionary.refinementAt,
            decodingContext);
      },
    onImmediateTextRegion:
      function SimpleSegmentVisitor_onImmediateTextRegion(region,
          referredSegments,
          data, start, end) {
        const regionInfo = region.info;
        let huffmanTables;

        // Combines exported symbols from all referred segments
        const symbols = this.symbols;
        let inputSymbols = [];
        for (let i = 0, ii = referredSegments.length; i < ii; i++) {
          inputSymbols = inputSymbols.concat(symbols[referredSegments[i]]);
        }
        const symbolCodeLength = log2(inputSymbols.length);

        const decodingContext = new DecodingContext(data, start, end);
        const bitmap = decodeTextRegion(region.huffman, region.refinement,
            regionInfo.width, regionInfo.height, region.defaultPixelValue,
            region.numberOfSymbolInstances, region.stripSize, inputSymbols,
            symbolCodeLength, region.transposed, region.dsOffset,
            region.referenceCorner, region.combinationOperator, huffmanTables,
            region.refinementTemplate, region.refinementAt, decodingContext);
        this.drawBitmap(regionInfo, bitmap);
      },
    onImmediateLosslessTextRegion:
      function SimpleSegmentVisitor_onImmediateLosslessTextRegion() {
        this.onImmediateTextRegion.apply(this, arguments);
      },
  };

  function Jbig2Image() {}

  Jbig2Image.prototype = {
    parseChunks: function Jbig2Image_parseChunks(chunks) {
      return parseJbig2Chunks(chunks);
    },
  };

  return Jbig2Image;
})();
