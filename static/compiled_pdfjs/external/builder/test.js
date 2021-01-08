/* jshint node:true */
/* globals cat, cd, echo, ls */
'use strict';

require('shelljs/make');

const builder = require('./builder');
const fs = require('fs');
const path = require('path');

const errors = 0;

cd(__dirname);
cd('fixtures');
ls('*-expected.*').forEach((expectationFilename) => {
  const inFilename = expectationFilename.replace('-expected', '');
  const expectation = cat(expectationFilename).trim()
      .replace(/__filename/g, fs.realpathSync(inFilename));
  const outLines = [];

  const outFilename = function (line) {
    outLines.push(line);
  };
  const defines = {
    TRUE: true,
    FALSE: false,
  };
  let out;
  try {
    builder.preprocess(inFilename, outFilename, defines);
    out = outLines.join('\n').trim();
  } catch (e) {
    out = (`Error: ${e.message}`).replace(/^/gm, '//');
  }
  if (out !== expectation) {
    echo(`Assertion failed for ${inFilename}`);
    echo('--------------------------------------------------');
    echo('EXPECTED:');
    echo(expectation);
    echo('--------------------------------------------------');
    echo('ACTUAL');
    echo(out);
    echo('--------------------------------------------------');
    echo();
  }
});

if (errors) {
  echo(`Found ${errors} expectation failures.`);
} else {
  echo('All tests completed without errors.');
}
