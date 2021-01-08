/* jshint node:true */
/* globals cat, echo, exit, ls */

'use strict';

function checkIfCrlfIsPresent(files) {
  const failed = [];

  (ls(files)).forEach((file) => {
    if ((cat(file)).match(/.*\r.*/)) {
      failed.push(file);
    }
  });

  if (failed.length) {
    const errorMessage =
      `Please remove carriage return's from\n${failed.join('\n')}\n` +
      'Also check your setting for: git config core.autocrlf.';

    echo();
    echo(errorMessage);
    exit(1);
  }
}

exports.checkIfCrlfIsPresent = checkIfCrlfIsPresent;
