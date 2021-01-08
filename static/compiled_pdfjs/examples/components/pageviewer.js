/* Copyright 2014 Mozilla Foundation
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

'use strict';

if (!PDFJS.PDFViewer || !PDFJS.getDocument) {
  alert('Please build the library and components using\n' +
        '  `node make generic components`');
}

// The workerSrc property shall be specified.
//
PDFJS.workerSrc = '../../build/pdf.worker.js';

// Some PDFs need external cmaps.
//
// PDFJS.cMapUrl = '../../external/bcmaps/';
// PDFJS.cMapPacked = true;

const DEFAULT_URL = '../../web/compressed.tracemonkey-pldi-09.pdf';
const PAGE_TO_VIEW = 1;
const SCALE = 1.0;

const container = document.getElementById('pageContainer');

// Loading document.
PDFJS.getDocument(DEFAULT_URL).then((pdfDocument) =>
  // Document loaded, retrieving the page.
  pdfDocument.getPage(PAGE_TO_VIEW).then((pdfPage) => {
    // Creating the page view with default parameters.
    const pdfPageView = new PDFJS.PDFPageView({
      container,
      id: PAGE_TO_VIEW,
      scale: SCALE,
      defaultViewport: pdfPage.getViewport(SCALE),
      // We can enable text/annotations layers, if needed
      textLayerFactory: new PDFJS.DefaultTextLayerFactory(),
      annotationsLayerFactory: new PDFJS.DefaultAnnotationsLayerFactory(),
    });
    // Associates the actual page with the view, and drawing it
    pdfPageView.setPdfPage(pdfPage);
    return pdfPageView.draw();
  })
);
