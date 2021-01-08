//
// See README for overview
//

'use strict';

// Parse query string to extract some parameters (it can fail for some input)
const query = document.location.href.replace(/^[^?]*(\?([^#]*))?(#.*)?/, '$2');
const queryParams = query ? JSON.parse(`{${query.split('&').map((a) => a.split('=').map(decodeURIComponent).map(JSON.stringify).join(': ')).join(',')}}`) : {};

const url = queryParams.file || '../../test/pdfs/liveprogramming.pdf';
const scale = +queryParams.scale || 1.5;

//
// Fetch the PDF document from the URL using promises
//
PDFJS.getDocument(url).then((pdf) => {
  const numPages = pdf.numPages;
  // Using promise to fetch the page

  // For testing only.
  const MAX_NUM_PAGES = 50;
  const ii = Math.min(MAX_NUM_PAGES, numPages);

  let promise = Promise.resolve();
  for (let i = 1; i <= ii; i++) {
    const anchor = document.createElement('a');
    anchor.setAttribute('name', `page=${i}`);
    anchor.setAttribute('title', `Page ${i}`);
    document.body.appendChild(anchor);

    // Using promise to fetch and render the next page
    promise = promise.then(((pageNum, anchor) => pdf.getPage(pageNum).then((page) => {
      const viewport = page.getViewport(scale);

      const container = document.createElement('div');
      container.id = `pageContainer${pageNum}`;
      container.className = 'pageContainer';
      container.style.width = `${viewport.width}px`;
      container.style.height = `${viewport.height}px`;
      anchor.appendChild(container);

      return page.getOperatorList().then((opList) => {
        const svgGfx = new PDFJS.SVGGraphics(page.commonObjs, page.objs);
        return svgGfx.getSVG(opList, viewport).then((svg) => {
          container.appendChild(svg);
        });
      });
    })).bind(null, i, anchor));
  }
});
