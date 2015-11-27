var _, $, jQuery;
var $ = require('ep_etherpad-lite/static/js/rjquery').$;
var _ = require('ep_etherpad-lite/static/js/underscore');
var padcookie = require('ep_etherpad-lite/static/js/pad_cookie').padcookie;

exports.postAceInit = function(hook, context){
  var $outerIframeContents = $('iframe[name="ace_outer"]').contents();
  var $innerIframe = $outerIframeContents.find('iframe');
  var $innerdocbody = $innerIframe.contents().find("#innerdocbody");
  var pdfURL = $("#exportpdfa").attr("href");

  $('body').append("<div id='pdfpreview' style='display:none;position:absolute;top:0;left:0;width:100%;height:500px;z-index:999999'></div>");

  // Hide the preview window on clicking elsewhere
  $('body').on('click', function(e){
console.log("hiding - - commented out for now");
//    $('#pdfpreview').hide();
  });

  $('#previewpdf').on('click', function(e) {
    e.preventDefault();
    previewPdf(pdfURL);
  });
};

var container = document.getElementById('pdfpreview');

function previewPdf(url){
  // console.log("Getting", url);
  $('#pdfpreview').html('<iframe src="/static/plugins/ep_print_preview_pdf/static/pdfjs/web/viewer.html?file='+url+'" style="width:100%;height:100%;border:none"></iframe>');
  $('#pdfpreview').show();
}

