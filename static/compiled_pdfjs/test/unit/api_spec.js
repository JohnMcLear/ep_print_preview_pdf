/* globals PDFJS, expect, it, describe, Promise, combineUrl, waitsFor,
           InvalidPDFException, MissingPDFException, StreamType, FontType,
           PDFDocumentProxy, PasswordException, PasswordResponses,
           PDFPageProxy, createPromiseCapability */

'use strict';

describe('api', () => {
  const basicApiUrl = combineUrl(window.location.href, '../pdfs/basicapi.pdf');
  const basicApiFileLength = 105779; // bytes
  function waitsForPromiseResolved(promise, successCallback) {
    let resolved = false;
    promise.then((val) => {
      resolved = true;
      successCallback(val);
    },
    (error) => {
      // Shouldn't get here.
      expect(false).toEqual(true);
    });
    waitsFor(() => resolved, 20000);
  }
  function waitsForPromiseRejected(promise, failureCallback) {
    let rejected = false;
    promise.then((val) => {
      // Shouldn't get here.
      expect(false).toEqual(true);
    },
    (error) => {
      rejected = true;
      failureCallback(error);
    });
    waitsFor(() => rejected, 20000);
  }

  describe('PDFJS', () => {
    describe('getDocument', () => {
      it('creates pdf doc from URL', () => {
        const loadingTask = PDFJS.getDocument(basicApiUrl);

        let isProgressReportedResolved = false;
        const progressReportedCapability = createPromiseCapability();

        // Attach the callback that is used to report loading progress;
        // similarly to how viewer.js works.
        loadingTask.onProgress = function (progressData) {
          if (!isProgressReportedResolved) {
            isProgressReportedResolved = true;
            progressReportedCapability.resolve(progressData);
          }
        };

        const promises = [
          progressReportedCapability.promise,
          loadingTask.promise,
        ];
        waitsForPromiseResolved(Promise.all(promises), (data) => {
          expect((data[0].loaded / data[0].total) > 0).toEqual(true);
          expect(data[1] instanceof PDFDocumentProxy).toEqual(true);
          expect(loadingTask).toEqual(data[1].loadingTask);
        });
      });
      it('creates pdf doc from URL and aborts before worker initialized',
          () => {
            const loadingTask = PDFJS.getDocument(basicApiUrl);
            loadingTask.destroy();
            waitsForPromiseRejected(loadingTask.promise, (reason) => {
              expect(true).toEqual(true);
            });
          });
      it('creates pdf doc from URL and aborts loading after worker initialized',
          () => {
            const loadingTask = PDFJS.getDocument(basicApiUrl);
            // This can be somewhat random -- we cannot guarantee perfect
            // 'Terminate' message to the worker before/after setting up pdfManager.
            const destroyed = loadingTask._transport.workerInitializedCapability
                .promise.then(() => loadingTask.destroy());
            waitsForPromiseResolved(destroyed, (data) => {
              expect(true).toEqual(true);
            });
          });
      it('creates pdf doc from typed array', () => {
        let nonBinaryRequest = PDFJS.disableWorker;
        const request = new XMLHttpRequest();
        request.open('GET', basicApiUrl, false);
        if (!nonBinaryRequest) {
          try {
            request.responseType = 'arraybuffer';
            nonBinaryRequest = request.responseType !== 'arraybuffer';
          } catch (e) {
            nonBinaryRequest = true;
          }
        }
        if (nonBinaryRequest && request.overrideMimeType) {
          request.overrideMimeType('text/plain; charset=x-user-defined');
        }
        request.send(null);

        let typedArrayPdf;
        if (nonBinaryRequest) {
          const data = Array.prototype.map.call(request.responseText,
              (ch) => ch.charCodeAt(0) & 0xFF);
          typedArrayPdf = new Uint8Array(data);
        } else {
          typedArrayPdf = new Uint8Array(request.response);
        }
        // Sanity check to make sure that we fetched the entire PDF file.
        expect(typedArrayPdf.length).toEqual(basicApiFileLength);

        const promise = PDFJS.getDocument(typedArrayPdf);
        waitsForPromiseResolved(promise, (data) => {
          expect(data instanceof PDFDocumentProxy).toEqual(true);
        });
      });
      it('creates pdf doc from invalid PDF file', () => {
        // A severely corrupt PDF file (even Adobe Reader fails to open it).
        const url = combineUrl(window.location.href, '../pdfs/bug1020226.pdf');

        const promise = PDFJS.getDocument(url);
        waitsForPromiseRejected(promise, (error) => {
          expect(error instanceof InvalidPDFException).toEqual(true);
        });
      });
      it('creates pdf doc from non-existent URL', () => {
        const nonExistentUrl = combineUrl(window.location.href,
            '../pdfs/non-existent.pdf');
        const promise = PDFJS.getDocument(nonExistentUrl);
        waitsForPromiseRejected(promise, (error) => {
          expect(error instanceof MissingPDFException).toEqual(true);
        });
      });
      it('creates pdf doc from PDF file protected with user and owner password',
          () => {
            const url = combineUrl(window.location.href, '../pdfs/pr6531_1.pdf');
            const loadingTask = PDFJS.getDocument(url);

            let isPasswordNeededResolved = false;
            const passwordNeededCapability = createPromiseCapability();
            let isPasswordIncorrectResolved = false;
            const passwordIncorrectCapability = createPromiseCapability();

            // Attach the callback that is used to request a password;
            // similarly to how viewer.js handles passwords.
            loadingTask.onPassword = function (updatePassword, reason) {
              if (reason === PasswordResponses.NEED_PASSWORD &&
              !isPasswordNeededResolved) {
                isPasswordNeededResolved = true;
                passwordNeededCapability.resolve();

                updatePassword('qwerty'); // Provide an incorrect password.
                return;
              }
              if (reason === PasswordResponses.INCORRECT_PASSWORD &&
              !isPasswordIncorrectResolved) {
                isPasswordIncorrectResolved = true;
                passwordIncorrectCapability.resolve();

                updatePassword('asdfasdf'); // Provide the correct password.
                return;
              }
              // Shouldn't get here.
              expect(false).toEqual(true);
            };

            const promises = [
              passwordNeededCapability.promise,
              passwordIncorrectCapability.promise,
              loadingTask.promise,
            ];
            waitsForPromiseResolved(Promise.all(promises), (data) => {
              expect(data[2] instanceof PDFDocumentProxy).toEqual(true);
            });
          });
      it('creates pdf doc from PDF file protected with only a user password',
          () => {
            const url = combineUrl(window.location.href, '../pdfs/pr6531_2.pdf');

            const passwordNeededPromise = PDFJS.getDocument({
              url, password: '',
            });
            waitsForPromiseRejected(passwordNeededPromise, (data) => {
              expect(data instanceof PasswordException).toEqual(true);
              expect(data.code).toEqual(PasswordResponses.NEED_PASSWORD);
            });

            const passwordIncorrectPromise = PDFJS.getDocument({
              url, password: 'qwerty',
            });
            waitsForPromiseRejected(passwordIncorrectPromise, (data) => {
              expect(data instanceof PasswordException).toEqual(true);
              expect(data.code).toEqual(PasswordResponses.INCORRECT_PASSWORD);
            });

            const passwordAcceptedPromise = PDFJS.getDocument({
              url, password: 'asdfasdf',
            });
            waitsForPromiseResolved(passwordAcceptedPromise, (data) => {
              expect(data instanceof PDFDocumentProxy).toEqual(true);
            });
          });
    });
  });
  describe('PDFDocument', () => {
    const promise = PDFJS.getDocument(basicApiUrl);
    let doc;
    waitsForPromiseResolved(promise, (data) => {
      doc = data;
    });
    it('gets number of pages', () => {
      expect(doc.numPages).toEqual(3);
    });
    it('gets fingerprint', () => {
      const fingerprint = doc.fingerprint;
      expect(typeof fingerprint).toEqual('string');
      expect(fingerprint.length > 0).toEqual(true);
    });
    it('gets page', () => {
      const promise = doc.getPage(1);
      waitsForPromiseResolved(promise, (data) => {
        expect(data instanceof PDFPageProxy).toEqual(true);
        expect(data.pageIndex).toEqual(0);
      });
    });
    it('gets non-existent page', () => {
      const promise = doc.getPage(100);
      waitsForPromiseRejected(promise, (data) => {
        expect(data instanceof Error).toEqual(true);
      });
    });
    it('gets page index', () => {
      // reference to second page
      const ref = {num: 17, gen: 0};
      const promise = doc.getPageIndex(ref);
      waitsForPromiseResolved(promise, (pageIndex) => {
        expect(pageIndex).toEqual(1);
      });
    });
    it('gets destinations', () => {
      const promise = doc.getDestinations();
      waitsForPromiseResolved(promise, (data) => {
        expect(data).toEqual({chapter1: [{gen: 0, num: 17},
          {name: 'XYZ'},
          0,
          841.89,
          null]});
      });
    });
    it('gets a destination', () => {
      const promise = doc.getDestination('chapter1');
      waitsForPromiseResolved(promise, (data) => {
        expect(data).toEqual([{gen: 0, num: 17},
          {name: 'XYZ'},
          0,
          841.89,
          null]);
      });
    });
    it('gets a non-existent destination', () => {
      const promise = doc.getDestination('non-existent-named-destination');
      waitsForPromiseResolved(promise, (data) => {
        expect(data).toEqual(null);
      });
    });
    it('gets attachments', () => {
      const promise = doc.getAttachments();
      waitsForPromiseResolved(promise, (data) => {
        expect(data).toEqual(null);
      });
    });
    it('gets javascript', () => {
      const promise = doc.getJavaScript();
      waitsForPromiseResolved(promise, (data) => {
        expect(data).toEqual([]);
      });
    });
    // Keep this in sync with the pattern in viewer.js. The pattern is used to
    // detect whether or not to automatically start printing.
    const viewerPrintRegExp = /\bprint\s*\(/;
    it('gets javascript with printing instructions (Print action)', () => {
      // PDF document with "Print" Named action in OpenAction
      const pdfUrl = combineUrl(window.location.href, '../pdfs/bug1001080.pdf');
      const promise = PDFJS.getDocument(pdfUrl).then((doc) => doc.getJavaScript());
      waitsForPromiseResolved(promise, (data) => {
        expect(data).toEqual(['print({});']);
        expect(data[0]).toMatch(viewerPrintRegExp);
      });
    });
    it('gets javascript with printing instructions (JS action)', () => {
      // PDF document with "JavaScript" action in OpenAction
      const pdfUrl = combineUrl(window.location.href, '../pdfs/issue6106.pdf');
      const promise = PDFJS.getDocument(pdfUrl).then((doc) => doc.getJavaScript());
      waitsForPromiseResolved(promise, (data) => {
        expect(data).toEqual(
            ['this.print({bUI:true,bSilent:false,bShrinkToFit:true});']);
        expect(data[0]).toMatch(viewerPrintRegExp);
      });
    });
    it('gets outline', () => {
      const promise = doc.getOutline();
      waitsForPromiseResolved(promise, (outline) => {
        // Two top level entries.
        expect(outline.length).toEqual(2);
        // Make sure some basic attributes are set.
        expect(outline[1].title).toEqual('Chapter 1');
        expect(outline[1].items.length).toEqual(1);
        expect(outline[1].items[0].title).toEqual('Paragraph 1.1');
      });
    });
    it('gets metadata', () => {
      const promise = doc.getMetadata();
      waitsForPromiseResolved(promise, (metadata) => {
        expect(metadata.info.Title).toEqual('Basic API Test');
        expect(metadata.info.PDFFormatVersion).toEqual('1.7');
        expect(metadata.metadata.get('dc:title')).toEqual('Basic API Test');
      });
    });
    it('gets data', () => {
      const promise = doc.getData();
      waitsForPromiseResolved(promise, (data) => {
        expect(data instanceof Uint8Array).toEqual(true);
        expect(data.length).toEqual(basicApiFileLength);
      });
    });
    it('gets download info', () => {
      const promise = doc.getDownloadInfo();
      waitsForPromiseResolved(promise, (data) => {
        expect(data).toEqual({length: basicApiFileLength});
      });
    });
    it('gets stats', () => {
      const promise = doc.getStats();
      waitsForPromiseResolved(promise, (stats) => {
        expect(stats).toEqual({streamTypes: [], fontTypes: []});
      });
    });

    it('checks that fingerprints are unique', () => {
      const url1 = combineUrl(window.location.href, '../pdfs/issue4436r.pdf');
      const loadingTask1 = PDFJS.getDocument(url1);

      const url2 = combineUrl(window.location.href, '../pdfs/issue4575.pdf');
      const loadingTask2 = PDFJS.getDocument(url2);

      const promises = [loadingTask1.promise,
        loadingTask2.promise];
      waitsForPromiseResolved(Promise.all(promises), (data) => {
        const fingerprint1 = data[0].fingerprint;
        expect(typeof fingerprint1).toEqual('string');
        expect(fingerprint1.length > 0).toEqual(true);

        const fingerprint2 = data[1].fingerprint;
        expect(typeof fingerprint2).toEqual('string');
        expect(fingerprint2.length > 0).toEqual(true);

        expect(fingerprint1).not.toEqual(fingerprint2);
      });
    });
  });
  describe('Page', () => {
    let resolvePromise;
    const promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    let pdfDocument;
    PDFJS.getDocument(basicApiUrl).then((doc) => {
      doc.getPage(1).then((data) => {
        resolvePromise(data);
      });
      pdfDocument = doc;
    });
    let page;
    waitsForPromiseResolved(promise, (data) => {
      page = data;
    });
    it('gets page number', () => {
      expect(page.pageNumber).toEqual(1);
    });
    it('gets rotate', () => {
      expect(page.rotate).toEqual(0);
    });
    it('gets ref', () => {
      expect(page.ref).toEqual({num: 15, gen: 0});
    });
    it('gets view', () => {
      expect(page.view).toEqual([0, 0, 595.28, 841.89]);
    });
    it('gets viewport', () => {
      const viewport = page.getViewport(1.5, 90);
      expect(viewport.viewBox).toEqual(page.view);
      expect(viewport.scale).toEqual(1.5);
      expect(viewport.rotation).toEqual(90);
      expect(viewport.transform).toEqual([0, 1.5, 1.5, 0, 0, 0]);
      expect(viewport.width).toEqual(1262.835);
      expect(viewport.height).toEqual(892.92);
    });
    it('gets annotations', () => {
      const defaultPromise = page.getAnnotations();
      waitsForPromiseResolved(defaultPromise, (data) => {
        expect(data.length).toEqual(4);
      });

      const displayPromise = page.getAnnotations({intent: 'display'});
      waitsForPromiseResolved(displayPromise, (data) => {
        expect(data.length).toEqual(4);
      });

      const printPromise = page.getAnnotations({intent: 'print'});
      waitsForPromiseResolved(printPromise, (data) => {
        expect(data.length).toEqual(4);
      });
    });
    it('gets text content', () => {
      const promise = page.getTextContent();
      waitsForPromiseResolved(promise, (data) => {
        expect(!!data.items).toEqual(true);
        expect(data.items.length).toEqual(7);
        expect(!!data.styles).toEqual(true);
      });
    });
    it('gets operator list', () => {
      const promise = page.getOperatorList();
      waitsForPromiseResolved(promise, (oplist) => {
        expect(!!oplist.fnArray).toEqual(true);
        expect(!!oplist.argsArray).toEqual(true);
        expect(oplist.lastChunk).toEqual(true);
      });
    });
    it('gets stats after parsing page', () => {
      const promise = page.getOperatorList().then(() => pdfDocument.getStats());
      const expectedStreamTypes = [];
      expectedStreamTypes[StreamType.FLATE] = true;
      const expectedFontTypes = [];
      expectedFontTypes[FontType.TYPE1] = true;
      expectedFontTypes[FontType.CIDFONTTYPE2] = true;

      waitsForPromiseResolved(promise, (stats) => {
        expect(stats).toEqual({streamTypes: expectedStreamTypes,
          fontTypes: expectedFontTypes});
      });
    });
  });
});
