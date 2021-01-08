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
/* globals PDFJS, createPromiseCapability, LocalPdfManager, NetworkPdfManager,
           NetworkManager, isInt, MissingPDFException,
           UnexpectedResponseException, PasswordException, Promise, warn,
           PasswordResponses, InvalidPDFException, UnknownErrorException,
           XRefParseException, Ref, info, globalScope, error, MessageHandler */

'use strict';

const WorkerTask = (function WorkerTaskClosure() {
  function WorkerTask(name) {
    this.name = name;
    this.terminated = false;
    this._capability = createPromiseCapability();
  }

  WorkerTask.prototype = {
    get finished() {
      return this._capability.promise;
    },

    finish() {
      this._capability.resolve();
    },

    terminate() {
      this.terminated = true;
    },

    ensureNotTerminated() {
      if (this.terminated) {
        throw new Error('Worker task was terminated');
      }
    },
  };

  return WorkerTask;
})();

const WorkerMessageHandler = PDFJS.WorkerMessageHandler = {
  setup: function wphSetup(handler) {
    let pdfManager;
    let terminated = false;
    let cancelXHRs = null;
    const WorkerTasks = [];

    function ensureNotTerminated() {
      if (terminated) {
        throw new Error('Worker was terminated');
      }
    }

    function startWorkerTask(task) {
      WorkerTasks.push(task);
    }

    function finishWorkerTask(task) {
      task.finish();
      const i = WorkerTasks.indexOf(task);
      WorkerTasks.splice(i, 1);
    }

    function loadDocument(recoveryMode) {
      const loadDocumentCapability = createPromiseCapability();

      const parseSuccess = function parseSuccess() {
        const numPagesPromise = pdfManager.ensureDoc('numPages');
        const fingerprintPromise = pdfManager.ensureDoc('fingerprint');
        const encryptedPromise = pdfManager.ensureXRef('encrypt');
        Promise.all([numPagesPromise,
          fingerprintPromise,
          encryptedPromise]).then((results) => {
          const doc = {
            numPages: results[0],
            fingerprint: results[1],
            encrypted: !!results[2],
          };
          loadDocumentCapability.resolve(doc);
        },
        parseFailure);
      };

      var parseFailure = function parseFailure(e) {
        loadDocumentCapability.reject(e);
      };

      pdfManager.ensureDoc('checkHeader', []).then(() => {
        pdfManager.ensureDoc('parseStartXRef', []).then(() => {
          pdfManager.ensureDoc('parse', [recoveryMode]).then(
              parseSuccess, parseFailure);
        }, parseFailure);
      }, parseFailure);

      return loadDocumentCapability.promise;
    }

    function getPdfManager(data) {
      const pdfManagerCapability = createPromiseCapability();
      let pdfManager;

      const source = data.source;
      const disableRange = data.disableRange;
      if (source.data) {
        try {
          pdfManager = new LocalPdfManager(source.data, source.password);
          pdfManagerCapability.resolve(pdfManager);
        } catch (ex) {
          pdfManagerCapability.reject(ex);
        }
        return pdfManagerCapability.promise;
      } else if (source.chunkedViewerLoading) {
        try {
          pdfManager = new NetworkPdfManager(source, handler);
          pdfManagerCapability.resolve(pdfManager);
        } catch (ex) {
          pdfManagerCapability.reject(ex);
        }
        return pdfManagerCapability.promise;
      }

      const networkManager = new NetworkManager(source.url, {
        httpHeaders: source.httpHeaders,
        withCredentials: source.withCredentials,
      });
      const cachedChunks = [];
      var fullRequestXhrId = networkManager.requestFull({
        onHeadersReceived: function onHeadersReceived() {
          if (disableRange) {
            return;
          }

          const fullRequestXhr = networkManager.getRequestXhr(fullRequestXhrId);
          if (fullRequestXhr.getResponseHeader('Accept-Ranges') !== 'bytes') {
            return;
          }

          const contentEncoding =
            fullRequestXhr.getResponseHeader('Content-Encoding') || 'identity';
          if (contentEncoding !== 'identity') {
            return;
          }

          let length = fullRequestXhr.getResponseHeader('Content-Length');
          length = parseInt(length, 10);
          if (!isInt(length)) {
            return;
          }
          source.length = length;
          if (length <= 2 * source.rangeChunkSize) {
            // The file size is smaller than the size of two chunks, so it does
            // not make any sense to abort the request and retry with a range
            // request.
            return;
          }

          if (networkManager.isStreamingRequest(fullRequestXhrId)) {
            // We can continue fetching when progressive loading is enabled,
            // and we don't need the autoFetch feature.
            source.disableAutoFetch = true;
          } else {
            // NOTE: by cancelling the full request, and then issuing range
            // requests, there will be an issue for sites where you can only
            // request the pdf once. However, if this is the case, then the
            // server should not be returning that it can support range
            // requests.
            networkManager.abortRequest(fullRequestXhrId);
          }

          try {
            pdfManager = new NetworkPdfManager(source, handler);
            pdfManagerCapability.resolve(pdfManager);
          } catch (ex) {
            pdfManagerCapability.reject(ex);
          }
          cancelXHRs = null;
        },

        onProgressiveData: source.disableStream ? null
        : function onProgressiveData(chunk) {
          if (!pdfManager) {
            cachedChunks.push(chunk);
            return;
          }
          pdfManager.sendProgressiveData(chunk);
        },

        onDone: function onDone(args) {
          if (pdfManager) {
            return; // already processed
          }

          let pdfFile;
          if (args === null) {
            // TODO add some streaming manager, e.g. for unknown length files.
            // The data was returned in the onProgressiveData, combining...
            let pdfFileLength = 0; let
              pos = 0;
            cachedChunks.forEach((chunk) => {
              pdfFileLength += chunk.byteLength;
            });
            if (source.length && pdfFileLength !== source.length) {
              warn('reported HTTP length is different from actual');
            }
            const pdfFileArray = new Uint8Array(pdfFileLength);
            cachedChunks.forEach((chunk) => {
              pdfFileArray.set(new Uint8Array(chunk), pos);
              pos += chunk.byteLength;
            });
            pdfFile = pdfFileArray.buffer;
          } else {
            pdfFile = args.chunk;
          }

          // the data is array, instantiating directly from it
          try {
            pdfManager = new LocalPdfManager(pdfFile, source.password);
            pdfManagerCapability.resolve(pdfManager);
          } catch (ex) {
            pdfManagerCapability.reject(ex);
          }
          cancelXHRs = null;
        },

        onError: function onError(status) {
          let exception;
          if (status === 404 || status === 0 && /^file:/.test(source.url)) {
            exception = new MissingPDFException(`Missing PDF "${
              source.url}".`);
            handler.send('MissingPDF', exception);
          } else {
            exception = new UnexpectedResponseException(
                `Unexpected server response (${status
                }) while retrieving PDF "${source.url}".`, status);
            handler.send('UnexpectedResponse', exception);
          }
          cancelXHRs = null;
        },

        onProgress: function onProgress(evt) {
          handler.send('DocProgress', {
            loaded: evt.loaded,
            total: evt.lengthComputable ? evt.total : source.length,
          });
        },
      });

      cancelXHRs = function () {
        networkManager.abortRequest(fullRequestXhrId);
      };

      return pdfManagerCapability.promise;
    }

    handler.on('test', (data) => {
      // check if Uint8Array can be sent to worker
      if (!(data instanceof Uint8Array)) {
        handler.send('test', false);
        return;
      }
      // making sure postMessage transfers are working
      const supportTransfers = data[0] === 255;
      handler.postMessageTransfers = supportTransfers;
      // check if the response property is supported by xhr
      const xhr = new XMLHttpRequest();
      let responseExists = 'response' in xhr;
      // check if the property is actually implemented
      try {
        const dummy = xhr.responseType;
      } catch (e) {
        responseExists = false;
      }
      if (!responseExists) {
        handler.send('test', false);
        return;
      }
      handler.send('test', {
        supportTypedArray: true,
        supportTransfers,
      });
    });

    handler.on('GetDocRequest', (data) => {
      const onSuccess = function (doc) {
        ensureNotTerminated();
        handler.send('GetDoc', {pdfInfo: doc});
      };

      const onFailure = function (e) {
        if (e instanceof PasswordException) {
          if (e.code === PasswordResponses.NEED_PASSWORD) {
            handler.send('NeedPassword', e);
          } else if (e.code === PasswordResponses.INCORRECT_PASSWORD) {
            handler.send('IncorrectPassword', e);
          }
        } else if (e instanceof InvalidPDFException) {
          handler.send('InvalidPDF', e);
        } else if (e instanceof MissingPDFException) {
          handler.send('MissingPDF', e);
        } else if (e instanceof UnexpectedResponseException) {
          handler.send('UnexpectedResponse', e);
        } else {
          handler.send('UnknownError',
              new UnknownErrorException(e.message, e.toString()));
        }
      };

      ensureNotTerminated();

      PDFJS.maxImageSize = data.maxImageSize === undefined
        ? -1 : data.maxImageSize;
      PDFJS.disableFontFace = data.disableFontFace;
      PDFJS.disableCreateObjectURL = data.disableCreateObjectURL;
      PDFJS.verbosity = data.verbosity;
      PDFJS.cMapUrl = data.cMapUrl === undefined
        ? null : data.cMapUrl;
      PDFJS.cMapPacked = data.cMapPacked === true;

      getPdfManager(data).then((newPdfManager) => {
        if (terminated) {
          // We were in a process of setting up the manager, but it got
          // terminated in the middle.
          newPdfManager.terminate();
          throw new Error('Worker was terminated');
        }

        pdfManager = newPdfManager;

        handler.send('PDFManagerReady', null);
        pdfManager.onLoadedStream().then((stream) => {
          handler.send('DataLoaded', {length: stream.bytes.byteLength});
        });
      }).then(function pdfManagerReady() {
        ensureNotTerminated();

        loadDocument(false).then(onSuccess, (ex) => {
          ensureNotTerminated();

          // Try again with recoveryMode == true
          if (!(ex instanceof XRefParseException)) {
            if (ex instanceof PasswordException) {
              // after password exception prepare to receive a new password
              // to repeat loading
              pdfManager.passwordChanged().then(pdfManagerReady);
            }

            onFailure(ex);
            return;
          }

          pdfManager.requestLoadedStream();
          pdfManager.onLoadedStream().then(() => {
            ensureNotTerminated();

            loadDocument(true).then(onSuccess, onFailure);
          });
        }, onFailure);
      }, onFailure);
    });

    handler.on('GetPage', (data) => pdfManager.getPage(data.pageIndex).then((page) => {
      const rotatePromise = pdfManager.ensure(page, 'rotate');
      const refPromise = pdfManager.ensure(page, 'ref');
      const viewPromise = pdfManager.ensure(page, 'view');

      return Promise.all([rotatePromise, refPromise, viewPromise]).then(
          (results) => ({
            rotate: results[0],
            ref: results[1],
            view: results[2],
          }));
    }));

    handler.on('GetPageIndex', (data) => {
      const ref = new Ref(data.ref.num, data.ref.gen);
      const catalog = pdfManager.pdfDocument.catalog;
      return catalog.getPageIndex(ref);
    });

    handler.on('GetDestinations',
        (data) => pdfManager.ensureCatalog('destinations')
    );

    handler.on('GetDestination',
        (data) => pdfManager.ensureCatalog('getDestination', [data.id])
    );

    handler.on('GetAttachments',
        (data) => pdfManager.ensureCatalog('attachments')
    );

    handler.on('GetJavaScript',
        (data) => pdfManager.ensureCatalog('javaScript')
    );

    handler.on('GetOutline',
        (data) => pdfManager.ensureCatalog('documentOutline')
    );

    handler.on('GetMetadata',
        (data) => Promise.all([pdfManager.ensureDoc('documentInfo'),
          pdfManager.ensureCatalog('metadata')])
    );

    handler.on('GetData', (data) => {
      pdfManager.requestLoadedStream();
      return pdfManager.onLoadedStream().then((stream) => stream.bytes);
    });

    handler.on('GetStats',
        (data) => pdfManager.pdfDocument.xref.stats
    );

    handler.on('UpdatePassword', (data) => {
      pdfManager.updatePassword(data);
    });

    handler.on('GetAnnotations', (data) => pdfManager.getPage(data.pageIndex).then((page) => pdfManager.ensure(page, 'getAnnotationsData', [data.intent])));

    handler.on('RenderPageRequest', (data) => {
      const pageIndex = data.pageIndex;
      pdfManager.getPage(pageIndex).then((page) => {
        const task = new WorkerTask(`RenderPageRequest: page ${pageIndex}`);
        startWorkerTask(task);

        const pageNum = pageIndex + 1;
        const start = Date.now();
        // Pre compile the pdf page and fetch the fonts/images.
        page.getOperatorList(handler, task, data.intent).then(
            (operatorList) => {
              finishWorkerTask(task);

              info(`page=${pageNum} - getOperatorList: time=${
                Date.now() - start}ms, len=${operatorList.totalLength}`);
            }, (e) => {
              finishWorkerTask(task);
              if (task.terminated) {
                return; // ignoring errors from the terminated thread
              }

              const minimumStackMessage =
            'worker.js: while trying to getPage() and getOperatorList()';

              let wrappedException;

              // Turn the error into an obj that can be serialized
              if (typeof e === 'string') {
                wrappedException = {
                  message: e,
                  stack: minimumStackMessage,
                };
              } else if (typeof e === 'object') {
                wrappedException = {
                  message: e.message || e.toString(),
                  stack: e.stack || minimumStackMessage,
                };
              } else {
                wrappedException = {
                  message: `Unknown exception type: ${typeof e}`,
                  stack: minimumStackMessage,
                };
              }

              handler.send('PageError', {
                pageNum,
                error: wrappedException,
                intent: data.intent,
              });
            });
      });
    }, this);

    handler.on('GetTextContent', (data) => {
      const pageIndex = data.pageIndex;
      return pdfManager.getPage(pageIndex).then((page) => {
        const task = new WorkerTask(`GetTextContent: page ${pageIndex}`);
        startWorkerTask(task);
        const pageNum = pageIndex + 1;
        const start = Date.now();
        return page.extractTextContent(task).then((textContent) => {
          finishWorkerTask(task);
          info(`text indexing: page=${pageNum} - time=${
            Date.now() - start}ms`);
          return textContent;
        }, (reason) => {
          finishWorkerTask(task);
          if (task.terminated) {
            return; // ignoring errors from the terminated thread
          }
          throw reason;
        });
      });
    });

    handler.on('Cleanup', (data) => pdfManager.cleanup());

    handler.on('Terminate', (data) => {
      terminated = true;
      if (pdfManager) {
        pdfManager.terminate();
        pdfManager = null;
      }
      if (cancelXHRs) {
        cancelXHRs();
      }

      const waitOn = [];
      WorkerTasks.forEach((task) => {
        waitOn.push(task.finished);
        task.terminate();
      });

      return Promise.all(waitOn).then(() => {});
    });
  },
};

const consoleTimer = {};

const workerConsole = {
  log: function log() {
    const args = Array.prototype.slice.call(arguments);
    globalScope.postMessage({
      action: 'console_log',
      data: args,
    });
  },

  error: function error() {
    const args = Array.prototype.slice.call(arguments);
    globalScope.postMessage({
      action: 'console_error',
      data: args,
    });
    throw 'pdf.js execution error';
  },

  time: function time(name) {
    consoleTimer[name] = Date.now();
  },

  timeEnd: function timeEnd(name) {
    const time = consoleTimer[name];
    if (!time) {
      error(`Unknown timer name ${name}`);
    }
    this.log('Timer:', name, Date.now() - time);
  },
};


// Worker thread?
if (typeof window === 'undefined') {
  if (!('console' in globalScope)) {
    globalScope.console = workerConsole;
  }

  // Listen for unsupported features so we can pass them on to the main thread.
  PDFJS.UnsupportedManager.listen((msg) => {
    globalScope.postMessage({
      action: '_unsupported_feature',
      data: msg,
    });
  });

  const handler = new MessageHandler('worker_processor', this);
  WorkerMessageHandler.setup(handler);
}
