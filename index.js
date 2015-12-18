var eejs = require('ep_etherpad-lite/node/eejs/');

// exports.eejsBlock_exportColumn = function (hook_name, args, cb) {
//   //args.content = args.content + "<a id='previewpdf'>PREVIEW</a>";
//   args.content = args.content + eejs.require("ep_print_preview_pdf/templates/editbarButton.ejs");
//   return cb();
// }

exports.eejsBlock_editbarMenuRight = function (hook_name, args, cb) {
  args.content = eejs.require("ep_print_preview_pdf/templates/editbarButton.ejs") + args.content;
  return cb();
}

exports.eejsBlock_styles = function (hook_name, args, cb) {
  args.content = args.content + eejs.require("ep_print_preview_pdf/templates/styles.html");
  return cb();
}
