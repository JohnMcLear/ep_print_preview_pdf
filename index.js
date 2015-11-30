var eejs = require('ep_etherpad-lite/node/eejs/');

exports.eejsBlock_exportColumn = function (hook_name, args, cb) {
  args.content = args.content + "<a id='previewpdf'>PREVIEW</a>";
  return cb();
}
