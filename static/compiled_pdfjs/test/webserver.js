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

const http = require('http');
const path = require('path');
const fs = require('fs');

const mimeTypes = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.xhtml': 'application/xhtml+xml',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.log': 'text/plain',
  '.bcmap': 'application/octet-stream',
  '.properties': 'text/plain',
};

const defaultMimeType = 'application/octet-stream';

function WebServer() {
  this.root = '.';
  this.host = '10.0.0.12';
  this.port = 0;
  this.server = null;
  this.verbose = false;
  this.cacheExpirationTime = 0;
  this.disableRangeRequests = false;
  this.hooks = {
    GET: [],
    POST: [],
  };
}
WebServer.prototype = {
  start(callback) {
    this._ensureNonZeroPort();
    this.server = http.createServer(this._handler.bind(this));
    this.server.listen(this.port, this.host, callback);
    console.log(
        `Server running at http://${this.host}:${this.port}/`);
  },
  stop(callback) {
    this.server.close(callback);
    this.server = null;
  },
  _ensureNonZeroPort() {
    if (!this.port) {
      // If port is 0, a random port will be chosen instead. Do not set a host
      // name to make sure that the port is synchronously set by .listen().
      const server = http.createServer().listen(0);
      const address = server.address();
      // .address().port being available synchronously is merely an
      // implementation detail. So we are defensive here and fall back to some
      // fixed port when the address is not available yet.
      this.port = address ? address.port : 8000;
      server.close();
    }
  },
  _handler(req, res) {
    const url = req.url.replace(/\/\//g, '/');
    const urlParts = /([^?]*)((?:\?(.*))?)/.exec(url);
    const pathPart = decodeURI(urlParts[1]); const
      queryPart = urlParts[3];
    const verbose = this.verbose;

    const methodHooks = this.hooks[req.method];
    if (!methodHooks) {
      res.writeHead(405);
      res.end('Unsupported request method', 'utf8');
      return;
    }
    const handled = methodHooks.some((hook) => hook(req, res));
    if (handled) {
      return;
    }

    if (pathPart === '/favicon.ico') {
      fs.realpath(path.join(this.root, 'test/resources/favicon.ico'),
          checkFile);
      return;
    }

    const disableRangeRequests = this.disableRangeRequests;
    const cacheExpirationTime = this.cacheExpirationTime;

    let filePath;
    fs.realpath(path.join(this.root, pathPart), checkFile);

    function checkFile(err, file) {
      if (err) {
        res.writeHead(404);
        res.end();
        if (verbose) {
          console.error(`${url}: not found`);
        }
        return;
      }
      filePath = file;
      fs.stat(filePath, statFile);
    }

    let fileSize;

    function statFile(err, stats) {
      if (err) {
        res.writeHead(500);
        res.end();
        return;
      }

      fileSize = stats.size;
      const isDir = stats.isDirectory();
      if (isDir && !/\/$/.test(pathPart)) {
        res.setHeader('Location', `${pathPart}/${urlParts[2]}`);
        res.writeHead(301);
        res.end('Redirected', 'utf8');
        return;
      }
      if (isDir) {
        serveDirectoryIndex(filePath);
        return;
      }

      const range = req.headers.range;
      if (range && !disableRangeRequests) {
        const rangesMatches = /^bytes=(\d+)\-(\d+)?/.exec(range);
        if (!rangesMatches) {
          res.writeHead(501);
          res.end('Bad range', 'utf8');
          if (verbose) {
            console.error(`${url}: bad range: "${range}"`);
          }
          return;
        }
        const start = +rangesMatches[1];
        const end = +rangesMatches[2];
        if (verbose) {
          console.log(`${url}: range ${start} - ${end}`);
        }
        serveRequestedFileRange(filePath,
            start,
            isNaN(end) ? fileSize : (end + 1));
        return;
      }
      if (verbose) {
        console.log(url);
      }
      serveRequestedFile(filePath);
    }

    function escapeHTML(untrusted) {
      // Escape untrusted input so that it can safely be used in a HTML response
      // in HTML and in HTML attributes.
      return untrusted
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
    }

    function serveDirectoryIndex(dir) {
      res.setHeader('Content-Type', 'text/html');
      res.writeHead(200);

      if (queryPart === 'frame') {
        res.end(`${'<html><frameset cols=*,200><frame name=pdf>' +
          '<frame src=\"'}${encodeURI(pathPart)
        }?side\"></frameset></html>`, 'utf8');
        return;
      }
      const all = queryPart === 'all';
      fs.readdir(dir, (err, files) => {
        if (err) {
          res.end();
          return;
        }
        res.write(`${'<html><head><meta charset=\"utf-8\"></head><body>' +
                  '<h1>PDFs of '}${pathPart}</h1>\n`);
        if (pathPart !== '/') {
          res.write('<a href=\"..\">..</a><br>\n');
        }
        files.forEach((file) => {
          let stat;
          const item = pathPart + file;
          let href = '';
          let label = '';
          let extraAttributes = '';
          try {
            stat = fs.statSync(path.join(dir, file));
          } catch (e) {
            href = encodeURI(item);
            label = `${file} (${e})`;
            extraAttributes = ' style="color:red"';
          }
          if (stat) {
            if (stat.isDirectory()) {
              href = encodeURI(item);
              label = file;
            } else if (path.extname(file).toLowerCase() === '.pdf') {
              href = `/web/viewer.html?file=${encodeURIComponent(item)}`;
              label = file;
              extraAttributes = ' target="pdf"';
            } else if (all) {
              href = encodeURI(item);
              label = file;
            }
          }
          if (label) {
            res.write(`<a href=\"${escapeHTML(href)}\"${
              extraAttributes}>${escapeHTML(label)}</a><br>\n`);
          }
        });
        if (files.length === 0) {
          res.write('<p>no files found</p>\n');
        }
        if (!all && queryPart !== 'side') {
          res.write('<hr><p>(only PDF files are shown, ' +
            '<a href=\"?all\">show all</a>)</p>\n');
        }
        res.end('</body></html>');
      });
    }

    function serveRequestedFile(filePath) {
      const stream = fs.createReadStream(filePath, {flags: 'rs'});

      stream.on('error', (error) => {
        res.writeHead(500);
        res.end();
      });

      const ext = path.extname(filePath).toLowerCase();
      const contentType = mimeTypes[ext] || defaultMimeType;

      if (!disableRangeRequests) {
        res.setHeader('Accept-Ranges', 'bytes');
      }
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', fileSize);
      if (cacheExpirationTime > 0) {
        const expireTime = new Date();
        expireTime.setSeconds(expireTime.getSeconds() + cacheExpirationTime);
        res.setHeader('Expires', expireTime.toUTCString());
      }
      res.writeHead(200);

      stream.pipe(res);
    }

    function serveRequestedFileRange(filePath, start, end) {
      const stream = fs.createReadStream(filePath, {flags: 'rs', start, end: end - 1});

      stream.on('error', (error) => {
        res.writeHead(500);
        res.end();
      });

      const ext = path.extname(filePath).toLowerCase();
      const contentType = mimeTypes[ext] || defaultMimeType;

      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', (end - start));
      res.setHeader('Content-Range',
          `bytes ${start}-${end - 1}/${fileSize}`);
      res.writeHead(206);

      stream.pipe(res);
    }
  },
};

exports.WebServer = WebServer;
