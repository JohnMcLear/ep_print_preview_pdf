var _, $, jQuery;
var $ = require('ep_etherpad-lite/static/js/rjquery').$;
var _ = require('ep_etherpad-lite/static/js/underscore');
var padcookie = require('ep_etherpad-lite/static/js/pad_cookie').padcookie;

exports.postAceInit = function(hook, context){
  var $outerIframeContents = $('iframe[name="ace_outer"]').contents();
  var $innerIframe = $outerIframeContents.find('iframe');
  var $innerdocbody = $innerIframe.contents().find("#innerdocbody");
  var pdfURL = $("#exportpdfa").attr("href");

  $.getScript("/static/plugins/ep_print_preview_pdf/static/js/pdf.worker.js", function(data, textStatus, jqxhr){});
  $.getScript("/static/plugins/ep_print_preview_pdf/static/js/pdf.js", function(data, textStatus, jqxhr){});

  $('body').append("<div id='pdfpreview' style='display:none'></div>");

  // Hide the preview window on clicking elsewhere
  $('body').on('click', function(e){
    $('#pdfpreview').hide();
  });

  $('#pdfpreview').html('<canvas id="the-canvas" style="border-right:1px solid black;width:50%;height:100%;position:absolute;top:0; left:0;bottom:0;z-index:999999999999"/></canvas>');

  $('#previewpdf').on('click', function(e) {
    console.log("foo");
    e.preventDefault();
    previewPdf(pdfURL);
  });
};

function previewPdf(url){
  console.log("Getting", url);
  PDFJS.workerSrc ='/static/plugins/ep_print_preview_pdf/static/js/pdf.worker.js';
  PDFJS.getDocument(url).then(function(pdf) {
    // Using promise to fetch the page
    console.log("um", pdf);
    pdf.getPage(1).then(function(page) {
      console.log("done loading", page);
      var scale = 1.5;
      var viewport = page.getViewport(scale);
      //
      // Prepare canvas using PDF page dimensions
      //
      var canvas = document.getElementById('the-canvas');
      var context = canvas.getContext('2d');
      canvas.height = viewport.height;
      canvas.width = viewport.width;
      //
      // Render PDF page into canvas context
      //
      var renderContext = {
        canvasContext: context,
        viewport: viewport
      };
      page.render(renderContext);
      $('#pdfpreview').show();
    });
  });
}

