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
/* globals warn, Dict, isDict, shadow, isArray, Util, StreamsSequenceStream,
           isStream, NullStream, ObjectLoader, PartialEvaluator, Promise,
           OperatorList, Annotation, error, assert, XRef, isArrayBuffer, Stream,
           isString, isName, info, Linearization, MissingDataException, Lexer,
           Catalog, stringToPDFString, stringToBytes, calculateMD5,
           AnnotationFactory */

'use strict';

const Page = (function PageClosure() {
  const LETTER_SIZE_MEDIABOX = [0, 0, 612, 792];

  function Page(pdfManager, xref, pageIndex, pageDict, ref, fontCache) {
    this.pdfManager = pdfManager;
    this.pageIndex = pageIndex;
    this.pageDict = pageDict;
    this.xref = xref;
    this.ref = ref;
    this.fontCache = fontCache;
    this.idCounters = {
      obj: 0,
    };
    this.resourcesPromise = null;
  }

  Page.prototype = {
    getPageProp: function Page_getPageProp(key) {
      return this.pageDict.get(key);
    },

    getInheritedPageProp: function Page_getInheritedPageProp(key) {
      let dict = this.pageDict; let valueArray = null; let
        loopCount = 0;
      const MAX_LOOP_COUNT = 100;
      // Always walk up the entire parent chain, to be able to find
      // e.g. \Resources placed on multiple levels of the tree.
      while (dict) {
        const value = dict.get(key);
        if (value) {
          if (!valueArray) {
            valueArray = [];
          }
          valueArray.push(value);
        }
        if (++loopCount > MAX_LOOP_COUNT) {
          warn('Page_getInheritedPageProp: maximum loop count exceeded.');
          break;
        }
        dict = dict.get('Parent');
      }
      if (!valueArray) {
        return Dict.empty;
      }
      if (valueArray.length === 1 || !isDict(valueArray[0]) ||
          loopCount > MAX_LOOP_COUNT) {
        return valueArray[0];
      }
      return Dict.merge(this.xref, valueArray);
    },

    get content() {
      return this.getPageProp('Contents');
    },

    get resources() {
      // For robustness: The spec states that a \Resources entry has to be
      // present, but can be empty. Some document omit it still, in this case
      // we return an empty dictionary.
      return shadow(this, 'resources', this.getInheritedPageProp('Resources'));
    },

    get mediaBox() {
      let obj = this.getInheritedPageProp('MediaBox');
      // Reset invalid media box to letter size.
      if (!isArray(obj) || obj.length !== 4) {
        obj = LETTER_SIZE_MEDIABOX;
      }
      return shadow(this, 'mediaBox', obj);
    },

    get view() {
      const mediaBox = this.mediaBox;
      let cropBox = this.getInheritedPageProp('CropBox');
      if (!isArray(cropBox) || cropBox.length !== 4) {
        return shadow(this, 'view', mediaBox);
      }

      // From the spec, 6th ed., p.963:
      // "The crop, bleed, trim, and art boxes should not ordinarily
      // extend beyond the boundaries of the media box. If they do, they are
      // effectively reduced to their intersection with the media box."
      cropBox = Util.intersect(cropBox, mediaBox);
      if (!cropBox) {
        return shadow(this, 'view', mediaBox);
      }
      return shadow(this, 'view', cropBox);
    },

    get rotate() {
      let rotate = this.getInheritedPageProp('Rotate') || 0;
      // Normalize rotation so it's a multiple of 90 and between 0 and 270
      if (rotate % 90 !== 0) {
        rotate = 0;
      } else if (rotate >= 360) {
        rotate %= 360;
      } else if (rotate < 0) {
        // The spec doesn't cover negatives, assume its counterclockwise
        // rotation. The following is the other implementation of modulo.
        rotate = ((rotate % 360) + 360) % 360;
      }
      return shadow(this, 'rotate', rotate);
    },

    getContentStream: function Page_getContentStream() {
      const content = this.content;
      let stream;
      if (isArray(content)) {
        // fetching items
        const xref = this.xref;
        let i; const
          n = content.length;
        const streams = [];
        for (i = 0; i < n; ++i) {
          streams.push(xref.fetchIfRef(content[i]));
        }
        stream = new StreamsSequenceStream(streams);
      } else if (isStream(content)) {
        stream = content;
      } else {
        // replacing non-existent page content with empty one
        stream = new NullStream();
      }
      return stream;
    },

    loadResources: function Page_loadResources(keys) {
      if (!this.resourcesPromise) {
        // TODO: add async getInheritedPageProp and remove this.
        this.resourcesPromise = this.pdfManager.ensure(this, 'resources');
      }
      return this.resourcesPromise.then(() => {
        const objectLoader = new ObjectLoader(this.resources.map,
            keys,
            this.xref);
        return objectLoader.load();
      });
    },

    getOperatorList: function Page_getOperatorList(handler, task, intent) {
      const self = this;

      const pdfManager = this.pdfManager;
      const contentStreamPromise = pdfManager.ensure(this, 'getContentStream',
          []);
      const resourcesPromise = this.loadResources([
        'ExtGState',
        'ColorSpace',
        'Pattern',
        'Shading',
        'XObject',
        'Font',
        // ProcSet
        // Properties
      ]);

      const partialEvaluator = new PartialEvaluator(pdfManager, this.xref,
          handler, this.pageIndex,
          `p${this.pageIndex}_`,
          this.idCounters,
          this.fontCache);

      const dataPromises = Promise.all([contentStreamPromise, resourcesPromise]);
      const pageListPromise = dataPromises.then((data) => {
        const contentStream = data[0];
        const opList = new OperatorList(intent, handler, self.pageIndex);

        handler.send('StartRenderPage', {
          transparency: partialEvaluator.hasBlendModes(self.resources),
          pageIndex: self.pageIndex,
          intent,
        });
        return partialEvaluator.getOperatorList(contentStream, task,
            self.resources, opList).then(() => opList);
      });

      const annotationsPromise = pdfManager.ensure(this, 'annotations');
      return Promise.all([pageListPromise, annotationsPromise]).then(
          (datas) => {
            const pageOpList = datas[0];
            const annotations = datas[1];

            if (annotations.length === 0) {
              pageOpList.flush(true);
              return pageOpList;
            }

            const annotationsReadyPromise = Annotation.appendToOperatorList(
                annotations, pageOpList, pdfManager, partialEvaluator, task, intent);
            return annotationsReadyPromise.then(() => {
              pageOpList.flush(true);
              return pageOpList;
            });
          });
    },

    extractTextContent: function Page_extractTextContent(task) {
      const handler = {
        on: function nullHandlerOn() {},
        send: function nullHandlerSend() {},
      };

      const self = this;

      const pdfManager = this.pdfManager;
      const contentStreamPromise = pdfManager.ensure(this, 'getContentStream',
          []);

      const resourcesPromise = this.loadResources([
        'ExtGState',
        'XObject',
        'Font',
      ]);

      const dataPromises = Promise.all([contentStreamPromise,
        resourcesPromise]);
      return dataPromises.then((data) => {
        const contentStream = data[0];
        const partialEvaluator = new PartialEvaluator(pdfManager, self.xref,
            handler, self.pageIndex,
            `p${self.pageIndex}_`,
            self.idCounters,
            self.fontCache);

        return partialEvaluator.getTextContent(contentStream,
            task,
            self.resources);
      });
    },

    getAnnotationsData: function Page_getAnnotationsData(intent) {
      const annotations = this.annotations;
      const annotationsData = [];
      for (let i = 0, n = annotations.length; i < n; ++i) {
        if (intent) {
          if (!(intent === 'display' && annotations[i].viewable) &&
              !(intent === 'print' && annotations[i].printable)) {
            continue;
          }
        }
        annotationsData.push(annotations[i].data);
      }
      return annotationsData;
    },

    get annotations() {
      const annotations = [];
      const annotationRefs = this.getInheritedPageProp('Annots') || [];
      const annotationFactory = new AnnotationFactory();
      for (let i = 0, n = annotationRefs.length; i < n; ++i) {
        const annotationRef = annotationRefs[i];
        const annotation = annotationFactory.create(this.xref, annotationRef);
        if (annotation) {
          annotations.push(annotation);
        }
      }
      return shadow(this, 'annotations', annotations);
    },
  };

  return Page;
})();

/**
 * The `PDFDocument` holds all the data of the PDF file. Compared to the
 * `PDFDoc`, this one doesn't have any job management code.
 * Right now there exists one PDFDocument on the main thread + one object
 * for each worker. If there is no worker support enabled, there are two
 * `PDFDocument` objects on the main thread created.
 */
const PDFDocument = (function PDFDocumentClosure() {
  const FINGERPRINT_FIRST_BYTES = 1024;
  const EMPTY_FINGERPRINT = '\x00\x00\x00\x00\x00\x00\x00' +
    '\x00\x00\x00\x00\x00\x00\x00\x00\x00';

  function PDFDocument(pdfManager, arg, password) {
    if (isStream(arg)) {
      init.call(this, pdfManager, arg, password);
    } else if (isArrayBuffer(arg)) {
      init.call(this, pdfManager, new Stream(arg), password);
    } else {
      error('PDFDocument: Unknown argument type');
    }
  }

  function init(pdfManager, stream, password) {
    assert(stream.length > 0, 'stream must have data');
    this.pdfManager = pdfManager;
    this.stream = stream;
    const xref = new XRef(this.stream, password, pdfManager);
    this.xref = xref;
  }

  function find(stream, needle, limit, backwards) {
    const pos = stream.pos;
    const end = stream.end;
    const strBuf = [];
    if (pos + limit > end) {
      limit = end - pos;
    }
    for (let n = 0; n < limit; ++n) {
      strBuf.push(String.fromCharCode(stream.getByte()));
    }
    const str = strBuf.join('');
    stream.pos = pos;
    const index = backwards ? str.lastIndexOf(needle) : str.indexOf(needle);
    if (index === -1) {
      return false; /* not found */
    }
    stream.pos += index;
    return true; /* found */
  }

  const DocumentInfoValidators = {
    get entries() {
      // Lazily build this since all the validation functions below are not
      // defined until after this file loads.
      return shadow(this, 'entries', {
        Title: isString,
        Author: isString,
        Subject: isString,
        Keywords: isString,
        Creator: isString,
        Producer: isString,
        CreationDate: isString,
        ModDate: isString,
        Trapped: isName,
      });
    },
  };

  PDFDocument.prototype = {
    parse: function PDFDocument_parse(recoveryMode) {
      this.setup(recoveryMode);
      const version = this.catalog.catDict.get('Version');
      if (isName(version)) {
        this.pdfFormatVersion = version.name;
      }
      try {
        // checking if AcroForm is present
        this.acroForm = this.catalog.catDict.get('AcroForm');
        if (this.acroForm) {
          this.xfa = this.acroForm.get('XFA');
          const fields = this.acroForm.get('Fields');
          if ((!fields || !isArray(fields) || fields.length === 0) &&
              !this.xfa) {
            // no fields and no XFA -- not a form (?)
            this.acroForm = null;
          }
        }
      } catch (ex) {
        info('Something wrong with AcroForm entry');
        this.acroForm = null;
      }
    },

    get linearization() {
      let linearization = null;
      if (this.stream.length) {
        try {
          linearization = Linearization.create(this.stream);
        } catch (err) {
          if (err instanceof MissingDataException) {
            throw err;
          }
          info(err);
        }
      }
      // shadow the prototype getter with a data property
      return shadow(this, 'linearization', linearization);
    },
    get startXRef() {
      const stream = this.stream;
      let startXRef = 0;
      const linearization = this.linearization;
      if (linearization) {
        // Find end of first obj.
        stream.reset();
        if (find(stream, 'endobj', 1024)) {
          startXRef = stream.pos + 6;
        }
      } else {
        // Find startxref by jumping backward from the end of the file.
        const step = 1024;
        let found = false; let
          pos = stream.end;
        while (!found && pos > 0) {
          pos -= step - 'startxref'.length;
          if (pos < 0) {
            pos = 0;
          }
          stream.pos = pos;
          found = find(stream, 'startxref', step, true);
        }
        if (found) {
          stream.skip(9);
          let ch;
          do {
            ch = stream.getByte();
          } while (Lexer.isSpace(ch));
          let str = '';
          while (ch >= 0x20 && ch <= 0x39) { // < '9'
            str += String.fromCharCode(ch);
            ch = stream.getByte();
          }
          startXRef = parseInt(str, 10);
          if (isNaN(startXRef)) {
            startXRef = 0;
          }
        }
      }
      // shadow the prototype getter with a data property
      return shadow(this, 'startXRef', startXRef);
    },
    get mainXRefEntriesOffset() {
      let mainXRefEntriesOffset = 0;
      const linearization = this.linearization;
      if (linearization) {
        mainXRefEntriesOffset = linearization.mainXRefEntriesOffset;
      }
      // shadow the prototype getter with a data property
      return shadow(this, 'mainXRefEntriesOffset', mainXRefEntriesOffset);
    },
    // Find the header, remove leading garbage and setup the stream
    // starting from the header.
    checkHeader: function PDFDocument_checkHeader() {
      const stream = this.stream;
      stream.reset();
      if (find(stream, '%PDF-', 1024)) {
        // Found the header, trim off any garbage before it.
        stream.moveStart();
        // Reading file format version
        const MAX_VERSION_LENGTH = 12;
        let version = ''; let
          ch;
        while ((ch = stream.getByte()) > 0x20) { // SPACE
          if (version.length >= MAX_VERSION_LENGTH) {
            break;
          }
          version += String.fromCharCode(ch);
        }
        if (!this.pdfFormatVersion) {
          // removing "%PDF-"-prefix
          this.pdfFormatVersion = version.substring(5);
        }
        return;
      }
      // May not be a PDF file, continue anyway.
    },
    parseStartXRef: function PDFDocument_parseStartXRef() {
      const startXRef = this.startXRef;
      this.xref.setStartXRef(startXRef);
    },
    setup: function PDFDocument_setup(recoveryMode) {
      this.xref.parse(recoveryMode);
      this.catalog = new Catalog(this.pdfManager, this.xref);
    },
    get numPages() {
      const linearization = this.linearization;
      const num = linearization ? linearization.numPages : this.catalog.numPages;
      // shadow the prototype getter
      return shadow(this, 'numPages', num);
    },
    get documentInfo() {
      const docInfo = {
        PDFFormatVersion: this.pdfFormatVersion,
        IsAcroFormPresent: !!this.acroForm,
        IsXFAPresent: !!this.xfa,
      };
      let infoDict;
      try {
        infoDict = this.xref.trailer.get('Info');
      } catch (err) {
        info('The document information dictionary is invalid.');
      }
      if (infoDict) {
        const validEntries = DocumentInfoValidators.entries;
        // Only fill the document info with valid entries from the spec.
        for (const key in validEntries) {
          if (infoDict.has(key)) {
            const value = infoDict.get(key);
            // Make sure the value conforms to the spec.
            if (validEntries[key](value)) {
              docInfo[key] = (typeof value !== 'string'
                ? value : stringToPDFString(value));
            } else {
              info(`Bad value in document info for "${key}"`);
            }
          }
        }
      }
      return shadow(this, 'documentInfo', docInfo);
    },
    get fingerprint() {
      const xref = this.xref; let hash; let
        fileID = '';
      const idArray = xref.trailer.get('ID');

      if (idArray && isArray(idArray) && idArray[0] && isString(idArray[0]) &&
          idArray[0] !== EMPTY_FINGERPRINT) {
        hash = stringToBytes(idArray[0]);
      } else {
        if (this.stream.ensureRange) {
          this.stream.ensureRange(0,
              Math.min(FINGERPRINT_FIRST_BYTES, this.stream.end));
        }
        hash = calculateMD5(this.stream.bytes.subarray(0,
            FINGERPRINT_FIRST_BYTES), 0, FINGERPRINT_FIRST_BYTES);
      }

      for (let i = 0, n = hash.length; i < n; i++) {
        const hex = hash[i].toString(16);
        fileID += hex.length === 1 ? `0${hex}` : hex;
      }

      return shadow(this, 'fingerprint', fileID);
    },

    getPage: function PDFDocument_getPage(pageIndex) {
      return this.catalog.getPage(pageIndex);
    },

    cleanup: function PDFDocument_cleanup() {
      return this.catalog.cleanup();
    },
  };

  return PDFDocument;
})();
