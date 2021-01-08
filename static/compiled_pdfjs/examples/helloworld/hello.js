//
// See README for overview
//

'use strict';

//
// Fetch the PDF document from the URL using promises
//
PDFJS.getDocument('helloworld.pdf').then((pdf) => {
  // Using promise to fetch the page
  pdf.getPage(1).then((page) => {
    const scale = 1.5;
    const viewport = page.getViewport(scale);

    //
    // Prepare canvas using PDF page dimensions
    //
    const canvas = document.getElementById('the-canvas');
    const context = canvas.getContext('2d');
    canvas.height = viewport.height;
    canvas.width = viewport.width;

    //
    // Render PDF page into canvas context
    //
    const renderContext = {
      canvasContext: context,
      viewport,
    };
    page.render(renderContext);
  });
});
