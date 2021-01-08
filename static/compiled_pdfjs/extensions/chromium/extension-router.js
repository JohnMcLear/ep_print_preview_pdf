/*
Copyright 2013 Mozilla Foundation

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
/* globals chrome */

'use strict';

(function ExtensionRouterClosure() {
  const VIEWER_URL = chrome.extension.getURL('content/web/viewer.html');
  const CRX_BASE_URL = chrome.extension.getURL('/');

  const schemes = [
    'http',
    'https',
    'ftp',
    'file',
    'chrome-extension',
    // Chromium OS
    'filesystem',
    // Chromium OS, shorthand for filesystem:<origin>/external/
    'drive',
  ];

  /**
   * @param {string} url The URL prefixed with chrome-extension://.../
   * @return {string|undefined} The percent-encoded URL of the (PDF) file.
   */
  function parseExtensionURL(url) {
    url = url.substring(CRX_BASE_URL.length);
    // Find the (url-encoded) colon and verify that the scheme is whitelisted.
    const schemeIndex = url.search(/:|%3A/i);
    if (schemeIndex === -1) {
      return;
    }
    const scheme = url.slice(0, schemeIndex).toLowerCase();
    if (schemes.indexOf(scheme) >= 0) {
      url = url.split('#')[0];
      if (url.charAt(schemeIndex) === ':') {
        url = encodeURIComponent(url);
      }
      return url;
    }
  }

  // TODO(rob): Use declarativeWebRequest once declared URL-encoding is
  //            supported, see http://crbug.com/273589
  //            (or rewrite the query string parser in viewer.js to get it to
  //             recognize the non-URL-encoded PDF URL.)
  chrome.webRequest.onBeforeRequest.addListener((details) => {
    // This listener converts chrome-extension://.../http://...pdf to
    // chrome-extension://.../content/web/viewer.html?file=http%3A%2F%2F...pdf
    let url = parseExtensionURL(details.url);
    if (url) {
      url = `${VIEWER_URL}?file=${url}`;
      const i = details.url.indexOf('#');
      if (i > 0) {
        url += details.url.slice(i);
      }
      console.log(`Redirecting ${details.url} to ${url}`);
      return {redirectUrl: url};
    }
  }, {
    types: ['main_frame', 'sub_frame'],
    urls: schemes.map((scheme) =>
      // Format: "chrome-extension://[EXTENSIONID]/<scheme>*"
      `${CRX_BASE_URL + scheme}*`
    ),
  }, ['blocking']);

  // When session restore is used, viewer pages may be loaded before the
  // webRequest event listener is attached (= page not found).
  // Or the extension could have been crashed (OOM), leaving a sad tab behind.
  // Reload these tabs.
  chrome.tabs.query({
    url: `${CRX_BASE_URL}*:*`,
  }, (tabsFromLastSession) => {
    for (let i = 0; i < tabsFromLastSession.length; ++i) {
      chrome.tabs.reload(tabsFromLastSession[i].id);
    }
  });
  console.log('Set up extension URL router.');

  Object.keys(localStorage).forEach((key) => {
    // The localStorage item is set upon unload by chromecom.js.
    const parsedKey = /^unload-(\d+)-(true|false)-(.+)/.exec(key);
    if (parsedKey) {
      const timeStart = parseInt(parsedKey[1], 10);
      const isHidden = parsedKey[2] === 'true';
      const url = parsedKey[3];
      if (Date.now() - timeStart < 3000) {
        // Is it a new item (younger than 3 seconds)? Assume that the extension
        // just reloaded, so restore the tab (work-around for crbug.com/511670).
        chrome.tabs.create({
          url: `${chrome.runtime.getURL('restoretab.html')
          }?${encodeURIComponent(url)
          }#${encodeURIComponent(localStorage.getItem(key))}`,
          active: !isHidden,
        });
      }
      localStorage.removeItem(key);
    }
  });
})();
