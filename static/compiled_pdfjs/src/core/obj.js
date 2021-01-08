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
/* globals assert, bytesToString, CipherTransformFactory, error, info,
           InvalidPDFException, isArray, isCmd, isDict, isInt, isName, isRef,
           isStream, Lexer, Page, Parser, Promise, shadow,
           stringToPDFString, stringToUTF8String, warn, isString,
           Promise, MissingDataException, XRefParseException, Stream,
           ChunkedStream, createPromiseCapability */

'use strict';

const Name = (function NameClosure() {
  function Name(name) {
    this.name = name;
  }

  Name.prototype = {};

  const nameCache = {};

  Name.get = function Name_get(name) {
    const nameValue = nameCache[name];
    return (nameValue ? nameValue : (nameCache[name] = new Name(name)));
  };

  return Name;
})();

const Cmd = (function CmdClosure() {
  function Cmd(cmd) {
    this.cmd = cmd;
  }

  Cmd.prototype = {};

  const cmdCache = {};

  Cmd.get = function Cmd_get(cmd) {
    const cmdValue = cmdCache[cmd];
    return (cmdValue ? cmdValue : (cmdCache[cmd] = new Cmd(cmd)));
  };

  return Cmd;
})();

const Dict = (function DictClosure() {
  var nonSerializable = function nonSerializableClosure() {
    return nonSerializable; // creating closure on some variable
  };

  const GETALL_DICTIONARY_TYPES_WHITELIST = {
    Background: true,
    ExtGState: true,
    Halftone: true,
    Layout: true,
    Mask: true,
    Pagination: true,
    Printing: true,
  };

  function isRecursionAllowedFor(dict) {
    if (!isName(dict.Type)) {
      return true;
    }
    const dictType = dict.Type.name;
    return GETALL_DICTIONARY_TYPES_WHITELIST[dictType] === true;
  }

  // xref is optional
  function Dict(xref) {
    // Map should only be used internally, use functions below to access.
    this.map = Object.create(null);
    this.xref = xref;
    this.objId = null;
    this.__nonSerializable__ = nonSerializable; // disable cloning of the Dict
  }

  Dict.prototype = {
    assignXref: function Dict_assignXref(newXref) {
      this.xref = newXref;
    },

    // automatically dereferences Ref objects
    get: function Dict_get(key1, key2, key3) {
      let value;
      const xref = this.xref;
      if (typeof (value = this.map[key1]) !== 'undefined' || key1 in this.map ||
          typeof key2 === 'undefined') {
        return xref ? xref.fetchIfRef(value) : value;
      }
      if (typeof (value = this.map[key2]) !== 'undefined' || key2 in this.map ||
          typeof key3 === 'undefined') {
        return xref ? xref.fetchIfRef(value) : value;
      }
      value = this.map[key3] || null;
      return xref ? xref.fetchIfRef(value) : value;
    },

    // Same as get(), but returns a promise and uses fetchIfRefAsync().
    getAsync: function Dict_getAsync(key1, key2, key3) {
      let value;
      const xref = this.xref;
      if (typeof (value = this.map[key1]) !== 'undefined' || key1 in this.map ||
          typeof key2 === 'undefined') {
        if (xref) {
          return xref.fetchIfRefAsync(value);
        }
        return Promise.resolve(value);
      }
      if (typeof (value = this.map[key2]) !== 'undefined' || key2 in this.map ||
          typeof key3 === 'undefined') {
        if (xref) {
          return xref.fetchIfRefAsync(value);
        }
        return Promise.resolve(value);
      }
      value = this.map[key3] || null;
      if (xref) {
        return xref.fetchIfRefAsync(value);
      }
      return Promise.resolve(value);
    },

    // Same as get(), but dereferences all elements if the result is an Array.
    getArray: function Dict_getArray(key1, key2, key3) {
      let value = this.get(key1, key2, key3);
      const xref = this.xref;
      if (!isArray(value) || !xref) {
        return value;
      }
      value = value.slice(); // Ensure that we don't modify the Dict data.
      for (let i = 0, ii = value.length; i < ii; i++) {
        if (!isRef(value[i])) {
          continue;
        }
        value[i] = xref.fetch(value[i]);
      }
      return value;
    },

    // no dereferencing
    getRaw: function Dict_getRaw(key) {
      return this.map[key];
    },

    // creates new map and dereferences all Refs
    getAll: function Dict_getAll() {
      const all = Object.create(null);
      let queue = null;
      let key, obj;
      for (key in this.map) {
        obj = this.get(key);
        if (obj instanceof Dict) {
          if (isRecursionAllowedFor(obj)) {
            (queue || (queue = [])).push({target: all, key, obj});
          } else {
            all[key] = this.getRaw(key);
          }
        } else {
          all[key] = obj;
        }
      }
      if (!queue) {
        return all;
      }

      // trying to take cyclic references into the account
      const processed = Object.create(null);
      while (queue.length > 0) {
        const item = queue.shift();
        const itemObj = item.obj;
        const objId = itemObj.objId;
        if (objId && objId in processed) {
          item.target[item.key] = processed[objId];
          continue;
        }
        const dereferenced = Object.create(null);
        for (key in itemObj.map) {
          obj = itemObj.get(key);
          if (obj instanceof Dict) {
            if (isRecursionAllowedFor(obj)) {
              queue.push({target: dereferenced, key, obj});
            } else {
              dereferenced[key] = itemObj.getRaw(key);
            }
          } else {
            dereferenced[key] = obj;
          }
        }
        if (objId) {
          processed[objId] = dereferenced;
        }
        item.target[item.key] = dereferenced;
      }
      return all;
    },

    getKeys: function Dict_getKeys() {
      return Object.keys(this.map);
    },

    set: function Dict_set(key, value) {
      this.map[key] = value;
    },

    has: function Dict_has(key) {
      return key in this.map;
    },

    forEach: function Dict_forEach(callback) {
      for (const key in this.map) {
        callback(key, this.get(key));
      }
    },
  };

  Dict.empty = new Dict(null);

  Dict.merge = function Dict_merge(xref, dictArray) {
    const mergedDict = new Dict(xref);

    for (let i = 0, ii = dictArray.length; i < ii; i++) {
      const dict = dictArray[i];
      if (!isDict(dict)) {
        continue;
      }
      for (const keyName in dict.map) {
        if (mergedDict.map[keyName]) {
          continue;
        }
        mergedDict.map[keyName] = dict.map[keyName];
      }
    }
    return mergedDict;
  };

  return Dict;
})();

const Ref = (function RefClosure() {
  function Ref(num, gen) {
    this.num = num;
    this.gen = gen;
  }

  Ref.prototype = {
    toString: function Ref_toString() {
      // This function is hot, so we make the string as compact as possible.
      // |this.gen| is almost always zero, so we treat that case specially.
      let str = `${this.num}R`;
      if (this.gen !== 0) {
        str += this.gen;
      }
      return str;
    },
  };

  return Ref;
})();

// The reference is identified by number and generation.
// This structure stores only one instance of the reference.
const RefSet = (function RefSetClosure() {
  function RefSet() {
    this.dict = {};
  }

  RefSet.prototype = {
    has: function RefSet_has(ref) {
      return ref.toString() in this.dict;
    },

    put: function RefSet_put(ref) {
      this.dict[ref.toString()] = true;
    },

    remove: function RefSet_remove(ref) {
      delete this.dict[ref.toString()];
    },
  };

  return RefSet;
})();

const RefSetCache = (function RefSetCacheClosure() {
  function RefSetCache() {
    this.dict = Object.create(null);
  }

  RefSetCache.prototype = {
    get: function RefSetCache_get(ref) {
      return this.dict[ref.toString()];
    },

    has: function RefSetCache_has(ref) {
      return ref.toString() in this.dict;
    },

    put: function RefSetCache_put(ref, obj) {
      this.dict[ref.toString()] = obj;
    },

    putAlias: function RefSetCache_putAlias(ref, aliasRef) {
      this.dict[ref.toString()] = this.get(aliasRef);
    },

    forEach: function RefSetCache_forEach(fn, thisArg) {
      for (const i in this.dict) {
        fn.call(thisArg, this.dict[i]);
      }
    },

    clear: function RefSetCache_clear() {
      this.dict = Object.create(null);
    },
  };

  return RefSetCache;
})();

const Catalog = (function CatalogClosure() {
  function Catalog(pdfManager, xref) {
    this.pdfManager = pdfManager;
    this.xref = xref;
    this.catDict = xref.getCatalogObj();
    this.fontCache = new RefSetCache();
    assert(isDict(this.catDict),
        'catalog object is not a dictionary');

    this.pagePromises = [];
  }

  Catalog.prototype = {
    get metadata() {
      const streamRef = this.catDict.getRaw('Metadata');
      if (!isRef(streamRef)) {
        return shadow(this, 'metadata', null);
      }

      const encryptMetadata = (!this.xref.encrypt ? false
        : this.xref.encrypt.encryptMetadata);

      const stream = this.xref.fetch(streamRef, !encryptMetadata);
      let metadata;
      if (stream && isDict(stream.dict)) {
        const type = stream.dict.get('Type');
        const subtype = stream.dict.get('Subtype');

        if (isName(type) && isName(subtype) &&
            type.name === 'Metadata' && subtype.name === 'XML') {
          // XXX: This should examine the charset the XML document defines,
          // however since there are currently no real means to decode
          // arbitrary charsets, let's just hope that the author of the PDF
          // was reasonable enough to stick with the XML default charset,
          // which is UTF-8.
          try {
            metadata = stringToUTF8String(bytesToString(stream.getBytes()));
          } catch (e) {
            info('Skipping invalid metadata.');
          }
        }
      }

      return shadow(this, 'metadata', metadata);
    },
    get toplevelPagesDict() {
      const pagesObj = this.catDict.get('Pages');
      assert(isDict(pagesObj), 'invalid top-level pages dictionary');
      // shadow the prototype getter
      return shadow(this, 'toplevelPagesDict', pagesObj);
    },
    get documentOutline() {
      let obj = null;
      try {
        obj = this.readDocumentOutline();
      } catch (ex) {
        if (ex instanceof MissingDataException) {
          throw ex;
        }
        warn('Unable to read document outline');
      }
      return shadow(this, 'documentOutline', obj);
    },
    readDocumentOutline: function Catalog_readDocumentOutline() {
      const xref = this.xref;
      let obj = this.catDict.get('Outlines');
      const root = {items: []};
      if (isDict(obj)) {
        obj = obj.getRaw('First');
        const processed = new RefSet();
        if (isRef(obj)) {
          const queue = [{obj, parent: root}];
          // to avoid recursion keeping track of the items
          // in the processed dictionary
          processed.put(obj);
          while (queue.length > 0) {
            const i = queue.shift();
            const outlineDict = xref.fetchIfRef(i.obj);
            if (outlineDict === null) {
              continue;
            }
            if (!outlineDict.has('Title')) {
              error('Invalid outline item');
            }
            let dest = outlineDict.get('A');
            if (dest) {
              dest = dest.get('D');
            } else if (outlineDict.has('Dest')) {
              dest = outlineDict.getRaw('Dest');
              if (isName(dest)) {
                dest = dest.name;
              }
            }
            const title = outlineDict.get('Title');
            const outlineItem = {
              dest,
              title: stringToPDFString(title),
              color: outlineDict.get('C') || [0, 0, 0],
              count: outlineDict.get('Count'),
              bold: !!(outlineDict.get('F') & 2),
              italic: !!(outlineDict.get('F') & 1),
              items: [],
            };
            i.parent.items.push(outlineItem);
            obj = outlineDict.getRaw('First');
            if (isRef(obj) && !processed.has(obj)) {
              queue.push({obj, parent: outlineItem});
              processed.put(obj);
            }
            obj = outlineDict.getRaw('Next');
            if (isRef(obj) && !processed.has(obj)) {
              queue.push({obj, parent: i.parent});
              processed.put(obj);
            }
          }
        }
      }
      return (root.items.length > 0 ? root.items : null);
    },
    get numPages() {
      const obj = this.toplevelPagesDict.get('Count');
      assert(
          isInt(obj),
          'page count in top level pages object is not an integer'
      );
      // shadow the prototype getter
      return shadow(this, 'num', obj);
    },
    get destinations() {
      function fetchDestination(dest) {
        return isDict(dest) ? dest.get('D') : dest;
      }

      const xref = this.xref;
      const dests = {}; let nameTreeRef; let nameDictionaryRef;
      let obj = this.catDict.get('Names');
      if (obj && obj.has('Dests')) {
        nameTreeRef = obj.getRaw('Dests');
      } else if (this.catDict.has('Dests')) {
        nameDictionaryRef = this.catDict.get('Dests');
      }

      if (nameDictionaryRef) {
        // reading simple destination dictionary
        obj = nameDictionaryRef;
        obj.forEach((key, value) => {
          if (!value) {
            return;
          }
          dests[key] = fetchDestination(value);
        });
      }
      if (nameTreeRef) {
        const nameTree = new NameTree(nameTreeRef, xref);
        const names = nameTree.getAll();
        for (const name in names) {
          if (!names.hasOwnProperty(name)) {
            continue;
          }
          dests[name] = fetchDestination(names[name]);
        }
      }
      return shadow(this, 'destinations', dests);
    },
    getDestination: function Catalog_getDestination(destinationId) {
      function fetchDestination(dest) {
        return isDict(dest) ? dest.get('D') : dest;
      }

      const xref = this.xref;
      let dest = null; let nameTreeRef; let nameDictionaryRef;
      const obj = this.catDict.get('Names');
      if (obj && obj.has('Dests')) {
        nameTreeRef = obj.getRaw('Dests');
      } else if (this.catDict.has('Dests')) {
        nameDictionaryRef = this.catDict.get('Dests');
      }

      if (nameDictionaryRef) { // Simple destination dictionary.
        const value = nameDictionaryRef.get(destinationId);
        if (value) {
          dest = fetchDestination(value);
        }
      }
      if (nameTreeRef) {
        const nameTree = new NameTree(nameTreeRef, xref);
        dest = fetchDestination(nameTree.get(destinationId));
      }
      return dest;
    },
    get attachments() {
      const xref = this.xref;
      let attachments = null; let
        nameTreeRef;
      const obj = this.catDict.get('Names');
      if (obj) {
        nameTreeRef = obj.getRaw('EmbeddedFiles');
      }

      if (nameTreeRef) {
        const nameTree = new NameTree(nameTreeRef, xref);
        const names = nameTree.getAll();
        for (const name in names) {
          if (!names.hasOwnProperty(name)) {
            continue;
          }
          const fs = new FileSpec(names[name], xref);
          if (!attachments) {
            attachments = {};
          }
          attachments[stringToPDFString(name)] = fs.serializable;
        }
      }
      return shadow(this, 'attachments', attachments);
    },
    get javaScript() {
      const xref = this.xref;
      const obj = this.catDict.get('Names');

      const javaScript = [];
      function appendIfJavaScriptDict(jsDict) {
        const type = jsDict.get('S');
        if (!isName(type) || type.name !== 'JavaScript') {
          return;
        }
        let js = jsDict.get('JS');
        if (isStream(js)) {
          js = bytesToString(js.getBytes());
        } else if (!isString(js)) {
          return;
        }
        javaScript.push(stringToPDFString(js));
      }
      if (obj && obj.has('JavaScript')) {
        const nameTree = new NameTree(obj.getRaw('JavaScript'), xref);
        const names = nameTree.getAll();
        for (const name in names) {
          if (!names.hasOwnProperty(name)) {
            continue;
          }
          // We don't really use the JavaScript right now. This code is
          // defensive so we don't cause errors on document load.
          const jsDict = names[name];
          if (isDict(jsDict)) {
            appendIfJavaScriptDict(jsDict);
          }
        }
      }

      // Append OpenAction actions to javaScript array
      const openactionDict = this.catDict.get('OpenAction');
      if (isDict(openactionDict, 'Action')) {
        const actionType = openactionDict.get('S');
        if (isName(actionType) && actionType.name === 'Named') {
          // The named Print action is not a part of the PDF 1.7 specification,
          // but is supported by many PDF readers/writers (including Adobe's).
          const action = openactionDict.get('N');
          if (isName(action) && action.name === 'Print') {
            javaScript.push('print({});');
          }
        } else {
          appendIfJavaScriptDict(openactionDict);
        }
      }

      return shadow(this, 'javaScript', javaScript);
    },

    cleanup: function Catalog_cleanup() {
      const promises = [];
      this.fontCache.forEach((promise) => {
        promises.push(promise);
      });
      return Promise.all(promises).then((translatedFonts) => {
        for (let i = 0, ii = translatedFonts.length; i < ii; i++) {
          const font = translatedFonts[i].dict;
          delete font.translated;
        }
        this.fontCache.clear();
      });
    },

    getPage: function Catalog_getPage(pageIndex) {
      if (!(pageIndex in this.pagePromises)) {
        this.pagePromises[pageIndex] = this.getPageDict(pageIndex).then(
            (a) => {
              const dict = a[0];
              const ref = a[1];
              return new Page(this.pdfManager, this.xref, pageIndex, dict, ref,
                  this.fontCache);
            }
        );
      }
      return this.pagePromises[pageIndex];
    },

    getPageDict: function Catalog_getPageDict(pageIndex) {
      const capability = createPromiseCapability();
      let nodesToVisit = [this.catDict.getRaw('Pages')];
      let currentPageIndex = 0;
      const xref = this.xref;
      let checkAllKids = false;

      function next() {
        while (nodesToVisit.length) {
          var currentNode = nodesToVisit.pop();

          if (isRef(currentNode)) {
            xref.fetchAsync(currentNode).then((obj) => {
              if (isDict(obj, 'Page') || (isDict(obj) && !obj.has('Kids'))) {
                if (pageIndex === currentPageIndex) {
                  capability.resolve([obj, currentNode]);
                } else {
                  currentPageIndex++;
                  next();
                }
                return;
              }
              nodesToVisit.push(obj);
              next();
            }, capability.reject);
            return;
          }

          // Must be a child page dictionary.
          assert(
              isDict(currentNode),
              'page dictionary kid reference points to wrong type of object'
          );
          const count = currentNode.get('Count');
          // If the current node doesn't have any children, avoid getting stuck
          // in an empty node further down in the tree (see issue5644.pdf).
          if (count === 0) {
            checkAllKids = true;
          }
          // Skip nodes where the page can't be.
          if (currentPageIndex + count <= pageIndex) {
            currentPageIndex += count;
            continue;
          }

          const kids = currentNode.get('Kids');
          assert(isArray(kids), 'page dictionary kids object is not an array');
          if (!checkAllKids && count === kids.length) {
            // Nodes that don't have the page have been skipped and this is the
            // bottom of the tree which means the page requested must be a
            // descendant of this pages node. Ideally we would just resolve the
            // promise with the page ref here, but there is the case where more
            // pages nodes could link to single a page (see issue 3666 pdf). To
            // handle this push it back on the queue so if it is a pages node it
            // will be descended into.
            nodesToVisit = [kids[pageIndex - currentPageIndex]];
            currentPageIndex = pageIndex;
            continue;
          } else {
            for (let last = kids.length - 1; last >= 0; last--) {
              nodesToVisit.push(kids[last]);
            }
          }
        }
        capability.reject(`Page index ${pageIndex} not found.`);
      }
      next();
      return capability.promise;
    },

    getPageIndex: function Catalog_getPageIndex(ref) {
      // The page tree nodes have the count of all the leaves below them. To get
      // how many pages are before we just have to walk up the tree and keep
      // adding the count of siblings to the left of the node.
      const xref = this.xref;
      function pagesBeforeRef(kidRef) {
        let total = 0;
        let parentRef;
        return xref.fetchAsync(kidRef).then((node) => {
          if (!node) {
            return null;
          }
          parentRef = node.getRaw('Parent');
          return node.getAsync('Parent');
        }).then((parent) => {
          if (!parent) {
            return null;
          }
          return parent.getAsync('Kids');
        }).then((kids) => {
          if (!kids) {
            return null;
          }
          const kidPromises = [];
          let found = false;
          for (let i = 0; i < kids.length; i++) {
            const kid = kids[i];
            assert(isRef(kid), 'kids must be a ref');
            if (kid.num === kidRef.num) {
              found = true;
              break;
            }
            kidPromises.push(xref.fetchAsync(kid).then((kid) => {
              if (kid.has('Count')) {
                const count = kid.get('Count');
                total += count;
              } else { // page leaf node
                total++;
              }
            }));
          }
          if (!found) {
            error('kid ref not found in parents kids');
          }
          return Promise.all(kidPromises).then(() => [total, parentRef]);
        });
      }

      let total = 0;
      function next(ref) {
        return pagesBeforeRef(ref).then((args) => {
          if (!args) {
            return total;
          }
          const count = args[0];
          const parentRef = args[1];
          total += count;
          return next(parentRef);
        });
      }

      return next(ref);
    },
  };

  return Catalog;
})();

const XRef = (function XRefClosure() {
  function XRef(stream, password) {
    this.stream = stream;
    this.entries = [];
    this.xrefstms = {};
    // prepare the XRef cache
    this.cache = [];
    this.password = password;
    this.stats = {
      streamTypes: [],
      fontTypes: [],
    };
  }

  XRef.prototype = {
    setStartXRef: function XRef_setStartXRef(startXRef) {
      // Store the starting positions of xref tables as we process them
      // so we can recover from missing data errors
      this.startXRefQueue = [startXRef];
    },

    parse: function XRef_parse(recoveryMode) {
      let trailerDict;
      if (!recoveryMode) {
        trailerDict = this.readXRef();
      } else {
        warn('Indexing all PDF objects');
        trailerDict = this.indexObjects();
      }
      trailerDict.assignXref(this);
      this.trailer = trailerDict;
      const encrypt = trailerDict.get('Encrypt');
      if (encrypt) {
        const ids = trailerDict.get('ID');
        const fileId = (ids && ids.length) ? ids[0] : '';
        this.encrypt = new CipherTransformFactory(encrypt, fileId,
            this.password);
      }

      // get the root dictionary (catalog) object
      if (!(this.root = trailerDict.get('Root'))) {
        error('Invalid root reference');
      }
    },

    processXRefTable: function XRef_processXRefTable(parser) {
      if (!('tableState' in this)) {
        // Stores state of the table as we process it so we can resume
        // from middle of table in case of missing data error
        this.tableState = {
          entryNum: 0,
          streamPos: parser.lexer.stream.pos,
          parserBuf1: parser.buf1,
          parserBuf2: parser.buf2,
        };
      }

      const obj = this.readXRefTable(parser);

      // Sanity check
      if (!isCmd(obj, 'trailer')) {
        error('Invalid XRef table: could not find trailer dictionary');
      }
      // Read trailer dictionary, e.g.
      // trailer
      //    << /Size 22
      //      /Root 20R
      //      /Info 10R
      //      /ID [ <81b14aafa313db63dbd6f981e49f94f4> ]
      //    >>
      // The parser goes through the entire stream << ... >> and provides
      // a getter interface for the key-value table
      let dict = parser.getObj();

      // The pdflib PDF generator can generate a nested trailer dictionary
      if (!isDict(dict) && dict.dict) {
        dict = dict.dict;
      }
      if (!isDict(dict)) {
        error('Invalid XRef table: could not parse trailer dictionary');
      }
      delete this.tableState;

      return dict;
    },

    readXRefTable: function XRef_readXRefTable(parser) {
      // Example of cross-reference table:
      // xref
      // 0 1                    <-- subsection header (first obj #, obj count)
      // 0000000000 65535 f     <-- actual object (offset, generation #, f/n)
      // 23 2                   <-- subsection header ... and so on ...
      // 0000025518 00002 n
      // 0000025635 00000 n
      // trailer
      // ...

      const stream = parser.lexer.stream;
      const tableState = this.tableState;
      stream.pos = tableState.streamPos;
      parser.buf1 = tableState.parserBuf1;
      parser.buf2 = tableState.parserBuf2;

      // Outer loop is over subsection headers
      let obj;

      while (true) {
        if (!('firstEntryNum' in tableState) || !('entryCount' in tableState)) {
          if (isCmd(obj = parser.getObj(), 'trailer')) {
            break;
          }
          tableState.firstEntryNum = obj;
          tableState.entryCount = parser.getObj();
        }

        var first = tableState.firstEntryNum;
        const count = tableState.entryCount;
        if (!isInt(first) || !isInt(count)) {
          error('Invalid XRef table: wrong types in subsection header');
        }
        // Inner loop is over objects themselves
        for (let i = tableState.entryNum; i < count; i++) {
          tableState.streamPos = stream.pos;
          tableState.entryNum = i;
          tableState.parserBuf1 = parser.buf1;
          tableState.parserBuf2 = parser.buf2;

          const entry = {};
          entry.offset = parser.getObj();
          entry.gen = parser.getObj();
          const type = parser.getObj();

          if (isCmd(type, 'f')) {
            entry.free = true;
          } else if (isCmd(type, 'n')) {
            entry.uncompressed = true;
          }

          // Validate entry obj
          if (!isInt(entry.offset) || !isInt(entry.gen) ||
              !(entry.free || entry.uncompressed)) {
            error(`Invalid entry in XRef subsection: ${first}, ${count}`);
          }

          if (!this.entries[i + first]) {
            this.entries[i + first] = entry;
          }
        }

        tableState.entryNum = 0;
        tableState.streamPos = stream.pos;
        tableState.parserBuf1 = parser.buf1;
        tableState.parserBuf2 = parser.buf2;
        delete tableState.firstEntryNum;
        delete tableState.entryCount;
      }

      // Per issue 3248: hp scanners generate bad XRef
      if (first === 1 && this.entries[1] && this.entries[1].free) {
        // shifting the entries
        this.entries.shift();
      }

      // Sanity check: as per spec, first object must be free
      if (this.entries[0] && !this.entries[0].free) {
        error('Invalid XRef table: unexpected first object');
      }
      return obj;
    },

    processXRefStream: function XRef_processXRefStream(stream) {
      if (!('streamState' in this)) {
        // Stores state of the stream as we process it so we can resume
        // from middle of stream in case of missing data error
        const streamParameters = stream.dict;
        const byteWidths = streamParameters.get('W');
        let range = streamParameters.get('Index');
        if (!range) {
          range = [0, streamParameters.get('Size')];
        }

        this.streamState = {
          entryRanges: range,
          byteWidths,
          entryNum: 0,
          streamPos: stream.pos,
        };
      }
      this.readXRefStream(stream);
      delete this.streamState;

      return stream.dict;
    },

    readXRefStream: function XRef_readXRefStream(stream) {
      let i, j;
      const streamState = this.streamState;
      stream.pos = streamState.streamPos;

      const byteWidths = streamState.byteWidths;
      const typeFieldWidth = byteWidths[0];
      const offsetFieldWidth = byteWidths[1];
      const generationFieldWidth = byteWidths[2];

      const entryRanges = streamState.entryRanges;
      while (entryRanges.length > 0) {
        const first = entryRanges[0];
        const n = entryRanges[1];

        if (!isInt(first) || !isInt(n)) {
          error(`Invalid XRef range fields: ${first}, ${n}`);
        }
        if (!isInt(typeFieldWidth) || !isInt(offsetFieldWidth) ||
            !isInt(generationFieldWidth)) {
          error(`Invalid XRef entry fields length: ${first}, ${n}`);
        }
        for (i = streamState.entryNum; i < n; ++i) {
          streamState.entryNum = i;
          streamState.streamPos = stream.pos;

          let type = 0; let offset = 0; let
            generation = 0;
          for (j = 0; j < typeFieldWidth; ++j) {
            type = (type << 8) | stream.getByte();
          }
          // if type field is absent, its default value is 1
          if (typeFieldWidth === 0) {
            type = 1;
          }
          for (j = 0; j < offsetFieldWidth; ++j) {
            offset = (offset << 8) | stream.getByte();
          }
          for (j = 0; j < generationFieldWidth; ++j) {
            generation = (generation << 8) | stream.getByte();
          }
          const entry = {};
          entry.offset = offset;
          entry.gen = generation;
          switch (type) {
            case 0:
              entry.free = true;
              break;
            case 1:
              entry.uncompressed = true;
              break;
            case 2:
              break;
            default:
              error(`Invalid XRef entry type: ${type}`);
          }
          if (!this.entries[first + i]) {
            this.entries[first + i] = entry;
          }
        }

        streamState.entryNum = 0;
        streamState.streamPos = stream.pos;
        entryRanges.splice(0, 2);
      }
    },

    indexObjects: function XRef_indexObjects() {
      // Simple scan through the PDF content to find objects,
      // trailers and XRef streams.
      const TAB = 0x9; const LF = 0xA; const CR = 0xD; const
        SPACE = 0x20;
      const PERCENT = 0x25; const
        LT = 0x3C;

      function readToken(data, offset) {
        let token = ''; let
          ch = data[offset];
        while (ch !== LF && ch !== CR && ch !== LT) {
          if (++offset >= data.length) {
            break;
          }
          token += String.fromCharCode(ch);
          ch = data[offset];
        }
        return token;
      }
      function skipUntil(data, offset, what) {
        const length = what.length; const
          dataLength = data.length;
        let skipped = 0;
        // finding byte sequence
        while (offset < dataLength) {
          let i = 0;
          while (i < length && data[offset + i] === what[i]) {
            ++i;
          }
          if (i >= length) {
            break; // sequence found
          }
          offset++;
          skipped++;
        }
        return skipped;
      }
      const objRegExp = /^(\d+)\s+(\d+)\s+obj\b/;
      const trailerBytes = new Uint8Array([116, 114, 97, 105, 108, 101, 114]);
      const startxrefBytes = new Uint8Array([115,
        116,
        97,
        114,
        116,
        120,
        114,
        101,
        102]);
      const endobjBytes = new Uint8Array([101, 110, 100, 111, 98, 106]);
      const xrefBytes = new Uint8Array([47, 88, 82, 101, 102]);

      // Clear out any existing entries, since they may be bogus.
      this.entries.length = 0;

      const stream = this.stream;
      stream.pos = 0;
      const buffer = stream.getBytes();
      let position = stream.start; const
        length = buffer.length;
      const trailers = []; const
        xrefStms = [];
      while (position < length) {
        let ch = buffer[position];
        if (ch === TAB || ch === LF || ch === CR || ch === SPACE) {
          ++position;
          continue;
        }
        if (ch === PERCENT) { // %-comment
          do {
            ++position;
            if (position >= length) {
              break;
            }
            ch = buffer[position];
          } while (ch !== LF && ch !== CR);
          continue;
        }
        const token = readToken(buffer, position);
        var m;
        if (token.indexOf('xref') === 0 &&
            (token.length === 4 || /\s/.test(token[4]))) {
          position += skipUntil(buffer, position, trailerBytes);
          trailers.push(position);
          position += skipUntil(buffer, position, startxrefBytes);
        } else if ((m = objRegExp.exec(token))) {
          if (typeof this.entries[m[1]] === 'undefined') {
            this.entries[m[1]] = {
              offset: position - stream.start,
              gen: m[2] | 0,
              uncompressed: true,
            };
          }
          const contentLength = skipUntil(buffer, position, endobjBytes) + 7;
          const content = buffer.subarray(position, position + contentLength);

          // checking XRef stream suspect
          // (it shall have '/XRef' and next char is not a letter)
          const xrefTagOffset = skipUntil(content, 0, xrefBytes);
          if (xrefTagOffset < contentLength &&
              content[xrefTagOffset + 5] < 64) {
            xrefStms.push(position - stream.start);
            this.xrefstms[position - stream.start] = 1; // Avoid recursion
          }

          position += contentLength;
        } else if (token.indexOf('trailer') === 0 &&
                   (token.length === 7 || /\s/.test(token[7]))) {
          trailers.push(position);
          position += skipUntil(buffer, position, startxrefBytes);
        } else {
          position += token.length + 1;
        }
      }
      // reading XRef streams
      let i, ii;
      for (i = 0, ii = xrefStms.length; i < ii; ++i) {
        this.startXRefQueue.push(xrefStms[i]);
        this.readXRef(/* recoveryMode */ true);
      }
      // finding main trailer
      let dict;
      for (i = 0, ii = trailers.length; i < ii; ++i) {
        stream.pos = trailers[i];
        const parser = new Parser(new Lexer(stream), true, this);
        const obj = parser.getObj();
        if (!isCmd(obj, 'trailer')) {
          continue;
        }
        // read the trailer dictionary
        if (!isDict(dict = parser.getObj())) {
          continue;
        }
        // taking the first one with 'ID'
        if (dict.has('ID')) {
          return dict;
        }
      }
      // no tailer with 'ID', taking last one (if exists)
      if (dict) {
        return dict;
      }
      // nothing helps
      // calling error() would reject worker with an UnknownErrorException.
      throw new InvalidPDFException('Invalid PDF structure');
    },

    readXRef: function XRef_readXRef(recoveryMode) {
      const stream = this.stream;

      try {
        while (this.startXRefQueue.length) {
          const startXRef = this.startXRefQueue[0];

          stream.pos = startXRef + stream.start;

          const parser = new Parser(new Lexer(stream), true, this);
          let obj = parser.getObj();
          var dict;

          // Get dictionary
          if (isCmd(obj, 'xref')) {
            // Parse end-of-file XRef
            dict = this.processXRefTable(parser);
            if (!this.topDict) {
              this.topDict = dict;
            }

            // Recursively get other XRefs 'XRefStm', if any
            obj = dict.get('XRefStm');
            if (isInt(obj)) {
              const pos = obj;
              // ignore previously loaded xref streams
              // (possible infinite recursion)
              if (!(pos in this.xrefstms)) {
                this.xrefstms[pos] = 1;
                this.startXRefQueue.push(pos);
              }
            }
          } else if (isInt(obj)) {
            // Parse in-stream XRef
            if (!isInt(parser.getObj()) ||
                !isCmd(parser.getObj(), 'obj') ||
                !isStream(obj = parser.getObj())) {
              error('Invalid XRef stream');
            }
            dict = this.processXRefStream(obj);
            if (!this.topDict) {
              this.topDict = dict;
            }
            if (!dict) {
              error('Failed to read XRef stream');
            }
          } else {
            error('Invalid XRef stream header');
          }

          // Recursively get previous dictionary, if any
          obj = dict.get('Prev');
          if (isInt(obj)) {
            this.startXRefQueue.push(obj);
          } else if (isRef(obj)) {
            // The spec says Prev must not be a reference, i.e. "/Prev NNN"
            // This is a fallback for non-compliant PDFs, i.e. "/Prev NNN 0 R"
            this.startXRefQueue.push(obj.num);
          }

          this.startXRefQueue.shift();
        }

        return this.topDict;
      } catch (e) {
        if (e instanceof MissingDataException) {
          throw e;
        }
        info(`(while reading XRef): ${e}`);
      }

      if (recoveryMode) {
        return;
      }
      throw new XRefParseException();
    },

    getEntry: function XRef_getEntry(i) {
      const xrefEntry = this.entries[i];
      if (xrefEntry && !xrefEntry.free && xrefEntry.offset) {
        return xrefEntry;
      }
      return null;
    },

    fetchIfRef: function XRef_fetchIfRef(obj) {
      if (!isRef(obj)) {
        return obj;
      }
      return this.fetch(obj);
    },

    fetch: function XRef_fetch(ref, suppressEncryption) {
      assert(isRef(ref), 'ref object is not a reference');
      const num = ref.num;
      if (num in this.cache) {
        const cacheEntry = this.cache[num];
        return cacheEntry;
      }

      let xrefEntry = this.getEntry(num);

      // the referenced entry can be free
      if (xrefEntry === null) {
        return (this.cache[num] = null);
      }

      if (xrefEntry.uncompressed) {
        xrefEntry = this.fetchUncompressed(ref, xrefEntry, suppressEncryption);
      } else {
        xrefEntry = this.fetchCompressed(xrefEntry, suppressEncryption);
      }
      if (isDict(xrefEntry)) {
        xrefEntry.objId = ref.toString();
      } else if (isStream(xrefEntry)) {
        xrefEntry.dict.objId = ref.toString();
      }
      return xrefEntry;
    },

    fetchUncompressed: function XRef_fetchUncompressed(ref, xrefEntry,
        suppressEncryption) {
      const gen = ref.gen;
      let num = ref.num;
      if (xrefEntry.gen !== gen) {
        error('inconsistent generation in XRef');
      }
      const stream = this.stream.makeSubStream(xrefEntry.offset +
                                             this.stream.start);
      const parser = new Parser(new Lexer(stream), true, this);
      const obj1 = parser.getObj();
      const obj2 = parser.getObj();
      const obj3 = parser.getObj();
      if (!isInt(obj1) || parseInt(obj1, 10) !== num ||
          !isInt(obj2) || parseInt(obj2, 10) !== gen ||
          !isCmd(obj3)) {
        error('bad XRef entry');
      }
      if (!isCmd(obj3, 'obj')) {
        // some bad PDFs use "obj1234" and really mean 1234
        if (obj3.cmd.indexOf('obj') === 0) {
          num = parseInt(obj3.cmd.substring(3), 10);
          if (!isNaN(num)) {
            return num;
          }
        }
        error('bad XRef entry');
      }
      if (this.encrypt && !suppressEncryption) {
        xrefEntry = parser.getObj(this.encrypt.createCipherTransform(num, gen));
      } else {
        xrefEntry = parser.getObj();
      }
      if (!isStream(xrefEntry)) {
        this.cache[num] = xrefEntry;
      }
      return xrefEntry;
    },

    fetchCompressed: function XRef_fetchCompressed(xrefEntry,
        suppressEncryption) {
      const tableOffset = xrefEntry.offset;
      const stream = this.fetch(new Ref(tableOffset, 0));
      if (!isStream(stream)) {
        error('bad ObjStm stream');
      }
      const first = stream.dict.get('First');
      const n = stream.dict.get('N');
      if (!isInt(first) || !isInt(n)) {
        error('invalid first and n parameters for ObjStm stream');
      }
      const parser = new Parser(new Lexer(stream), false, this);
      parser.allowStreams = true;
      let i; const entries = []; let num; const
        nums = [];
      // read the object numbers to populate cache
      for (i = 0; i < n; ++i) {
        num = parser.getObj();
        if (!isInt(num)) {
          error(`invalid object number in the ObjStm stream: ${num}`);
        }
        nums.push(num);
        const offset = parser.getObj();
        if (!isInt(offset)) {
          error(`invalid object offset in the ObjStm stream: ${offset}`);
        }
      }
      // read stream objects for cache
      for (i = 0; i < n; ++i) {
        entries.push(parser.getObj());
        num = nums[i];
        const entry = this.entries[num];
        if (entry && entry.offset === tableOffset && entry.gen === i) {
          this.cache[num] = entries[i];
        }
      }
      xrefEntry = entries[xrefEntry.gen];
      if (xrefEntry === undefined) {
        error('bad XRef entry for compressed object');
      }
      return xrefEntry;
    },

    fetchIfRefAsync: function XRef_fetchIfRefAsync(obj) {
      if (!isRef(obj)) {
        return Promise.resolve(obj);
      }
      return this.fetchAsync(obj);
    },

    fetchAsync: function XRef_fetchAsync(ref, suppressEncryption) {
      const streamManager = this.stream.manager;
      const xref = this;
      return new Promise(function tryFetch(resolve, reject) {
        try {
          resolve(xref.fetch(ref, suppressEncryption));
        } catch (e) {
          if (e instanceof MissingDataException) {
            streamManager.requestRange(e.begin, e.end).then(() => {
              tryFetch(resolve, reject);
            }, reject);
            return;
          }
          reject(e);
        }
      });
    },

    getCatalogObj: function XRef_getCatalogObj() {
      return this.root;
    },
  };

  return XRef;
})();

/**
 * A NameTree is like a Dict but has some advantageous properties, see the
 * spec (7.9.6) for more details.
 * TODO: implement all the Dict functions and make this more efficent.
 */
var NameTree = (function NameTreeClosure() {
  function NameTree(root, xref) {
    this.root = root;
    this.xref = xref;
  }

  NameTree.prototype = {
    getAll: function NameTree_getAll() {
      const dict = {};
      if (!this.root) {
        return dict;
      }
      const xref = this.xref;
      // reading name tree
      const processed = new RefSet();
      processed.put(this.root);
      const queue = [this.root];
      while (queue.length > 0) {
        var i, n;
        const obj = xref.fetchIfRef(queue.shift());
        if (!isDict(obj)) {
          continue;
        }
        if (obj.has('Kids')) {
          const kids = obj.get('Kids');
          for (i = 0, n = kids.length; i < n; i++) {
            const kid = kids[i];
            if (processed.has(kid)) {
              error('invalid destinations');
            }
            queue.push(kid);
            processed.put(kid);
          }
          continue;
        }
        const names = obj.get('Names');
        if (names) {
          for (i = 0, n = names.length; i < n; i += 2) {
            dict[xref.fetchIfRef(names[i])] = xref.fetchIfRef(names[i + 1]);
          }
        }
      }
      return dict;
    },

    get: function NameTree_get(destinationId) {
      if (!this.root) {
        return null;
      }

      const xref = this.xref;
      let kidsOrNames = xref.fetchIfRef(this.root);
      let loopCount = 0;
      const MAX_NAMES_LEVELS = 10;
      let l, r, m;

      // Perform a binary search to quickly find the entry that
      // contains the named destination we are looking for.
      while (kidsOrNames.has('Kids')) {
        loopCount++;
        if (loopCount > MAX_NAMES_LEVELS) {
          warn('Search depth limit for named destionations has been reached.');
          return null;
        }

        const kids = kidsOrNames.get('Kids');
        if (!isArray(kids)) {
          return null;
        }

        l = 0;
        r = kids.length - 1;
        while (l <= r) {
          m = (l + r) >> 1;
          const kid = xref.fetchIfRef(kids[m]);
          const limits = kid.get('Limits');

          if (destinationId < xref.fetchIfRef(limits[0])) {
            r = m - 1;
          } else if (destinationId > xref.fetchIfRef(limits[1])) {
            l = m + 1;
          } else {
            kidsOrNames = xref.fetchIfRef(kids[m]);
            break;
          }
        }
        if (l > r) {
          return null;
        }
      }

      // If we get here, then we have found the right entry. Now
      // go through the named destinations in the Named dictionary
      // until we find the exact destination we're looking for.
      const names = kidsOrNames.get('Names');
      if (isArray(names)) {
        // Perform a binary search to reduce the lookup time.
        l = 0;
        r = names.length - 2;
        while (l <= r) {
          // Check only even indices (0, 2, 4, ...) because the
          // odd indices contain the actual D array.
          m = (l + r) & ~1;
          if (destinationId < xref.fetchIfRef(names[m])) {
            r = m - 2;
          } else if (destinationId > xref.fetchIfRef(names[m])) {
            l = m + 2;
          } else {
            return xref.fetchIfRef(names[m + 1]);
          }
        }
      }
      return null;
    },
  };
  return NameTree;
})();

/**
 * "A PDF file can refer to the contents of another file by using a File
 * Specification (PDF 1.1)", see the spec (7.11) for more details.
 * NOTE: Only embedded files are supported (as part of the attachments support)
 * TODO: support the 'URL' file system (with caching if !/V), portable
 * collections attributes and related files (/RF)
 */
var FileSpec = (function FileSpecClosure() {
  function FileSpec(root, xref) {
    if (!root || !isDict(root)) {
      return;
    }
    this.xref = xref;
    this.root = root;
    if (root.has('FS')) {
      this.fs = root.get('FS');
    }
    this.description = root.has('Desc')
      ? stringToPDFString(root.get('Desc'))
      : '';
    if (root.has('RF')) {
      warn('Related file specifications are not supported');
    }
    this.contentAvailable = true;
    if (!root.has('EF')) {
      this.contentAvailable = false;
      warn('Non-embedded file specifications are not supported');
    }
  }

  function pickPlatformItem(dict) {
    // Look for the filename in this order:
    // UF, F, Unix, Mac, DOS
    if (dict.has('UF')) {
      return dict.get('UF');
    } else if (dict.has('F')) {
      return dict.get('F');
    } else if (dict.has('Unix')) {
      return dict.get('Unix');
    } else if (dict.has('Mac')) {
      return dict.get('Mac');
    } else if (dict.has('DOS')) {
      return dict.get('DOS');
    } else {
      return null;
    }
  }

  FileSpec.prototype = {
    get filename() {
      if (!this._filename && this.root) {
        const filename = pickPlatformItem(this.root) || 'unnamed';
        this._filename = stringToPDFString(filename)
            .replace(/\\\\/g, '\\')
            .replace(/\\\//g, '/')
            .replace(/\\/g, '/');
      }
      return this._filename;
    },
    get content() {
      if (!this.contentAvailable) {
        return null;
      }
      if (!this.contentRef && this.root) {
        this.contentRef = pickPlatformItem(this.root.get('EF'));
      }
      let content = null;
      if (this.contentRef) {
        const xref = this.xref;
        const fileObj = xref.fetchIfRef(this.contentRef);
        if (fileObj && isStream(fileObj)) {
          content = fileObj.getBytes();
        } else {
          warn('Embedded file specification points to non-existing/invalid ' +
            'content');
        }
      } else {
        warn('Embedded file specification does not have a content');
      }
      return content;
    },
    get serializable() {
      return {
        filename: this.filename,
        content: this.content,
      };
    },
  };
  return FileSpec;
})();

/**
 * A helper for loading missing data in object graphs. It traverses the graph
 * depth first and queues up any objects that have missing data. Once it has
 * has traversed as many objects that are available it attempts to bundle the
 * missing data requests and then resume from the nodes that weren't ready.
 *
 * NOTE: It provides protection from circular references by keeping track of
 * of loaded references. However, you must be careful not to load any graphs
 * that have references to the catalog or other pages since that will cause the
 * entire PDF document object graph to be traversed.
 */
const ObjectLoader = (function () {
  function mayHaveChildren(value) {
    return isRef(value) || isDict(value) || isArray(value) || isStream(value);
  }

  function addChildren(node, nodesToVisit) {
    let value;
    if (isDict(node) || isStream(node)) {
      let map;
      if (isDict(node)) {
        map = node.map;
      } else {
        map = node.dict.map;
      }
      for (const key in map) {
        value = map[key];
        if (mayHaveChildren(value)) {
          nodesToVisit.push(value);
        }
      }
    } else if (isArray(node)) {
      for (let i = 0, ii = node.length; i < ii; i++) {
        value = node[i];
        if (mayHaveChildren(value)) {
          nodesToVisit.push(value);
        }
      }
    }
  }

  function ObjectLoader(obj, keys, xref) {
    this.obj = obj;
    this.keys = keys;
    this.xref = xref;
    this.refSet = null;
    this.capability = null;
  }

  ObjectLoader.prototype = {
    load: function ObjectLoader_load() {
      const keys = this.keys;
      this.capability = createPromiseCapability();
      // Don't walk the graph if all the data is already loaded.
      if (!(this.xref.stream instanceof ChunkedStream) ||
          this.xref.stream.getMissingChunks().length === 0) {
        this.capability.resolve();
        return this.capability.promise;
      }

      this.refSet = new RefSet();
      // Setup the initial nodes to visit.
      const nodesToVisit = [];
      for (let i = 0; i < keys.length; i++) {
        nodesToVisit.push(this.obj[keys[i]]);
      }

      this._walk(nodesToVisit);
      return this.capability.promise;
    },

    _walk: function ObjectLoader_walk(nodesToVisit) {
      const nodesToRevisit = [];
      const pendingRequests = [];
      // DFS walk of the object graph.
      while (nodesToVisit.length) {
        let currentNode = nodesToVisit.pop();

        // Only references or chunked streams can cause missing data exceptions.
        if (isRef(currentNode)) {
          // Skip nodes that have already been visited.
          if (this.refSet.has(currentNode)) {
            continue;
          }
          try {
            const ref = currentNode;
            this.refSet.put(ref);
            currentNode = this.xref.fetch(currentNode);
          } catch (e) {
            if (!(e instanceof MissingDataException)) {
              throw e;
            }
            nodesToRevisit.push(currentNode);
            pendingRequests.push({begin: e.begin, end: e.end});
          }
        }
        if (currentNode && currentNode.getBaseStreams) {
          const baseStreams = currentNode.getBaseStreams();
          let foundMissingData = false;
          for (let i = 0; i < baseStreams.length; i++) {
            const stream = baseStreams[i];
            if (stream.getMissingChunks && stream.getMissingChunks().length) {
              foundMissingData = true;
              pendingRequests.push({
                begin: stream.start,
                end: stream.end,
              });
            }
          }
          if (foundMissingData) {
            nodesToRevisit.push(currentNode);
          }
        }

        addChildren(currentNode, nodesToVisit);
      }

      if (pendingRequests.length) {
        this.xref.stream.manager.requestRanges(pendingRequests).then(
            () => {
              nodesToVisit = nodesToRevisit;
              for (let i = 0; i < nodesToRevisit.length; i++) {
                const node = nodesToRevisit[i];
                // Remove any reference nodes from the currrent refset so they
                // aren't skipped when we revist them.
                if (isRef(node)) {
                  this.refSet.remove(node);
                }
              }
              this._walk(nodesToVisit);
            }, this.capability.reject);
        return;
      }
      // Everything is loaded.
      this.refSet = null;
      this.capability.resolve();
    },
  };

  return ObjectLoader;
})();
