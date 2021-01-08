/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

//
// Basic node example that prints document metadata and text content.
// Requires single file built version of PDF.js -- please run
// `node make singlefile` before running the example.
//

const fs = require('fs');

// HACK few hacks to let PDF.js be loaded not as a module in global space.
global.window = global;
global.navigator = {userAgent: 'node'};
global.PDFJS = {};
global.DOMParser = require('./domparsermock.js').DOMParserMock;

require('../../build/singlefile/build/pdf.combined.js');

// Loading file from file system into typed array
const pdfPath = process.argv[2] || '../../web/compressed.tracemonkey-pldi-09.pdf';
const data = new Uint8Array(fs.readFileSync(pdfPath));

// Will be using promises to load document, pages and misc data instead of
// callback.
PDFJS.getDocument(data).then((doc) => {
  const numPages = doc.numPages;
  console.log('# Document Loaded');
  console.log(`Number of Pages: ${numPages}`);
  console.log();

  let lastPromise; // will be used to chain promises
  lastPromise = doc.getMetadata().then((data) => {
    console.log('# Metadata Is Loaded');
    console.log('## Info');
    console.log(JSON.stringify(data.info, null, 2));
    console.log();
    if (data.metadata) {
      console.log('## Metadata');
      console.log(JSON.stringify(data.metadata.metadata, null, 2));
      console.log();
    }
  });

  const loadPage = function (pageNum) {
    return doc.getPage(pageNum).then((page) => {
      console.log(`# Page ${pageNum}`);
      const viewport = page.getViewport(1.0 /* scale */);
      console.log(`Size: ${viewport.width}x${viewport.height}`);
      console.log();
      return page.getTextContent().then((content) => {
        // Content contains lots of information about the text layout and
        // styles, but we need only strings at the moment
        const strings = content.items.map((item) => item.str);
        console.log('## Text Content');
        console.log(strings.join(' '));
      }).then(() => {
        console.log();
      });
    });
  };
  // Loading of the first page will wait on metadata and subsequent loadings
  // will wait on the previous pages.
  for (let i = 1; i <= numPages; i++) {
    lastPromise = lastPromise.then(loadPage.bind(null, i));
  }
  return lastPromise;
}).then(() => {
  console.log('# End of Document');
}, (err) => {
  console.error(`Error: ${err}`);
});
