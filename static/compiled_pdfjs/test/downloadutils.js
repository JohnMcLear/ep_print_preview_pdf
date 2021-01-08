/*
 * Copyright 2014 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* jslint node: true */

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

function downloadFile(file, url, callback, redirects) {
  let completed = false;
  const protocol = /^https:\/\//.test(url) ? https : http;
  protocol.get(url, (response) => {
    let redirectTo;
    if (response.statusCode === 301 || response.statusCode === 302 ||
        response.statusCode === 307 || response.statusCode === 308) {
      if (redirects > 10) {
        callback('Too many redirects');
      }
      redirectTo = response.headers.location;
      redirectTo = require('url').resolve(url, redirectTo);
      downloadFile(file, redirectTo, callback, (redirects || 0) + 1);
      return;
    }
    if (response.statusCode === 404 && url.indexOf('web.archive.org') < 0) {
      // trying waybackmachine
      redirectTo = `http://web.archive.org/web/${url}`;
      downloadFile(file, redirectTo, callback, (redirects || 0) + 1);
      return;
    }

    if (response.statusCode !== 200) {
      if (!completed) {
        completed = true;
        callback(`HTTP ${response.statusCode}`);
      }
      return;
    }
    const stream = fs.createWriteStream(file);
    stream.on('error', (err) => {
      if (!completed) {
        completed = true;
        callback(err);
      }
    });
    response.pipe(stream);
    stream.on('finish', () => {
      stream.close();
      if (!completed) {
        completed = true;
        callback();
      }
    });
  }).on('error', (err) => {
    if (!completed) {
      if (typeof err === 'object' && err.errno === 'ENOTFOUND' &&
          url.indexOf('web.archive.org') < 0) {
        // trying waybackmachine
        const redirectTo = `http://web.archive.org/web/${url}`;
        downloadFile(file, redirectTo, callback, (redirects || 0) + 1);
        return;
      }
      completed = true;
      callback(err);
    }
  });
}

function downloadManifestFiles(manifest, callback) {
  function downloadNext() {
    if (i >= links.length) {
      callback();
      return;
    }
    const file = links[i].file;
    const url = links[i].url;
    console.log(`Downloading ${url} to ${file}...`);
    downloadFile(file, url, (err) => {
      if (err) {
        console.error(`Error during downloading of ${url}: ${err}`);
        fs.writeFileSync(file, ''); // making it empty file
        fs.writeFileSync(`${file}.error`, err);
      }
      i++;
      downloadNext();
    });
  }

  var links = manifest.filter((item) => item.link && !fs.existsSync(item.file)).map((item) => {
    const file = item.file;
    const linkfile = `${file}.link`;
    let url = fs.readFileSync(linkfile).toString();
    url = url.replace(/\s+$/, '');
    return {file, url};
  });

  var i = 0;
  downloadNext();
}

function calculateMD5(file, callback) {
  const hash = crypto.createHash('md5');
  const stream = fs.createReadStream(file);
  stream.on('data', (data) => {
    hash.update(data);
  });
  stream.on('error', (err) => {
    callback(err);
  });
  stream.on('end', () => {
    const result = hash.digest('hex');
    callback(null, result);
  });
}

function verifyManifestFiles(manifest, callback) {
  function verifyNext() {
    if (i >= manifest.length) {
      callback(error);
      return;
    }
    const item = manifest[i];
    if (fs.existsSync(`${item.file}.error`)) {
      console.error(`WARNING: File was not downloaded. See "${
        item.file}.error" file.`);
      error = true;
      i++;
      verifyNext();
      return;
    }
    calculateMD5(item.file, (err, md5) => {
      if (err) {
        console.log(`WARNING: Unable to open file for reading "${err}".`);
        error = true;
      } else if (!item.md5) {
        console.error(`WARNING: Missing md5 for file "${item.file}". ` +
                      `Hash for current file is "${md5}"`);
        error = true;
      } else if (md5 !== item.md5) {
        console.error(`WARNING: MD5 of file "${item.file
        }" does not match file. Expected "${
          item.md5}" computed "${md5}"`);
        error = true;
      }
      i++;
      verifyNext();
    });
  }
  var i = 0;
  var error = false;
  verifyNext();
}

exports.downloadManifestFiles = downloadManifestFiles;
exports.verifyManifestFiles = verifyManifestFiles;
