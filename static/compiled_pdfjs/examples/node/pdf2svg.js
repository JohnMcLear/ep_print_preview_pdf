/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

//
// Node tool to dump SVG output into a file.
//

const fs = require('fs');

// HACK few hacks to let PDF.js be loaded not as a module in global space.
global.window = global;
global.navigator = {userAgent: 'node'};
global.PDFJS = {};

require('./domstubs.js');

PDFJS.workerSrc = true;
require('../../build/singlefile/build/pdf.combined.js');

// Loading file from file system into typed array
const pdfPath = process.argv[2] || '../../web/compressed.tracemonkey-pldi-09.pdf';
const data = new Uint8Array(fs.readFileSync(pdfPath));

// Dumps svg outputs to a folder called svgdump
function writeToFile(svgdump, pageNum) {
  const name = getFileNameFromPath(pdfPath);
  fs.mkdir('./svgdump/', (err) => {
    if (!err || err.code === 'EEXIST') {
      fs.writeFile(`./svgdump/${name}-${pageNum}.svg`, svgdump,
          (err) => {
            if (err) {
              console.log(`Error: ${err}`);
            } else {
              console.log(`Page: ${pageNum}`);
            }
          });
    }
  });
}

// Get filename from the path

function getFileNameFromPath(path) {
  const index = path.lastIndexOf('/');
  const extIndex = path.lastIndexOf('.');
  return path.substring(index, extIndex);
}

// Will be using promises to load document, pages and misc data instead of
// callback.
PDFJS.getDocument(data).then((doc) => {
  const numPages = doc.numPages;
  console.log('# Document Loaded');
  console.log(`Number of Pages: ${numPages}`);
  console.log();

  let lastPromise = Promise.resolve(); // will be used to chain promises
  const loadPage = function (pageNum) {
    return doc.getPage(pageNum).then((page) => {
      console.log(`# Page ${pageNum}`);
      const viewport = page.getViewport(1.0 /* scale */);
      console.log(`Size: ${viewport.width}x${viewport.height}`);
      console.log();

      return page.getOperatorList().then((opList) => {
        const svgGfx = new PDFJS.SVGGraphics(page.commonObjs, page.objs);
        svgGfx.embedFonts = true;
        return svgGfx.getSVG(opList, viewport).then((svg) => {
          const svgDump = svg.toString();
          writeToFile(svgDump, pageNum);
        });
      });
    });
  };

  for (let i = 1; i <= numPages; i++) {
    lastPromise = lastPromise.then(loadPage.bind(null, i));
  }
  return lastPromise;
}).then(() => {
  console.log('# End of Document');
}, (err) => {
  console.error(`Error: ${err}`);
});
