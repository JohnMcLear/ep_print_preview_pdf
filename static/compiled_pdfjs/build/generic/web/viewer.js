/* Copyright 2012 Mozilla Foundation
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
/* globals PDFJS, PDFBug, FirefoxCom, Stats, Cache, ProgressBar,
           DownloadManager, getFileName, getPDFFileNameFromURL,
           PDFHistory, Preferences, SidebarView, ViewHistory, Stats,
           PDFThumbnailViewer, URL, noContextMenuHandler, SecondaryToolbar,
           PasswordPrompt, PDFPresentationMode, PDFDocumentProperties, HandTool,
           Promise, PDFLinkService, PDFOutlineView, PDFAttachmentView,
           OverlayManager, PDFFindController, PDFFindBar, PDFViewer,
           PDFRenderingQueue, PresentationModeState, parseQueryString,
           RenderingStates, UNKNOWN_SCALE, DEFAULT_SCALE_VALUE,
           IGNORE_CURRENT_POSITION_ON_ZOOM: true */

'use strict';

const DEFAULT_URL = 'compressed.tracemonkey-pldi-09.pdf';
const DEFAULT_SCALE_DELTA = 1.1;
const MIN_SCALE = 0.25;
const MAX_SCALE = 10.0;
const SCALE_SELECT_CONTAINER_PADDING = 8;
const SCALE_SELECT_PADDING = 22;
const PAGE_NUMBER_LOADING_INDICATOR = 'visiblePageIsLoading';
const DISABLE_AUTO_FETCH_LOADING_BAR_TIMEOUT = 5000;

PDFJS.imageResourcesPath = './images/';
PDFJS.workerSrc = '../build/pdf.worker.js';
PDFJS.cMapUrl = '../web/cmaps/';
PDFJS.cMapPacked = true;

const mozL10n = document.mozL10n || document.webL10n;


const CSS_UNITS = 96.0 / 72.0;
const DEFAULT_SCALE_VALUE = 'auto';
const DEFAULT_SCALE = 1.0;
const UNKNOWN_SCALE = 0;
const MAX_AUTO_SCALE = 1.25;
const SCROLLBAR_PADDING = 40;
const VERTICAL_PADDING = 5;

const NullCharactersRegExp = /\x00/g;

function removeNullCharacters(str) {
  return str.replace(NullCharactersRegExp, '');
}

function getFileName(url) {
  const anchor = url.indexOf('#');
  const query = url.indexOf('?');
  const end = Math.min(
      anchor > 0 ? anchor : url.length,
      query > 0 ? query : url.length);
  return url.substring(url.lastIndexOf('/', end) + 1, end);
}

/**
 * Returns scale factor for the canvas. It makes sense for the HiDPI displays.
 * @return {Object} The object with horizontal (sx) and vertical (sy)
                    scales. The scaled property is set to false if scaling is
                    not required, true otherwise.
 */
function getOutputScale(ctx) {
  const devicePixelRatio = window.devicePixelRatio || 1;
  const backingStoreRatio = ctx.webkitBackingStorePixelRatio ||
                          ctx.mozBackingStorePixelRatio ||
                          ctx.msBackingStorePixelRatio ||
                          ctx.oBackingStorePixelRatio ||
                          ctx.backingStorePixelRatio || 1;
  const pixelRatio = devicePixelRatio / backingStoreRatio;
  return {
    sx: pixelRatio,
    sy: pixelRatio,
    scaled: pixelRatio !== 1,
  };
}

/**
 * Scrolls specified element into view of its parent.
 * @param {Object} element - The element to be visible.
 * @param {Object} spot - An object with optional top and left properties,
 *   specifying the offset from the top left edge.
 * @param {boolean} skipOverflowHiddenElements - Ignore elements that have
 *   the CSS rule `overflow: hidden;` set. The default is false.
 */
function scrollIntoView(element, spot, skipOverflowHiddenElements) {
  // Assuming offsetParent is available (it's not available when viewer is in
  // hidden iframe or object). We have to scroll: if the offsetParent is not set
  // producing the error. See also animationStartedClosure.
  let parent = element.offsetParent;
  if (!parent) {
    console.error('offsetParent is not set -- cannot scroll');
    return;
  }
  const checkOverflow = skipOverflowHiddenElements || false;
  let offsetY = element.offsetTop + element.clientTop;
  let offsetX = element.offsetLeft + element.clientLeft;
  while (parent.clientHeight === parent.scrollHeight ||
         (checkOverflow && getComputedStyle(parent).overflow === 'hidden')) {
    if (parent.dataset._scaleY) {
      offsetY /= parent.dataset._scaleY;
      offsetX /= parent.dataset._scaleX;
    }
    offsetY += parent.offsetTop;
    offsetX += parent.offsetLeft;
    parent = parent.offsetParent;
    if (!parent) {
      return; // no need to scroll
    }
  }
  if (spot) {
    if (spot.top !== undefined) {
      offsetY += spot.top;
    }
    if (spot.left !== undefined) {
      offsetX += spot.left;
      parent.scrollLeft = offsetX;
    }
  }
  parent.scrollTop = offsetY;
}

/**
 * Helper function to start monitoring the scroll event and converting them into
 * PDF.js friendly one: with scroll debounce and scroll direction.
 */
function watchScroll(viewAreaElement, callback) {
  const debounceScroll = function debounceScroll(evt) {
    if (rAF) {
      return;
    }
    // schedule an invocation of scroll for next animation frame.
    rAF = window.requestAnimationFrame(() => {
      rAF = null;

      const currentY = viewAreaElement.scrollTop;
      const lastY = state.lastY;
      if (currentY !== lastY) {
        state.down = currentY > lastY;
      }
      state.lastY = currentY;
      callback(state);
    });
  };

  var state = {
    down: true,
    lastY: viewAreaElement.scrollTop,
    _eventHandler: debounceScroll,
  };

  var rAF = null;
  viewAreaElement.addEventListener('scroll', debounceScroll, true);
  return state;
}

/**
 * Helper function to parse query string (e.g. ?param1=value&parm2=...).
 */
function parseQueryString(query) {
  const parts = query.split('&');
  const params = {};
  for (let i = 0, ii = parts.length; i < ii; ++i) {
    const param = parts[i].split('=');
    const key = param[0].toLowerCase();
    const value = param.length > 1 ? param[1] : null;
    params[decodeURIComponent(key)] = decodeURIComponent(value);
  }
  return params;
}

/**
 * Use binary search to find the index of the first item in a given array which
 * passes a given condition. The items are expected to be sorted in the sense
 * that if the condition is true for one item in the array, then it is also true
 * for all following items.
 *
 * @returns {Number} Index of the first array element to pass the test,
 *                   or |items.length| if no such element exists.
 */
function binarySearchFirstItem(items, condition) {
  let minIndex = 0;
  let maxIndex = items.length - 1;

  if (items.length === 0 || !condition(items[maxIndex])) {
    return items.length;
  }
  if (condition(items[minIndex])) {
    return minIndex;
  }

  while (minIndex < maxIndex) {
    const currentIndex = (minIndex + maxIndex) >> 1;
    const currentItem = items[currentIndex];
    if (condition(currentItem)) {
      maxIndex = currentIndex;
    } else {
      minIndex = currentIndex + 1;
    }
  }
  return minIndex; /* === maxIndex */
}

/**
 *  Approximates float number as a fraction using Farey sequence (max order
 *  of 8).
 *  @param {number} x - Positive float number.
 *  @returns {Array} Estimated fraction: the first array item is a numerator,
 *                   the second one is a denominator.
 */
function approximateFraction(x) {
  // Fast paths for int numbers or their inversions.
  if (Math.floor(x) === x) {
    return [x, 1];
  }
  const xinv = 1 / x;
  const limit = 8;
  if (xinv > limit) {
    return [1, limit];
  } else if (Math.floor(xinv) === xinv) {
    return [1, xinv];
  }

  const x_ = x > 1 ? xinv : x;
  // a/b and c/d are neighbours in Farey sequence.
  let a = 0; let b = 1; let c = 1; let
    d = 1;
  // Limiting search to order 8.
  while (true) {
    // Generating next term in sequence (order of q).
    const p = a + c; const
      q = b + d;
    if (q > limit) {
      break;
    }
    if (x_ <= p / q) {
      c = p; d = q;
    } else {
      a = p; b = q;
    }
  }
  // Select closest of the neighbours to x.
  if (x_ - a / b < c / d - x_) {
    return x_ === x ? [a, b] : [b, a];
  } else {
    return x_ === x ? [c, d] : [d, c];
  }
}

function roundToDivide(x, div) {
  const r = x % div;
  return r === 0 ? x : Math.round(x - r + div);
}

/**
 * Generic helper to find out what elements are visible within a scroll pane.
 */
function getVisibleElements(scrollEl, views, sortByVisibility) {
  const top = scrollEl.scrollTop; const
    bottom = top + scrollEl.clientHeight;
  const left = scrollEl.scrollLeft; const
    right = left + scrollEl.clientWidth;

  function isElementBottomBelowViewTop(view) {
    const element = view.div;
    const elementBottom =
      element.offsetTop + element.clientTop + element.clientHeight;
    return elementBottom > top;
  }

  const visible = []; let view; let element;
  let currentHeight, viewHeight, hiddenHeight, percentHeight;
  let currentWidth, viewWidth;
  const firstVisibleElementInd = (views.length === 0) ? 0
    : binarySearchFirstItem(views, isElementBottomBelowViewTop);

  for (let i = firstVisibleElementInd, ii = views.length; i < ii; i++) {
    view = views[i];
    element = view.div;
    currentHeight = element.offsetTop + element.clientTop;
    viewHeight = element.clientHeight;

    if (currentHeight > bottom) {
      break;
    }

    currentWidth = element.offsetLeft + element.clientLeft;
    viewWidth = element.clientWidth;
    if (currentWidth + viewWidth < left || currentWidth > right) {
      continue;
    }
    hiddenHeight = Math.max(0, top - currentHeight) +
      Math.max(0, currentHeight + viewHeight - bottom);
    percentHeight = ((viewHeight - hiddenHeight) * 100 / viewHeight) | 0;

    visible.push({
      id: view.id,
      x: currentWidth,
      y: currentHeight,
      view,
      percent: percentHeight,
    });
  }

  const first = visible[0];
  const last = visible[visible.length - 1];

  if (sortByVisibility) {
    visible.sort((a, b) => {
      const pc = a.percent - b.percent;
      if (Math.abs(pc) > 0.001) {
        return -pc;
      }
      return a.id - b.id; // ensure stability
    });
  }
  return {first, last, views: visible};
}

/**
 * Event handler to suppress context menu.
 */
function noContextMenuHandler(e) {
  e.preventDefault();
}

/**
 * Returns the filename or guessed filename from the url (see issue 3455).
 * url {String} The original PDF location.
 * @return {String} Guessed PDF file name.
 */
function getPDFFileNameFromURL(url) {
  const reURI = /^(?:([^:]+:)?\/\/[^\/]+)?([^?#]*)(\?[^#]*)?(#.*)?$/;
  //            SCHEME      HOST         1.PATH  2.QUERY   3.REF
  // Pattern to get last matching NAME.pdf
  const reFilename = /[^\/?#=]+\.pdf\b(?!.*\.pdf\b)/i;
  const splitURI = reURI.exec(url);
  let suggestedFilename = reFilename.exec(splitURI[1]) ||
                           reFilename.exec(splitURI[2]) ||
                           reFilename.exec(splitURI[3]);
  if (suggestedFilename) {
    suggestedFilename = suggestedFilename[0];
    if (suggestedFilename.indexOf('%') !== -1) {
      // URL-encoded %2Fpath%2Fto%2Ffile.pdf should be file.pdf
      try {
        suggestedFilename =
          reFilename.exec(decodeURIComponent(suggestedFilename))[0];
      } catch (e) { // Possible (extremely rare) errors:
        // URIError "Malformed URI", e.g. for "%AA.pdf"
        // TypeError "null has no properties", e.g. for "%2F.pdf"
      }
    }
  }
  return suggestedFilename || 'document.pdf';
}

const ProgressBar = (function ProgressBarClosure() {
  function clamp(v, min, max) {
    return Math.min(Math.max(v, min), max);
  }

  function ProgressBar(id, opts) {
    this.visible = true;

    // Fetch the sub-elements for later.
    this.div = document.querySelector(`${id} .progress`);

    // Get the loading bar element, so it can be resized to fit the viewer.
    this.bar = this.div.parentNode;

    // Get options, with sensible defaults.
    this.height = opts.height || 100;
    this.width = opts.width || 100;
    this.units = opts.units || '%';

    // Initialize heights.
    this.div.style.height = this.height + this.units;
    this.percent = 0;
  }

  ProgressBar.prototype = {

    updateBar: function ProgressBar_updateBar() {
      if (this._indeterminate) {
        this.div.classList.add('indeterminate');
        this.div.style.width = this.width + this.units;
        return;
      }

      this.div.classList.remove('indeterminate');
      const progressSize = this.width * this._percent / 100;
      this.div.style.width = progressSize + this.units;
    },

    get percent() {
      return this._percent;
    },

    set percent(val) {
      this._indeterminate = isNaN(val);
      this._percent = clamp(val, 0, 100);
      this.updateBar();
    },

    setWidth: function ProgressBar_setWidth(viewer) {
      if (viewer) {
        const container = viewer.parentNode;
        const scrollbarWidth = container.offsetWidth - viewer.offsetWidth;
        if (scrollbarWidth > 0) {
          this.bar.setAttribute('style', `width: calc(100% - ${
            scrollbarWidth}px);`);
        }
      }
    },

    hide: function ProgressBar_hide() {
      if (!this.visible) {
        return;
      }
      this.visible = false;
      this.bar.classList.add('hidden');
      document.body.classList.remove('loadingInProgress');
    },

    show: function ProgressBar_show() {
      if (this.visible) {
        return;
      }
      this.visible = true;
      document.body.classList.add('loadingInProgress');
      this.bar.classList.remove('hidden');
    },
  };

  return ProgressBar;
})();


const DEFAULT_PREFERENCES = {
  showPreviousViewOnLoad: true,
  defaultZoomValue: '',
  sidebarViewOnLoad: 0,
  enableHandToolOnLoad: false,
  enableWebGL: false,
  pdfBugEnabled: false,
  disableRange: false,
  disableStream: false,
  disableAutoFetch: false,
  disableFontFace: false,
  disableTextLayer: false,
  useOnlyCssZoom: false,
  externalLinkTarget: 0,
};


const SidebarView = {
  NONE: 0,
  THUMBS: 1,
  OUTLINE: 2,
  ATTACHMENTS: 3,
};

/**
 * Preferences - Utility for storing persistent settings.
 *   Used for settings that should be applied to all opened documents,
 *   or every time the viewer is loaded.
 */
const Preferences = {
  prefs: Object.create(DEFAULT_PREFERENCES),
  isInitializedPromiseResolved: false,
  initializedPromise: null,

  /**
   * Initialize and fetch the current preference values from storage.
   * @return {Promise} A promise that is resolved when the preferences
   *                   have been initialized.
   */
  initialize: function preferencesInitialize() {
    return this.initializedPromise =
        this._readFromStorage(DEFAULT_PREFERENCES).then((prefObj) => {
          this.isInitializedPromiseResolved = true;
          if (prefObj) {
            this.prefs = prefObj;
          }
        });
  },

  /**
   * Stub function for writing preferences to storage.
   * NOTE: This should be overridden by a build-specific function defined below.
   * @param {Object} prefObj The preferences that should be written to storage.
   * @return {Promise} A promise that is resolved when the preference values
   *                   have been written.
   */
  _writeToStorage: function preferences_writeToStorage(prefObj) {
    return Promise.resolve();
  },

  /**
   * Stub function for reading preferences from storage.
   * NOTE: This should be overridden by a build-specific function defined below.
   * @param {Object} prefObj The preferences that should be read from storage.
   * @return {Promise} A promise that is resolved with an {Object} containing
   *                   the preferences that have been read.
   */
  _readFromStorage: function preferences_readFromStorage(prefObj) {
    return Promise.resolve();
  },

  /**
   * Reset the preferences to their default values and update storage.
   * @return {Promise} A promise that is resolved when the preference values
   *                   have been reset.
   */
  reset: function preferencesReset() {
    return this.initializedPromise.then(() => {
      this.prefs = Object.create(DEFAULT_PREFERENCES);
      return this._writeToStorage(DEFAULT_PREFERENCES);
    });
  },

  /**
   * Replace the current preference values with the ones from storage.
   * @return {Promise} A promise that is resolved when the preference values
   *                   have been updated.
   */
  reload: function preferencesReload() {
    return this.initializedPromise.then(() => {
      this._readFromStorage(DEFAULT_PREFERENCES).then((prefObj) => {
        if (prefObj) {
          this.prefs = prefObj;
        }
      });
    });
  },

  /**
   * Set the value of a preference.
   * @param {string} name The name of the preference that should be changed.
   * @param {boolean|number|string} value The new value of the preference.
   * @return {Promise} A promise that is resolved when the value has been set,
   *                   provided that the preference exists and the types match.
   */
  set: function preferencesSet(name, value) {
    return this.initializedPromise.then(() => {
      if (DEFAULT_PREFERENCES[name] === undefined) {
        throw new Error(`preferencesSet: '${name}' is undefined.`);
      } else if (value === undefined) {
        throw new Error('preferencesSet: no value is specified.');
      }
      const valueType = typeof value;
      const defaultType = typeof DEFAULT_PREFERENCES[name];

      if (valueType !== defaultType) {
        if (valueType === 'number' && defaultType === 'string') {
          value = value.toString();
        } else {
          throw new Error(`Preferences_set: '${value}' is a \"${
            valueType}\", expected \"${defaultType}\".`);
        }
      } else if (valueType === 'number' && (value | 0) !== value) {
        throw new Error(`Preferences_set: '${value
        }' must be an \"integer\".`);
      }
      this.prefs[name] = value;
      return this._writeToStorage(this.prefs);
    });
  },

  /**
   * Get the value of a preference.
   * @param {string} name The name of the preference whose value is requested.
   * @return {Promise} A promise that is resolved with a {boolean|number|string}
   *                   containing the value of the preference.
   */
  get: function preferencesGet(name) {
    return this.initializedPromise.then(() => {
      const defaultValue = DEFAULT_PREFERENCES[name];

      if (defaultValue === undefined) {
        throw new Error(`preferencesGet: '${name}' is undefined.`);
      } else {
        const prefValue = this.prefs[name];

        if (prefValue !== undefined) {
          return prefValue;
        }
      }
      return defaultValue;
    });
  },
};


Preferences._writeToStorage = function (prefObj) {
  return new Promise((resolve) => {
    localStorage.setItem('pdfjs.preferences', JSON.stringify(prefObj));
    resolve();
  });
};

Preferences._readFromStorage = function (prefObj) {
  return new Promise((resolve) => {
    const readPrefs = JSON.parse(localStorage.getItem('pdfjs.preferences'));
    resolve(readPrefs);
  });
};


(function mozPrintCallbackPolyfillClosure() {
  if ('mozPrintCallback' in document.createElement('canvas')) {
    return;
  }
  // Cause positive result on feature-detection:
  HTMLCanvasElement.prototype.mozPrintCallback = undefined;

  let canvases; // During print task: non-live NodeList of <canvas> elements
  let index; // Index of <canvas> element that is being processed

  const print = window.print;
  window.print = function print() {
    if (canvases) {
      console.warn('Ignored window.print() because of a pending print job.');
      return;
    }
    try {
      dispatchEvent('beforeprint');
    } finally {
      canvases = document.querySelectorAll('canvas');
      index = -1;
      next();
    }
  };

  function dispatchEvent(eventType) {
    const event = document.createEvent('CustomEvent');
    event.initCustomEvent(eventType, false, false, 'custom');
    window.dispatchEvent(event);
  }

  function next() {
    if (!canvases) {
      return; // Print task cancelled by user (state reset in abort())
    }

    renderProgress();
    if (++index < canvases.length) {
      const canvas = canvases[index];
      if (typeof canvas.mozPrintCallback === 'function') {
        canvas.mozPrintCallback({
          context: canvas.getContext('2d'),
          abort,
          done: next,
        });
      } else {
        next();
      }
    } else {
      renderProgress();
      print.call(window);
      setTimeout(abort, 20); // Tidy-up
    }
  }

  function abort() {
    if (canvases) {
      canvases = null;
      renderProgress();
      dispatchEvent('afterprint');
    }
  }

  function renderProgress() {
    const progressContainer = document.getElementById('mozPrintCallback-shim');
    if (canvases && canvases.length) {
      const progress = Math.round(100 * index / canvases.length);
      const progressBar = progressContainer.querySelector('progress');
      const progressPerc = progressContainer.querySelector('.relative-progress');
      progressBar.value = progress;
      progressPerc.textContent = `${progress}%`;
      progressContainer.removeAttribute('hidden');
      progressContainer.onclick = abort;
    } else {
      progressContainer.setAttribute('hidden', '');
    }
  }

  const hasAttachEvent = !!document.attachEvent;

  window.addEventListener('keydown', (event) => {
    // Intercept Cmd/Ctrl + P in all browsers.
    // Also intercept Cmd/Ctrl + Shift + P in Chrome and Opera
    if (event.keyCode === 80/* P*/ && (event.ctrlKey || event.metaKey) &&
        !event.altKey && (!event.shiftKey || window.chrome || window.opera)) {
      window.print();
      if (hasAttachEvent) {
        // Only attachEvent can cancel Ctrl + P dialog in IE <=10
        // attachEvent is gone in IE11, so the dialog will re-appear in IE11.
        return;
      }
      event.preventDefault();
      if (event.stopImmediatePropagation) {
        event.stopImmediatePropagation();
      } else {
        event.stopPropagation();
      }
      return;
    }
    if (event.keyCode === 27 && canvases) { // Esc
      abort();
    }
  }, true);
  if (hasAttachEvent) {
    document.attachEvent('onkeydown', (event) => {
      event = event || window.event;
      if (event.keyCode === 80/* P*/ && event.ctrlKey) {
        event.keyCode = 0;
        return false;
      }
    });
  }

  if ('onbeforeprint' in window) {
    // Do not propagate before/afterprint events when they are not triggered
    // from within this polyfill. (FF/IE).
    const stopPropagationIfNeeded = function (event) {
      if (event.detail !== 'custom' && event.stopImmediatePropagation) {
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener('beforeprint', stopPropagationIfNeeded, false);
    window.addEventListener('afterprint', stopPropagationIfNeeded, false);
  }
})();


const DownloadManager = (function DownloadManagerClosure() {
  function download(blobUrl, filename) {
    const a = document.createElement('a');
    if (a.click) {
      // Use a.click() if available. Otherwise, Chrome might show
      // "Unsafe JavaScript attempt to initiate a navigation change
      //  for frame with URL" and not open the PDF at all.
      // Supported by (not mentioned = untested):
      // - Firefox 6 - 19 (4- does not support a.click, 5 ignores a.click)
      // - Chrome 19 - 26 (18- does not support a.click)
      // - Opera 9 - 12.15
      // - Internet Explorer 6 - 10
      // - Safari 6 (5.1- does not support a.click)
      a.href = blobUrl;
      a.target = '_parent';
      // Use a.download if available. This increases the likelihood that
      // the file is downloaded instead of opened by another PDF plugin.
      if ('download' in a) {
        a.download = filename;
      }
      // <a> must be in the document for IE and recent Firefox versions.
      // (otherwise .click() is ignored)
      (document.body || document.documentElement).appendChild(a);
      a.click();
      a.parentNode.removeChild(a);
    } else {
      if (window.top === window &&
          blobUrl.split('#')[0] === window.location.href.split('#')[0]) {
        // If _parent == self, then opening an identical URL with different
        // location hash will only cause a navigation, not a download.
        const padCharacter = blobUrl.indexOf('?') === -1 ? '?' : '&';
        blobUrl = blobUrl.replace(/#|$/, `${padCharacter}$&`);
      }
      window.open(blobUrl, '_parent');
    }
  }

  function DownloadManager() {}

  DownloadManager.prototype = {
    downloadUrl: function DownloadManager_downloadUrl(url, filename) {
      if (!PDFJS.isValidUrl(url, true)) {
        return; // restricted/invalid URL
      }

      download(`${url}#pdfjs.action=download`, filename);
    },

    downloadData: function DownloadManager_downloadData(data, filename,
        contentType) {
      if (navigator.msSaveBlob) { // IE10 and above
        return navigator.msSaveBlob(new Blob([data], {type: contentType}),
            filename);
      }

      const blobUrl = PDFJS.createObjectURL(data, contentType);
      download(blobUrl, filename);
    },

    download: function DownloadManager_download(blob, url, filename) {
      if (!URL) {
        // URL.createObjectURL is not supported
        this.downloadUrl(url, filename);
        return;
      }

      if (navigator.msSaveBlob) {
        // IE10 / IE11
        if (!navigator.msSaveBlob(blob, filename)) {
          this.downloadUrl(url, filename);
        }
        return;
      }

      const blobUrl = URL.createObjectURL(blob);
      download(blobUrl, filename);
    },
  };

  return DownloadManager;
})();


const DEFAULT_VIEW_HISTORY_CACHE_SIZE = 20;

/**
 * View History - This is a utility for saving various view parameters for
 *                recently opened files.
 *
 * The way that the view parameters are stored depends on how PDF.js is built,
 * for 'node make <flag>' the following cases exist:
 *  - FIREFOX or MOZCENTRAL - uses sessionStorage.
 *  - GENERIC or CHROME     - uses localStorage, if it is available.
 */
const ViewHistory = (function ViewHistoryClosure() {
  function ViewHistory(fingerprint, cacheSize) {
    this.fingerprint = fingerprint;
    this.cacheSize = cacheSize || DEFAULT_VIEW_HISTORY_CACHE_SIZE;
    this.isInitializedPromiseResolved = false;
    this.initializedPromise =
        this._readFromStorage().then((databaseStr) => {
          this.isInitializedPromiseResolved = true;

          const database = JSON.parse(databaseStr || '{}');
          if (!('files' in database)) {
            database.files = [];
          }
          if (database.files.length >= this.cacheSize) {
            database.files.shift();
          }
          let index;
          for (let i = 0, length = database.files.length; i < length; i++) {
            const branch = database.files[i];
            if (branch.fingerprint === this.fingerprint) {
              index = i;
              break;
            }
          }
          if (typeof index !== 'number') {
            index = database.files.push({fingerprint: this.fingerprint}) - 1;
          }
          this.file = database.files[index];
          this.database = database;
        });
  }

  ViewHistory.prototype = {
    _writeToStorage: function ViewHistory_writeToStorage() {
      return new Promise((resolve) => {
        const databaseStr = JSON.stringify(this.database);


        localStorage.setItem('database', databaseStr);
        resolve();
      });
    },

    _readFromStorage: function ViewHistory_readFromStorage() {
      return new Promise((resolve) => {
        resolve(localStorage.getItem('database'));
      });
    },

    set: function ViewHistory_set(name, val) {
      if (!this.isInitializedPromiseResolved) {
        return;
      }
      this.file[name] = val;
      return this._writeToStorage();
    },

    setMultiple: function ViewHistory_setMultiple(properties) {
      if (!this.isInitializedPromiseResolved) {
        return;
      }
      for (const name in properties) {
        this.file[name] = properties[name];
      }
      return this._writeToStorage();
    },

    get: function ViewHistory_get(name, defaultValue) {
      if (!this.isInitializedPromiseResolved) {
        return defaultValue;
      }
      return this.file[name] || defaultValue;
    },
  };

  return ViewHistory;
})();


/**
 * Creates a "search bar" given a set of DOM elements that act as controls
 * for searching or for setting search preferences in the UI. This object
 * also sets up the appropriate events for the controls. Actual searching
 * is done by PDFFindController.
 */
const PDFFindBar = (function PDFFindBarClosure() {
  function PDFFindBar(options) {
    this.opened = false;
    this.bar = options.bar || null;
    this.toggleButton = options.toggleButton || null;
    this.findField = options.findField || null;
    this.highlightAll = options.highlightAllCheckbox || null;
    this.caseSensitive = options.caseSensitiveCheckbox || null;
    this.findMsg = options.findMsg || null;
    this.findResultsCount = options.findResultsCount || null;
    this.findStatusIcon = options.findStatusIcon || null;
    this.findPreviousButton = options.findPreviousButton || null;
    this.findNextButton = options.findNextButton || null;
    this.findController = options.findController || null;

    if (this.findController === null) {
      throw new Error('PDFFindBar cannot be used without a ' +
                      'PDFFindController instance.');
    }

    // Add event listeners to the DOM elements.
    const self = this;
    this.toggleButton.addEventListener('click', () => {
      self.toggle();
    });

    this.findField.addEventListener('input', () => {
      self.dispatchEvent('');
    });

    this.bar.addEventListener('keydown', (evt) => {
      switch (evt.keyCode) {
        case 13: // Enter
          if (evt.target === self.findField) {
            self.dispatchEvent('again', evt.shiftKey);
          }
          break;
        case 27: // Escape
          self.close();
          break;
      }
    });

    this.findPreviousButton.addEventListener('click', () => {
      self.dispatchEvent('again', true);
    });

    this.findNextButton.addEventListener('click', () => {
      self.dispatchEvent('again', false);
    });

    this.highlightAll.addEventListener('click', () => {
      self.dispatchEvent('highlightallchange');
    });

    this.caseSensitive.addEventListener('click', () => {
      self.dispatchEvent('casesensitivitychange');
    });
  }

  PDFFindBar.prototype = {
    dispatchEvent: function PDFFindBar_dispatchEvent(type, findPrev) {
      const event = document.createEvent('CustomEvent');
      event.initCustomEvent(`find${type}`, true, true, {
        query: this.findField.value,
        caseSensitive: this.caseSensitive.checked,
        highlightAll: this.highlightAll.checked,
        findPrevious: findPrev,
      });
      return window.dispatchEvent(event);
    },

    updateUIState:
        function PDFFindBar_updateUIState(state, previous, matchCount) {
          let notFound = false;
          let findMsg = '';
          let status = '';

          switch (state) {
            case FindStates.FIND_FOUND:
              break;

            case FindStates.FIND_PENDING:
              status = 'pending';
              break;

            case FindStates.FIND_NOTFOUND:
              findMsg = mozL10n.get('find_not_found', null, 'Phrase not found');
              notFound = true;
              break;

            case FindStates.FIND_WRAPPED:
              if (previous) {
                findMsg = mozL10n.get('find_reached_top', null,
                    'Reached top of document, continued from bottom');
              } else {
                findMsg = mozL10n.get('find_reached_bottom', null,
                    'Reached end of document, continued from top');
              }
              break;
          }

          if (notFound) {
            this.findField.classList.add('notFound');
          } else {
            this.findField.classList.remove('notFound');
          }

          this.findField.setAttribute('data-status', status);
          this.findMsg.textContent = findMsg;

          this.updateResultsCount(matchCount);
        },

    updateResultsCount(matchCount) {
      if (!this.findResultsCount) {
        return; // no UI control is provided
      }

      // If there are no matches, hide the counter
      if (!matchCount) {
        this.findResultsCount.classList.add('hidden');
        return;
      }

      // Create the match counter
      this.findResultsCount.textContent = matchCount.toLocaleString();

      // Show the counter
      this.findResultsCount.classList.remove('hidden');
    },

    open: function PDFFindBar_open() {
      if (!this.opened) {
        this.opened = true;
        this.toggleButton.classList.add('toggled');
        this.bar.classList.remove('hidden');
      }
      this.findField.select();
      this.findField.focus();
    },

    close: function PDFFindBar_close() {
      if (!this.opened) {
        return;
      }
      this.opened = false;
      this.toggleButton.classList.remove('toggled');
      this.bar.classList.add('hidden');
      this.findController.active = false;
    },

    toggle: function PDFFindBar_toggle() {
      if (this.opened) {
        this.close();
      } else {
        this.open();
      }
    },
  };
  return PDFFindBar;
})();


var FindStates = {
  FIND_FOUND: 0,
  FIND_NOTFOUND: 1,
  FIND_WRAPPED: 2,
  FIND_PENDING: 3,
};

const FIND_SCROLL_OFFSET_TOP = -50;
const FIND_SCROLL_OFFSET_LEFT = -400;

/**
 * Provides "search" or "find" functionality for the PDF.
 * This object actually performs the search for a given string.
 */
const PDFFindController = (function PDFFindControllerClosure() {
  function PDFFindController(options) {
    this.startedTextExtraction = false;
    this.extractTextPromises = [];
    this.pendingFindMatches = {};
    this.active = false; // If active, find results will be highlighted.
    this.pageContents = []; // Stores the text for each page.
    this.pageMatches = [];
    this.matchCount = 0;
    this.selected = { // Currently selected match.
      pageIdx: -1,
      matchIdx: -1,
    };
    this.offset = { // Where the find algorithm currently is in the document.
      pageIdx: null,
      matchIdx: null,
    };
    this.pagesToSearch = null;
    this.resumePageIdx = null;
    this.state = null;
    this.dirtyMatch = false;
    this.findTimeout = null;
    this.pdfViewer = options.pdfViewer || null;
    this.integratedFind = options.integratedFind || false;
    this.charactersToNormalize = {
      '\u2018': '\'', // Left single quotation mark
      '\u2019': '\'', // Right single quotation mark
      '\u201A': '\'', // Single low-9 quotation mark
      '\u201B': '\'', // Single high-reversed-9 quotation mark
      '\u201C': '"', // Left double quotation mark
      '\u201D': '"', // Right double quotation mark
      '\u201E': '"', // Double low-9 quotation mark
      '\u201F': '"', // Double high-reversed-9 quotation mark
      '\u00BC': '1/4', // Vulgar fraction one quarter
      '\u00BD': '1/2', // Vulgar fraction one half
      '\u00BE': '3/4', // Vulgar fraction three quarters
      '\u00A0': ' ', // No-break space
    };
    this.findBar = options.findBar || null;

    // Compile the regular expression for text normalization once
    const replace = Object.keys(this.charactersToNormalize).join('');
    this.normalizationRegex = new RegExp(`[${replace}]`, 'g');

    const events = [
      'find',
      'findagain',
      'findhighlightallchange',
      'findcasesensitivitychange',
    ];

    this.firstPagePromise = new Promise((resolve) => {
      this.resolveFirstPage = resolve;
    });
    this.handleEvent = this.handleEvent.bind(this);

    for (let i = 0, len = events.length; i < len; i++) {
      window.addEventListener(events[i], this.handleEvent);
    }
  }

  PDFFindController.prototype = {
    setFindBar: function PDFFindController_setFindBar(findBar) {
      this.findBar = findBar;
    },

    reset: function PDFFindController_reset() {
      this.startedTextExtraction = false;
      this.extractTextPromises = [];
      this.active = false;
    },

    normalize: function PDFFindController_normalize(text) {
      const self = this;
      return text.replace(this.normalizationRegex, (ch) => self.charactersToNormalize[ch]);
    },

    calcFindMatch: function PDFFindController_calcFindMatch(pageIndex) {
      let pageContent = this.normalize(this.pageContents[pageIndex]);
      let query = this.normalize(this.state.query);
      const caseSensitive = this.state.caseSensitive;
      const queryLen = query.length;

      if (queryLen === 0) {
        // Do nothing: the matches should be wiped out already.
        return;
      }

      if (!caseSensitive) {
        pageContent = pageContent.toLowerCase();
        query = query.toLowerCase();
      }

      const matches = [];
      let matchIdx = -queryLen;
      while (true) {
        matchIdx = pageContent.indexOf(query, matchIdx + queryLen);
        if (matchIdx === -1) {
          break;
        }
        matches.push(matchIdx);
      }
      this.pageMatches[pageIndex] = matches;
      this.updatePage(pageIndex);
      if (this.resumePageIdx === pageIndex) {
        this.resumePageIdx = null;
        this.nextPageMatch();
      }

      // Update the matches count
      if (matches.length > 0) {
        this.matchCount += matches.length;
        this.updateUIResultsCount();
      }
    },

    extractText: function PDFFindController_extractText() {
      if (this.startedTextExtraction) {
        return;
      }
      this.startedTextExtraction = true;

      this.pageContents = [];
      const extractTextPromisesResolves = [];
      const numPages = this.pdfViewer.pagesCount;
      for (let i = 0; i < numPages; i++) {
        this.extractTextPromises.push(new Promise((resolve) => {
          extractTextPromisesResolves.push(resolve);
        }));
      }

      const self = this;
      function extractPageText(pageIndex) {
        self.pdfViewer.getPageTextContent(pageIndex).then(
            (textContent) => {
              const textItems = textContent.items;
              const str = [];

              for (let i = 0, len = textItems.length; i < len; i++) {
                str.push(textItems[i].str);
              }

              // Store the pageContent as a string.
              self.pageContents.push(str.join(''));

              extractTextPromisesResolves[pageIndex](pageIndex);
              if ((pageIndex + 1) < self.pdfViewer.pagesCount) {
                extractPageText(pageIndex + 1);
              }
            }
        );
      }
      extractPageText(0);
    },

    handleEvent: function PDFFindController_handleEvent(e) {
      if (this.state === null || e.type !== 'findagain') {
        this.dirtyMatch = true;
      }
      this.state = e.detail;
      this.updateUIState(FindStates.FIND_PENDING);

      this.firstPagePromise.then(() => {
        this.extractText();

        clearTimeout(this.findTimeout);
        if (e.type === 'find') {
          // Only trigger the find action after 250ms of silence.
          this.findTimeout = setTimeout(this.nextMatch.bind(this), 250);
        } else {
          this.nextMatch();
        }
      });
    },

    updatePage: function PDFFindController_updatePage(index) {
      if (this.selected.pageIdx === index) {
        // If the page is selected, scroll the page into view, which triggers
        // rendering the page, which adds the textLayer. Once the textLayer is
        // build, it will scroll onto the selected match.
        this.pdfViewer.scrollPageIntoView(index + 1);
      }

      const page = this.pdfViewer.getPageView(index);
      if (page.textLayer) {
        page.textLayer.updateMatches();
      }
    },

    nextMatch: function PDFFindController_nextMatch() {
      const previous = this.state.findPrevious;
      const currentPageIndex = this.pdfViewer.currentPageNumber - 1;
      const numPages = this.pdfViewer.pagesCount;

      this.active = true;

      if (this.dirtyMatch) {
        // Need to recalculate the matches, reset everything.
        this.dirtyMatch = false;
        this.selected.pageIdx = this.selected.matchIdx = -1;
        this.offset.pageIdx = currentPageIndex;
        this.offset.matchIdx = null;
        this.hadMatch = false;
        this.resumePageIdx = null;
        this.pageMatches = [];
        this.matchCount = 0;
        const self = this;

        for (let i = 0; i < numPages; i++) {
          // Wipe out any previous highlighted matches.
          this.updatePage(i);

          // As soon as the text is extracted start finding the matches.
          if (!(i in this.pendingFindMatches)) {
            this.pendingFindMatches[i] = true;
            this.extractTextPromises[i].then((pageIdx) => {
              delete self.pendingFindMatches[pageIdx];
              self.calcFindMatch(pageIdx);
            });
          }
        }
      }

      // If there's no query there's no point in searching.
      if (this.state.query === '') {
        this.updateUIState(FindStates.FIND_FOUND);
        return;
      }

      // If we're waiting on a page, we return since we can't do anything else.
      if (this.resumePageIdx) {
        return;
      }

      const offset = this.offset;
      // Keep track of how many pages we should maximally iterate through.
      this.pagesToSearch = numPages;
      // If there's already a matchIdx that means we are iterating through a
      // page's matches.
      if (offset.matchIdx !== null) {
        const numPageMatches = this.pageMatches[offset.pageIdx].length;
        if ((!previous && offset.matchIdx + 1 < numPageMatches) ||
            (previous && offset.matchIdx > 0)) {
          // The simple case; we just have advance the matchIdx to select
          // the next match on the page.
          this.hadMatch = true;
          offset.matchIdx = (previous ? offset.matchIdx - 1
            : offset.matchIdx + 1);
          this.updateMatch(true);
          return;
        }
        // We went beyond the current page's matches, so we advance to
        // the next page.
        this.advanceOffsetPage(previous);
      }
      // Start searching through the page.
      this.nextPageMatch();
    },

    matchesReady: function PDFFindController_matchesReady(matches) {
      const offset = this.offset;
      const numMatches = matches.length;
      const previous = this.state.findPrevious;

      if (numMatches) {
        // There were matches for the page, so initialize the matchIdx.
        this.hadMatch = true;
        offset.matchIdx = (previous ? numMatches - 1 : 0);
        this.updateMatch(true);
        return true;
      } else {
        // No matches, so attempt to search the next page.
        this.advanceOffsetPage(previous);
        if (offset.wrapped) {
          offset.matchIdx = null;
          if (this.pagesToSearch < 0) {
            // No point in wrapping again, there were no matches.
            this.updateMatch(false);
            // while matches were not found, searching for a page
            // with matches should nevertheless halt.
            return true;
          }
        }
        // Matches were not found (and searching is not done).
        return false;
      }
    },

    /**
     * The method is called back from the text layer when match presentation
     * is updated.
     * @param {number} pageIndex - page index.
     * @param {number} index - match index.
     * @param {Array} elements - text layer div elements array.
     * @param {number} beginIdx - start index of the div array for the match.
     * @param {number} endIdx - end index of the div array for the match.
     */
    updateMatchPosition: function PDFFindController_updateMatchPosition(
        pageIndex, index, elements, beginIdx, endIdx) {
      if (this.selected.matchIdx === index &&
          this.selected.pageIdx === pageIndex) {
        const spot = {
          top: FIND_SCROLL_OFFSET_TOP,
          left: FIND_SCROLL_OFFSET_LEFT,
        };
        scrollIntoView(elements[beginIdx], spot,
            /* skipOverflowHiddenElements = */ true);
      }
    },

    nextPageMatch: function PDFFindController_nextPageMatch() {
      if (this.resumePageIdx !== null) {
        console.error('There can only be one pending page.');
      }
      do {
        const pageIdx = this.offset.pageIdx;
        var matches = this.pageMatches[pageIdx];
        if (!matches) {
          // The matches don't exist yet for processing by "matchesReady",
          // so set a resume point for when they do exist.
          this.resumePageIdx = pageIdx;
          break;
        }
      } while (!this.matchesReady(matches));
    },

    advanceOffsetPage: function PDFFindController_advanceOffsetPage(previous) {
      const offset = this.offset;
      const numPages = this.extractTextPromises.length;
      offset.pageIdx = (previous ? offset.pageIdx - 1 : offset.pageIdx + 1);
      offset.matchIdx = null;

      this.pagesToSearch--;

      if (offset.pageIdx >= numPages || offset.pageIdx < 0) {
        offset.pageIdx = (previous ? numPages - 1 : 0);
        offset.wrapped = true;
      }
    },

    updateMatch: function PDFFindController_updateMatch(found) {
      let state = FindStates.FIND_NOTFOUND;
      const wrapped = this.offset.wrapped;
      this.offset.wrapped = false;

      if (found) {
        const previousPage = this.selected.pageIdx;
        this.selected.pageIdx = this.offset.pageIdx;
        this.selected.matchIdx = this.offset.matchIdx;
        state = (wrapped ? FindStates.FIND_WRAPPED : FindStates.FIND_FOUND);
        // Update the currently selected page to wipe out any selected matches.
        if (previousPage !== -1 && previousPage !== this.selected.pageIdx) {
          this.updatePage(previousPage);
        }
      }

      this.updateUIState(state, this.state.findPrevious);
      if (this.selected.pageIdx !== -1) {
        this.updatePage(this.selected.pageIdx);
      }
    },

    updateUIResultsCount:
        function PDFFindController_updateUIResultsCount() {
          if (this.findBar === null) {
            throw new Error('PDFFindController is not initialized with a ' +
          'PDFFindBar instance.');
          }
          this.findBar.updateResultsCount(this.matchCount);
        },

    updateUIState: function PDFFindController_updateUIState(state, previous) {
      if (this.integratedFind) {
        FirefoxCom.request('updateFindControlState',
            {result: state, findPrevious: previous});
        return;
      }
      if (this.findBar === null) {
        throw new Error('PDFFindController is not initialized with a ' +
                        'PDFFindBar instance.');
      }
      this.findBar.updateUIState(state, previous, this.matchCount);
    },
  };
  return PDFFindController;
})();


/**
 * Performs navigation functions inside PDF, such as opening specified page,
 * or destination.
 * @class
 * @implements {IPDFLinkService}
 */
const PDFLinkService = (function () {
  /**
   * @constructs PDFLinkService
   */
  function PDFLinkService() {
    this.baseUrl = null;
    this.pdfDocument = null;
    this.pdfViewer = null;
    this.pdfHistory = null;

    this._pagesRefCache = null;
  }

  PDFLinkService.prototype = {
    setDocument: function PDFLinkService_setDocument(pdfDocument, baseUrl) {
      this.baseUrl = baseUrl;
      this.pdfDocument = pdfDocument;
      this._pagesRefCache = Object.create(null);
    },

    setViewer: function PDFLinkService_setViewer(pdfViewer) {
      this.pdfViewer = pdfViewer;
    },

    setHistory: function PDFLinkService_setHistory(pdfHistory) {
      this.pdfHistory = pdfHistory;
    },

    /**
     * @returns {number}
     */
    get pagesCount() {
      return this.pdfDocument.numPages;
    },

    /**
     * @returns {number}
     */
    get page() {
      return this.pdfViewer.currentPageNumber;
    },

    /**
     * @param {number} value
     */
    set page(value) {
      this.pdfViewer.currentPageNumber = value;
    },

    /**
     * @param dest - The PDF destination object.
     */
    navigateTo: function PDFLinkService_navigateTo(dest) {
      let destString = '';
      const self = this;

      var goToDestination = function (destRef) {
        // dest array looks like that: <page-ref> </XYZ|FitXXX> <args..>
        let pageNumber = destRef instanceof Object
          ? self._pagesRefCache[`${destRef.num} ${destRef.gen} R`]
          : (destRef + 1);
        if (pageNumber) {
          if (pageNumber > self.pagesCount) {
            pageNumber = self.pagesCount;
          }
          self.pdfViewer.scrollPageIntoView(pageNumber, dest);

          if (self.pdfHistory) {
            // Update the browsing history.
            self.pdfHistory.push({
              dest,
              hash: destString,
              page: pageNumber,
            });
          }
        } else {
          self.pdfDocument.getPageIndex(destRef).then((pageIndex) => {
            const pageNum = pageIndex + 1;
            const cacheKey = `${destRef.num} ${destRef.gen} R`;
            self._pagesRefCache[cacheKey] = pageNum;
            goToDestination(destRef);
          });
        }
      };

      let destinationPromise;
      if (typeof dest === 'string') {
        destString = dest;
        destinationPromise = this.pdfDocument.getDestination(dest);
      } else {
        destinationPromise = Promise.resolve(dest);
      }
      destinationPromise.then((destination) => {
        dest = destination;
        if (!(destination instanceof Array)) {
          return; // invalid destination
        }
        goToDestination(destination[0]);
      });
    },

    /**
     * @param dest - The PDF destination object.
     * @returns {string} The hyperlink to the PDF object.
     */
    getDestinationHash: function PDFLinkService_getDestinationHash(dest) {
      if (typeof dest === 'string') {
        return this.getAnchorUrl(`#${escape(dest)}`);
      }
      if (dest instanceof Array) {
        const destRef = dest[0]; // see navigateTo method for dest format
        const pageNumber = destRef instanceof Object
          ? this._pagesRefCache[`${destRef.num} ${destRef.gen} R`]
          : (destRef + 1);
        if (pageNumber) {
          let pdfOpenParams = this.getAnchorUrl(`#page=${pageNumber}`);
          const destKind = dest[1];
          if (typeof destKind === 'object' && 'name' in destKind &&
              destKind.name === 'XYZ') {
            let scale = (dest[4] || this.pdfViewer.currentScaleValue);
            const scaleNumber = parseFloat(scale);
            if (scaleNumber) {
              scale = scaleNumber * 100;
            }
            pdfOpenParams += `&zoom=${scale}`;
            if (dest[2] || dest[3]) {
              pdfOpenParams += `,${dest[2] || 0},${dest[3] || 0}`;
            }
          }
          return pdfOpenParams;
        }
      }
      return '';
    },

    /**
     * Prefix the full url on anchor links to make sure that links are resolved
     * relative to the current URL instead of the one defined in <base href>.
     * @param {String} anchor The anchor hash, including the #.
     * @returns {string} The hyperlink to the PDF object.
     */
    getAnchorUrl: function PDFLinkService_getAnchorUrl(anchor) {
      return (this.baseUrl || '') + anchor;
    },

    /**
     * @param {string} hash
     */
    setHash: function PDFLinkService_setHash(hash) {
      if (hash.indexOf('=') >= 0) {
        const params = parseQueryString(hash);
        // borrowing syntax from "Parameters for Opening PDF Files"
        if ('nameddest' in params) {
          if (this.pdfHistory) {
            this.pdfHistory.updateNextHashParam(params.nameddest);
          }
          this.navigateTo(params.nameddest);
          return;
        }
        let pageNumber, dest;
        if ('page' in params) {
          pageNumber = (params.page | 0) || 1;
        }
        if ('zoom' in params) {
          // Build the destination array.
          const zoomArgs = params.zoom.split(','); // scale,left,top
          const zoomArg = zoomArgs[0];
          const zoomArgNumber = parseFloat(zoomArg);

          if (zoomArg.indexOf('Fit') === -1) {
            // If the zoomArg is a number, it has to get divided by 100. If it's
            // a string, it should stay as it is.
            dest = [null,
              {name: 'XYZ'},
              zoomArgs.length > 1 ? (zoomArgs[1] | 0) : null,
              zoomArgs.length > 2 ? (zoomArgs[2] | 0) : null,
              (zoomArgNumber ? zoomArgNumber / 100 : zoomArg)];
          } else if (zoomArg === 'Fit' || zoomArg === 'FitB') {
            dest = [null, {name: zoomArg}];
          } else if ((zoomArg === 'FitH' || zoomArg === 'FitBH') ||
                       (zoomArg === 'FitV' || zoomArg === 'FitBV')) {
            dest = [null,
              {name: zoomArg},
              zoomArgs.length > 1 ? (zoomArgs[1] | 0) : null];
          } else if (zoomArg === 'FitR') {
            if (zoomArgs.length !== 5) {
              console.error('PDFLinkService_setHash: ' +
                              'Not enough parameters for \'FitR\'.');
            } else {
              dest = [null,
                {name: zoomArg},
                (zoomArgs[1] | 0),
                (zoomArgs[2] | 0),
                (zoomArgs[3] | 0),
                (zoomArgs[4] | 0)];
            }
          } else {
            console.error(`PDFLinkService_setHash: '${zoomArg
            }' is not a valid zoom value.`);
          }
        }
        if (dest) {
          this.pdfViewer.scrollPageIntoView(pageNumber || this.page, dest);
        } else if (pageNumber) {
          this.page = pageNumber; // simple page
        }
        if ('pagemode' in params) {
          const event = document.createEvent('CustomEvent');
          event.initCustomEvent('pagemode', true, true, {
            mode: params.pagemode,
          });
          this.pdfViewer.container.dispatchEvent(event);
        }
      } else if (/^\d+$/.test(hash)) { // page number
        this.page = hash;
      } else { // named destination
        if (this.pdfHistory) {
          this.pdfHistory.updateNextHashParam(unescape(hash));
        }
        this.navigateTo(unescape(hash));
      }
    },

    /**
     * @param {string} action
     */
    executeNamedAction: function PDFLinkService_executeNamedAction(action) {
      // See PDF reference, table 8.45 - Named action
      switch (action) {
        case 'GoBack':
          if (this.pdfHistory) {
            this.pdfHistory.back();
          }
          break;

        case 'GoForward':
          if (this.pdfHistory) {
            this.pdfHistory.forward();
          }
          break;

        case 'NextPage':
          this.page++;
          break;

        case 'PrevPage':
          this.page--;
          break;

        case 'LastPage':
          this.page = this.pagesCount;
          break;

        case 'FirstPage':
          this.page = 1;
          break;

        default:
          break; // No action according to spec
      }

      const event = document.createEvent('CustomEvent');
      event.initCustomEvent('namedaction', true, true, {
        action,
      });
      this.pdfViewer.container.dispatchEvent(event);
    },

    /**
     * @param {number} pageNum - page number.
     * @param {Object} pageRef - reference to the page.
     */
    cachePageRef: function PDFLinkService_cachePageRef(pageNum, pageRef) {
      const refStr = `${pageRef.num} ${pageRef.gen} R`;
      this._pagesRefCache[refStr] = pageNum;
    },
  };

  return PDFLinkService;
})();


const PDFHistory = (function () {
  function PDFHistory(options) {
    this.linkService = options.linkService;

    this.initialized = false;
    this.initialDestination = null;
    this.initialBookmark = null;
  }

  PDFHistory.prototype = {
    /**
     * @param {string} fingerprint
     * @param {IPDFLinkService} linkService
     */
    initialize: function pdfHistoryInitialize(fingerprint) {
      this.initialized = true;
      this.reInitialized = false;
      this.allowHashChange = true;
      this.historyUnlocked = true;
      this.isViewerInPresentationMode = false;

      this.previousHash = window.location.hash.substring(1);
      this.currentBookmark = '';
      this.currentPage = 0;
      this.updatePreviousBookmark = false;
      this.previousBookmark = '';
      this.previousPage = 0;
      this.nextHashParam = '';

      this.fingerprint = fingerprint;
      this.currentUid = this.uid = 0;
      this.current = {};

      const state = window.history.state;
      if (this._isStateObjectDefined(state)) {
        // This corresponds to navigating back to the document
        // from another page in the browser history.
        if (state.target.dest) {
          this.initialDestination = state.target.dest;
        } else {
          this.initialBookmark = state.target.hash;
        }
        this.currentUid = state.uid;
        this.uid = state.uid + 1;
        this.current = state.target;
      } else {
        // This corresponds to the loading of a new document.
        if (state && state.fingerprint &&
          this.fingerprint !== state.fingerprint) {
          // Reinitialize the browsing history when a new document
          // is opened in the web viewer.
          this.reInitialized = true;
        }
        this._pushOrReplaceState({fingerprint: this.fingerprint}, true);
      }

      const self = this;
      window.addEventListener('popstate', (evt) => {
        if (!self.historyUnlocked) {
          return;
        }
        if (evt.state) {
          // Move back/forward in the history.
          self._goTo(evt.state);
          return;
        }

        // If the state is not set, then the user tried to navigate to a
        // different hash by manually editing the URL and pressing Enter, or by
        // clicking on an in-page link (e.g. the "current view" link).
        // Save the current view state to the browser history.

        // Note: In Firefox, history.null could also be null after an in-page
        // navigation to the same URL, and without dispatching the popstate
        // event: https://bugzilla.mozilla.org/show_bug.cgi?id=1183881

        if (self.uid === 0) {
          // Replace the previous state if it was not explicitly set.
          const previousParams = (self.previousHash && self.currentBookmark &&
            self.previousHash !== self.currentBookmark)
            ? {hash: self.currentBookmark, page: self.currentPage}
            : {page: 1};
          replacePreviousHistoryState(previousParams, () => {
            updateHistoryWithCurrentHash();
          });
        } else {
          updateHistoryWithCurrentHash();
        }
      }, false);


      function updateHistoryWithCurrentHash() {
        self.previousHash = window.location.hash.slice(1);
        self._pushToHistory({hash: self.previousHash}, false, true);
        self._updatePreviousBookmark();
      }

      function replacePreviousHistoryState(params, callback) {
        // To modify the previous history entry, the following happens:
        // 1. history.back()
        // 2. _pushToHistory, which calls history.replaceState( ... )
        // 3. history.forward()
        // Because a navigation via the history API does not immediately update
        // the history state, the popstate event is used for synchronization.
        self.historyUnlocked = false;

        // Suppress the hashchange event to avoid side effects caused by
        // navigating back and forward.
        self.allowHashChange = false;
        window.addEventListener('popstate', rewriteHistoryAfterBack);
        history.back();

        function rewriteHistoryAfterBack() {
          window.removeEventListener('popstate', rewriteHistoryAfterBack);
          window.addEventListener('popstate', rewriteHistoryAfterForward);
          self._pushToHistory(params, false, true);
          history.forward();
        }
        function rewriteHistoryAfterForward() {
          window.removeEventListener('popstate', rewriteHistoryAfterForward);
          self.allowHashChange = true;
          self.historyUnlocked = true;
          callback();
        }
      }

      function pdfHistoryBeforeUnload() {
        const previousParams = self._getPreviousParams(null, true);
        if (previousParams) {
          const replacePrevious = (!self.current.dest &&
          self.current.hash !== self.previousHash);
          self._pushToHistory(previousParams, false, replacePrevious);
          self._updatePreviousBookmark();
        }
        // Remove the event listener when navigating away from the document,
        // since 'beforeunload' prevents Firefox from caching the document.
        window.removeEventListener('beforeunload', pdfHistoryBeforeUnload,
            false);
      }

      window.addEventListener('beforeunload', pdfHistoryBeforeUnload, false);

      window.addEventListener('pageshow', (evt) => {
        // If the entire viewer (including the PDF file) is cached in
        // the browser, we need to reattach the 'beforeunload' event listener
        // since the 'DOMContentLoaded' event is not fired on 'pageshow'.
        window.addEventListener('beforeunload', pdfHistoryBeforeUnload, false);
      }, false);

      window.addEventListener('presentationmodechanged', (e) => {
        self.isViewerInPresentationMode = !!e.detail.active;
      });
    },

    clearHistoryState: function pdfHistory_clearHistoryState() {
      this._pushOrReplaceState(null, true);
    },

    _isStateObjectDefined: function pdfHistory_isStateObjectDefined(state) {
      return (state && state.uid >= 0 &&
      state.fingerprint && this.fingerprint === state.fingerprint &&
      state.target && state.target.hash) ? true : false;
    },

    _pushOrReplaceState: function pdfHistory_pushOrReplaceState(stateObj,
        replace) {
      if (replace) {
        window.history.replaceState(stateObj, '', document.URL);
      } else {
        window.history.pushState(stateObj, '', document.URL);
      }
    },

    get isHashChangeUnlocked() {
      if (!this.initialized) {
        return true;
      }
      return this.allowHashChange;
    },

    _updatePreviousBookmark: function pdfHistory_updatePreviousBookmark() {
      if (this.updatePreviousBookmark &&
        this.currentBookmark && this.currentPage) {
        this.previousBookmark = this.currentBookmark;
        this.previousPage = this.currentPage;
        this.updatePreviousBookmark = false;
      }
    },

    updateCurrentBookmark: function pdfHistoryUpdateCurrentBookmark(bookmark,
        pageNum) {
      if (this.initialized) {
        this.currentBookmark = bookmark.substring(1);
        this.currentPage = pageNum | 0;
        this._updatePreviousBookmark();
      }
    },

    updateNextHashParam: function pdfHistoryUpdateNextHashParam(param) {
      if (this.initialized) {
        this.nextHashParam = param;
      }
    },

    push: function pdfHistoryPush(params, isInitialBookmark) {
      if (!(this.initialized && this.historyUnlocked)) {
        return;
      }
      if (params.dest && !params.hash) {
        params.hash = (this.current.hash && this.current.dest &&
        this.current.dest === params.dest)
          ? this.current.hash
          : this.linkService.getDestinationHash(params.dest).split('#')[1];
      }
      if (params.page) {
        params.page |= 0;
      }
      if (isInitialBookmark) {
        const target = window.history.state.target;
        if (!target) {
          // Invoked when the user specifies an initial bookmark,
          // thus setting initialBookmark, when the document is loaded.
          this._pushToHistory(params, false);
          this.previousHash = window.location.hash.substring(1);
        }
        this.updatePreviousBookmark = this.nextHashParam ? false : true;
        if (target) {
          // If the current document is reloaded,
          // avoid creating duplicate entries in the history.
          this._updatePreviousBookmark();
        }
        return;
      }
      if (this.nextHashParam) {
        if (this.nextHashParam === params.hash) {
          this.nextHashParam = null;
          this.updatePreviousBookmark = true;
          return;
        } else {
          this.nextHashParam = null;
        }
      }

      if (params.hash) {
        if (this.current.hash) {
          if (this.current.hash !== params.hash) {
            this._pushToHistory(params, true);
          } else {
            if (!this.current.page && params.page) {
              this._pushToHistory(params, false, true);
            }
            this.updatePreviousBookmark = true;
          }
        } else {
          this._pushToHistory(params, true);
        }
      } else if (this.current.page && params.page &&
        this.current.page !== params.page) {
        this._pushToHistory(params, true);
      }
    },

    _getPreviousParams: function pdfHistory_getPreviousParams(onlyCheckPage,
        beforeUnload) {
      if (!(this.currentBookmark && this.currentPage)) {
        return null;
      } else if (this.updatePreviousBookmark) {
        this.updatePreviousBookmark = false;
      }
      if (this.uid > 0 && !(this.previousBookmark && this.previousPage)) {
        // Prevent the history from getting stuck in the current state,
        // effectively preventing the user from going back/forward in
        // the history.
        //
        // This happens if the current position in the document didn't change
        // when the history was previously updated. The reasons for this are
        // either:
        // 1. The current zoom value is such that the document does not need to,
        //    or cannot, be scrolled to display the destination.
        // 2. The previous destination is broken, and doesn't actally point to a
        //    position within the document.
        //    (This is either due to a bad PDF generator, or the user making a
        //     mistake when entering a destination in the hash parameters.)
        return null;
      }
      if ((!this.current.dest && !onlyCheckPage) || beforeUnload) {
        if (this.previousBookmark === this.currentBookmark) {
          return null;
        }
      } else if (this.current.page || onlyCheckPage) {
        if (this.previousPage === this.currentPage) {
          return null;
        }
      } else {
        return null;
      }
      const params = {hash: this.currentBookmark, page: this.currentPage};
      if (this.isViewerInPresentationMode) {
        params.hash = null;
      }
      return params;
    },

    _stateObj: function pdfHistory_stateObj(params) {
      return {fingerprint: this.fingerprint, uid: this.uid, target: params};
    },

    _pushToHistory: function pdfHistory_pushToHistory(params,
        addPrevious, overwrite) {
      if (!this.initialized) {
        return;
      }
      if (!params.hash && params.page) {
        params.hash = (`page=${params.page}`);
      }
      if (addPrevious && !overwrite) {
        const previousParams = this._getPreviousParams();
        if (previousParams) {
          const replacePrevious = (!this.current.dest &&
          this.current.hash !== this.previousHash);
          this._pushToHistory(previousParams, false, replacePrevious);
        }
      }
      this._pushOrReplaceState(this._stateObj(params),
          (overwrite || this.uid === 0));
      this.currentUid = this.uid++;
      this.current = params;
      this.updatePreviousBookmark = true;
    },

    _goTo: function pdfHistory_goTo(state) {
      if (!(this.initialized && this.historyUnlocked &&
        this._isStateObjectDefined(state))) {
        return;
      }
      if (!this.reInitialized && state.uid < this.currentUid) {
        const previousParams = this._getPreviousParams(true);
        if (previousParams) {
          this._pushToHistory(this.current, false);
          this._pushToHistory(previousParams, false);
          this.currentUid = state.uid;
          window.history.back();
          return;
        }
      }
      this.historyUnlocked = false;

      if (state.target.dest) {
        this.linkService.navigateTo(state.target.dest);
      } else {
        this.linkService.setHash(state.target.hash);
      }
      this.currentUid = state.uid;
      if (state.uid > this.uid) {
        this.uid = state.uid;
      }
      this.current = state.target;
      this.updatePreviousBookmark = true;

      const currentHash = window.location.hash.substring(1);
      if (this.previousHash !== currentHash) {
        this.allowHashChange = false;
      }
      this.previousHash = currentHash;

      this.historyUnlocked = true;
    },

    back: function pdfHistoryBack() {
      this.go(-1);
    },

    forward: function pdfHistoryForward() {
      this.go(1);
    },

    go: function pdfHistoryGo(direction) {
      if (this.initialized && this.historyUnlocked) {
        const state = window.history.state;
        if (direction === -1 && state && state.uid > 0) {
          window.history.back();
        } else if (direction === 1 && state && state.uid < (this.uid - 1)) {
          window.history.forward();
        }
      }
    },
  };

  return PDFHistory;
})();


const SecondaryToolbar = {
  opened: false,
  previousContainerHeight: null,
  newContainerHeight: null,

  initialize: function secondaryToolbarInitialize(options) {
    this.toolbar = options.toolbar;
    this.buttonContainer = this.toolbar.firstElementChild;

    // Define the toolbar buttons.
    this.toggleButton = options.toggleButton;
    this.presentationModeButton = options.presentationModeButton;
    this.openFile = options.openFile;
    this.print = options.print;
    this.download = options.download;
    this.viewBookmark = options.viewBookmark;
    this.firstPage = options.firstPage;
    this.lastPage = options.lastPage;
    this.pageRotateCw = options.pageRotateCw;
    this.pageRotateCcw = options.pageRotateCcw;
    this.documentPropertiesButton = options.documentPropertiesButton;

    // Attach the event listeners.
    const elements = [
      // Button to toggle the visibility of the secondary toolbar:
      {element: this.toggleButton, handler: this.toggle},
      // All items within the secondary toolbar
      // (except for toggleHandTool, hand_tool.js is responsible for it):
      {element: this.presentationModeButton,
        handler: this.presentationModeClick},
      {element: this.openFile, handler: this.openFileClick},
      {element: this.print, handler: this.printClick},
      {element: this.download, handler: this.downloadClick},
      {element: this.viewBookmark, handler: this.viewBookmarkClick},
      {element: this.firstPage, handler: this.firstPageClick},
      {element: this.lastPage, handler: this.lastPageClick},
      {element: this.pageRotateCw, handler: this.pageRotateCwClick},
      {element: this.pageRotateCcw, handler: this.pageRotateCcwClick},
      {element: this.documentPropertiesButton,
        handler: this.documentPropertiesClick},
    ];

    for (const item in elements) {
      const element = elements[item].element;
      if (element) {
        element.addEventListener('click', elements[item].handler.bind(this));
      }
    }
  },

  // Event handling functions.
  presentationModeClick: function secondaryToolbarPresentationModeClick(evt) {
    PDFViewerApplication.requestPresentationMode();
    this.close();
  },

  openFileClick: function secondaryToolbarOpenFileClick(evt) {
    document.getElementById('fileInput').click();
    this.close();
  },

  printClick: function secondaryToolbarPrintClick(evt) {
    window.print();
    this.close();
  },

  downloadClick: function secondaryToolbarDownloadClick(evt) {
    PDFViewerApplication.download();
    this.close();
  },

  viewBookmarkClick: function secondaryToolbarViewBookmarkClick(evt) {
    this.close();
  },

  firstPageClick: function secondaryToolbarFirstPageClick(evt) {
    PDFViewerApplication.page = 1;
    this.close();
  },

  lastPageClick: function secondaryToolbarLastPageClick(evt) {
    if (PDFViewerApplication.pdfDocument) {
      PDFViewerApplication.page = PDFViewerApplication.pagesCount;
    }
    this.close();
  },

  pageRotateCwClick: function secondaryToolbarPageRotateCwClick(evt) {
    PDFViewerApplication.rotatePages(90);
  },

  pageRotateCcwClick: function secondaryToolbarPageRotateCcwClick(evt) {
    PDFViewerApplication.rotatePages(-90);
  },

  documentPropertiesClick: function secondaryToolbarDocumentPropsClick(evt) {
    PDFViewerApplication.pdfDocumentProperties.open();
    this.close();
  },

  // Misc. functions for interacting with the toolbar.
  setMaxHeight: function secondaryToolbarSetMaxHeight(container) {
    if (!container || !this.buttonContainer) {
      return;
    }
    this.newContainerHeight = container.clientHeight;
    if (this.previousContainerHeight === this.newContainerHeight) {
      return;
    }
    this.buttonContainer.setAttribute('style',
        `max-height: ${this.newContainerHeight - SCROLLBAR_PADDING}px;`);
    this.previousContainerHeight = this.newContainerHeight;
  },

  open: function secondaryToolbarOpen() {
    if (this.opened) {
      return;
    }
    this.opened = true;
    this.toggleButton.classList.add('toggled');
    this.toolbar.classList.remove('hidden');
  },

  close: function secondaryToolbarClose(target) {
    if (!this.opened) {
      return;
    } else if (target && !this.toolbar.contains(target)) {
      return;
    }
    this.opened = false;
    this.toolbar.classList.add('hidden');
    this.toggleButton.classList.remove('toggled');
  },

  toggle: function secondaryToolbarToggle() {
    if (this.opened) {
      this.close();
    } else {
      this.open();
    }
  },
};


const DELAY_BEFORE_RESETTING_SWITCH_IN_PROGRESS = 1500; // in ms
const DELAY_BEFORE_HIDING_CONTROLS = 3000; // in ms
const ACTIVE_SELECTOR = 'pdfPresentationMode';
const CONTROLS_SELECTOR = 'pdfPresentationModeControls';

/**
 * @typedef {Object} PDFPresentationModeOptions
 * @property {HTMLDivElement} container - The container for the viewer element.
 * @property {HTMLDivElement} viewer - (optional) The viewer element.
 * @property {PDFViewer} pdfViewer - The document viewer.
 * @property {PDFThumbnailViewer} pdfThumbnailViewer - (optional) The thumbnail
 *   viewer.
 * @property {Array} contextMenuItems - (optional) The menuitems that are added
 *   to the context menu in Presentation Mode.
 */

/**
 * @class
 */
const PDFPresentationMode = (function PDFPresentationModeClosure() {
  /**
   * @constructs PDFPresentationMode
   * @param {PDFPresentationModeOptions} options
   */
  function PDFPresentationMode(options) {
    this.container = options.container;
    this.viewer = options.viewer || options.container.firstElementChild;
    this.pdfViewer = options.pdfViewer;
    this.pdfThumbnailViewer = options.pdfThumbnailViewer || null;
    const contextMenuItems = options.contextMenuItems || null;

    this.active = false;
    this.args = null;
    this.contextMenuOpen = false;
    this.mouseScrollTimeStamp = 0;
    this.mouseScrollDelta = 0;

    if (contextMenuItems) {
      for (let i = 0, ii = contextMenuItems.length; i < ii; i++) {
        const item = contextMenuItems[i];
        item.element.addEventListener('click', function (handler) {
          this.contextMenuOpen = false;
          handler();
        }.bind(this, item.handler));
      }
    }
  }

  PDFPresentationMode.prototype = {
    /**
     * Request the browser to enter fullscreen mode.
     * @returns {boolean} Indicating if the request was successful.
     */
    request: function PDFPresentationMode_request() {
      if (this.switchInProgress || this.active ||
          !this.viewer.hasChildNodes()) {
        return false;
      }
      this._addFullscreenChangeListeners();
      this._setSwitchInProgress();
      this._notifyStateChange();

      if (this.container.requestFullscreen) {
        this.container.requestFullscreen();
      } else if (this.container.mozRequestFullScreen) {
        this.container.mozRequestFullScreen();
      } else if (this.container.webkitRequestFullscreen) {
        this.container.webkitRequestFullscreen(Element.ALLOW_KEYBOARD_INPUT);
      } else if (this.container.msRequestFullscreen) {
        this.container.msRequestFullscreen();
      } else {
        return false;
      }

      this.args = {
        page: this.pdfViewer.currentPageNumber,
        previousScale: this.pdfViewer.currentScaleValue,
      };

      return true;
    },

    /**
     * Switches page when the user scrolls (using a scroll wheel or a touchpad)
     * with large enough motion, to prevent accidental page switches.
     * @param {number} delta - The delta value from the mouse event.
     */
    mouseScroll: function PDFPresentationMode_mouseScroll(delta) {
      if (!this.active) {
        return;
      }
      const MOUSE_SCROLL_COOLDOWN_TIME = 50;
      const PAGE_SWITCH_THRESHOLD = 120;
      const PageSwitchDirection = {
        UP: -1,
        DOWN: 1,
      };

      const currentTime = (new Date()).getTime();
      const storedTime = this.mouseScrollTimeStamp;

      // If we've already switched page, avoid accidentally switching again.
      if (currentTime > storedTime &&
          currentTime - storedTime < MOUSE_SCROLL_COOLDOWN_TIME) {
        return;
      }
      // If the scroll direction changed, reset the accumulated scroll delta.
      if ((this.mouseScrollDelta > 0 && delta < 0) ||
          (this.mouseScrollDelta < 0 && delta > 0)) {
        this._resetMouseScrollState();
      }
      this.mouseScrollDelta += delta;

      if (Math.abs(this.mouseScrollDelta) >= PAGE_SWITCH_THRESHOLD) {
        const pageSwitchDirection = (this.mouseScrollDelta > 0)
          ? PageSwitchDirection.UP : PageSwitchDirection.DOWN;
        const page = this.pdfViewer.currentPageNumber;
        this._resetMouseScrollState();

        // If we're at the first/last page, we don't need to do anything.
        if ((page === 1 && pageSwitchDirection === PageSwitchDirection.UP) ||
            (page === this.pdfViewer.pagesCount &&
             pageSwitchDirection === PageSwitchDirection.DOWN)) {
          return;
        }
        this.pdfViewer.currentPageNumber = (page + pageSwitchDirection);
        this.mouseScrollTimeStamp = currentTime;
      }
    },

    get isFullscreen() {
      return !!(document.fullscreenElement ||
                document.mozFullScreen ||
                document.webkitIsFullScreen ||
                document.msFullscreenElement);
    },

    /**
     * @private
     */
    _notifyStateChange: function PDFPresentationMode_notifyStateChange() {
      const event = document.createEvent('CustomEvent');
      event.initCustomEvent('presentationmodechanged', true, true, {
        active: this.active,
        switchInProgress: !!this.switchInProgress,
      });
      window.dispatchEvent(event);
    },

    /**
     * Used to initialize a timeout when requesting Presentation Mode,
     * i.e. when the browser is requested to enter fullscreen mode.
     * This timeout is used to prevent the current page from being scrolled
     * partially, or completely, out of view when entering Presentation Mode.
     * NOTE: This issue seems limited to certain zoom levels (e.g. page-width).
     * @private
     */
    _setSwitchInProgress: function PDFPresentationMode_setSwitchInProgress() {
      if (this.switchInProgress) {
        clearTimeout(this.switchInProgress);
      }
      this.switchInProgress = setTimeout(() => {
        this._removeFullscreenChangeListeners();
        delete this.switchInProgress;
        this._notifyStateChange();
      }, DELAY_BEFORE_RESETTING_SWITCH_IN_PROGRESS);
    },

    /**
     * @private
     */
    _resetSwitchInProgress:
        function PDFPresentationMode_resetSwitchInProgress() {
          if (this.switchInProgress) {
            clearTimeout(this.switchInProgress);
            delete this.switchInProgress;
          }
        },

    /**
     * @private
     */
    _enter: function PDFPresentationMode_enter() {
      this.active = true;
      this._resetSwitchInProgress();
      this._notifyStateChange();
      this.container.classList.add(ACTIVE_SELECTOR);

      // Ensure that the correct page is scrolled into view when entering
      // Presentation Mode, by waiting until fullscreen mode in enabled.
      setTimeout(() => {
        this.pdfViewer.currentPageNumber = this.args.page;
        this.pdfViewer.currentScaleValue = 'page-fit';
      }, 0);

      this._addWindowListeners();
      this._showControls();
      this.contextMenuOpen = false;
      this.container.setAttribute('contextmenu', 'viewerContextMenu');

      // Text selection is disabled in Presentation Mode, thus it's not possible
      // for the user to deselect text that is selected (e.g. with "Select all")
      // when entering Presentation Mode, hence we remove any active selection.
      window.getSelection().removeAllRanges();
    },

    /**
     * @private
     */
    _exit: function PDFPresentationMode_exit() {
      const page = this.pdfViewer.currentPageNumber;
      this.container.classList.remove(ACTIVE_SELECTOR);

      // Ensure that the correct page is scrolled into view when exiting
      // Presentation Mode, by waiting until fullscreen mode is disabled.
      setTimeout(() => {
        this.active = false;
        this._removeFullscreenChangeListeners();
        this._notifyStateChange();

        this.pdfViewer.currentScaleValue = this.args.previousScale;
        this.pdfViewer.currentPageNumber = page;
        this.args = null;
      }, 0);

      this._removeWindowListeners();
      this._hideControls();
      this._resetMouseScrollState();
      this.container.removeAttribute('contextmenu');
      this.contextMenuOpen = false;

      if (this.pdfThumbnailViewer) {
        this.pdfThumbnailViewer.ensureThumbnailVisible(page);
      }
    },

    /**
     * @private
     */
    _mouseDown: function PDFPresentationMode_mouseDown(evt) {
      if (this.contextMenuOpen) {
        this.contextMenuOpen = false;
        evt.preventDefault();
        return;
      }
      if (evt.button === 0) {
        // Enable clicking of links in presentation mode. Please note:
        // Only links pointing to destinations in the current PDF document work.
        const isInternalLink = (evt.target.href &&
                              evt.target.classList.contains('internalLink'));
        if (!isInternalLink) {
          // Unless an internal link was clicked, advance one page.
          evt.preventDefault();
          this.pdfViewer.currentPageNumber += (evt.shiftKey ? -1 : 1);
        }
      }
    },

    /**
     * @private
     */
    _contextMenu: function PDFPresentationMode_contextMenu() {
      this.contextMenuOpen = true;
    },

    /**
     * @private
     */
    _showControls: function PDFPresentationMode_showControls() {
      if (this.controlsTimeout) {
        clearTimeout(this.controlsTimeout);
      } else {
        this.container.classList.add(CONTROLS_SELECTOR);
      }
      this.controlsTimeout = setTimeout(() => {
        this.container.classList.remove(CONTROLS_SELECTOR);
        delete this.controlsTimeout;
      }, DELAY_BEFORE_HIDING_CONTROLS);
    },

    /**
     * @private
     */
    _hideControls: function PDFPresentationMode_hideControls() {
      if (!this.controlsTimeout) {
        return;
      }
      clearTimeout(this.controlsTimeout);
      this.container.classList.remove(CONTROLS_SELECTOR);
      delete this.controlsTimeout;
    },

    /**
     * Resets the properties used for tracking mouse scrolling events.
     * @private
     */
    _resetMouseScrollState:
        function PDFPresentationMode_resetMouseScrollState() {
          this.mouseScrollTimeStamp = 0;
          this.mouseScrollDelta = 0;
        },

    /**
     * @private
     */
    _addWindowListeners: function PDFPresentationMode_addWindowListeners() {
      this.showControlsBind = this._showControls.bind(this);
      this.mouseDownBind = this._mouseDown.bind(this);
      this.resetMouseScrollStateBind = this._resetMouseScrollState.bind(this);
      this.contextMenuBind = this._contextMenu.bind(this);

      window.addEventListener('mousemove', this.showControlsBind);
      window.addEventListener('mousedown', this.mouseDownBind);
      window.addEventListener('keydown', this.resetMouseScrollStateBind);
      window.addEventListener('contextmenu', this.contextMenuBind);
    },

    /**
     * @private
     */
    _removeWindowListeners:
        function PDFPresentationMode_removeWindowListeners() {
          window.removeEventListener('mousemove', this.showControlsBind);
          window.removeEventListener('mousedown', this.mouseDownBind);
          window.removeEventListener('keydown', this.resetMouseScrollStateBind);
          window.removeEventListener('contextmenu', this.contextMenuBind);

          delete this.showControlsBind;
          delete this.mouseDownBind;
          delete this.resetMouseScrollStateBind;
          delete this.contextMenuBind;
        },

    /**
     * @private
     */
    _fullscreenChange: function PDFPresentationMode_fullscreenChange() {
      if (this.isFullscreen) {
        this._enter();
      } else {
        this._exit();
      }
    },

    /**
     * @private
     */
    _addFullscreenChangeListeners:
        function PDFPresentationMode_addFullscreenChangeListeners() {
          this.fullscreenChangeBind = this._fullscreenChange.bind(this);

          window.addEventListener('fullscreenchange', this.fullscreenChangeBind);
          window.addEventListener('mozfullscreenchange', this.fullscreenChangeBind);
          window.addEventListener('webkitfullscreenchange',
              this.fullscreenChangeBind);
          window.addEventListener('MSFullscreenChange', this.fullscreenChangeBind);
        },

    /**
     * @private
     */
    _removeFullscreenChangeListeners:
        function PDFPresentationMode_removeFullscreenChangeListeners() {
          window.removeEventListener('fullscreenchange', this.fullscreenChangeBind);
          window.removeEventListener('mozfullscreenchange',
              this.fullscreenChangeBind);
          window.removeEventListener('webkitfullscreenchange',
              this.fullscreenChangeBind);
          window.removeEventListener('MSFullscreenChange',
              this.fullscreenChangeBind);

          delete this.fullscreenChangeBind;
        },
  };

  return PDFPresentationMode;
})();


const GrabToPan = (function GrabToPanClosure() {
  /**
   * Construct a GrabToPan instance for a given HTML element.
   * @param options.element {Element}
   * @param options.ignoreTarget {function} optional. See `ignoreTarget(node)`
   * @param options.onActiveChanged {function(boolean)} optional. Called
   *  when grab-to-pan is (de)activated. The first argument is a boolean that
   *  shows whether grab-to-pan is activated.
   */
  function GrabToPan(options) {
    this.element = options.element;
    this.document = options.element.ownerDocument;
    if (typeof options.ignoreTarget === 'function') {
      this.ignoreTarget = options.ignoreTarget;
    }
    this.onActiveChanged = options.onActiveChanged;

    // Bind the contexts to ensure that `this` always points to
    // the GrabToPan instance.
    this.activate = this.activate.bind(this);
    this.deactivate = this.deactivate.bind(this);
    this.toggle = this.toggle.bind(this);
    this._onmousedown = this._onmousedown.bind(this);
    this._onmousemove = this._onmousemove.bind(this);
    this._endPan = this._endPan.bind(this);

    // This overlay will be inserted in the document when the mouse moves during
    // a grab operation, to ensure that the cursor has the desired appearance.
    const overlay = this.overlay = document.createElement('div');
    overlay.className = 'grab-to-pan-grabbing';
  }
  GrabToPan.prototype = {
    /**
     * Class name of element which can be grabbed
     */
    CSS_CLASS_GRAB: 'grab-to-pan-grab',

    /**
     * Bind a mousedown event to the element to enable grab-detection.
     */
    activate: function GrabToPan_activate() {
      if (!this.active) {
        this.active = true;
        this.element.addEventListener('mousedown', this._onmousedown, true);
        this.element.classList.add(this.CSS_CLASS_GRAB);
        if (this.onActiveChanged) {
          this.onActiveChanged(true);
        }
      }
    },

    /**
     * Removes all events. Any pending pan session is immediately stopped.
     */
    deactivate: function GrabToPan_deactivate() {
      if (this.active) {
        this.active = false;
        this.element.removeEventListener('mousedown', this._onmousedown, true);
        this._endPan();
        this.element.classList.remove(this.CSS_CLASS_GRAB);
        if (this.onActiveChanged) {
          this.onActiveChanged(false);
        }
      }
    },

    toggle: function GrabToPan_toggle() {
      if (this.active) {
        this.deactivate();
      } else {
        this.activate();
      }
    },

    /**
     * Whether to not pan if the target element is clicked.
     * Override this method to change the default behaviour.
     *
     * @param node {Element} The target of the event
     * @return {boolean} Whether to not react to the click event.
     */
    ignoreTarget: function GrabToPan_ignoreTarget(node) {
      // Use matchesSelector to check whether the clicked element
      // is (a child of) an input element / link
      return node[matchesSelector](
          'a[href], a[href] *, input, textarea, button, button *, select, option'
      );
    },

    /**
     * @private
     */
    _onmousedown: function GrabToPan__onmousedown(event) {
      if (event.button !== 0 || this.ignoreTarget(event.target)) {
        return;
      }
      if (event.originalTarget) {
        try {
          /* jshint expr:true */
          event.originalTarget.tagName;
        } catch (e) {
          // Mozilla-specific: element is a scrollbar (XUL element)
          return;
        }
      }

      this.scrollLeftStart = this.element.scrollLeft;
      this.scrollTopStart = this.element.scrollTop;
      this.clientXStart = event.clientX;
      this.clientYStart = event.clientY;
      this.document.addEventListener('mousemove', this._onmousemove, true);
      this.document.addEventListener('mouseup', this._endPan, true);
      // When a scroll event occurs before a mousemove, assume that the user
      // dragged a scrollbar (necessary for Opera Presto, Safari and IE)
      // (not needed for Chrome/Firefox)
      this.element.addEventListener('scroll', this._endPan, true);
      event.preventDefault();
      event.stopPropagation();
      this.document.documentElement.classList.add(this.CSS_CLASS_GRABBING);

      const focusedElement = document.activeElement;
      if (focusedElement && !focusedElement.contains(event.target)) {
        focusedElement.blur();
      }
    },

    /**
     * @private
     */
    _onmousemove: function GrabToPan__onmousemove(event) {
      this.element.removeEventListener('scroll', this._endPan, true);
      if (isLeftMouseReleased(event)) {
        this._endPan();
        return;
      }
      const xDiff = event.clientX - this.clientXStart;
      const yDiff = event.clientY - this.clientYStart;
      this.element.scrollTop = this.scrollTopStart - yDiff;
      this.element.scrollLeft = this.scrollLeftStart - xDiff;
      if (!this.overlay.parentNode) {
        document.body.appendChild(this.overlay);
      }
    },

    /**
     * @private
     */
    _endPan: function GrabToPan__endPan() {
      this.element.removeEventListener('scroll', this._endPan, true);
      this.document.removeEventListener('mousemove', this._onmousemove, true);
      this.document.removeEventListener('mouseup', this._endPan, true);
      if (this.overlay.parentNode) {
        this.overlay.parentNode.removeChild(this.overlay);
      }
    },
  };

  // Get the correct (vendor-prefixed) name of the matches method.
  let matchesSelector;
  ['webkitM', 'mozM', 'msM', 'oM', 'm'].some((prefix) => {
    let name = `${prefix}atches`;
    if (name in document.documentElement) {
      matchesSelector = name;
    }
    name += 'Selector';
    if (name in document.documentElement) {
      matchesSelector = name;
    }
    return matchesSelector; // If found, then truthy, and [].some() ends.
  });

  // Browser sniffing because it's impossible to feature-detect
  // whether event.which for onmousemove is reliable
  const isNotIEorIsIE10plus = !document.documentMode || document.documentMode > 9;
  const chrome = window.chrome;
  const isChrome15OrOpera15plus = chrome && (chrome.webstore || chrome.app);
  //                                       ^ Chrome 15+       ^ Opera 15+
  const isSafari6plus = /Apple/.test(navigator.vendor) &&
                      /Version\/([6-9]\d*|[1-5]\d+)/.test(navigator.userAgent);

  /**
   * Whether the left mouse is not pressed.
   * @param event {MouseEvent}
   * @return {boolean} True if the left mouse button is not pressed.
   *                   False if unsure or if the left mouse button is pressed.
   */
  function isLeftMouseReleased(event) {
    if ('buttons' in event && isNotIEorIsIE10plus) {
      // http://www.w3.org/TR/DOM-Level-3-Events/#events-MouseEvent-buttons
      // Firefox 15+
      // Internet Explorer 10+
      return !(event.buttons | 1);
    }
    if (isChrome15OrOpera15plus || isSafari6plus) {
      // Chrome 14+
      // Opera 15+
      // Safari 6.0+
      return event.which === 0;
    }
  }

  return GrabToPan;
})();

const HandTool = {
  initialize: function handToolInitialize(options) {
    const toggleHandTool = options.toggleHandTool;
    this.handTool = new GrabToPan({
      element: options.container,
      onActiveChanged(isActive) {
        if (!toggleHandTool) {
          return;
        }
        if (isActive) {
          toggleHandTool.title =
            mozL10n.get('hand_tool_disable.title', null, 'Disable hand tool');
          toggleHandTool.firstElementChild.textContent =
            mozL10n.get('hand_tool_disable_label', null, 'Disable hand tool');
        } else {
          toggleHandTool.title =
            mozL10n.get('hand_tool_enable.title', null, 'Enable hand tool');
          toggleHandTool.firstElementChild.textContent =
            mozL10n.get('hand_tool_enable_label', null, 'Enable hand tool');
        }
      },
    });
    if (toggleHandTool) {
      toggleHandTool.addEventListener('click', this.toggle.bind(this), false);

      window.addEventListener('localized', (evt) => {
        Preferences.get('enableHandToolOnLoad').then((value) => {
          if (value) {
            this.handTool.activate();
          }
        }, (reason) => {});
      });

      window.addEventListener('presentationmodechanged', (evt) => {
        if (evt.detail.switchInProgress) {
          return;
        }
        if (evt.detail.active) {
          this.enterPresentationMode();
        } else {
          this.exitPresentationMode();
        }
      });
    }
  },

  toggle: function handToolToggle() {
    this.handTool.toggle();
    SecondaryToolbar.close();
  },

  enterPresentationMode: function handToolEnterPresentationMode() {
    if (this.handTool.active) {
      this.wasActive = true;
      this.handTool.deactivate();
    }
  },

  exitPresentationMode: function handToolExitPresentationMode() {
    if (this.wasActive) {
      this.wasActive = null;
      this.handTool.activate();
    }
  },
};


var OverlayManager = {
  overlays: {},
  active: null,

  /**
   * @param {string} name The name of the overlay that is registered. This must
   *                 be equal to the ID of the overlay's DOM element.
   * @param {function} callerCloseMethod (optional) The method that, if present,
   *                   will call OverlayManager.close from the Object
   *                   registering the overlay. Access to this method is
   *                   necessary in order to run cleanup code when e.g.
   *                   the overlay is force closed. The default is null.
   * @param {boolean} canForceClose (optional) Indicates if opening the overlay
   *                  will close an active overlay. The default is false.
   * @returns {Promise} A promise that is resolved when the overlay has been
   *                    registered.
   */
  register: function overlayManagerRegister(name,
      callerCloseMethod, canForceClose) {
    return new Promise((resolve) => {
      let element, container;
      if (!name || !(element = document.getElementById(name)) ||
          !(container = element.parentNode)) {
        throw new Error('Not enough parameters.');
      } else if (this.overlays[name]) {
        throw new Error('The overlay is already registered.');
      }
      this.overlays[name] = {element,
        container,
        callerCloseMethod: (callerCloseMethod || null),
        canForceClose: (canForceClose || false)};
      resolve();
    });
  },

  /**
   * @param {string} name The name of the overlay that is unregistered.
   * @returns {Promise} A promise that is resolved when the overlay has been
   *                    unregistered.
   */
  unregister: function overlayManagerUnregister(name) {
    return new Promise((resolve) => {
      if (!this.overlays[name]) {
        throw new Error('The overlay does not exist.');
      } else if (this.active === name) {
        throw new Error('The overlay cannot be removed while it is active.');
      }
      delete this.overlays[name];

      resolve();
    });
  },

  /**
   * @param {string} name The name of the overlay that should be opened.
   * @returns {Promise} A promise that is resolved when the overlay has been
   *                    opened.
   */
  open: function overlayManagerOpen(name) {
    return new Promise((resolve) => {
      if (!this.overlays[name]) {
        throw new Error('The overlay does not exist.');
      } else if (this.active) {
        if (this.overlays[name].canForceClose) {
          this._closeThroughCaller();
        } else if (this.active === name) {
          throw new Error('The overlay is already active.');
        } else {
          throw new Error('Another overlay is currently active.');
        }
      }
      this.active = name;
      this.overlays[this.active].element.classList.remove('hidden');
      this.overlays[this.active].container.classList.remove('hidden');

      window.addEventListener('keydown', this._keyDown);
      resolve();
    });
  },

  /**
   * @param {string} name The name of the overlay that should be closed.
   * @returns {Promise} A promise that is resolved when the overlay has been
   *                    closed.
   */
  close: function overlayManagerClose(name) {
    return new Promise((resolve) => {
      if (!this.overlays[name]) {
        throw new Error('The overlay does not exist.');
      } else if (!this.active) {
        throw new Error('The overlay is currently not active.');
      } else if (this.active !== name) {
        throw new Error('Another overlay is currently active.');
      }
      this.overlays[this.active].container.classList.add('hidden');
      this.overlays[this.active].element.classList.add('hidden');
      this.active = null;

      window.removeEventListener('keydown', this._keyDown);
      resolve();
    });
  },

  /**
   * @private
   */
  _keyDown: function overlayManager_keyDown(evt) {
    const self = OverlayManager;
    if (self.active && evt.keyCode === 27) { // Esc key.
      self._closeThroughCaller();
      evt.preventDefault();
    }
  },

  /**
   * @private
   */
  _closeThroughCaller: function overlayManager_closeThroughCaller() {
    if (this.overlays[this.active].callerCloseMethod) {
      this.overlays[this.active].callerCloseMethod();
    }
    if (this.active) {
      this.close(this.active);
    }
  },
};


const PasswordPrompt = {
  overlayName: null,
  updatePassword: null,
  reason: null,
  passwordField: null,
  passwordText: null,
  passwordSubmit: null,
  passwordCancel: null,

  initialize: function secondaryToolbarInitialize(options) {
    this.overlayName = options.overlayName;
    this.passwordField = options.passwordField;
    this.passwordText = options.passwordText;
    this.passwordSubmit = options.passwordSubmit;
    this.passwordCancel = options.passwordCancel;

    // Attach the event listeners.
    this.passwordSubmit.addEventListener('click',
        this.verifyPassword.bind(this));

    this.passwordCancel.addEventListener('click', this.close.bind(this));

    this.passwordField.addEventListener('keydown', (e) => {
      if (e.keyCode === 13) { // Enter key
        this.verifyPassword();
      }
    });

    OverlayManager.register(this.overlayName, this.close.bind(this), true);
  },

  open: function passwordPromptOpen() {
    OverlayManager.open(this.overlayName).then(() => {
      this.passwordField.focus();

      let promptString = mozL10n.get('password_label', null,
          'Enter the password to open this PDF file.');

      if (this.reason === PDFJS.PasswordResponses.INCORRECT_PASSWORD) {
        promptString = mozL10n.get('password_invalid', null,
            'Invalid password. Please try again.');
      }

      this.passwordText.textContent = promptString;
    });
  },

  close: function passwordPromptClose() {
    OverlayManager.close(this.overlayName).then(() => {
      this.passwordField.value = '';
    });
  },

  verifyPassword: function passwordPromptVerifyPassword() {
    const password = this.passwordField.value;
    if (password && password.length > 0) {
      this.close();
      return this.updatePassword(password);
    }
  },
};


/**
 * @typedef {Object} PDFDocumentPropertiesOptions
 * @property {string} overlayName - Name/identifier for the overlay.
 * @property {Object} fields - Names and elements of the overlay's fields.
 * @property {HTMLButtonElement} closeButton - Button for closing the overlay.
 */

/**
 * @class
 */
const PDFDocumentProperties = (function PDFDocumentPropertiesClosure() {
  /**
   * @constructs PDFDocumentProperties
   * @param {PDFDocumentPropertiesOptions} options
   */
  function PDFDocumentProperties(options) {
    this.fields = options.fields;
    this.overlayName = options.overlayName;

    this.rawFileSize = 0;
    this.url = null;
    this.pdfDocument = null;

    // Bind the event listener for the Close button.
    if (options.closeButton) {
      options.closeButton.addEventListener('click', this.close.bind(this));
    }

    this.dataAvailablePromise = new Promise((resolve) => {
      this.resolveDataAvailable = resolve;
    });

    OverlayManager.register(this.overlayName, this.close.bind(this));
  }

  PDFDocumentProperties.prototype = {
    /**
     * Open the document properties overlay.
     */
    open: function PDFDocumentProperties_open() {
      Promise.all([OverlayManager.open(this.overlayName),
        this.dataAvailablePromise]).then(() => {
        this._getProperties();
      });
    },

    /**
     * Close the document properties overlay.
     */
    close: function PDFDocumentProperties_close() {
      OverlayManager.close(this.overlayName);
    },

    /**
     * Set the file size of the PDF document. This method is used to
     * update the file size in the document properties overlay once it
     * is known so we do not have to wait until the entire file is loaded.
     *
     * @param {number} fileSize - The file size of the PDF document.
     */
    setFileSize: function PDFDocumentProperties_setFileSize(fileSize) {
      if (fileSize > 0) {
        this.rawFileSize = fileSize;
      }
    },

    /**
     * Set a reference to the PDF document and the URL in order
     * to populate the overlay fields with the document properties.
     * Note that the overlay will contain no information if this method
     * is not called.
     *
     * @param {Object} pdfDocument - A reference to the PDF document.
     * @param {string} url - The URL of the document.
     */
    setDocumentAndUrl:
        function PDFDocumentProperties_setDocumentAndUrl(pdfDocument, url) {
          this.pdfDocument = pdfDocument;
          this.url = url;
          this.resolveDataAvailable();
        },

    /**
     * @private
     */
    _getProperties: function PDFDocumentProperties_getProperties() {
      if (!OverlayManager.active) {
        // If the dialog was closed before dataAvailablePromise was resolved,
        // don't bother updating the properties.
        return;
      }
      // Get the file size (if it hasn't already been set).
      this.pdfDocument.getDownloadInfo().then((data) => {
        if (data.length === this.rawFileSize) {
          return;
        }
        this.setFileSize(data.length);
        this._updateUI(this.fields.fileSize, this._parseFileSize());
      });

      // Get the document properties.
      this.pdfDocument.getMetadata().then((data) => {
        const content = {
          fileName: getPDFFileNameFromURL(this.url),
          fileSize: this._parseFileSize(),
          title: data.info.Title,
          author: data.info.Author,
          subject: data.info.Subject,
          keywords: data.info.Keywords,
          creationDate: this._parseDate(data.info.CreationDate),
          modificationDate: this._parseDate(data.info.ModDate),
          creator: data.info.Creator,
          producer: data.info.Producer,
          version: data.info.PDFFormatVersion,
          pageCount: this.pdfDocument.numPages,
        };

        // Show the properties in the dialog.
        for (const identifier in content) {
          this._updateUI(this.fields[identifier], content[identifier]);
        }
      });
    },

    /**
     * @private
     */
    _updateUI: function PDFDocumentProperties_updateUI(field, content) {
      if (field && content !== undefined && content !== '') {
        field.textContent = content;
      }
    },

    /**
     * @private
     */
    _parseFileSize: function PDFDocumentProperties_parseFileSize() {
      const fileSize = this.rawFileSize; const
        kb = fileSize / 1024;
      if (!kb) {
        return;
      } else if (kb < 1024) {
        return mozL10n.get('document_properties_kb', {
          size_kb: (+kb.toPrecision(3)).toLocaleString(),
          size_b: fileSize.toLocaleString(),
        }, '{{size_kb}} KB ({{size_b}} bytes)');
      } else {
        return mozL10n.get('document_properties_mb', {
          size_mb: (+(kb / 1024).toPrecision(3)).toLocaleString(),
          size_b: fileSize.toLocaleString(),
        }, '{{size_mb}} MB ({{size_b}} bytes)');
      }
    },

    /**
     * @private
     */
    _parseDate: function PDFDocumentProperties_parseDate(inputDate) {
      // This is implemented according to the PDF specification, but note that
      // Adobe Reader doesn't handle changing the date to universal time
      // and doesn't use the user's time zone (they're effectively ignoring
      // the HH' and mm' parts of the date string).
      let dateToParse = inputDate;
      if (dateToParse === undefined) {
        return '';
      }

      // Remove the D: prefix if it is available.
      if (dateToParse.substring(0, 2) === 'D:') {
        dateToParse = dateToParse.substring(2);
      }

      // Get all elements from the PDF date string.
      // JavaScript's Date object expects the month to be between
      // 0 and 11 instead of 1 and 12, so we're correcting for this.
      const year = parseInt(dateToParse.substring(0, 4), 10);
      const month = parseInt(dateToParse.substring(4, 6), 10) - 1;
      const day = parseInt(dateToParse.substring(6, 8), 10);
      let hours = parseInt(dateToParse.substring(8, 10), 10);
      let minutes = parseInt(dateToParse.substring(10, 12), 10);
      const seconds = parseInt(dateToParse.substring(12, 14), 10);
      const utRel = dateToParse.substring(14, 15);
      const offsetHours = parseInt(dateToParse.substring(15, 17), 10);
      const offsetMinutes = parseInt(dateToParse.substring(18, 20), 10);

      // As per spec, utRel = 'Z' means equal to universal time.
      // The other cases ('-' and '+') have to be handled here.
      if (utRel === '-') {
        hours += offsetHours;
        minutes += offsetMinutes;
      } else if (utRel === '+') {
        hours -= offsetHours;
        minutes -= offsetMinutes;
      }

      // Return the new date format from the user's locale.
      const date = new Date(Date.UTC(year, month, day, hours, minutes, seconds));
      const dateString = date.toLocaleDateString();
      const timeString = date.toLocaleTimeString();
      return mozL10n.get('document_properties_date_string',
          {date: dateString, time: timeString},
          '{{date}}, {{time}}');
    },
  };

  return PDFDocumentProperties;
})();


const PresentationModeState = {
  UNKNOWN: 0,
  NORMAL: 1,
  CHANGING: 2,
  FULLSCREEN: 3,
};

let IGNORE_CURRENT_POSITION_ON_ZOOM = false;
const DEFAULT_CACHE_SIZE = 10;


const CLEANUP_TIMEOUT = 30000;

const RenderingStates = {
  INITIAL: 0,
  RUNNING: 1,
  PAUSED: 2,
  FINISHED: 3,
};

/**
 * Controls rendering of the views for pages and thumbnails.
 * @class
 */
const PDFRenderingQueue = (function PDFRenderingQueueClosure() {
  /**
   * @constructs
   */
  function PDFRenderingQueue() {
    this.pdfViewer = null;
    this.pdfThumbnailViewer = null;
    this.onIdle = null;

    this.highestPriorityPage = null;
    this.idleTimeout = null;
    this.printing = false;
    this.isThumbnailViewEnabled = false;
  }

  PDFRenderingQueue.prototype = /** @lends PDFRenderingQueue.prototype */ {
    /**
     * @param {PDFViewer} pdfViewer
     */
    setViewer: function PDFRenderingQueue_setViewer(pdfViewer) {
      this.pdfViewer = pdfViewer;
    },

    /**
     * @param {PDFThumbnailViewer} pdfThumbnailViewer
     */
    setThumbnailViewer:
        function PDFRenderingQueue_setThumbnailViewer(pdfThumbnailViewer) {
          this.pdfThumbnailViewer = pdfThumbnailViewer;
        },

    /**
     * @param {IRenderableView} view
     * @returns {boolean}
     */
    isHighestPriority: function PDFRenderingQueue_isHighestPriority(view) {
      return this.highestPriorityPage === view.renderingId;
    },

    renderHighestPriority: function
    PDFRenderingQueue_renderHighestPriority(currentlyVisiblePages) {
      if (this.idleTimeout) {
        clearTimeout(this.idleTimeout);
        this.idleTimeout = null;
      }

      // Pages have a higher priority than thumbnails, so check them first.
      if (this.pdfViewer.forceRendering(currentlyVisiblePages)) {
        return;
      }
      // No pages needed rendering so check thumbnails.
      if (this.pdfThumbnailViewer && this.isThumbnailViewEnabled) {
        if (this.pdfThumbnailViewer.forceRendering()) {
          return;
        }
      }

      if (this.printing) {
        // If printing is currently ongoing do not reschedule cleanup.
        return;
      }

      if (this.onIdle) {
        this.idleTimeout = setTimeout(this.onIdle.bind(this), CLEANUP_TIMEOUT);
      }
    },

    getHighestPriority: function
    PDFRenderingQueue_getHighestPriority(visible, views, scrolledDown) {
      // The state has changed figure out which page has the highest priority to
      // render next (if any).
      // Priority:
      // 1 visible pages
      // 2 if last scrolled down page after the visible pages
      // 2 if last scrolled up page before the visible pages
      const visibleViews = visible.views;

      const numVisible = visibleViews.length;
      if (numVisible === 0) {
        return false;
      }
      for (let i = 0; i < numVisible; ++i) {
        const view = visibleViews[i].view;
        if (!this.isViewFinished(view)) {
          return view;
        }
      }

      // All the visible views have rendered, try to render next/previous pages.
      if (scrolledDown) {
        const nextPageIndex = visible.last.id;
        // ID's start at 1 so no need to add 1.
        if (views[nextPageIndex] &&
            !this.isViewFinished(views[nextPageIndex])) {
          return views[nextPageIndex];
        }
      } else {
        const previousPageIndex = visible.first.id - 2;
        if (views[previousPageIndex] &&
          !this.isViewFinished(views[previousPageIndex])) {
          return views[previousPageIndex];
        }
      }
      // Everything that needs to be rendered has been.
      return null;
    },

    /**
     * @param {IRenderableView} view
     * @returns {boolean}
     */
    isViewFinished: function PDFRenderingQueue_isViewFinished(view) {
      return view.renderingState === RenderingStates.FINISHED;
    },

    /**
     * Render a page or thumbnail view. This calls the appropriate function
     * based on the views state. If the view is already rendered it will return
     * false.
     * @param {IRenderableView} view
     */
    renderView: function PDFRenderingQueue_renderView(view) {
      const state = view.renderingState;
      switch (state) {
        case RenderingStates.FINISHED:
          return false;
        case RenderingStates.PAUSED:
          this.highestPriorityPage = view.renderingId;
          view.resume();
          break;
        case RenderingStates.RUNNING:
          this.highestPriorityPage = view.renderingId;
          break;
        case RenderingStates.INITIAL:
          this.highestPriorityPage = view.renderingId;
          var continueRendering = function () {
            this.renderHighestPriority();
          }.bind(this);
          view.draw().then(continueRendering, continueRendering);
          break;
      }
      return true;
    },
  };

  return PDFRenderingQueue;
})();


const TEXT_LAYER_RENDER_DELAY = 200; // ms

/**
 * @typedef {Object} PDFPageViewOptions
 * @property {HTMLDivElement} container - The viewer element.
 * @property {number} id - The page unique ID (normally its number).
 * @property {number} scale - The page scale display.
 * @property {PageViewport} defaultViewport - The page viewport.
 * @property {PDFRenderingQueue} renderingQueue - The rendering queue object.
 * @property {IPDFTextLayerFactory} textLayerFactory
 * @property {IPDFAnnotationsLayerFactory} annotationsLayerFactory
 */

/**
 * @class
 * @implements {IRenderableView}
 */
const PDFPageView = (function PDFPageViewClosure() {
  const CustomStyle = PDFJS.CustomStyle;

  /**
   * @constructs PDFPageView
   * @param {PDFPageViewOptions} options
   */
  function PDFPageView(options) {
    const container = options.container;
    const id = options.id;
    const scale = options.scale;
    const defaultViewport = options.defaultViewport;
    const renderingQueue = options.renderingQueue;
    const textLayerFactory = options.textLayerFactory;
    const annotationsLayerFactory = options.annotationsLayerFactory;

    this.id = id;
    this.renderingId = `page${id}`;

    this.rotation = 0;
    this.scale = scale || DEFAULT_SCALE;
    this.viewport = defaultViewport;
    this.pdfPageRotate = defaultViewport.rotation;
    this.hasRestrictedScaling = false;

    this.renderingQueue = renderingQueue;
    this.textLayerFactory = textLayerFactory;
    this.annotationsLayerFactory = annotationsLayerFactory;

    this.renderingState = RenderingStates.INITIAL;
    this.resume = null;

    this.onBeforeDraw = null;
    this.onAfterDraw = null;

    this.textLayer = null;

    this.zoomLayer = null;

    this.annotationLayer = null;

    const div = document.createElement('div');
    div.id = `pageContainer${this.id}`;
    div.className = 'page';
    div.style.width = `${Math.floor(this.viewport.width)}px`;
    div.style.height = `${Math.floor(this.viewport.height)}px`;
    div.setAttribute('data-page-number', this.id);
    this.div = div;

    container.appendChild(div);
  }

  PDFPageView.prototype = {
    setPdfPage: function PDFPageView_setPdfPage(pdfPage) {
      this.pdfPage = pdfPage;
      this.pdfPageRotate = pdfPage.rotate;
      const totalRotation = (this.rotation + this.pdfPageRotate) % 360;
      this.viewport = pdfPage.getViewport(this.scale * CSS_UNITS,
          totalRotation);
      this.stats = pdfPage.stats;
      this.reset();
    },

    destroy: function PDFPageView_destroy() {
      this.zoomLayer = null;
      this.reset();
      if (this.pdfPage) {
        this.pdfPage.cleanup();
      }
    },

    reset: function PDFPageView_reset(keepZoomLayer, keepAnnotations) {
      if (this.renderTask) {
        this.renderTask.cancel();
      }
      this.resume = null;
      this.renderingState = RenderingStates.INITIAL;

      const div = this.div;
      div.style.width = `${Math.floor(this.viewport.width)}px`;
      div.style.height = `${Math.floor(this.viewport.height)}px`;

      const childNodes = div.childNodes;
      const currentZoomLayerNode = (keepZoomLayer && this.zoomLayer) || null;
      const currentAnnotationNode = (keepAnnotations && this.annotationLayer &&
                                   this.annotationLayer.div) || null;
      for (let i = childNodes.length - 1; i >= 0; i--) {
        const node = childNodes[i];
        if (currentZoomLayerNode === node || currentAnnotationNode === node) {
          continue;
        }
        div.removeChild(node);
      }
      div.removeAttribute('data-loaded');

      if (currentAnnotationNode) {
        // Hide annotationLayer until all elements are resized
        // so they are not displayed on the already-resized page
        this.annotationLayer.hide();
      } else {
        this.annotationLayer = null;
      }

      if (this.canvas && !currentZoomLayerNode) {
        // Zeroing the width and height causes Firefox to release graphics
        // resources immediately, which can greatly reduce memory consumption.
        this.canvas.width = 0;
        this.canvas.height = 0;
        delete this.canvas;
      }

      this.loadingIconDiv = document.createElement('div');
      this.loadingIconDiv.className = 'loadingIcon';
      div.appendChild(this.loadingIconDiv);
    },

    update: function PDFPageView_update(scale, rotation) {
      this.scale = scale || this.scale;

      if (typeof rotation !== 'undefined') {
        this.rotation = rotation;
      }

      const totalRotation = (this.rotation + this.pdfPageRotate) % 360;
      this.viewport = this.viewport.clone({
        scale: this.scale * CSS_UNITS,
        rotation: totalRotation,
      });

      let isScalingRestricted = false;
      if (this.canvas && PDFJS.maxCanvasPixels > 0) {
        const outputScale = this.outputScale;
        const pixelsInViewport = this.viewport.width * this.viewport.height;
        const maxScale = Math.sqrt(PDFJS.maxCanvasPixels / pixelsInViewport);
        if (((Math.floor(this.viewport.width) * outputScale.sx) | 0) *
            ((Math.floor(this.viewport.height) * outputScale.sy) | 0) >
            PDFJS.maxCanvasPixels) {
          isScalingRestricted = true;
        }
      }

      if (this.canvas) {
        if (PDFJS.useOnlyCssZoom ||
            (this.hasRestrictedScaling && isScalingRestricted)) {
          this.cssTransform(this.canvas, true);

          const event = document.createEvent('CustomEvent');
          event.initCustomEvent('pagerendered', true, true, {
            pageNumber: this.id,
            cssTransform: true,
          });
          this.div.dispatchEvent(event);

          return;
        }
        if (!this.zoomLayer) {
          this.zoomLayer = this.canvas.parentNode;
          this.zoomLayer.style.position = 'absolute';
        }
      }
      if (this.zoomLayer) {
        this.cssTransform(this.zoomLayer.firstChild);
      }
      this.reset(/* keepZoomLayer = */ true, /* keepAnnotations = */ true);
    },

    /**
     * Called when moved in the parent's container.
     */
    updatePosition: function PDFPageView_updatePosition() {
      if (this.textLayer) {
        this.textLayer.render(TEXT_LAYER_RENDER_DELAY);
      }
    },

    cssTransform: function PDFPageView_transform(canvas, redrawAnnotations) {
      // Scale canvas, canvas wrapper, and page container.
      const width = this.viewport.width;
      const height = this.viewport.height;
      const div = this.div;
      canvas.style.width = canvas.parentNode.style.width = div.style.width =
        `${Math.floor(width)}px`;
      canvas.style.height = canvas.parentNode.style.height = div.style.height =
        `${Math.floor(height)}px`;
      // The canvas may have been originally rotated, rotate relative to that.
      const relativeRotation = this.viewport.rotation - canvas._viewport.rotation;
      const absRotation = Math.abs(relativeRotation);
      let scaleX = 1; let
        scaleY = 1;
      if (absRotation === 90 || absRotation === 270) {
        // Scale x and y because of the rotation.
        scaleX = height / width;
        scaleY = width / height;
      }
      const cssTransform = `rotate(${relativeRotation}deg) ` +
        `scale(${scaleX},${scaleY})`;
      CustomStyle.setProp('transform', canvas, cssTransform);

      if (this.textLayer) {
        // Rotating the text layer is more complicated since the divs inside the
        // the text layer are rotated.
        // TODO: This could probably be simplified by drawing the text layer in
        // one orientation then rotating overall.
        const textLayerViewport = this.textLayer.viewport;
        const textRelativeRotation = this.viewport.rotation -
          textLayerViewport.rotation;
        const textAbsRotation = Math.abs(textRelativeRotation);
        let scale = width / textLayerViewport.width;
        if (textAbsRotation === 90 || textAbsRotation === 270) {
          scale = width / textLayerViewport.height;
        }
        const textLayerDiv = this.textLayer.textLayerDiv;
        let transX, transY;
        switch (textAbsRotation) {
          case 0:
            transX = transY = 0;
            break;
          case 90:
            transX = 0;
            transY = `-${textLayerDiv.style.height}`;
            break;
          case 180:
            transX = `-${textLayerDiv.style.width}`;
            transY = `-${textLayerDiv.style.height}`;
            break;
          case 270:
            transX = `-${textLayerDiv.style.width}`;
            transY = 0;
            break;
          default:
            console.error('Bad rotation value.');
            break;
        }
        CustomStyle.setProp('transform', textLayerDiv,
            `rotate(${textAbsRotation}deg) ` +
            `scale(${scale}, ${scale}) ` +
            `translate(${transX}, ${transY})`);
        CustomStyle.setProp('transformOrigin', textLayerDiv, '0% 0%');
      }

      if (redrawAnnotations && this.annotationLayer) {
        this.annotationLayer.setupAnnotations(this.viewport, 'display');
      }
    },

    get width() {
      return this.viewport.width;
    },

    get height() {
      return this.viewport.height;
    },

    getPagePoint: function PDFPageView_getPagePoint(x, y) {
      return this.viewport.convertToPdfPoint(x, y);
    },

    draw: function PDFPageView_draw() {
      if (this.renderingState !== RenderingStates.INITIAL) {
        console.error('Must be in new state before drawing');
      }

      this.renderingState = RenderingStates.RUNNING;

      const pdfPage = this.pdfPage;
      const viewport = this.viewport;
      const div = this.div;
      // Wrap the canvas so if it has a css transform for highdpi the overflow
      // will be hidden in FF.
      const canvasWrapper = document.createElement('div');
      canvasWrapper.style.width = div.style.width;
      canvasWrapper.style.height = div.style.height;
      canvasWrapper.classList.add('canvasWrapper');

      const canvas = document.createElement('canvas');
      canvas.id = `page${this.id}`;
      // Keep the canvas hidden until the first draw callback, or until drawing
      // is complete when `!this.renderingQueue`, to prevent black flickering.
      canvas.setAttribute('hidden', 'hidden');
      let isCanvasHidden = true;

      canvasWrapper.appendChild(canvas);
      if (this.annotationLayer && this.annotationLayer.div) {
        // annotationLayer needs to stay on top
        div.insertBefore(canvasWrapper, this.annotationLayer.div);
      } else {
        div.appendChild(canvasWrapper);
      }
      this.canvas = canvas;

      canvas.mozOpaque = true;
      const ctx = canvas.getContext('2d', {alpha: false});
      const outputScale = getOutputScale(ctx);
      this.outputScale = outputScale;

      if (PDFJS.useOnlyCssZoom) {
        const actualSizeViewport = viewport.clone({scale: CSS_UNITS});
        // Use a scale that will make the canvas be the original intended size
        // of the page.
        outputScale.sx *= actualSizeViewport.width / viewport.width;
        outputScale.sy *= actualSizeViewport.height / viewport.height;
        outputScale.scaled = true;
      }

      if (PDFJS.maxCanvasPixels > 0) {
        const pixelsInViewport = viewport.width * viewport.height;
        const maxScale = Math.sqrt(PDFJS.maxCanvasPixels / pixelsInViewport);
        if (outputScale.sx > maxScale || outputScale.sy > maxScale) {
          outputScale.sx = maxScale;
          outputScale.sy = maxScale;
          outputScale.scaled = true;
          this.hasRestrictedScaling = true;
        } else {
          this.hasRestrictedScaling = false;
        }
      }

      const sfx = approximateFraction(outputScale.sx);
      const sfy = approximateFraction(outputScale.sy);
      canvas.width = roundToDivide(viewport.width * outputScale.sx, sfx[0]);
      canvas.height = roundToDivide(viewport.height * outputScale.sy, sfy[0]);
      canvas.style.width = `${roundToDivide(viewport.width, sfx[1])}px`;
      canvas.style.height = `${roundToDivide(viewport.height, sfy[1])}px`;
      // Add the viewport so it's known what it was originally drawn with.
      canvas._viewport = viewport;

      let textLayerDiv = null;
      let textLayer = null;
      if (this.textLayerFactory) {
        textLayerDiv = document.createElement('div');
        textLayerDiv.className = 'textLayer';
        textLayerDiv.style.width = canvasWrapper.style.width;
        textLayerDiv.style.height = canvasWrapper.style.height;
        if (this.annotationLayer && this.annotationLayer.div) {
          // annotationLayer needs to stay on top
          div.insertBefore(textLayerDiv, this.annotationLayer.div);
        } else {
          div.appendChild(textLayerDiv);
        }

        textLayer = this.textLayerFactory.createTextLayerBuilder(textLayerDiv,
            this.id - 1,
            this.viewport);
      }
      this.textLayer = textLayer;

      let resolveRenderPromise, rejectRenderPromise;
      const promise = new Promise((resolve, reject) => {
        resolveRenderPromise = resolve;
        rejectRenderPromise = reject;
      });

      // Rendering area

      const self = this;
      function pageViewDrawCallback(error) {
        // The renderTask may have been replaced by a new one, so only remove
        // the reference to the renderTask if it matches the one that is
        // triggering this callback.
        if (renderTask === self.renderTask) {
          self.renderTask = null;
        }

        if (error === 'cancelled') {
          rejectRenderPromise(error);
          return;
        }

        self.renderingState = RenderingStates.FINISHED;

        if (isCanvasHidden) {
          self.canvas.removeAttribute('hidden');
          isCanvasHidden = false;
        }

        if (self.loadingIconDiv) {
          div.removeChild(self.loadingIconDiv);
          delete self.loadingIconDiv;
        }

        if (self.zoomLayer) {
          // Zeroing the width and height causes Firefox to release graphics
          // resources immediately, which can greatly reduce memory consumption.
          const zoomLayerCanvas = self.zoomLayer.firstChild;
          zoomLayerCanvas.width = 0;
          zoomLayerCanvas.height = 0;

          div.removeChild(self.zoomLayer);
          self.zoomLayer = null;
        }

        self.error = error;
        self.stats = pdfPage.stats;
        if (self.onAfterDraw) {
          self.onAfterDraw();
        }
        const event = document.createEvent('CustomEvent');
        event.initCustomEvent('pagerendered', true, true, {
          pageNumber: self.id,
          cssTransform: false,
        });
        div.dispatchEvent(event);
        // This custom event is deprecated, and will be removed in the future,
        // please use the |pagerendered| event instead.
        const deprecatedEvent = document.createEvent('CustomEvent');
        deprecatedEvent.initCustomEvent('pagerender', true, true, {
          pageNumber: pdfPage.pageNumber,
        });
        div.dispatchEvent(deprecatedEvent);

        if (!error) {
          resolveRenderPromise(undefined);
        } else {
          rejectRenderPromise(error);
        }
      }

      let renderContinueCallback = null;
      if (this.renderingQueue) {
        renderContinueCallback = function renderContinueCallback(cont) {
          if (!self.renderingQueue.isHighestPriority(self)) {
            self.renderingState = RenderingStates.PAUSED;
            self.resume = function resumeCallback() {
              self.renderingState = RenderingStates.RUNNING;
              cont();
            };
            return;
          }
          if (isCanvasHidden) {
            self.canvas.removeAttribute('hidden');
            isCanvasHidden = false;
          }
          cont();
        };
      }

      const transform = !outputScale.scaled ? null
        : [outputScale.sx, 0, 0, outputScale.sy, 0, 0];
      const renderContext = {
        canvasContext: ctx,
        transform,
        viewport: this.viewport,
        // intent: 'default', // === 'display'
      };
      var renderTask = this.renderTask = this.pdfPage.render(renderContext);
      renderTask.onContinue = renderContinueCallback;

      this.renderTask.promise.then(
          () => {
            pageViewDrawCallback(null);
            if (textLayer) {
              self.pdfPage.getTextContent().then(
                  (textContent) => {
                    textLayer.setTextContent(textContent);
                    textLayer.render(TEXT_LAYER_RENDER_DELAY);
                  }
              );
            }
          },
          (error) => {
            pageViewDrawCallback(error);
          }
      );

      if (this.annotationsLayerFactory) {
        if (!this.annotationLayer) {
          this.annotationLayer = this.annotationsLayerFactory
              .createAnnotationsLayerBuilder(div, this.pdfPage);
        }
        this.annotationLayer.setupAnnotations(this.viewport, 'display');
      }
      div.setAttribute('data-loaded', true);

      if (self.onBeforeDraw) {
        self.onBeforeDraw();
      }
      return promise;
    },

    beforePrint: function PDFPageView_beforePrint() {
      const pdfPage = this.pdfPage;

      const viewport = pdfPage.getViewport(1);
      // Use the same hack we use for high dpi displays for printing to get
      // better output until bug 811002 is fixed in FF.
      const PRINT_OUTPUT_SCALE = 2;
      const canvas = document.createElement('canvas');

      // The logical size of the canvas.
      canvas.width = Math.floor(viewport.width) * PRINT_OUTPUT_SCALE;
      canvas.height = Math.floor(viewport.height) * PRINT_OUTPUT_SCALE;

      // The rendered size of the canvas, relative to the size of canvasWrapper.
      canvas.style.width = `${PRINT_OUTPUT_SCALE * 100}%`;
      canvas.style.height = `${PRINT_OUTPUT_SCALE * 100}%`;

      const cssScale = `scale(${1 / PRINT_OUTPUT_SCALE}, ${
        1 / PRINT_OUTPUT_SCALE})`;
      CustomStyle.setProp('transform', canvas, cssScale);
      CustomStyle.setProp('transformOrigin', canvas, '0% 0%');

      const printContainer = document.getElementById('printContainer');
      const canvasWrapper = document.createElement('div');
      canvasWrapper.style.width = `${viewport.width}pt`;
      canvasWrapper.style.height = `${viewport.height}pt`;
      canvasWrapper.appendChild(canvas);
      printContainer.appendChild(canvasWrapper);

      canvas.mozPrintCallback = function (obj) {
        const ctx = obj.context;

        ctx.save();
        ctx.fillStyle = 'rgb(255, 255, 255)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
        // Used by the mozCurrentTransform polyfill in src/display/canvas.js.
        ctx._transformMatrix =
          [PRINT_OUTPUT_SCALE, 0, 0, PRINT_OUTPUT_SCALE, 0, 0];
        ctx.scale(PRINT_OUTPUT_SCALE, PRINT_OUTPUT_SCALE);

        const renderContext = {
          canvasContext: ctx,
          viewport,
          intent: 'print',
        };

        pdfPage.render(renderContext).promise.then(() => {
          // Tell the printEngine that rendering this canvas/page has finished.
          obj.done();
        }, (error) => {
          console.error(error);
          // Tell the printEngine that rendering this canvas/page has failed.
          // This will make the print proces stop.
          if ('abort' in obj) {
            obj.abort();
          } else {
            obj.done();
          }
        });
      };
    },
  };

  return PDFPageView;
})();


/**
 * @typedef {Object} TextLayerBuilderOptions
 * @property {HTMLDivElement} textLayerDiv - The text layer container.
 * @property {number} pageIndex - The page index.
 * @property {PageViewport} viewport - The viewport of the text layer.
 * @property {PDFFindController} findController
 */

/**
 * TextLayerBuilder provides text-selection functionality for the PDF.
 * It does this by creating overlay divs over the PDF text. These divs
 * contain text that matches the PDF text they are overlaying. This object
 * also provides a way to highlight text that is being searched for.
 * @class
 */
const TextLayerBuilder = (function TextLayerBuilderClosure() {
  function TextLayerBuilder(options) {
    this.textLayerDiv = options.textLayerDiv;
    this.renderingDone = false;
    this.divContentDone = false;
    this.pageIdx = options.pageIndex;
    this.pageNumber = this.pageIdx + 1;
    this.matches = [];
    this.viewport = options.viewport;
    this.textDivs = [];
    this.findController = options.findController || null;
    this.textLayerRenderTask = null;
    this._bindMouse();
  }

  TextLayerBuilder.prototype = {
    _finishRendering: function TextLayerBuilder_finishRendering() {
      this.renderingDone = true;

      const endOfContent = document.createElement('div');
      endOfContent.className = 'endOfContent';
      this.textLayerDiv.appendChild(endOfContent);

      const event = document.createEvent('CustomEvent');
      event.initCustomEvent('textlayerrendered', true, true, {
        pageNumber: this.pageNumber,
      });
      this.textLayerDiv.dispatchEvent(event);
    },

    /**
     * Renders the text layer.
     * @param {number} timeout (optional) if specified, the rendering waits
     *   for specified amount of ms.
     */
    render: function TextLayerBuilder_render(timeout) {
      if (!this.divContentDone || this.renderingDone) {
        return;
      }

      if (this.textLayerRenderTask) {
        this.textLayerRenderTask.cancel();
        this.textLayerRenderTask = null;
      }

      this.textDivs = [];
      const textLayerFrag = document.createDocumentFragment();
      this.textLayerRenderTask = PDFJS.renderTextLayer({
        textContent: this.textContent,
        container: textLayerFrag,
        viewport: this.viewport,
        textDivs: this.textDivs,
        timeout,
      });
      this.textLayerRenderTask.promise.then(() => {
        this.textLayerDiv.appendChild(textLayerFrag);
        this._finishRendering();
        this.updateMatches();
      }, (reason) => {
        // canceled or failed to render text layer -- skipping errors
      });
    },

    setTextContent: function TextLayerBuilder_setTextContent(textContent) {
      if (this.textLayerRenderTask) {
        this.textLayerRenderTask.cancel();
        this.textLayerRenderTask = null;
      }
      this.textContent = textContent;
      this.divContentDone = true;
    },

    convertMatches: function TextLayerBuilder_convertMatches(matches) {
      let i = 0;
      let iIndex = 0;
      const bidiTexts = this.textContent.items;
      const end = bidiTexts.length - 1;
      const queryLen = (this.findController === null
        ? 0 : this.findController.state.query.length);
      const ret = [];

      for (let m = 0, len = matches.length; m < len; m++) {
        // Calculate the start position.
        let matchIdx = matches[m];

        // Loop over the divIdxs.
        while (i !== end && matchIdx >= (iIndex + bidiTexts[i].str.length)) {
          iIndex += bidiTexts[i].str.length;
          i++;
        }

        if (i === bidiTexts.length) {
          console.error('Could not find a matching mapping');
        }

        const match = {
          begin: {
            divIdx: i,
            offset: matchIdx - iIndex,
          },
        };

        // Calculate the end position.
        matchIdx += queryLen;

        // Somewhat the same array as above, but use > instead of >= to get
        // the end position right.
        while (i !== end && matchIdx > (iIndex + bidiTexts[i].str.length)) {
          iIndex += bidiTexts[i].str.length;
          i++;
        }

        match.end = {
          divIdx: i,
          offset: matchIdx - iIndex,
        };
        ret.push(match);
      }

      return ret;
    },

    renderMatches: function TextLayerBuilder_renderMatches(matches) {
      // Early exit if there is nothing to render.
      if (matches.length === 0) {
        return;
      }

      const bidiTexts = this.textContent.items;
      const textDivs = this.textDivs;
      let prevEnd = null;
      const pageIdx = this.pageIdx;
      const isSelectedPage = (this.findController === null
        ? false : (pageIdx === this.findController.selected.pageIdx));
      const selectedMatchIdx = (this.findController === null
        ? -1 : this.findController.selected.matchIdx);
      const highlightAll = (this.findController === null
        ? false : this.findController.state.highlightAll);
      const infinity = {
        divIdx: -1,
        offset: undefined,
      };

      function beginText(begin, className) {
        const divIdx = begin.divIdx;
        textDivs[divIdx].textContent = '';
        appendTextToDiv(divIdx, 0, begin.offset, className);
      }

      function appendTextToDiv(divIdx, fromOffset, toOffset, className) {
        const div = textDivs[divIdx];
        const content = bidiTexts[divIdx].str.substring(fromOffset, toOffset);
        const node = document.createTextNode(content);
        if (className) {
          const span = document.createElement('span');
          span.className = className;
          span.appendChild(node);
          div.appendChild(span);
          return;
        }
        div.appendChild(node);
      }

      let i0 = selectedMatchIdx; let
        i1 = i0 + 1;
      if (highlightAll) {
        i0 = 0;
        i1 = matches.length;
      } else if (!isSelectedPage) {
        // Not highlighting all and this isn't the selected page, so do nothing.
        return;
      }

      for (let i = i0; i < i1; i++) {
        const match = matches[i];
        const begin = match.begin;
        const end = match.end;
        const isSelected = (isSelectedPage && i === selectedMatchIdx);
        const highlightSuffix = (isSelected ? ' selected' : '');

        if (this.findController) {
          this.findController.updateMatchPosition(pageIdx, i, textDivs,
              begin.divIdx, end.divIdx);
        }

        // Match inside new div.
        if (!prevEnd || begin.divIdx !== prevEnd.divIdx) {
          // If there was a previous div, then add the text at the end.
          if (prevEnd !== null) {
            appendTextToDiv(prevEnd.divIdx, prevEnd.offset, infinity.offset);
          }
          // Clear the divs and set the content until the starting point.
          beginText(begin);
        } else {
          appendTextToDiv(prevEnd.divIdx, prevEnd.offset, begin.offset);
        }

        if (begin.divIdx === end.divIdx) {
          appendTextToDiv(begin.divIdx, begin.offset, end.offset,
              `highlight${highlightSuffix}`);
        } else {
          appendTextToDiv(begin.divIdx, begin.offset, infinity.offset,
              `highlight begin${highlightSuffix}`);
          for (let n0 = begin.divIdx + 1, n1 = end.divIdx; n0 < n1; n0++) {
            textDivs[n0].className = `highlight middle${highlightSuffix}`;
          }
          beginText(end, `highlight end${highlightSuffix}`);
        }
        prevEnd = end;
      }

      if (prevEnd) {
        appendTextToDiv(prevEnd.divIdx, prevEnd.offset, infinity.offset);
      }
    },

    updateMatches: function TextLayerBuilder_updateMatches() {
      // Only show matches when all rendering is done.
      if (!this.renderingDone) {
        return;
      }

      // Clear all matches.
      const matches = this.matches;
      const textDivs = this.textDivs;
      const bidiTexts = this.textContent.items;
      let clearedUntilDivIdx = -1;

      // Clear all current matches.
      for (let i = 0, len = matches.length; i < len; i++) {
        const match = matches[i];
        const begin = Math.max(clearedUntilDivIdx, match.begin.divIdx);
        for (let n = begin, end = match.end.divIdx; n <= end; n++) {
          const div = textDivs[n];
          div.textContent = bidiTexts[n].str;
          div.className = '';
        }
        clearedUntilDivIdx = match.end.divIdx + 1;
      }

      if (this.findController === null || !this.findController.active) {
        return;
      }

      // Convert the matches on the page controller into the match format
      // used for the textLayer.
      this.matches = this.convertMatches(this.findController === null
        ? [] : (this.findController.pageMatches[this.pageIdx] || []));
      this.renderMatches(this.matches);
    },

    /**
     * Fixes text selection: adds additional div where mouse was clicked.
     * This reduces flickering of the content if mouse slowly dragged down/up.
     * @private
     */
    _bindMouse: function TextLayerBuilder_bindMouse() {
      const div = this.textLayerDiv;
      div.addEventListener('mousedown', (e) => {
        const end = div.querySelector('.endOfContent');
        if (!end) {
          return;
        }
        // On non-Firefox browsers, the selection will feel better if the height
        // of the endOfContent div will be adjusted to start at mouse click
        // location -- this will avoid flickering when selections moves up.
        // However it does not work when selection started on empty space.
        let adjustTop = e.target !== div;
        adjustTop = adjustTop && window.getComputedStyle(end)
            .getPropertyValue('-moz-user-select') !== 'none';
        if (adjustTop) {
          const divBounds = div.getBoundingClientRect();
          const r = Math.max(0, (e.pageY - divBounds.top) / divBounds.height);
          end.style.top = `${(r * 100).toFixed(2)}%`;
        }
        end.classList.add('active');
      });
      div.addEventListener('mouseup', (e) => {
        const end = div.querySelector('.endOfContent');
        if (!end) {
          return;
        }
        end.style.top = '';
        end.classList.remove('active');
      });
    },
  };
  return TextLayerBuilder;
})();

/**
 * @constructor
 * @implements IPDFTextLayerFactory
 */
function DefaultTextLayerFactory() {}
DefaultTextLayerFactory.prototype = {
  /**
   * @param {HTMLDivElement} textLayerDiv
   * @param {number} pageIndex
   * @param {PageViewport} viewport
   * @returns {TextLayerBuilder}
   */
  createTextLayerBuilder(textLayerDiv, pageIndex, viewport) {
    return new TextLayerBuilder({
      textLayerDiv,
      pageIndex,
      viewport,
    });
  },
};


/**
 * @typedef {Object} AnnotationsLayerBuilderOptions
 * @property {HTMLDivElement} pageDiv
 * @property {PDFPage} pdfPage
 * @property {IPDFLinkService} linkService
 */

/**
 * @class
 */
const AnnotationsLayerBuilder = (function AnnotationsLayerBuilderClosure() {
  const CustomStyle = PDFJS.CustomStyle;

  /**
   * @param {AnnotationsLayerBuilderOptions} options
   * @constructs AnnotationsLayerBuilder
   */
  function AnnotationsLayerBuilder(options) {
    this.pageDiv = options.pageDiv;
    this.pdfPage = options.pdfPage;
    this.linkService = options.linkService;

    this.div = null;
  }
  AnnotationsLayerBuilder.prototype =
    /** @lends AnnotationsLayerBuilder.prototype */ {

      /**
     * @param {PageViewport} viewport
     * @param {string} intent (default value is 'display')
     */
      setupAnnotations:
        function AnnotationsLayerBuilder_setupAnnotations(viewport, intent) {
          function bindLink(link, dest) {
            link.href = linkService.getDestinationHash(dest);
            link.onclick = function annotationsLayerBuilderLinksOnclick() {
              if (dest) {
                linkService.navigateTo(dest);
              }
              return false;
            };
            if (dest) {
              link.className = 'internalLink';
            }
          }

          function bindNamedAction(link, action) {
            link.href = linkService.getAnchorUrl('');
            link.onclick = function annotationsLayerBuilderNamedActionOnClick() {
              linkService.executeNamedAction(action);
              return false;
            };
            link.className = 'internalLink';
          }

          var linkService = this.linkService;
          const pdfPage = this.pdfPage;
          const self = this;
          const getAnnotationsParams = {
            intent: (intent === undefined ? 'display' : intent),
          };

          pdfPage.getAnnotations(getAnnotationsParams).then(
              (annotationsData) => {
                viewport = viewport.clone({dontFlip: true});
                const transform = viewport.transform;
                const transformStr = `matrix(${transform.join(',')})`;
                let data, element, i, ii;

                if (self.div) {
                  // If an annotationLayer already exists, refresh its children's
                  // transformation matrices
                  for (i = 0, ii = annotationsData.length; i < ii; i++) {
                    data = annotationsData[i];
                    element = self.div.querySelector(
                        `[data-annotation-id="${data.id}"]`);
                    if (element) {
                      CustomStyle.setProp('transform', element, transformStr);
                    }
                  }
                  // See PDFPageView.reset()
                  self.div.removeAttribute('hidden');
                } else {
                  for (i = 0, ii = annotationsData.length; i < ii; i++) {
                    data = annotationsData[i];
                    if (!data || !data.hasHtml) {
                      continue;
                    }

                    element = PDFJS.AnnotationUtils.getHtmlElement(data,
                        pdfPage.commonObjs);
                    element.setAttribute('data-annotation-id', data.id);
                    if (typeof mozL10n !== 'undefined') {
                      mozL10n.translate(element);
                    }

                    let rect = data.rect;
                    const view = pdfPage.view;
                    rect = PDFJS.Util.normalizeRect([
                      rect[0],
                      view[3] - rect[1] + view[1],
                      rect[2],
                      view[3] - rect[3] + view[1],
                    ]);
                    element.style.left = `${rect[0]}px`;
                    element.style.top = `${rect[1]}px`;
                    element.style.position = 'absolute';

                    CustomStyle.setProp('transform', element, transformStr);
                    const transformOriginStr = `${-rect[0]}px ${-rect[1]}px`;
                    CustomStyle.setProp('transformOrigin', element, transformOriginStr);

                    if (data.subtype === 'Link' && !data.url) {
                      const link = element.getElementsByTagName('a')[0];
                      if (link) {
                        if (data.action) {
                          bindNamedAction(link, data.action);
                        } else {
                          bindLink(link, ('dest' in data) ? data.dest : null);
                        }
                      }
                    }

                    if (!self.div) {
                      const annotationLayerDiv = document.createElement('div');
                      annotationLayerDiv.className = 'annotationLayer';
                      self.pageDiv.appendChild(annotationLayerDiv);
                      self.div = annotationLayerDiv;
                    }

                    self.div.appendChild(element);
                  }
                }
              });
        },

      hide() {
        if (!this.div) {
          return;
        }
        this.div.setAttribute('hidden', 'true');
      },
    };
  return AnnotationsLayerBuilder;
})();

/**
 * @constructor
 * @implements IPDFAnnotationsLayerFactory
 */
function DefaultAnnotationsLayerFactory() {}
DefaultAnnotationsLayerFactory.prototype = {
  /**
   * @param {HTMLDivElement} pageDiv
   * @param {PDFPage} pdfPage
   * @returns {AnnotationsLayerBuilder}
   */
  createAnnotationsLayerBuilder(pageDiv, pdfPage) {
    return new AnnotationsLayerBuilder({
      pageDiv,
      pdfPage,
      linkService: new SimpleLinkService(),
    });
  },
};


/**
 * @typedef {Object} PDFViewerOptions
 * @property {HTMLDivElement} container - The container for the viewer element.
 * @property {HTMLDivElement} viewer - (optional) The viewer element.
 * @property {IPDFLinkService} linkService - The navigation/linking service.
 * @property {PDFRenderingQueue} renderingQueue - (optional) The rendering
 *   queue object.
 * @property {boolean} removePageBorders - (optional) Removes the border shadow
 *   around the pages. The default is false.
 */

/**
 * Simple viewer control to display PDF content/pages.
 * @class
 * @implements {IRenderableView}
 */
const PDFViewer = (function pdfViewer() {
  function PDFPageViewBuffer(size) {
    const data = [];
    this.push = function cachePush(view) {
      const i = data.indexOf(view);
      if (i >= 0) {
        data.splice(i, 1);
      }
      data.push(view);
      if (data.length > size) {
        data.shift().destroy();
      }
    };
    this.resize = function (newSize) {
      size = newSize;
      while (data.length > size) {
        data.shift().destroy();
      }
    };
  }

  function isSameScale(oldScale, newScale) {
    if (newScale === oldScale) {
      return true;
    }
    if (Math.abs(newScale - oldScale) < 1e-15) {
      // Prevent unnecessary re-rendering of all pages when the scale
      // changes only because of limited numerical precision.
      return true;
    }
    return false;
  }

  /**
   * @constructs PDFViewer
   * @param {PDFViewerOptions} options
   */
  function PDFViewer(options) {
    this.container = options.container;
    this.viewer = options.viewer || options.container.firstElementChild;
    this.linkService = options.linkService || new SimpleLinkService();
    this.removePageBorders = options.removePageBorders || false;

    this.defaultRenderingQueue = !options.renderingQueue;
    if (this.defaultRenderingQueue) {
      // Custom rendering queue is not specified, using default one
      this.renderingQueue = new PDFRenderingQueue();
      this.renderingQueue.setViewer(this);
    } else {
      this.renderingQueue = options.renderingQueue;
    }

    this.scroll = watchScroll(this.container, this._scrollUpdate.bind(this));
    this.updateInProgress = false;
    this.presentationModeState = PresentationModeState.UNKNOWN;
    this._resetView();

    if (this.removePageBorders) {
      this.viewer.classList.add('removePageBorders');
    }
  }

  PDFViewer.prototype = /** @lends PDFViewer.prototype */{
    get pagesCount() {
      return this._pages.length;
    },

    getPageView(index) {
      return this._pages[index];
    },

    get currentPageNumber() {
      return this._currentPageNumber;
    },

    set currentPageNumber(val) {
      if (!this.pdfDocument) {
        this._currentPageNumber = val;
        return;
      }

      const event = document.createEvent('UIEvents');
      event.initUIEvent('pagechange', true, true, window, 0);
      event.updateInProgress = this.updateInProgress;

      if (!(0 < val && val <= this.pagesCount)) {
        event.pageNumber = this._currentPageNumber;
        event.previousPageNumber = val;
        this.container.dispatchEvent(event);
        return;
      }

      event.previousPageNumber = this._currentPageNumber;
      this._currentPageNumber = val;
      event.pageNumber = val;
      this.container.dispatchEvent(event);

      // Check if the caller is `PDFViewer_update`, to avoid breaking scrolling.
      if (this.updateInProgress) {
        return;
      }
      this.scrollPageIntoView(val);
    },

    /**
     * @returns {number}
     */
    get currentScale() {
      return this._currentScale !== UNKNOWN_SCALE ? this._currentScale
        : DEFAULT_SCALE;
    },

    /**
     * @param {number} val - Scale of the pages in percents.
     */
    set currentScale(val) {
      if (isNaN(val)) {
        throw new Error('Invalid numeric scale');
      }
      if (!this.pdfDocument) {
        this._currentScale = val;
        this._currentScaleValue = val !== UNKNOWN_SCALE ? val.toString() : null;
        return;
      }
      this._setScale(val, false);
    },

    /**
     * @returns {string}
     */
    get currentScaleValue() {
      return this._currentScaleValue;
    },

    /**
     * @param val - The scale of the pages (in percent or predefined value).
     */
    set currentScaleValue(val) {
      if (!this.pdfDocument) {
        this._currentScale = isNaN(val) ? UNKNOWN_SCALE : val;
        this._currentScaleValue = val;
        return;
      }
      this._setScale(val, false);
    },

    /**
     * @returns {number}
     */
    get pagesRotation() {
      return this._pagesRotation;
    },

    /**
     * @param {number} rotation - The rotation of the pages (0, 90, 180, 270).
     */
    set pagesRotation(rotation) {
      this._pagesRotation = rotation;

      for (let i = 0, l = this._pages.length; i < l; i++) {
        const pageView = this._pages[i];
        pageView.update(pageView.scale, rotation);
      }

      this._setScale(this._currentScaleValue, true);

      if (this.defaultRenderingQueue) {
        this.update();
      }
    },

    /**
     * @param pdfDocument {PDFDocument}
     */
    setDocument(pdfDocument) {
      if (this.pdfDocument) {
        this._resetView();
      }

      this.pdfDocument = pdfDocument;
      if (!pdfDocument) {
        return;
      }

      const pagesCount = pdfDocument.numPages;
      const self = this;

      let resolvePagesPromise;
      const pagesPromise = new Promise((resolve) => {
        resolvePagesPromise = resolve;
      });
      this.pagesPromise = pagesPromise;
      pagesPromise.then(() => {
        const event = document.createEvent('CustomEvent');
        event.initCustomEvent('pagesloaded', true, true, {
          pagesCount,
        });
        self.container.dispatchEvent(event);
      });

      let isOnePageRenderedResolved = false;
      let resolveOnePageRendered = null;
      const onePageRendered = new Promise((resolve) => {
        resolveOnePageRendered = resolve;
      });
      this.onePageRendered = onePageRendered;

      const bindOnAfterAndBeforeDraw = function (pageView) {
        pageView.onBeforeDraw = function pdfViewLoadOnBeforeDraw() {
          // Add the page to the buffer at the start of drawing. That way it can
          // be evicted from the buffer and destroyed even if we pause its
          // rendering.
          self._buffer.push(this);
        };
        // when page is painted, using the image as thumbnail base
        pageView.onAfterDraw = function pdfViewLoadOnAfterDraw() {
          if (!isOnePageRenderedResolved) {
            isOnePageRenderedResolved = true;
            resolveOnePageRendered();
          }
        };
      };

      const firstPagePromise = pdfDocument.getPage(1);
      this.firstPagePromise = firstPagePromise;

      // Fetch a single page so we can get a viewport that will be the default
      // viewport for all pages
      return firstPagePromise.then((pdfPage) => {
        const scale = this.currentScale;
        const viewport = pdfPage.getViewport(scale * CSS_UNITS);
        for (let pageNum = 1; pageNum <= pagesCount; ++pageNum) {
          let textLayerFactory = null;
          if (!PDFJS.disableTextLayer) {
            textLayerFactory = this;
          }
          const pageView = new PDFPageView({
            container: this.viewer,
            id: pageNum,
            scale,
            defaultViewport: viewport.clone(),
            renderingQueue: this.renderingQueue,
            textLayerFactory,
            annotationsLayerFactory: this,
          });
          bindOnAfterAndBeforeDraw(pageView);
          this._pages.push(pageView);
        }

        const linkService = this.linkService;

        // Fetch all the pages since the viewport is needed before printing
        // starts to create the correct size canvas. Wait until one page is
        // rendered so we don't tie up too many resources early on.
        onePageRendered.then(() => {
          if (!PDFJS.disableAutoFetch) {
            let getPagesLeft = pagesCount;
            for (let pageNum = 1; pageNum <= pagesCount; ++pageNum) {
              pdfDocument.getPage(pageNum).then(((pageNum, pdfPage) => {
                const pageView = self._pages[pageNum - 1];
                if (!pageView.pdfPage) {
                  pageView.setPdfPage(pdfPage);
                }
                linkService.cachePageRef(pageNum, pdfPage.ref);
                getPagesLeft--;
                if (!getPagesLeft) {
                  resolvePagesPromise();
                }
              }).bind(null, pageNum));
            }
          } else {
            // XXX: Printing is semi-broken with auto fetch disabled.
            resolvePagesPromise();
          }
        });

        const event = document.createEvent('CustomEvent');
        event.initCustomEvent('pagesinit', true, true, null);
        self.container.dispatchEvent(event);

        if (this.defaultRenderingQueue) {
          this.update();
        }

        if (this.findController) {
          this.findController.resolveFirstPage();
        }
      });
    },

    _resetView() {
      this._pages = [];
      this._currentPageNumber = 1;
      this._currentScale = UNKNOWN_SCALE;
      this._currentScaleValue = null;
      this._buffer = new PDFPageViewBuffer(DEFAULT_CACHE_SIZE);
      this._location = null;
      this._pagesRotation = 0;
      this._pagesRequests = [];

      const container = this.viewer;
      while (container.hasChildNodes()) {
        container.removeChild(container.lastChild);
      }
    },

    _scrollUpdate: function PDFViewer_scrollUpdate() {
      if (this.pagesCount === 0) {
        return;
      }
      this.update();
      for (let i = 0, ii = this._pages.length; i < ii; i++) {
        this._pages[i].updatePosition();
      }
    },

    _setScaleDispatchEvent: function pdfViewer_setScaleDispatchEvent(
        newScale, newValue, preset) {
      const event = document.createEvent('UIEvents');
      event.initUIEvent('scalechange', true, true, window, 0);
      event.scale = newScale;
      if (preset) {
        event.presetValue = newValue;
      }
      this.container.dispatchEvent(event);
    },

    _setScaleUpdatePages: function pdfViewer_setScaleUpdatePages(
        newScale, newValue, noScroll, preset) {
      this._currentScaleValue = newValue;

      if (isSameScale(this._currentScale, newScale)) {
        if (preset) {
          this._setScaleDispatchEvent(newScale, newValue, true);
        }
        return;
      }

      for (let i = 0, ii = this._pages.length; i < ii; i++) {
        this._pages[i].update(newScale);
      }
      this._currentScale = newScale;

      if (!noScroll) {
        let page = this._currentPageNumber; let
          dest;
        if (this._location && !IGNORE_CURRENT_POSITION_ON_ZOOM &&
            !(this.isInPresentationMode || this.isChangingPresentationMode)) {
          page = this._location.pageNumber;
          dest = [null,
            {name: 'XYZ'},
            this._location.left,
            this._location.top,
            null];
        }
        this.scrollPageIntoView(page, dest);
      }

      this._setScaleDispatchEvent(newScale, newValue, preset);

      if (this.defaultRenderingQueue) {
        this.update();
      }
    },

    _setScale: function pdfViewer_setScale(value, noScroll) {
      let scale = parseFloat(value);

      if (scale > 0) {
        this._setScaleUpdatePages(scale, value, noScroll, false);
      } else {
        const currentPage = this._pages[this._currentPageNumber - 1];
        if (!currentPage) {
          return;
        }
        const hPadding = (this.isInPresentationMode || this.removePageBorders)
          ? 0 : SCROLLBAR_PADDING;
        const vPadding = (this.isInPresentationMode || this.removePageBorders)
          ? 0 : VERTICAL_PADDING;
        const pageWidthScale = (this.container.clientWidth - hPadding) /
                             currentPage.width * currentPage.scale;
        const pageHeightScale = (this.container.clientHeight - vPadding) /
                              currentPage.height * currentPage.scale;
        switch (value) {
          case 'page-actual':
            scale = 1;
            break;
          case 'page-width':
            scale = pageWidthScale;
            break;
          case 'page-height':
            scale = pageHeightScale;
            break;
          case 'page-fit':
            scale = Math.min(pageWidthScale, pageHeightScale);
            break;
          case 'auto':
            var isLandscape = (currentPage.width > currentPage.height);
            // For pages in landscape mode, fit the page height to the viewer
            // *unless* the page would thus become too wide to fit horizontally.
            var horizontalScale = isLandscape
              ? Math.min(pageHeightScale, pageWidthScale) : pageWidthScale;
            scale = Math.min(MAX_AUTO_SCALE, horizontalScale);
            break;
          default:
            console.error(`pdfViewSetScale: '${value
            }' is an unknown zoom value.`);
            return;
        }
        this._setScaleUpdatePages(scale, value, noScroll, true);
      }
    },

    /**
     * Scrolls page into view.
     * @param {number} pageNumber
     * @param {Array} dest - (optional) original PDF destination array:
     *   <page-ref> </XYZ|FitXXX> <args..>
     */
    scrollPageIntoView: function PDFViewer_scrollPageIntoView(pageNumber,
        dest) {
      if (!this.pdfDocument) {
        return;
      }

      const pageView = this._pages[pageNumber - 1];

      if (this.isInPresentationMode) {
        if (this._currentPageNumber !== pageView.id) {
          // Avoid breaking getVisiblePages in presentation mode.
          this.currentPageNumber = pageView.id;
          return;
        }
        dest = null;
        // Fixes the case when PDF has different page sizes.
        this._setScale(this._currentScaleValue, true);
      }
      if (!dest) {
        scrollIntoView(pageView.div);
        return;
      }

      let x = 0; let
        y = 0;
      let width = 0; let height = 0; let widthScale; let heightScale;
      const changeOrientation = (pageView.rotation % 180 === 0 ? false : true);
      const pageWidth = (changeOrientation ? pageView.height : pageView.width) /
        pageView.scale / CSS_UNITS;
      const pageHeight = (changeOrientation ? pageView.width : pageView.height) /
        pageView.scale / CSS_UNITS;
      let scale = 0;
      switch (dest[1].name) {
        case 'XYZ':
          x = dest[2];
          y = dest[3];
          scale = dest[4];
          // If x and/or y coordinates are not supplied, default to
          // _top_ left of the page (not the obvious bottom left,
          // since aligning the bottom of the intended page with the
          // top of the window is rarely helpful).
          x = x !== null ? x : 0;
          y = y !== null ? y : pageHeight;
          break;
        case 'Fit':
        case 'FitB':
          scale = 'page-fit';
          break;
        case 'FitH':
        case 'FitBH':
          y = dest[2];
          scale = 'page-width';
          // According to the PDF spec, section 12.3.2.2, a `null` value in the
          // parameter should maintain the position relative to the new page.
          if (y === null && this._location) {
            x = this._location.left;
            y = this._location.top;
          }
          break;
        case 'FitV':
        case 'FitBV':
          x = dest[2];
          width = pageWidth;
          height = pageHeight;
          scale = 'page-height';
          break;
        case 'FitR':
          x = dest[2];
          y = dest[3];
          width = dest[4] - x;
          height = dest[5] - y;
          var hPadding = this.removePageBorders ? 0 : SCROLLBAR_PADDING;
          var vPadding = this.removePageBorders ? 0 : VERTICAL_PADDING;

          widthScale = (this.container.clientWidth - hPadding) /
            width / CSS_UNITS;
          heightScale = (this.container.clientHeight - vPadding) /
            height / CSS_UNITS;
          scale = Math.min(Math.abs(widthScale), Math.abs(heightScale));
          break;
        default:
          return;
      }

      if (scale && scale !== this._currentScale) {
        this.currentScaleValue = scale;
      } else if (this._currentScale === UNKNOWN_SCALE) {
        this.currentScaleValue = DEFAULT_SCALE_VALUE;
      }

      if (scale === 'page-fit' && !dest[4]) {
        scrollIntoView(pageView.div);
        return;
      }

      const boundingRect = [
        pageView.viewport.convertToViewportPoint(x, y),
        pageView.viewport.convertToViewportPoint(x + width, y + height),
      ];
      const left = Math.min(boundingRect[0][0], boundingRect[1][0]);
      const top = Math.min(boundingRect[0][1], boundingRect[1][1]);

      scrollIntoView(pageView.div, {left, top});
    },

    _updateLocation(firstPage) {
      const currentScale = this._currentScale;
      const currentScaleValue = this._currentScaleValue;
      const normalizedScaleValue =
        parseFloat(currentScaleValue) === currentScale
          ? Math.round(currentScale * 10000) / 100 : currentScaleValue;

      const pageNumber = firstPage.id;
      let pdfOpenParams = `#page=${pageNumber}`;
      pdfOpenParams += `&zoom=${normalizedScaleValue}`;
      const currentPageView = this._pages[pageNumber - 1];
      const container = this.container;
      const topLeft = currentPageView.getPagePoint(
          (container.scrollLeft - firstPage.x),
          (container.scrollTop - firstPage.y));
      const intLeft = Math.round(topLeft[0]);
      const intTop = Math.round(topLeft[1]);
      pdfOpenParams += `,${intLeft},${intTop}`;

      this._location = {
        pageNumber,
        scale: normalizedScaleValue,
        top: intTop,
        left: intLeft,
        pdfOpenParams,
      };
    },

    update: function PDFViewer_update() {
      const visible = this._getVisiblePages();
      const visiblePages = visible.views;
      if (visiblePages.length === 0) {
        return;
      }

      this.updateInProgress = true;

      const suggestedCacheSize = Math.max(DEFAULT_CACHE_SIZE,
          2 * visiblePages.length + 1);
      this._buffer.resize(suggestedCacheSize);

      this.renderingQueue.renderHighestPriority(visible);

      let currentId = this._currentPageNumber;
      const firstPage = visible.first;

      for (var i = 0, ii = visiblePages.length, stillFullyVisible = false;
        i < ii; ++i) {
        const page = visiblePages[i];

        if (page.percent < 100) {
          break;
        }
        if (page.id === currentId) {
          stillFullyVisible = true;
          break;
        }
      }

      if (!stillFullyVisible) {
        currentId = visiblePages[0].id;
      }

      if (!this.isInPresentationMode) {
        this.currentPageNumber = currentId;
      }

      this._updateLocation(firstPage);

      this.updateInProgress = false;

      const event = document.createEvent('UIEvents');
      event.initUIEvent('updateviewarea', true, true, window, 0);
      event.location = this._location;
      this.container.dispatchEvent(event);
    },

    containsElement(element) {
      return this.container.contains(element);
    },

    focus() {
      this.container.focus();
    },

    get isInPresentationMode() {
      return this.presentationModeState === PresentationModeState.FULLSCREEN;
    },

    get isChangingPresentationMode() {
      return this.presentationModeState === PresentationModeState.CHANGING;
    },

    get isHorizontalScrollbarEnabled() {
      return (this.isInPresentationMode
        ? false : (this.container.scrollWidth > this.container.clientWidth));
    },

    _getVisiblePages() {
      if (!this.isInPresentationMode) {
        return getVisibleElements(this.container, this._pages, true);
      } else {
        // The algorithm in getVisibleElements doesn't work in all browsers and
        // configurations when presentation mode is active.
        const visible = [];
        const currentPage = this._pages[this._currentPageNumber - 1];
        visible.push({id: currentPage.id, view: currentPage});
        return {first: currentPage, last: currentPage, views: visible};
      }
    },

    cleanup() {
      for (let i = 0, ii = this._pages.length; i < ii; i++) {
        if (this._pages[i] &&
            this._pages[i].renderingState !== RenderingStates.FINISHED) {
          this._pages[i].reset();
        }
      }
    },

    /**
     * @param {PDFPageView} pageView
     * @returns {PDFPage}
     * @private
     */
    _ensurePdfPageLoaded(pageView) {
      if (pageView.pdfPage) {
        return Promise.resolve(pageView.pdfPage);
      }
      const pageNumber = pageView.id;
      if (this._pagesRequests[pageNumber]) {
        return this._pagesRequests[pageNumber];
      }
      const promise = this.pdfDocument.getPage(pageNumber).then(
          (pdfPage) => {
            pageView.setPdfPage(pdfPage);
            this._pagesRequests[pageNumber] = null;
            return pdfPage;
          });
      this._pagesRequests[pageNumber] = promise;
      return promise;
    },

    forceRendering(currentlyVisiblePages) {
      const visiblePages = currentlyVisiblePages || this._getVisiblePages();
      const pageView = this.renderingQueue.getHighestPriority(visiblePages,
          this._pages,
          this.scroll.down);
      if (pageView) {
        this._ensurePdfPageLoaded(pageView).then(() => {
          this.renderingQueue.renderView(pageView);
        });
        return true;
      }
      return false;
    },

    getPageTextContent(pageIndex) {
      return this.pdfDocument.getPage(pageIndex + 1).then((page) => page.getTextContent());
    },

    /**
     * @param {HTMLDivElement} textLayerDiv
     * @param {number} pageIndex
     * @param {PageViewport} viewport
     * @returns {TextLayerBuilder}
     */
    createTextLayerBuilder(textLayerDiv, pageIndex, viewport) {
      return new TextLayerBuilder({
        textLayerDiv,
        pageIndex,
        viewport,
        findController: this.isInPresentationMode ? null : this.findController,
      });
    },

    /**
     * @param {HTMLDivElement} pageDiv
     * @param {PDFPage} pdfPage
     * @returns {AnnotationsLayerBuilder}
     */
    createAnnotationsLayerBuilder(pageDiv, pdfPage) {
      return new AnnotationsLayerBuilder({
        pageDiv,
        pdfPage,
        linkService: this.linkService,
      });
    },

    setFindController(findController) {
      this.findController = findController;
    },
  };

  return PDFViewer;
})();

var SimpleLinkService = (function SimpleLinkServiceClosure() {
  function SimpleLinkService() {}

  SimpleLinkService.prototype = {
    /**
     * @returns {number}
     */
    get page() {
      return 0;
    },
    /**
     * @param {number} value
     */
    set page(value) {},
    /**
     * @param dest - The PDF destination object.
     */
    navigateTo(dest) {},
    /**
     * @param dest - The PDF destination object.
     * @returns {string} The hyperlink to the PDF object.
     */
    getDestinationHash(dest) {
      return '#';
    },
    /**
     * @param hash - The PDF parameters/hash.
     * @returns {string} The hyperlink to the PDF object.
     */
    getAnchorUrl(hash) {
      return '#';
    },
    /**
     * @param {string} hash
     */
    setHash(hash) {},
    /**
     * @param {string} action
     */
    executeNamedAction(action) {},
    /**
     * @param {number} pageNum - page number.
     * @param {Object} pageRef - reference to the page.
     */
    cachePageRef(pageNum, pageRef) {},
  };
  return SimpleLinkService;
})();


const THUMBNAIL_SCROLL_MARGIN = -19;


const THUMBNAIL_WIDTH = 98; // px
const THUMBNAIL_CANVAS_BORDER_WIDTH = 1; // px

/**
 * @typedef {Object} PDFThumbnailViewOptions
 * @property {HTMLDivElement} container - The viewer element.
 * @property {number} id - The thumbnail's unique ID (normally its number).
 * @property {PageViewport} defaultViewport - The page viewport.
 * @property {IPDFLinkService} linkService - The navigation/linking service.
 * @property {PDFRenderingQueue} renderingQueue - The rendering queue object.
 */

/**
 * @class
 * @implements {IRenderableView}
 */
const PDFThumbnailView = (function PDFThumbnailViewClosure() {
  function getTempCanvas(width, height) {
    let tempCanvas = PDFThumbnailView.tempImageCache;
    if (!tempCanvas) {
      tempCanvas = document.createElement('canvas');
      PDFThumbnailView.tempImageCache = tempCanvas;
    }
    tempCanvas.width = width;
    tempCanvas.height = height;

    // Since this is a temporary canvas, we need to fill the canvas with a white
    // background ourselves. |_getPageDrawContext| uses CSS rules for this.
    tempCanvas.mozOpaque = true;
    const ctx = tempCanvas.getContext('2d', {alpha: false});
    ctx.save();
    ctx.fillStyle = 'rgb(255, 255, 255)';
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
    return tempCanvas;
  }

  /**
   * @constructs PDFThumbnailView
   * @param {PDFThumbnailViewOptions} options
   */
  function PDFThumbnailView(options) {
    const container = options.container;
    const id = options.id;
    const defaultViewport = options.defaultViewport;
    const linkService = options.linkService;
    const renderingQueue = options.renderingQueue;

    this.id = id;
    this.renderingId = `thumbnail${id}`;

    this.pdfPage = null;
    this.rotation = 0;
    this.viewport = defaultViewport;
    this.pdfPageRotate = defaultViewport.rotation;

    this.linkService = linkService;
    this.renderingQueue = renderingQueue;

    this.hasImage = false;
    this.resume = null;
    this.renderingState = RenderingStates.INITIAL;

    this.pageWidth = this.viewport.width;
    this.pageHeight = this.viewport.height;
    this.pageRatio = this.pageWidth / this.pageHeight;

    this.canvasWidth = THUMBNAIL_WIDTH;
    this.canvasHeight = (this.canvasWidth / this.pageRatio) | 0;
    this.scale = this.canvasWidth / this.pageWidth;

    const anchor = document.createElement('a');
    anchor.href = linkService.getAnchorUrl(`#page=${id}`);
    anchor.title = mozL10n.get('thumb_page_title', {page: id}, 'Page {{page}}');
    anchor.onclick = function stopNavigation() {
      linkService.page = id;
      return false;
    };

    const div = document.createElement('div');
    div.id = `thumbnailContainer${id}`;
    div.className = 'thumbnail';
    this.div = div;

    if (id === 1) {
      // Highlight the thumbnail of the first page when no page number is
      // specified (or exists in cache) when the document is loaded.
      div.classList.add('selected');
    }

    const ring = document.createElement('div');
    ring.className = 'thumbnailSelectionRing';
    const borderAdjustment = 2 * THUMBNAIL_CANVAS_BORDER_WIDTH;
    ring.style.width = `${this.canvasWidth + borderAdjustment}px`;
    ring.style.height = `${this.canvasHeight + borderAdjustment}px`;
    this.ring = ring;

    div.appendChild(ring);
    anchor.appendChild(div);
    container.appendChild(anchor);
  }

  PDFThumbnailView.prototype = {
    setPdfPage: function PDFThumbnailView_setPdfPage(pdfPage) {
      this.pdfPage = pdfPage;
      this.pdfPageRotate = pdfPage.rotate;
      const totalRotation = (this.rotation + this.pdfPageRotate) % 360;
      this.viewport = pdfPage.getViewport(1, totalRotation);
      this.reset();
    },

    reset: function PDFThumbnailView_reset() {
      if (this.renderTask) {
        this.renderTask.cancel();
      }
      this.hasImage = false;
      this.resume = null;
      this.renderingState = RenderingStates.INITIAL;

      this.pageWidth = this.viewport.width;
      this.pageHeight = this.viewport.height;
      this.pageRatio = this.pageWidth / this.pageHeight;

      this.canvasHeight = (this.canvasWidth / this.pageRatio) | 0;
      this.scale = (this.canvasWidth / this.pageWidth);

      this.div.removeAttribute('data-loaded');
      const ring = this.ring;
      const childNodes = ring.childNodes;
      for (let i = childNodes.length - 1; i >= 0; i--) {
        ring.removeChild(childNodes[i]);
      }
      const borderAdjustment = 2 * THUMBNAIL_CANVAS_BORDER_WIDTH;
      ring.style.width = `${this.canvasWidth + borderAdjustment}px`;
      ring.style.height = `${this.canvasHeight + borderAdjustment}px`;

      if (this.canvas) {
        // Zeroing the width and height causes Firefox to release graphics
        // resources immediately, which can greatly reduce memory consumption.
        this.canvas.width = 0;
        this.canvas.height = 0;
        delete this.canvas;
      }
      if (this.image) {
        this.image.removeAttribute('src');
        delete this.image;
      }
    },

    update: function PDFThumbnailView_update(rotation) {
      if (typeof rotation !== 'undefined') {
        this.rotation = rotation;
      }
      const totalRotation = (this.rotation + this.pdfPageRotate) % 360;
      this.viewport = this.viewport.clone({
        scale: 1,
        rotation: totalRotation,
      });
      this.reset();
    },

    /**
     * @private
     */
    _getPageDrawContext:
        function PDFThumbnailView_getPageDrawContext(noCtxScale) {
          const canvas = document.createElement('canvas');
          this.canvas = canvas;

          canvas.mozOpaque = true;
          const ctx = canvas.getContext('2d', {alpha: false});
          const outputScale = getOutputScale(ctx);

          canvas.width = (this.canvasWidth * outputScale.sx) | 0;
          canvas.height = (this.canvasHeight * outputScale.sy) | 0;
          canvas.style.width = `${this.canvasWidth}px`;
          canvas.style.height = `${this.canvasHeight}px`;

          if (!noCtxScale && outputScale.scaled) {
            ctx.scale(outputScale.sx, outputScale.sy);
          }

          const image = document.createElement('img');
          this.image = image;

          image.id = this.renderingId;
          image.className = 'thumbnailImage';
          image.setAttribute('aria-label', mozL10n.get('thumb_page_canvas',
              {page: this.id}, 'Thumbnail of Page {{page}}'));

          image.style.width = canvas.style.width;
          image.style.height = canvas.style.height;

          return ctx;
        },

    /**
     * @private
     */
    _convertCanvasToImage: function PDFThumbnailView_convertCanvasToImage() {
      if (!this.canvas) {
        return;
      }
      this.image.src = this.canvas.toDataURL();

      this.div.setAttribute('data-loaded', true);
      this.ring.appendChild(this.image);

      // Zeroing the width and height causes Firefox to release graphics
      // resources immediately, which can greatly reduce memory consumption.
      this.canvas.width = 0;
      this.canvas.height = 0;
      delete this.canvas;
    },

    draw: function PDFThumbnailView_draw() {
      if (this.renderingState !== RenderingStates.INITIAL) {
        console.error('Must be in new state before drawing');
      }
      if (this.hasImage) {
        return Promise.resolve(undefined);
      }
      this.hasImage = true;
      this.renderingState = RenderingStates.RUNNING;

      let resolveRenderPromise, rejectRenderPromise;
      const promise = new Promise((resolve, reject) => {
        resolveRenderPromise = resolve;
        rejectRenderPromise = reject;
      });

      const self = this;
      function thumbnailDrawCallback(error) {
        // The renderTask may have been replaced by a new one, so only remove
        // the reference to the renderTask if it matches the one that is
        // triggering this callback.
        if (renderTask === self.renderTask) {
          self.renderTask = null;
        }
        if (error === 'cancelled') {
          rejectRenderPromise(error);
          return;
        }
        self.renderingState = RenderingStates.FINISHED;
        self._convertCanvasToImage();

        if (!error) {
          resolveRenderPromise(undefined);
        } else {
          rejectRenderPromise(error);
        }
      }

      const ctx = this._getPageDrawContext();
      const drawViewport = this.viewport.clone({scale: this.scale});
      const renderContinueCallback = function renderContinueCallback(cont) {
        if (!self.renderingQueue.isHighestPriority(self)) {
          self.renderingState = RenderingStates.PAUSED;
          self.resume = function resumeCallback() {
            self.renderingState = RenderingStates.RUNNING;
            cont();
          };
          return;
        }
        cont();
      };

      const renderContext = {
        canvasContext: ctx,
        viewport: drawViewport,
      };
      var renderTask = this.renderTask = this.pdfPage.render(renderContext);
      renderTask.onContinue = renderContinueCallback;

      renderTask.promise.then(
          () => {
            thumbnailDrawCallback(null);
          },
          (error) => {
            thumbnailDrawCallback(error);
          }
      );
      return promise;
    },

    setImage: function PDFThumbnailView_setImage(pageView) {
      const img = pageView.canvas;
      if (this.hasImage || !img) {
        return;
      }
      if (!this.pdfPage) {
        this.setPdfPage(pageView.pdfPage);
      }
      this.hasImage = true;
      this.renderingState = RenderingStates.FINISHED;

      const ctx = this._getPageDrawContext(true);
      const canvas = ctx.canvas;

      if (img.width <= 2 * canvas.width) {
        ctx.drawImage(img, 0, 0, img.width, img.height,
            0, 0, canvas.width, canvas.height);
        this._convertCanvasToImage();
        return;
      }
      // drawImage does an awful job of rescaling the image, doing it gradually.
      const MAX_NUM_SCALING_STEPS = 3;
      let reducedWidth = canvas.width << MAX_NUM_SCALING_STEPS;
      let reducedHeight = canvas.height << MAX_NUM_SCALING_STEPS;
      const reducedImage = getTempCanvas(reducedWidth, reducedHeight);
      const reducedImageCtx = reducedImage.getContext('2d');

      while (reducedWidth > img.width || reducedHeight > img.height) {
        reducedWidth >>= 1;
        reducedHeight >>= 1;
      }
      reducedImageCtx.drawImage(img, 0, 0, img.width, img.height,
          0, 0, reducedWidth, reducedHeight);
      while (reducedWidth > 2 * canvas.width) {
        reducedImageCtx.drawImage(reducedImage,
            0, 0, reducedWidth, reducedHeight,
            0, 0, reducedWidth >> 1, reducedHeight >> 1);
        reducedWidth >>= 1;
        reducedHeight >>= 1;
      }
      ctx.drawImage(reducedImage, 0, 0, reducedWidth, reducedHeight,
          0, 0, canvas.width, canvas.height);
      this._convertCanvasToImage();
    },
  };

  return PDFThumbnailView;
})();

PDFThumbnailView.tempImageCache = null;


/**
 * @typedef {Object} PDFThumbnailViewerOptions
 * @property {HTMLDivElement} container - The container for the thumbnail
 *   elements.
 * @property {IPDFLinkService} linkService - The navigation/linking service.
 * @property {PDFRenderingQueue} renderingQueue - The rendering queue object.
 */

/**
 * Simple viewer control to display thumbnails for pages.
 * @class
 * @implements {IRenderableView}
 */
const PDFThumbnailViewer = (function PDFThumbnailViewerClosure() {
  /**
   * @constructs PDFThumbnailViewer
   * @param {PDFThumbnailViewerOptions} options
   */
  function PDFThumbnailViewer(options) {
    this.container = options.container;
    this.renderingQueue = options.renderingQueue;
    this.linkService = options.linkService;

    this.scroll = watchScroll(this.container, this._scrollUpdated.bind(this));
    this._resetView();
  }

  PDFThumbnailViewer.prototype = {
    /**
     * @private
     */
    _scrollUpdated: function PDFThumbnailViewer_scrollUpdated() {
      this.renderingQueue.renderHighestPriority();
    },

    getThumbnail: function PDFThumbnailViewer_getThumbnail(index) {
      return this.thumbnails[index];
    },

    /**
     * @private
     */
    _getVisibleThumbs: function PDFThumbnailViewer_getVisibleThumbs() {
      return getVisibleElements(this.container, this.thumbnails);
    },

    scrollThumbnailIntoView:
        function PDFThumbnailViewer_scrollThumbnailIntoView(page) {
          const selected = document.querySelector('.thumbnail.selected');
          if (selected) {
            selected.classList.remove('selected');
          }
          const thumbnail = document.getElementById(`thumbnailContainer${page}`);
          if (thumbnail) {
            thumbnail.classList.add('selected');
          }
          const visibleThumbs = this._getVisibleThumbs();
          const numVisibleThumbs = visibleThumbs.views.length;

          // If the thumbnail isn't currently visible, scroll it into view.
          if (numVisibleThumbs > 0) {
            const first = visibleThumbs.first.id;
            // Account for only one thumbnail being visible.
            const last = (numVisibleThumbs > 1 ? visibleThumbs.last.id : first);
            if (page <= first || page >= last) {
              scrollIntoView(thumbnail, {top: THUMBNAIL_SCROLL_MARGIN});
            }
          }
        },

    get pagesRotation() {
      return this._pagesRotation;
    },

    set pagesRotation(rotation) {
      this._pagesRotation = rotation;
      for (let i = 0, l = this.thumbnails.length; i < l; i++) {
        const thumb = this.thumbnails[i];
        thumb.update(rotation);
      }
    },

    cleanup: function PDFThumbnailViewer_cleanup() {
      const tempCanvas = PDFThumbnailView.tempImageCache;
      if (tempCanvas) {
        // Zeroing the width and height causes Firefox to release graphics
        // resources immediately, which can greatly reduce memory consumption.
        tempCanvas.width = 0;
        tempCanvas.height = 0;
      }
      PDFThumbnailView.tempImageCache = null;
    },

    /**
     * @private
     */
    _resetView: function PDFThumbnailViewer_resetView() {
      this.thumbnails = [];
      this._pagesRotation = 0;
      this._pagesRequests = [];
    },

    setDocument: function PDFThumbnailViewer_setDocument(pdfDocument) {
      if (this.pdfDocument) {
        // cleanup of the elements and views
        const thumbsView = this.container;
        while (thumbsView.hasChildNodes()) {
          thumbsView.removeChild(thumbsView.lastChild);
        }
        this._resetView();
      }

      this.pdfDocument = pdfDocument;
      if (!pdfDocument) {
        return Promise.resolve();
      }

      return pdfDocument.getPage(1).then((firstPage) => {
        const pagesCount = pdfDocument.numPages;
        const viewport = firstPage.getViewport(1.0);
        for (let pageNum = 1; pageNum <= pagesCount; ++pageNum) {
          const thumbnail = new PDFThumbnailView({
            container: this.container,
            id: pageNum,
            defaultViewport: viewport.clone(),
            linkService: this.linkService,
            renderingQueue: this.renderingQueue,
          });
          this.thumbnails.push(thumbnail);
        }
      });
    },

    /**
     * @param {PDFPageView} pageView
     * @returns {PDFPage}
     * @private
     */
    _ensurePdfPageLoaded:
        function PDFThumbnailViewer_ensurePdfPageLoaded(thumbView) {
          if (thumbView.pdfPage) {
            return Promise.resolve(thumbView.pdfPage);
          }
          const pageNumber = thumbView.id;
          if (this._pagesRequests[pageNumber]) {
            return this._pagesRequests[pageNumber];
          }
          const promise = this.pdfDocument.getPage(pageNumber).then(
              (pdfPage) => {
                thumbView.setPdfPage(pdfPage);
                this._pagesRequests[pageNumber] = null;
                return pdfPage;
              });
          this._pagesRequests[pageNumber] = promise;
          return promise;
        },

    ensureThumbnailVisible:
        function PDFThumbnailViewer_ensureThumbnailVisible(page) {
          // Ensure that the thumbnail of the current page is visible
          // when switching from another view.
          scrollIntoView(document.getElementById(`thumbnailContainer${page}`));
        },

    forceRendering() {
      const visibleThumbs = this._getVisibleThumbs();
      const thumbView = this.renderingQueue.getHighestPriority(visibleThumbs,
          this.thumbnails,
          this.scroll.down);
      if (thumbView) {
        this._ensurePdfPageLoaded(thumbView).then(() => {
          this.renderingQueue.renderView(thumbView);
        });
        return true;
      }
      return false;
    },
  };

  return PDFThumbnailViewer;
})();


/**
 * @typedef {Object} PDFOutlineViewOptions
 * @property {HTMLDivElement} container - The viewer element.
 * @property {Array} outline - An array of outline objects.
 * @property {IPDFLinkService} linkService - The navigation/linking service.
 */

/**
 * @class
 */
const PDFOutlineView = (function PDFOutlineViewClosure() {
  /**
   * @constructs PDFOutlineView
   * @param {PDFOutlineViewOptions} options
   */
  function PDFOutlineView(options) {
    this.container = options.container;
    this.outline = options.outline;
    this.linkService = options.linkService;
    this.lastToggleIsShow = true;
  }

  PDFOutlineView.prototype = {
    reset: function PDFOutlineView_reset() {
      const container = this.container;
      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }
      this.lastToggleIsShow = true;
    },

    /**
     * @private
     */
    _dispatchEvent: function PDFOutlineView_dispatchEvent(outlineCount) {
      const event = document.createEvent('CustomEvent');
      event.initCustomEvent('outlineloaded', true, true, {
        outlineCount,
      });
      this.container.dispatchEvent(event);
    },

    /**
     * @private
     */
    _bindLink: function PDFOutlineView_bindLink(element, item) {
      const linkService = this.linkService;
      element.href = linkService.getDestinationHash(item.dest);
      element.onclick = function goToDestination(e) {
        linkService.navigateTo(item.dest);
        return false;
      };
    },

    /**
     * Prepend a button before an outline item which allows the user to toggle
     * the visibility of all outline items at that level.
     *
     * @private
     */
    _addToggleButton: function PDFOutlineView_addToggleButton(div) {
      const toggler = document.createElement('div');
      toggler.className = 'outlineItemToggler';
      toggler.onclick = function (event) {
        event.stopPropagation();
        toggler.classList.toggle('outlineItemsHidden');

        if (event.shiftKey) {
          const shouldShowAll = !toggler.classList.contains('outlineItemsHidden');
          this._toggleOutlineItem(div, shouldShowAll);
        }
      }.bind(this);
      div.insertBefore(toggler, div.firstChild);
    },

    /**
     * Toggle the visibility of the subtree of an outline item.
     *
     * @param {Element} root - the root of the outline (sub)tree.
     * @param {boolean} state - whether to show the outline (sub)tree. If false,
     *   the outline subtree rooted at |root| will be collapsed.
     *
     * @private
     */
    _toggleOutlineItem: function PDFOutlineView_toggleOutlineItem(root, show) {
      this.lastToggleIsShow = show;
      const togglers = root.querySelectorAll('.outlineItemToggler');
      for (let i = 0, ii = togglers.length; i < ii; ++i) {
        togglers[i].classList[show ? 'remove' : 'add']('outlineItemsHidden');
      }
    },

    /**
     * Collapse or expand all subtrees of the outline.
     */
    toggleOutlineTree: function PDFOutlineView_toggleOutlineTree() {
      this._toggleOutlineItem(this.container, !this.lastToggleIsShow);
    },

    render: function PDFOutlineView_render() {
      const outline = this.outline;
      let outlineCount = 0;

      this.reset();

      if (!outline) {
        this._dispatchEvent(outlineCount);
        return;
      }

      const fragment = document.createDocumentFragment();
      const queue = [{parent: fragment, items: this.outline}];
      let hasAnyNesting = false;
      while (queue.length > 0) {
        const levelData = queue.shift();
        for (let i = 0, len = levelData.items.length; i < len; i++) {
          const item = levelData.items[i];
          const div = document.createElement('div');
          div.className = 'outlineItem';
          const element = document.createElement('a');
          this._bindLink(element, item);
          element.textContent = removeNullCharacters(item.title);
          div.appendChild(element);

          if (item.items.length > 0) {
            hasAnyNesting = true;
            this._addToggleButton(div);

            const itemsDiv = document.createElement('div');
            itemsDiv.className = 'outlineItems';
            div.appendChild(itemsDiv);
            queue.push({parent: itemsDiv, items: item.items});
          }

          levelData.parent.appendChild(div);
          outlineCount++;
        }
      }
      if (hasAnyNesting) {
        this.container.classList.add('outlineWithDeepNesting');
      }

      this.container.appendChild(fragment);

      this._dispatchEvent(outlineCount);
    },
  };

  return PDFOutlineView;
})();


/**
 * @typedef {Object} PDFAttachmentViewOptions
 * @property {HTMLDivElement} container - The viewer element.
 * @property {Array} attachments - An array of attachment objects.
 * @property {DownloadManager} downloadManager - The download manager.
 */

/**
 * @class
 */
const PDFAttachmentView = (function PDFAttachmentViewClosure() {
  /**
   * @constructs PDFAttachmentView
   * @param {PDFAttachmentViewOptions} options
   */
  function PDFAttachmentView(options) {
    this.container = options.container;
    this.attachments = options.attachments;
    this.downloadManager = options.downloadManager;
  }

  PDFAttachmentView.prototype = {
    reset: function PDFAttachmentView_reset() {
      const container = this.container;
      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }
    },

    /**
     * @private
     */
    _dispatchEvent: function PDFAttachmentView_dispatchEvent(attachmentsCount) {
      const event = document.createEvent('CustomEvent');
      event.initCustomEvent('attachmentsloaded', true, true, {
        attachmentsCount,
      });
      this.container.dispatchEvent(event);
    },

    /**
     * @private
     */
    _bindLink: function PDFAttachmentView_bindLink(button, content, filename) {
      button.onclick = function downloadFile(e) {
        this.downloadManager.downloadData(content, filename, '');
        return false;
      }.bind(this);
    },

    render: function PDFAttachmentView_render() {
      const attachments = this.attachments;
      let attachmentsCount = 0;

      this.reset();

      if (!attachments) {
        this._dispatchEvent(attachmentsCount);
        return;
      }

      const names = Object.keys(attachments).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      attachmentsCount = names.length;

      for (let i = 0; i < attachmentsCount; i++) {
        const item = attachments[names[i]];
        const filename = getFileName(item.filename);
        const div = document.createElement('div');
        div.className = 'attachmentsItem';
        const button = document.createElement('button');
        this._bindLink(button, item.content, filename);
        button.textContent = removeNullCharacters(filename);
        div.appendChild(button);
        this.container.appendChild(div);
      }

      this._dispatchEvent(attachmentsCount);
    },
  };

  return PDFAttachmentView;
})();


var PDFViewerApplication = {
  initialBookmark: document.location.hash.substring(1),
  initialDestination: null,
  initialized: false,
  fellback: false,
  pdfDocument: null,
  pdfLoadingTask: null,
  sidebarOpen: false,
  printing: false,
  /** @type {PDFViewer} */
  pdfViewer: null,
  /** @type {PDFThumbnailViewer} */
  pdfThumbnailViewer: null,
  /** @type {PDFRenderingQueue} */
  pdfRenderingQueue: null,
  /** @type {PDFPresentationMode} */
  pdfPresentationMode: null,
  /** @type {PDFDocumentProperties} */
  pdfDocumentProperties: null,
  /** @type {PDFLinkService} */
  pdfLinkService: null,
  /** @type {PDFHistory} */
  pdfHistory: null,
  pageRotation: 0,
  isInitialViewSet: false,
  animationStartedPromise: null,
  preferenceSidebarViewOnLoad: SidebarView.NONE,
  preferencePdfBugEnabled: false,
  preferenceShowPreviousViewOnLoad: true,
  preferenceDefaultZoomValue: '',
  isViewerEmbedded: (window.parent !== window),
  url: '',

  // called once when the document is loaded
  initialize: function pdfViewInitialize() {
    const pdfRenderingQueue = new PDFRenderingQueue();
    pdfRenderingQueue.onIdle = this.cleanup.bind(this);
    this.pdfRenderingQueue = pdfRenderingQueue;

    const pdfLinkService = new PDFLinkService();
    this.pdfLinkService = pdfLinkService;

    const container = document.getElementById('viewerContainer');
    const viewer = document.getElementById('viewer');
    this.pdfViewer = new PDFViewer({
      container,
      viewer,
      renderingQueue: pdfRenderingQueue,
      linkService: pdfLinkService,
    });
    pdfRenderingQueue.setViewer(this.pdfViewer);
    pdfLinkService.setViewer(this.pdfViewer);

    const thumbnailContainer = document.getElementById('thumbnailView');
    this.pdfThumbnailViewer = new PDFThumbnailViewer({
      container: thumbnailContainer,
      renderingQueue: pdfRenderingQueue,
      linkService: pdfLinkService,
    });
    pdfRenderingQueue.setThumbnailViewer(this.pdfThumbnailViewer);

    Preferences.initialize();

    this.pdfHistory = new PDFHistory({
      linkService: pdfLinkService,
    });
    pdfLinkService.setHistory(this.pdfHistory);

    this.findController = new PDFFindController({
      pdfViewer: this.pdfViewer,
      integratedFind: this.supportsIntegratedFind,
    });
    this.pdfViewer.setFindController(this.findController);

    this.findBar = new PDFFindBar({
      bar: document.getElementById('findbar'),
      toggleButton: document.getElementById('viewFind'),
      findField: document.getElementById('findInput'),
      highlightAllCheckbox: document.getElementById('findHighlightAll'),
      caseSensitiveCheckbox: document.getElementById('findMatchCase'),
      findMsg: document.getElementById('findMsg'),
      findResultsCount: document.getElementById('findResultsCount'),
      findStatusIcon: document.getElementById('findStatusIcon'),
      findPreviousButton: document.getElementById('findPrevious'),
      findNextButton: document.getElementById('findNext'),
      findController: this.findController,
    });

    this.findController.setFindBar(this.findBar);

    HandTool.initialize({
      container,
      toggleHandTool: document.getElementById('toggleHandTool'),
    });

    this.pdfDocumentProperties = new PDFDocumentProperties({
      overlayName: 'documentPropertiesOverlay',
      closeButton: document.getElementById('documentPropertiesClose'),
      fields: {
        fileName: document.getElementById('fileNameField'),
        fileSize: document.getElementById('fileSizeField'),
        title: document.getElementById('titleField'),
        author: document.getElementById('authorField'),
        subject: document.getElementById('subjectField'),
        keywords: document.getElementById('keywordsField'),
        creationDate: document.getElementById('creationDateField'),
        modificationDate: document.getElementById('modificationDateField'),
        creator: document.getElementById('creatorField'),
        producer: document.getElementById('producerField'),
        version: document.getElementById('versionField'),
        pageCount: document.getElementById('pageCountField'),
      },
    });

    SecondaryToolbar.initialize({
      toolbar: document.getElementById('secondaryToolbar'),
      toggleButton: document.getElementById('secondaryToolbarToggle'),
      presentationModeButton:
        document.getElementById('secondaryPresentationMode'),
      openFile: document.getElementById('secondaryOpenFile'),
      print: document.getElementById('secondaryPrint'),
      download: document.getElementById('secondaryDownload'),
      viewBookmark: document.getElementById('secondaryViewBookmark'),
      firstPage: document.getElementById('firstPage'),
      lastPage: document.getElementById('lastPage'),
      pageRotateCw: document.getElementById('pageRotateCw'),
      pageRotateCcw: document.getElementById('pageRotateCcw'),
      documentPropertiesButton: document.getElementById('documentProperties'),
    });

    if (this.supportsFullscreen) {
      const toolbar = SecondaryToolbar;
      this.pdfPresentationMode = new PDFPresentationMode({
        container,
        viewer,
        pdfViewer: this.pdfViewer,
        pdfThumbnailViewer: this.pdfThumbnailViewer,
        contextMenuItems: [
          {element: document.getElementById('contextFirstPage'),
            handler: toolbar.firstPageClick.bind(toolbar)},
          {element: document.getElementById('contextLastPage'),
            handler: toolbar.lastPageClick.bind(toolbar)},
          {element: document.getElementById('contextPageRotateCw'),
            handler: toolbar.pageRotateCwClick.bind(toolbar)},
          {element: document.getElementById('contextPageRotateCcw'),
            handler: toolbar.pageRotateCcwClick.bind(toolbar)},
        ],
      });
    }

    PasswordPrompt.initialize({
      overlayName: 'passwordOverlay',
      passwordField: document.getElementById('password'),
      passwordText: document.getElementById('passwordText'),
      passwordSubmit: document.getElementById('passwordSubmit'),
      passwordCancel: document.getElementById('passwordCancel'),
    });

    const self = this;
    const initializedPromise = Promise.all([
      Preferences.get('enableWebGL').then((value) => {
        PDFJS.disableWebGL = !value;
      }),
      Preferences.get('sidebarViewOnLoad').then((value) => {
        self.preferenceSidebarViewOnLoad = value;
      }),
      Preferences.get('pdfBugEnabled').then((value) => {
        self.preferencePdfBugEnabled = value;
      }),
      Preferences.get('showPreviousViewOnLoad').then((value) => {
        self.preferenceShowPreviousViewOnLoad = value;
      }),
      Preferences.get('defaultZoomValue').then((value) => {
        self.preferenceDefaultZoomValue = value;
      }),
      Preferences.get('disableTextLayer').then((value) => {
        if (PDFJS.disableTextLayer === true) {
          return;
        }
        PDFJS.disableTextLayer = value;
      }),
      Preferences.get('disableRange').then((value) => {
        if (PDFJS.disableRange === true) {
          return;
        }
        PDFJS.disableRange = value;
      }),
      Preferences.get('disableStream').then((value) => {
        if (PDFJS.disableStream === true) {
          return;
        }
        PDFJS.disableStream = value;
      }),
      Preferences.get('disableAutoFetch').then((value) => {
        PDFJS.disableAutoFetch = value;
      }),
      Preferences.get('disableFontFace').then((value) => {
        if (PDFJS.disableFontFace === true) {
          return;
        }
        PDFJS.disableFontFace = value;
      }),
      Preferences.get('useOnlyCssZoom').then((value) => {
        PDFJS.useOnlyCssZoom = value;
      }),
      Preferences.get('externalLinkTarget').then((value) => {
        if (PDFJS.isExternalLinkTargetSet()) {
          return;
        }
        PDFJS.externalLinkTarget = value;
      }),
      // TODO move more preferences and other async stuff here
    ]).catch((reason) => { });

    return initializedPromise.then(() => {
      if (self.isViewerEmbedded && !PDFJS.isExternalLinkTargetSet()) {
        // Prevent external links from "replacing" the viewer,
        // when it's embedded in e.g. an iframe or an object.
        PDFJS.externalLinkTarget = PDFJS.LinkTarget.TOP;
      }

      self.initialized = true;
    });
  },

  zoomIn: function pdfViewZoomIn(ticks) {
    let newScale = this.pdfViewer.currentScale;
    do {
      newScale = (newScale * DEFAULT_SCALE_DELTA).toFixed(2);
      newScale = Math.ceil(newScale * 10) / 10;
      newScale = Math.min(MAX_SCALE, newScale);
    } while (--ticks > 0 && newScale < MAX_SCALE);
    this.pdfViewer.currentScaleValue = newScale;
  },

  zoomOut: function pdfViewZoomOut(ticks) {
    let newScale = this.pdfViewer.currentScale;
    do {
      newScale = (newScale / DEFAULT_SCALE_DELTA).toFixed(2);
      newScale = Math.floor(newScale * 10) / 10;
      newScale = Math.max(MIN_SCALE, newScale);
    } while (--ticks > 0 && newScale > MIN_SCALE);
    this.pdfViewer.currentScaleValue = newScale;
  },

  get pagesCount() {
    return this.pdfDocument.numPages;
  },

  set page(val) {
    this.pdfLinkService.page = val;
  },

  get page() { // TODO remove
    return this.pdfLinkService.page;
  },

  get supportsPrinting() {
    const canvas = document.createElement('canvas');
    const value = 'mozPrintCallback' in canvas;

    return PDFJS.shadow(this, 'supportsPrinting', value);
  },

  get supportsFullscreen() {
    const doc = document.documentElement;
    let support = !!(doc.requestFullscreen || doc.mozRequestFullScreen ||
                     doc.webkitRequestFullScreen || doc.msRequestFullscreen);

    if (document.fullscreenEnabled === false ||
        document.mozFullScreenEnabled === false ||
        document.webkitFullscreenEnabled === false ||
        document.msFullscreenEnabled === false) {
      support = false;
    }
    if (support && PDFJS.disableFullscreen === true) {
      support = false;
    }

    return PDFJS.shadow(this, 'supportsFullscreen', support);
  },

  get supportsIntegratedFind() {
    const support = false;

    return PDFJS.shadow(this, 'supportsIntegratedFind', support);
  },

  get supportsDocumentFonts() {
    const support = true;

    return PDFJS.shadow(this, 'supportsDocumentFonts', support);
  },

  get supportsDocumentColors() {
    const support = true;

    return PDFJS.shadow(this, 'supportsDocumentColors', support);
  },

  get loadingBar() {
    const bar = new ProgressBar('#loadingBar', {});

    return PDFJS.shadow(this, 'loadingBar', bar);
  },

  get supportedMouseWheelZoomModifierKeys() {
    const support = {
      ctrlKey: true,
      metaKey: true,
    };

    return PDFJS.shadow(this, 'supportedMouseWheelZoomModifierKeys', support);
  },


  setTitleUsingUrl: function pdfViewSetTitleUsingUrl(url) {
    this.url = url;
    try {
      this.setTitle(decodeURIComponent(getFileName(url)) || url);
    } catch (e) {
      // decodeURIComponent may throw URIError,
      // fall back to using the unprocessed url in that case
      this.setTitle(url);
    }
  },

  setTitle: function pdfViewSetTitle(title) {
    if (this.isViewerEmbedded) {
      // Embedded PDF viewers should not be changing their parent page's title.
      return;
    }
    document.title = title;
  },

  /**
   * Closes opened PDF document.
   * @returns {Promise} - Returns the promise, which is resolved when all
   *                      destruction is completed.
   */
  close: function pdfViewClose() {
    const errorWrapper = document.getElementById('errorWrapper');
    errorWrapper.setAttribute('hidden', 'true');

    if (!this.pdfLoadingTask) {
      return Promise.resolve();
    }

    const promise = this.pdfLoadingTask.destroy();
    this.pdfLoadingTask = null;

    if (this.pdfDocument) {
      this.pdfDocument = null;

      this.pdfThumbnailViewer.setDocument(null);
      this.pdfViewer.setDocument(null);
      this.pdfLinkService.setDocument(null, null);
    }

    if (typeof PDFBug !== 'undefined') {
      PDFBug.cleanup();
    }
    return promise;
  },

  /**
   * Opens PDF document specified by URL or array with additional arguments.
   * @param {string|TypedArray|ArrayBuffer} file - PDF location or binary data.
   * @param {Object} args - (optional) Additional arguments for the getDocument
   *                        call, e.g. HTTP headers ('httpHeaders') or
   *                        alternative data transport ('range').
   * @returns {Promise} - Returns the promise, which is resolved when document
   *                      is opened.
   */
  open: function pdfViewOpen(file, args) {
    let scale = 0;
    if (arguments.length > 2 || typeof args === 'number') {
      console.warn('Call of open() with obsolete signature.');
      if (typeof args === 'number') {
        scale = args; // scale argument was found
      }
      args = arguments[4] || null;
      if (arguments[3] && typeof arguments[3] === 'object') {
        // The pdfDataRangeTransport argument is present.
        args = Object.create(args);
        args.range = arguments[3];
      }
      if (typeof arguments[2] === 'string') {
        // The password argument is present.
        args = Object.create(args);
        args.password = arguments[2];
      }
    }

    if (this.pdfLoadingTask) {
      // We need to destroy already opened document.
      return this.close().then(() => {
        // Reload the preferences if a document was previously opened.
        Preferences.reload();
        // ... and repeat the open() call.
        return this.open(file, args);
      });
    }

    const parameters = Object.create(null);
    if (typeof file === 'string') { // URL
      this.setTitleUsingUrl(file);
      parameters.url = file;
    } else if (file && 'byteLength' in file) { // ArrayBuffer
      parameters.data = file;
    } else if (file.url && file.originalUrl) {
      this.setTitleUsingUrl(file.originalUrl);
      parameters.url = file.url;
    }
    if (args) {
      for (const prop in args) {
        parameters[prop] = args[prop];
      }
    }

    const self = this;
    self.downloadComplete = false;

    const loadingTask = PDFJS.getDocument(parameters);
    this.pdfLoadingTask = loadingTask;

    loadingTask.onPassword = function passwordNeeded(updatePassword, reason) {
      PasswordPrompt.updatePassword = updatePassword;
      PasswordPrompt.reason = reason;
      PasswordPrompt.open();
    };

    loadingTask.onProgress = function getDocumentProgress(progressData) {
      self.progress(progressData.loaded / progressData.total);
    };

    const result = loadingTask.promise.then(
        (pdfDocument) => {
          self.load(pdfDocument, scale);
        },
        (exception) => {
          const message = exception && exception.message;
          let loadingErrorMessage = mozL10n.get('loading_error', null,
              'An error occurred while loading the PDF.');

          if (exception instanceof PDFJS.InvalidPDFException) {
          // change error message also for other builds
            loadingErrorMessage = mozL10n.get('invalid_file_error', null,
                'Invalid or corrupted PDF file.');
          } else if (exception instanceof PDFJS.MissingPDFException) {
          // special message for missing PDF's
            loadingErrorMessage = mozL10n.get('missing_file_error', null,
                'Missing PDF file.');
          } else if (exception instanceof PDFJS.UnexpectedResponseException) {
            loadingErrorMessage = mozL10n.get('unexpected_response_error', null,
                'Unexpected server response.');
          }

          const moreInfo = {
            message,
          };
          self.error(loadingErrorMessage, moreInfo);

          throw new Error(loadingErrorMessage);
        }
    );

    if (args && args.length) {
      PDFViewerApplication.pdfDocumentProperties.setFileSize(args.length);
    }
    return result;
  },

  download: function pdfViewDownload() {
    function downloadByUrl() {
      downloadManager.downloadUrl(url, filename);
    }

    var url = this.url.split('#')[0];
    var filename = getPDFFileNameFromURL(url);
    var downloadManager = new DownloadManager();
    downloadManager.onerror = function (err) {
      // This error won't really be helpful because it's likely the
      // fallback won't work either (or is already open).
      PDFViewerApplication.error('PDF failed to download.');
    };

    if (!this.pdfDocument) { // the PDF is not ready yet
      downloadByUrl();
      return;
    }

    if (!this.downloadComplete) { // the PDF is still downloading
      downloadByUrl();
      return;
    }

    this.pdfDocument.getData().then(
        (data) => {
          const blob = PDFJS.createBlob(data, 'application/pdf');
          downloadManager.download(blob, url, filename);
        },
        downloadByUrl // Error occurred try downloading with just the url.
    ).then(null, downloadByUrl);
  },

  fallback: function pdfViewFallback(featureId) {
  },

  /**
   * Show the error box.
   * @param {String} message A message that is human readable.
   * @param {Object} moreInfo (optional) Further information about the error
   *                            that is more technical.  Should have a 'message'
   *                            and optionally a 'stack' property.
   */
  error: function pdfViewError(message, moreInfo) {
    let moreInfoText = `${mozL10n.get('error_version_info',
        {version: PDFJS.version || '?', build: PDFJS.build || '?'},
        'PDF.js v{{version}} (build: {{build}})')}\n`;
    if (moreInfo) {
      moreInfoText +=
        mozL10n.get('error_message', {message: moreInfo.message},
            'Message: {{message}}');
      if (moreInfo.stack) {
        moreInfoText += `\n${
          mozL10n.get('error_stack', {stack: moreInfo.stack},
              'Stack: {{stack}}')}`;
      } else {
        if (moreInfo.filename) {
          moreInfoText += `\n${
            mozL10n.get('error_file', {file: moreInfo.filename},
                'File: {{file}}')}`;
        }
        if (moreInfo.lineNumber) {
          moreInfoText += `\n${
            mozL10n.get('error_line', {line: moreInfo.lineNumber},
                'Line: {{line}}')}`;
        }
      }
    }

    const errorWrapper = document.getElementById('errorWrapper');
    errorWrapper.removeAttribute('hidden');

    const errorMessage = document.getElementById('errorMessage');
    errorMessage.textContent = message;

    const closeButton = document.getElementById('errorClose');
    closeButton.onclick = function () {
      errorWrapper.setAttribute('hidden', 'true');
    };

    const errorMoreInfo = document.getElementById('errorMoreInfo');
    const moreInfoButton = document.getElementById('errorShowMore');
    const lessInfoButton = document.getElementById('errorShowLess');
    moreInfoButton.onclick = function () {
      errorMoreInfo.removeAttribute('hidden');
      moreInfoButton.setAttribute('hidden', 'true');
      lessInfoButton.removeAttribute('hidden');
      errorMoreInfo.style.height = `${errorMoreInfo.scrollHeight}px`;
    };
    lessInfoButton.onclick = function () {
      errorMoreInfo.setAttribute('hidden', 'true');
      moreInfoButton.removeAttribute('hidden');
      lessInfoButton.setAttribute('hidden', 'true');
    };
    moreInfoButton.oncontextmenu = noContextMenuHandler;
    lessInfoButton.oncontextmenu = noContextMenuHandler;
    closeButton.oncontextmenu = noContextMenuHandler;
    moreInfoButton.removeAttribute('hidden');
    lessInfoButton.setAttribute('hidden', 'true');
    errorMoreInfo.value = moreInfoText;
  },

  progress: function pdfViewProgress(level) {
    const percent = Math.round(level * 100);
    // When we transition from full request to range requests, it's possible
    // that we discard some of the loaded data. This can cause the loading
    // bar to move backwards. So prevent this by only updating the bar if it
    // increases.
    if (percent > this.loadingBar.percent || isNaN(percent)) {
      this.loadingBar.percent = percent;

      // When disableAutoFetch is enabled, it's not uncommon for the entire file
      // to never be fetched (depends on e.g. the file structure). In this case
      // the loading bar will not be completely filled, nor will it be hidden.
      // To prevent displaying a partially filled loading bar permanently, we
      // hide it when no data has been loaded during a certain amount of time.
      if (PDFJS.disableAutoFetch && percent) {
        if (this.disableAutoFetchLoadingBarTimeout) {
          clearTimeout(this.disableAutoFetchLoadingBarTimeout);
          this.disableAutoFetchLoadingBarTimeout = null;
        }
        this.loadingBar.show();

        this.disableAutoFetchLoadingBarTimeout = setTimeout(() => {
          this.loadingBar.hide();
          this.disableAutoFetchLoadingBarTimeout = null;
        }, DISABLE_AUTO_FETCH_LOADING_BAR_TIMEOUT);
      }
    }
  },

  load: function pdfViewLoad(pdfDocument, scale) {
    const self = this;
    scale = scale || UNKNOWN_SCALE;

    this.findController.reset();

    this.pdfDocument = pdfDocument;

    this.pdfDocumentProperties.setDocumentAndUrl(pdfDocument, this.url);

    const downloadedPromise = pdfDocument.getDownloadInfo().then(() => {
      self.downloadComplete = true;
      self.loadingBar.hide();
    });

    const pagesCount = pdfDocument.numPages;
    document.getElementById('numPages').textContent =
      mozL10n.get('page_of', {pageCount: pagesCount}, 'of {{pageCount}}');
    document.getElementById('pageNumber').max = pagesCount;

    const id = this.documentFingerprint = pdfDocument.fingerprint;
    const store = this.store = new ViewHistory(id);

    const baseDocumentUrl = null;
    this.pdfLinkService.setDocument(pdfDocument, baseDocumentUrl);

    const pdfViewer = this.pdfViewer;
    pdfViewer.currentScale = scale;
    pdfViewer.setDocument(pdfDocument);
    const firstPagePromise = pdfViewer.firstPagePromise;
    const pagesPromise = pdfViewer.pagesPromise;
    const onePageRendered = pdfViewer.onePageRendered;

    this.pageRotation = 0;
    this.isInitialViewSet = false;

    this.pdfThumbnailViewer.setDocument(pdfDocument);

    firstPagePromise.then((pdfPage) => {
      downloadedPromise.then(() => {
        const event = document.createEvent('CustomEvent');
        event.initCustomEvent('documentload', true, true, {});
        window.dispatchEvent(event);
      });

      self.loadingBar.setWidth(document.getElementById('viewer'));

      if (!PDFJS.disableHistory && !self.isViewerEmbedded) {
        // The browsing history is only enabled when the viewer is standalone,
        // i.e. not when it is embedded in a web page.
        if (!self.preferenceShowPreviousViewOnLoad) {
          self.pdfHistory.clearHistoryState();
        }
        self.pdfHistory.initialize(self.documentFingerprint);

        if (self.pdfHistory.initialDestination) {
          self.initialDestination = self.pdfHistory.initialDestination;
        } else if (self.pdfHistory.initialBookmark) {
          self.initialBookmark = self.pdfHistory.initialBookmark;
        }
      }

      const initialParams = {
        destination: self.initialDestination,
        bookmark: self.initialBookmark,
        hash: null,
      };

      store.initializedPromise.then(() => {
        let storedHash = null;
        if (self.preferenceShowPreviousViewOnLoad &&
            store.get('exists', false)) {
          const pageNum = store.get('page', '1');
          const zoom = self.preferenceDefaultZoomValue ||
                     store.get('zoom', DEFAULT_SCALE_VALUE);
          const left = store.get('scrollLeft', '0');
          const top = store.get('scrollTop', '0');

          storedHash = `page=${pageNum}&zoom=${zoom},${
            left},${top}`;
        } else if (self.preferenceDefaultZoomValue) {
          storedHash = `page=1&zoom=${self.preferenceDefaultZoomValue}`;
        }
        self.setInitialView(storedHash, scale);

        initialParams.hash = storedHash;

        // Make all navigation keys work on document load,
        // unless the viewer is embedded in a web page.
        if (!self.isViewerEmbedded) {
          self.pdfViewer.focus();
        }
      }, (reason) => {
        console.error(reason);
        self.setInitialView(null, scale);
      });

      // For documents with different page sizes,
      // ensure that the correct location becomes visible on load.
      pagesPromise.then(() => {
        if (!initialParams.destination && !initialParams.bookmark &&
            !initialParams.hash) {
          return;
        }
        if (self.hasEqualPageSizes) {
          return;
        }
        self.initialDestination = initialParams.destination;
        self.initialBookmark = initialParams.bookmark;

        self.pdfViewer.currentScaleValue = self.pdfViewer.currentScaleValue;
        self.setInitialView(initialParams.hash, scale);
      });
    });

    pagesPromise.then(() => {
      if (self.supportsPrinting) {
        pdfDocument.getJavaScript().then((javaScript) => {
          if (javaScript.length) {
            console.warn('Warning: JavaScript is not supported');
            self.fallback(PDFJS.UNSUPPORTED_FEATURES.javaScript);
          }
          // Hack to support auto printing.
          const regex = /\bprint\s*\(/;
          for (let i = 0, ii = javaScript.length; i < ii; i++) {
            const js = javaScript[i];
            if (js && regex.test(js)) {
              setTimeout(() => {
                window.print();
              });
              return;
            }
          }
        });
      }
    });

    // outline depends on pagesRefMap
    const promises = [pagesPromise, this.animationStartedPromise];
    Promise.all(promises).then(() => {
      pdfDocument.getOutline().then((outline) => {
        const container = document.getElementById('outlineView');
        self.outline = new PDFOutlineView({
          container,
          outline,
          linkService: self.pdfLinkService,
        });
        self.outline.render();
        document.getElementById('viewOutline').disabled = !outline;

        if (!outline && !container.classList.contains('hidden')) {
          self.switchSidebarView('thumbs');
        }
        if (outline &&
            self.preferenceSidebarViewOnLoad === SidebarView.OUTLINE) {
          self.switchSidebarView('outline', true);
        }
      });
      pdfDocument.getAttachments().then((attachments) => {
        const container = document.getElementById('attachmentsView');
        self.attachments = new PDFAttachmentView({
          container,
          attachments,
          downloadManager: new DownloadManager(),
        });
        self.attachments.render();
        document.getElementById('viewAttachments').disabled = !attachments;

        if (!attachments && !container.classList.contains('hidden')) {
          self.switchSidebarView('thumbs');
        }
        if (attachments &&
            self.preferenceSidebarViewOnLoad === SidebarView.ATTACHMENTS) {
          self.switchSidebarView('attachments', true);
        }
      });
    });

    if (self.preferenceSidebarViewOnLoad === SidebarView.THUMBS) {
      Promise.all([firstPagePromise, onePageRendered]).then(() => {
        self.switchSidebarView('thumbs', true);
      });
    }

    pdfDocument.getMetadata().then((data) => {
      const info = data.info; const
        metadata = data.metadata;
      self.documentInfo = info;
      self.metadata = metadata;

      // Provides some basic debug information
      console.log(`PDF ${pdfDocument.fingerprint} [${
        info.PDFFormatVersion} ${(info.Producer || '-').trim()
      } / ${(info.Creator || '-').trim()}]` +
                  ` (PDF.js: ${PDFJS.version || '-'
                  }${!PDFJS.disableWebGL ? ' [WebGL]' : ''})`);

      let pdfTitle;
      if (metadata && metadata.has('dc:title')) {
        const title = metadata.get('dc:title');
        // Ghostscript sometimes return 'Untitled', sets the title to 'Untitled'
        if (title !== 'Untitled') {
          pdfTitle = title;
        }
      }

      if (!pdfTitle && info && info.Title) {
        pdfTitle = info.Title;
      }

      if (pdfTitle) {
        self.setTitle(`${pdfTitle} - ${document.title}`);
      }

      if (info.IsAcroFormPresent) {
        console.warn('Warning: AcroForm/XFA is not supported');
        self.fallback(PDFJS.UNSUPPORTED_FEATURES.forms);
      }
    });
  },

  setInitialView: function pdfViewSetInitialView(storedHash, scale) {
    this.isInitialViewSet = true;

    // When opening a new file, when one is already loaded in the viewer,
    // ensure that the 'pageNumber' element displays the correct value.
    document.getElementById('pageNumber').value =
      this.pdfViewer.currentPageNumber;

    if (this.initialDestination) {
      this.pdfLinkService.navigateTo(this.initialDestination);
      this.initialDestination = null;
    } else if (this.initialBookmark) {
      this.pdfLinkService.setHash(this.initialBookmark);
      this.pdfHistory.push({hash: this.initialBookmark}, true);
      this.initialBookmark = null;
    } else if (storedHash) {
      this.pdfLinkService.setHash(storedHash);
    } else if (scale) {
      this.pdfViewer.currentScaleValue = scale;
      this.page = 1;
    }

    if (!this.pdfViewer.currentScaleValue) {
      // Scale was not initialized: invalid bookmark or scale was not specified.
      // Setting the default one.
      this.pdfViewer.currentScaleValue = DEFAULT_SCALE_VALUE;
    }
  },

  cleanup: function pdfViewCleanup() {
    if (!this.pdfDocument) {
      return; // run cleanup when document is loaded
    }
    this.pdfViewer.cleanup();
    this.pdfThumbnailViewer.cleanup();
    this.pdfDocument.cleanup();
  },

  forceRendering: function pdfViewForceRendering() {
    this.pdfRenderingQueue.printing = this.printing;
    this.pdfRenderingQueue.isThumbnailViewEnabled = this.sidebarOpen;
    this.pdfRenderingQueue.renderHighestPriority();
  },

  refreshThumbnailViewer: function pdfViewRefreshThumbnailViewer() {
    const pdfViewer = this.pdfViewer;
    const thumbnailViewer = this.pdfThumbnailViewer;

    // set thumbnail images of rendered pages
    const pagesCount = pdfViewer.pagesCount;
    for (let pageIndex = 0; pageIndex < pagesCount; pageIndex++) {
      const pageView = pdfViewer.getPageView(pageIndex);
      if (pageView && pageView.renderingState === RenderingStates.FINISHED) {
        const thumbnailView = thumbnailViewer.getThumbnail(pageIndex);
        thumbnailView.setImage(pageView);
      }
    }

    thumbnailViewer.scrollThumbnailIntoView(this.page);
  },

  switchSidebarView: function pdfViewSwitchSidebarView(view, openSidebar) {
    if (openSidebar && !this.sidebarOpen) {
      document.getElementById('sidebarToggle').click();
    }
    const thumbsView = document.getElementById('thumbnailView');
    const outlineView = document.getElementById('outlineView');
    const attachmentsView = document.getElementById('attachmentsView');

    const thumbsButton = document.getElementById('viewThumbnail');
    const outlineButton = document.getElementById('viewOutline');
    const attachmentsButton = document.getElementById('viewAttachments');

    switch (view) {
      case 'thumbs':
        var wasAnotherViewVisible = thumbsView.classList.contains('hidden');

        thumbsButton.classList.add('toggled');
        outlineButton.classList.remove('toggled');
        attachmentsButton.classList.remove('toggled');
        thumbsView.classList.remove('hidden');
        outlineView.classList.add('hidden');
        attachmentsView.classList.add('hidden');

        this.forceRendering();

        if (wasAnotherViewVisible) {
          this.pdfThumbnailViewer.ensureThumbnailVisible(this.page);
        }
        break;

      case 'outline':
        if (outlineButton.disabled) {
          return;
        }
        thumbsButton.classList.remove('toggled');
        outlineButton.classList.add('toggled');
        attachmentsButton.classList.remove('toggled');
        thumbsView.classList.add('hidden');
        outlineView.classList.remove('hidden');
        attachmentsView.classList.add('hidden');
        break;

      case 'attachments':
        if (attachmentsButton.disabled) {
          return;
        }
        thumbsButton.classList.remove('toggled');
        outlineButton.classList.remove('toggled');
        attachmentsButton.classList.add('toggled');
        thumbsView.classList.add('hidden');
        outlineView.classList.add('hidden');
        attachmentsView.classList.remove('hidden');
        break;
    }
  },

  beforePrint: function pdfViewSetupBeforePrint() {
    if (!this.supportsPrinting) {
      const printMessage = mozL10n.get('printing_not_supported', null,
          'Warning: Printing is not fully supported by this browser.');
      this.error(printMessage);
      return;
    }

    let alertNotReady = false;
    let i, ii;
    if (!this.pdfDocument || !this.pagesCount) {
      alertNotReady = true;
    } else {
      for (i = 0, ii = this.pagesCount; i < ii; ++i) {
        if (!this.pdfViewer.getPageView(i).pdfPage) {
          alertNotReady = true;
          break;
        }
      }
    }
    if (alertNotReady) {
      const notReadyMessage = mozL10n.get('printing_not_ready', null,
          'Warning: The PDF is not fully loaded for printing.');
      window.alert(notReadyMessage);
      return;
    }

    this.printing = true;
    this.forceRendering();

    const body = document.querySelector('body');
    body.setAttribute('data-mozPrintCallback', true);

    if (!this.hasEqualPageSizes) {
      console.warn('Not all pages have the same size. The printed result ' +
          'may be incorrect!');
    }

    // Insert a @page + size rule to make sure that the page size is correctly
    // set. Note that we assume that all pages have the same size, because
    // variable-size pages are not supported yet (at least in Chrome & Firefox).
    // TODO(robwu): Use named pages when size calculation bugs get resolved
    // (e.g. https://crbug.com/355116) AND when support for named pages is
    // added (http://www.w3.org/TR/css3-page/#using-named-pages).
    // In browsers where @page + size is not supported (such as Firefox,
    // https://bugzil.la/851441), the next stylesheet will be ignored and the
    // user has to select the correct paper size in the UI if wanted.
    this.pageStyleSheet = document.createElement('style');
    const pageSize = this.pdfViewer.getPageView(0).pdfPage.getViewport(1);
    this.pageStyleSheet.textContent =
      // "size:<width> <height>" is what we need. But also add "A4" because
      // Firefox incorrectly reports support for the other value.
      `${'@supports ((size:A4) and (size:1pt 1pt)) {' +
      '@page { size: '}${pageSize.width}pt ${pageSize.height}pt;}` +
      // The canvas and each ancestor node must have a height of 100% to make
      // sure that each canvas is printed on exactly one page.
      '#printContainer {height:100%}' +
      '#printContainer > div {width:100% !important;height:100% !important;}' +
      '}';
    body.appendChild(this.pageStyleSheet);

    for (i = 0, ii = this.pagesCount; i < ii; ++i) {
      this.pdfViewer.getPageView(i).beforePrint();
    }
  },

  // Whether all pages of the PDF have the same width and height.
  get hasEqualPageSizes() {
    const firstPage = this.pdfViewer.getPageView(0);
    for (let i = 1, ii = this.pagesCount; i < ii; ++i) {
      const pageView = this.pdfViewer.getPageView(i);
      if (pageView.width !== firstPage.width ||
          pageView.height !== firstPage.height) {
        return false;
      }
    }
    return true;
  },

  afterPrint: function pdfViewSetupAfterPrint() {
    const div = document.getElementById('printContainer');
    while (div.hasChildNodes()) {
      div.removeChild(div.lastChild);
    }

    if (this.pageStyleSheet && this.pageStyleSheet.parentNode) {
      this.pageStyleSheet.parentNode.removeChild(this.pageStyleSheet);
      this.pageStyleSheet = null;
    }

    this.printing = false;
    this.forceRendering();
  },

  rotatePages: function pdfViewRotatePages(delta) {
    const pageNumber = this.page;
    this.pageRotation = (this.pageRotation + 360 + delta) % 360;
    this.pdfViewer.pagesRotation = this.pageRotation;
    this.pdfThumbnailViewer.pagesRotation = this.pageRotation;

    this.forceRendering();

    this.pdfViewer.scrollPageIntoView(pageNumber);
  },

  requestPresentationMode: function pdfViewRequestPresentationMode() {
    if (!this.pdfPresentationMode) {
      return;
    }
    this.pdfPresentationMode.request();
  },

  /**
   * @param {number} delta - The delta value from the mouse event.
   */
  scrollPresentationMode: function pdfViewScrollPresentationMode(delta) {
    if (!this.pdfPresentationMode) {
      return;
    }
    this.pdfPresentationMode.mouseScroll(delta);
  },
};
window.PDFView = PDFViewerApplication; // obsolete name, using it as an alias


function webViewerLoad(evt) {
  PDFViewerApplication.initialize().then(webViewerInitialized);
}

function webViewerInitialized() {
  const queryString = document.location.search.substring(1);
  const params = parseQueryString(queryString);
  const file = 'file' in params ? params.file : DEFAULT_URL;

  const fileInput = document.createElement('input');
  fileInput.id = 'fileInput';
  fileInput.className = 'fileInput';
  fileInput.setAttribute('type', 'file');
  fileInput.oncontextmenu = noContextMenuHandler;
  document.body.appendChild(fileInput);

  if (!window.File || !window.FileReader || !window.FileList || !window.Blob) {
    document.getElementById('openFile').setAttribute('hidden', 'true');
    document.getElementById('secondaryOpenFile').setAttribute('hidden', 'true');
  } else {
    document.getElementById('fileInput').value = null;
  }

  let locale = PDFJS.locale || navigator.language;

  if (PDFViewerApplication.preferencePdfBugEnabled) {
    // Special debugging flags in the hash section of the URL.
    const hash = document.location.hash.substring(1);
    const hashParams = parseQueryString(hash);

    if ('disableworker' in hashParams) {
      PDFJS.disableWorker = (hashParams.disableworker === 'true');
    }
    if ('disablerange' in hashParams) {
      PDFJS.disableRange = (hashParams.disablerange === 'true');
    }
    if ('disablestream' in hashParams) {
      PDFJS.disableStream = (hashParams.disablestream === 'true');
    }
    if ('disableautofetch' in hashParams) {
      PDFJS.disableAutoFetch = (hashParams.disableautofetch === 'true');
    }
    if ('disablefontface' in hashParams) {
      PDFJS.disableFontFace = (hashParams.disablefontface === 'true');
    }
    if ('disablehistory' in hashParams) {
      PDFJS.disableHistory = (hashParams.disablehistory === 'true');
    }
    if ('webgl' in hashParams) {
      PDFJS.disableWebGL = (hashParams.webgl !== 'true');
    }
    if ('useonlycsszoom' in hashParams) {
      PDFJS.useOnlyCssZoom = (hashParams.useonlycsszoom === 'true');
    }
    if ('verbosity' in hashParams) {
      PDFJS.verbosity = hashParams.verbosity | 0;
    }
    if ('ignorecurrentpositiononzoom' in hashParams) {
      IGNORE_CURRENT_POSITION_ON_ZOOM =
        (hashParams.ignorecurrentpositiononzoom === 'true');
    }
    if ('locale' in hashParams) {
      locale = hashParams.locale;
    }
    if ('textlayer' in hashParams) {
      switch (hashParams.textlayer) {
        case 'off':
          PDFJS.disableTextLayer = true;
          break;
        case 'visible':
        case 'shadow':
        case 'hover':
          var viewer = document.getElementById('viewer');
          viewer.classList.add(`textLayer-${hashParams.textlayer}`);
          break;
      }
    }
    if ('pdfbug' in hashParams) {
      PDFJS.pdfBug = true;
      const pdfBug = hashParams.pdfbug;
      const enabled = pdfBug.split(',');
      PDFBug.enable(enabled);
      PDFBug.init();
    }
  }

  mozL10n.setLanguage(locale);

  if (!PDFViewerApplication.supportsPrinting) {
    document.getElementById('print').classList.add('hidden');
    document.getElementById('secondaryPrint').classList.add('hidden');
  }

  if (!PDFViewerApplication.supportsFullscreen) {
    document.getElementById('presentationMode').classList.add('hidden');
    document.getElementById('secondaryPresentationMode')
        .classList.add('hidden');
  }

  if (PDFViewerApplication.supportsIntegratedFind) {
    document.getElementById('viewFind').classList.add('hidden');
  }

  // Listen for unsupported features to trigger the fallback UI.
  PDFJS.UnsupportedManager.listen(
      PDFViewerApplication.fallback.bind(PDFViewerApplication));

  // Suppress context menus for some controls
  document.getElementById('scaleSelect').oncontextmenu = noContextMenuHandler;

  const mainContainer = document.getElementById('mainContainer');
  const outerContainer = document.getElementById('outerContainer');
  mainContainer.addEventListener('transitionend', (e) => {
    if (e.target === mainContainer) {
      const event = document.createEvent('UIEvents');
      event.initUIEvent('resize', false, false, window, 0);
      window.dispatchEvent(event);
      outerContainer.classList.remove('sidebarMoving');
    }
  }, true);

  document.getElementById('sidebarToggle').addEventListener('click',
      function () {
        this.classList.toggle('toggled');
        outerContainer.classList.add('sidebarMoving');
        outerContainer.classList.toggle('sidebarOpen');
        PDFViewerApplication.sidebarOpen =
        outerContainer.classList.contains('sidebarOpen');
        if (PDFViewerApplication.sidebarOpen) {
          PDFViewerApplication.refreshThumbnailViewer();
        }
        PDFViewerApplication.forceRendering();
      });

  document.getElementById('viewThumbnail').addEventListener('click',
      () => {
        PDFViewerApplication.switchSidebarView('thumbs');
      });

  document.getElementById('viewOutline').addEventListener('click',
      () => {
        PDFViewerApplication.switchSidebarView('outline');
      });

  document.getElementById('viewOutline').addEventListener('dblclick',
      () => {
        PDFViewerApplication.outline.toggleOutlineTree();
      });

  document.getElementById('viewAttachments').addEventListener('click',
      () => {
        PDFViewerApplication.switchSidebarView('attachments');
      });

  document.getElementById('previous').addEventListener('click',
      () => {
        PDFViewerApplication.page--;
      });

  document.getElementById('next').addEventListener('click',
      () => {
        PDFViewerApplication.page++;
      });

  document.getElementById('zoomIn').addEventListener('click',
      () => {
        PDFViewerApplication.zoomIn();
      });

  document.getElementById('zoomOut').addEventListener('click',
      () => {
        PDFViewerApplication.zoomOut();
      });

  document.getElementById('pageNumber').addEventListener('click', function () {
    this.select();
  });

  document.getElementById('pageNumber').addEventListener('change', function () {
    // Handle the user inputting a floating point number.
    PDFViewerApplication.page = (this.value | 0);

    if (this.value !== (this.value | 0).toString()) {
      this.value = PDFViewerApplication.page;
    }
  });

  document.getElementById('scaleSelect').addEventListener('change', function () {
    if (this.value === 'custom') {
      return;
    }
    PDFViewerApplication.pdfViewer.currentScaleValue = this.value;
  });

  document.getElementById('presentationMode').addEventListener('click',
      SecondaryToolbar.presentationModeClick.bind(SecondaryToolbar));

  document.getElementById('openFile').addEventListener('click',
      SecondaryToolbar.openFileClick.bind(SecondaryToolbar));

  document.getElementById('print').addEventListener('click',
      SecondaryToolbar.printClick.bind(SecondaryToolbar));

  document.getElementById('download').addEventListener('click',
      SecondaryToolbar.downloadClick.bind(SecondaryToolbar));


  if (file && file.lastIndexOf('file:', 0) === 0) {
    // file:-scheme. Load the contents in the main thread because QtWebKit
    // cannot load file:-URLs in a Web Worker. file:-URLs are usually loaded
    // very quickly, so there is no need to set up progress event listeners.
    PDFViewerApplication.setTitleUsingUrl(file);
    const xhr = new XMLHttpRequest();
    xhr.onload = function () {
      PDFViewerApplication.open(new Uint8Array(xhr.response));
    };
    try {
      xhr.open('GET', file);
      xhr.responseType = 'arraybuffer';
      xhr.send();
    } catch (e) {
      PDFViewerApplication.error(mozL10n.get('loading_error', null,
          'An error occurred while loading the PDF.'), e);
    }
    return;
  }

  if (file) {
    PDFViewerApplication.open(file);
  }
}

document.addEventListener('DOMContentLoaded', webViewerLoad, true);

document.addEventListener('pagerendered', (e) => {
  const pageNumber = e.detail.pageNumber;
  const pageIndex = pageNumber - 1;
  const pageView = PDFViewerApplication.pdfViewer.getPageView(pageIndex);

  if (PDFViewerApplication.sidebarOpen) {
    const thumbnailView = PDFViewerApplication.pdfThumbnailViewer
        .getThumbnail(pageIndex);
    thumbnailView.setImage(pageView);
  }

  if (PDFJS.pdfBug && Stats.enabled && pageView.stats) {
    Stats.add(pageNumber, pageView.stats);
  }

  if (pageView.error) {
    PDFViewerApplication.error(mozL10n.get('rendering_error', null,
        'An error occurred while rendering the page.'), pageView.error);
  }

  // If the page is still visible when it has finished rendering,
  // ensure that the page number input loading indicator is hidden.
  if (pageNumber === PDFViewerApplication.page) {
    const pageNumberInput = document.getElementById('pageNumber');
    pageNumberInput.classList.remove(PAGE_NUMBER_LOADING_INDICATOR);
  }
}, true);

document.addEventListener('textlayerrendered', (e) => {
  const pageIndex = e.detail.pageNumber - 1;
  const pageView = PDFViewerApplication.pdfViewer.getPageView(pageIndex);
}, true);

document.addEventListener('pagemode', (evt) => {
  if (!PDFViewerApplication.initialized) {
    return;
  }
  // Handle the 'pagemode' hash parameter, see also `PDFLinkService_setHash`.
  let mode = evt.detail.mode;
  switch (mode) {
    case 'bookmarks':
      // Note: Our code calls this property 'outline', even though the
      //       Open Parameter specification calls it 'bookmarks'.
      mode = 'outline';
      /* falls through */
    case 'thumbs':
    case 'attachments':
      PDFViewerApplication.switchSidebarView(mode, true);
      break;
    case 'none':
      if (PDFViewerApplication.sidebarOpen) {
        document.getElementById('sidebarToggle').click();
      }
      break;
  }
}, true);

document.addEventListener('namedaction', (e) => {
  if (!PDFViewerApplication.initialized) {
    return;
  }
  // Processing couple of named actions that might be useful.
  // See also PDFLinkService.executeNamedAction
  const action = e.detail.action;
  switch (action) {
    case 'GoToPage':
      document.getElementById('pageNumber').focus();
      break;

    case 'Find':
      if (!PDFViewerApplication.supportsIntegratedFind) {
        PDFViewerApplication.findBar.toggle();
      }
      break;
  }
}, true);

window.addEventListener('presentationmodechanged', (e) => {
  const active = e.detail.active;
  const switchInProgress = e.detail.switchInProgress;
  PDFViewerApplication.pdfViewer.presentationModeState =
    switchInProgress ? PresentationModeState.CHANGING
    : active ? PresentationModeState.FULLSCREEN : PresentationModeState.NORMAL;
});

window.addEventListener('updateviewarea', (evt) => {
  if (!PDFViewerApplication.initialized) {
    return;
  }
  const location = evt.location;

  PDFViewerApplication.store.initializedPromise.then(() => {
    PDFViewerApplication.store.setMultiple({
      exists: true,
      page: location.pageNumber,
      zoom: location.scale,
      scrollLeft: location.left,
      scrollTop: location.top,
    }).catch(() => {
      // unable to write to storage
    });
  });
  const href =
    PDFViewerApplication.pdfLinkService.getAnchorUrl(location.pdfOpenParams);
  document.getElementById('viewBookmark').href = href;
  document.getElementById('secondaryViewBookmark').href = href;

  // Update the current bookmark in the browsing history.
  PDFViewerApplication.pdfHistory.updateCurrentBookmark(location.pdfOpenParams,
      location.pageNumber);

  // Show/hide the loading indicator in the page number input element.
  const pageNumberInput = document.getElementById('pageNumber');
  const currentPage =
    PDFViewerApplication.pdfViewer.getPageView(PDFViewerApplication.page - 1);

  if (currentPage.renderingState === RenderingStates.FINISHED) {
    pageNumberInput.classList.remove(PAGE_NUMBER_LOADING_INDICATOR);
  } else {
    pageNumberInput.classList.add(PAGE_NUMBER_LOADING_INDICATOR);
  }
}, true);

window.addEventListener('resize', (evt) => {
  if (PDFViewerApplication.initialized) {
    const currentScaleValue = PDFViewerApplication.pdfViewer.currentScaleValue;
    if (currentScaleValue === 'auto' ||
        currentScaleValue === 'page-fit' ||
        currentScaleValue === 'page-width') {
      // Note: the scale is constant for 'page-actual'.
      PDFViewerApplication.pdfViewer.currentScaleValue = currentScaleValue;
    } else if (!currentScaleValue) {
      // Normally this shouldn't happen, but if the scale wasn't initialized
      // we set it to the default value in order to prevent any issues.
      // (E.g. the document being rendered with the wrong scale on load.)
      PDFViewerApplication.pdfViewer.currentScaleValue = DEFAULT_SCALE_VALUE;
    }
    PDFViewerApplication.pdfViewer.update();
  }

  // Set the 'max-height' CSS property of the secondary toolbar.
  SecondaryToolbar.setMaxHeight(document.getElementById('viewerContainer'));
});

window.addEventListener('hashchange', (evt) => {
  if (PDFViewerApplication.pdfHistory.isHashChangeUnlocked) {
    const hash = document.location.hash.substring(1);
    if (!hash) {
      return;
    }
    if (!PDFViewerApplication.isInitialViewSet) {
      PDFViewerApplication.initialBookmark = hash;
    } else {
      PDFViewerApplication.pdfLinkService.setHash(hash);
    }
  }
});

window.addEventListener('change', (evt) => {
  const files = evt.target.files;
  if (!files || files.length === 0) {
    return;
  }
  const file = files[0];

  if (!PDFJS.disableCreateObjectURL &&
      typeof URL !== 'undefined' && URL.createObjectURL) {
    PDFViewerApplication.open(URL.createObjectURL(file));
  } else {
    // Read the local file into a Uint8Array.
    const fileReader = new FileReader();
    fileReader.onload = function webViewerChangeFileReaderOnload(evt) {
      const buffer = evt.target.result;
      const uint8Array = new Uint8Array(buffer);
      PDFViewerApplication.open(uint8Array);
    };
    fileReader.readAsArrayBuffer(file);
  }

  PDFViewerApplication.setTitleUsingUrl(file.name);

  // URL does not reflect proper document location - hiding some icons.
  document.getElementById('viewBookmark').setAttribute('hidden', 'true');
  document.getElementById('secondaryViewBookmark')
      .setAttribute('hidden', 'true');
  document.getElementById('download').setAttribute('hidden', 'true');
  document.getElementById('secondaryDownload').setAttribute('hidden', 'true');
}, true);

function selectScaleOption(value) {
  const options = document.getElementById('scaleSelect').options;
  let predefinedValueFound = false;
  for (let i = 0, ii = options.length; i < ii; i++) {
    const option = options[i];
    if (option.value !== value) {
      option.selected = false;
      continue;
    }
    option.selected = true;
    predefinedValueFound = true;
  }
  return predefinedValueFound;
}

window.addEventListener('localized', (evt) => {
  document.getElementsByTagName('html')[0].dir = mozL10n.getDirection();

  PDFViewerApplication.animationStartedPromise.then(() => {
    // Adjust the width of the zoom box to fit the content.
    // Note: If the window is narrow enough that the zoom box is not visible,
    //       we temporarily show it to be able to adjust its width.
    const container = document.getElementById('scaleSelectContainer');
    if (container.clientWidth === 0) {
      container.setAttribute('style', 'display: inherit;');
    }
    if (container.clientWidth > 0) {
      const select = document.getElementById('scaleSelect');
      select.setAttribute('style', 'min-width: inherit;');
      const width = select.clientWidth + SCALE_SELECT_CONTAINER_PADDING;
      select.setAttribute('style', `min-width: ${
        width + SCALE_SELECT_PADDING}px;`);
      container.setAttribute('style', `min-width: ${width}px; ` +
                                      `max-width: ${width}px;`);
    }

    // Set the 'max-height' CSS property of the secondary toolbar.
    SecondaryToolbar.setMaxHeight(document.getElementById('viewerContainer'));
  });
}, true);

window.addEventListener('scalechange', (evt) => {
  document.getElementById('zoomOut').disabled = (evt.scale === MIN_SCALE);
  document.getElementById('zoomIn').disabled = (evt.scale === MAX_SCALE);

  // Update the 'scaleSelect' DOM element.
  const predefinedValueFound = selectScaleOption(evt.presetValue ||
                                               `${evt.scale}`);
  if (!predefinedValueFound) {
    const customScaleOption = document.getElementById('customScaleOption');
    const customScale = Math.round(evt.scale * 10000) / 100;
    customScaleOption.textContent =
      mozL10n.get('page_scale_percent', {scale: customScale}, '{{scale}}%');
    customScaleOption.selected = true;
  }
  if (!PDFViewerApplication.initialized) {
    return;
  }
  PDFViewerApplication.pdfViewer.update();
}, true);

window.addEventListener('pagechange', (evt) => {
  const page = evt.pageNumber;
  if (evt.previousPageNumber !== page) {
    document.getElementById('pageNumber').value = page;
    if (PDFViewerApplication.sidebarOpen) {
      PDFViewerApplication.pdfThumbnailViewer.scrollThumbnailIntoView(page);
    }
  }
  const numPages = PDFViewerApplication.pagesCount;

  document.getElementById('previous').disabled = (page <= 1);
  document.getElementById('next').disabled = (page >= numPages);

  document.getElementById('firstPage').disabled = (page <= 1);
  document.getElementById('lastPage').disabled = (page >= numPages);

  // we need to update stats
  if (PDFJS.pdfBug && Stats.enabled) {
    const pageView = PDFViewerApplication.pdfViewer.getPageView(page - 1);
    if (pageView.stats) {
      Stats.add(page, pageView.stats);
    }
  }
}, true);

function handleMouseWheel(evt) {
  const MOUSE_WHEEL_DELTA_FACTOR = 40;
  const ticks = (evt.type === 'DOMMouseScroll') ? -evt.detail
    : evt.wheelDelta / MOUSE_WHEEL_DELTA_FACTOR;
  const direction = (ticks < 0) ? 'zoomOut' : 'zoomIn';

  const pdfViewer = PDFViewerApplication.pdfViewer;
  if (pdfViewer.isInPresentationMode) {
    evt.preventDefault();
    PDFViewerApplication.scrollPresentationMode(ticks *
                                                MOUSE_WHEEL_DELTA_FACTOR);
  } else if (evt.ctrlKey || evt.metaKey) {
    const support = PDFViewerApplication.supportedMouseWheelZoomModifierKeys;
    if ((evt.ctrlKey && !support.ctrlKey) ||
        (evt.metaKey && !support.metaKey)) {
      return;
    }
    // Only zoom the pages, not the entire viewer.
    evt.preventDefault();

    const previousScale = pdfViewer.currentScale;

    PDFViewerApplication[direction](Math.abs(ticks));

    const currentScale = pdfViewer.currentScale;
    if (previousScale !== currentScale) {
      // After scaling the page via zoomIn/zoomOut, the position of the upper-
      // left corner is restored. When the mouse wheel is used, the position
      // under the cursor should be restored instead.
      const scaleCorrectionFactor = currentScale / previousScale - 1;
      const rect = pdfViewer.container.getBoundingClientRect();
      const dx = evt.clientX - rect.left;
      const dy = evt.clientY - rect.top;
      pdfViewer.container.scrollLeft += dx * scaleCorrectionFactor;
      pdfViewer.container.scrollTop += dy * scaleCorrectionFactor;
    }
  }
}

window.addEventListener('DOMMouseScroll', handleMouseWheel);
window.addEventListener('mousewheel', handleMouseWheel);

window.addEventListener('click', (evt) => {
  if (SecondaryToolbar.opened &&
      PDFViewerApplication.pdfViewer.containsElement(evt.target)) {
    SecondaryToolbar.close();
  }
}, false);

window.addEventListener('keydown', (evt) => {
  if (OverlayManager.active) {
    return;
  }

  let handled = false;
  const cmd = (evt.ctrlKey ? 1 : 0) |
            (evt.altKey ? 2 : 0) |
            (evt.shiftKey ? 4 : 0) |
            (evt.metaKey ? 8 : 0);

  const pdfViewer = PDFViewerApplication.pdfViewer;
  const isViewerInPresentationMode = pdfViewer && pdfViewer.isInPresentationMode;

  // First, handle the key bindings that are independent whether an input
  // control is selected or not.
  if (cmd === 1 || cmd === 8 || cmd === 5 || cmd === 12) {
    // either CTRL or META key with optional SHIFT.
    switch (evt.keyCode) {
      case 70: // f
        if (!PDFViewerApplication.supportsIntegratedFind) {
          PDFViewerApplication.findBar.open();
          handled = true;
        }
        break;
      case 71: // g
        if (!PDFViewerApplication.supportsIntegratedFind) {
          PDFViewerApplication.findBar.dispatchEvent('again',
              cmd === 5 || cmd === 12);
          handled = true;
        }
        break;
      case 61: // FF/Mac '='
      case 107: // FF '+' and '='
      case 187: // Chrome '+'
      case 171: // FF with German keyboard
        if (!isViewerInPresentationMode) {
          PDFViewerApplication.zoomIn();
        }
        handled = true;
        break;
      case 173: // FF/Mac '-'
      case 109: // FF '-'
      case 189: // Chrome '-'
        if (!isViewerInPresentationMode) {
          PDFViewerApplication.zoomOut();
        }
        handled = true;
        break;
      case 48: // '0'
      case 96: // '0' on Numpad of Swedish keyboard
        if (!isViewerInPresentationMode) {
          // keeping it unhandled (to restore page zoom to 100%)
          setTimeout(() => {
            // ... and resetting the scale after browser adjusts its scale
            pdfViewer.currentScaleValue = DEFAULT_SCALE_VALUE;
          });
          handled = false;
        }
        break;
    }
  }

  // CTRL or META without shift
  if (cmd === 1 || cmd === 8) {
    switch (evt.keyCode) {
      case 83: // s
        PDFViewerApplication.download();
        handled = true;
        break;
    }
  }

  // CTRL+ALT or Option+Command
  if (cmd === 3 || cmd === 10) {
    switch (evt.keyCode) {
      case 80: // p
        PDFViewerApplication.requestPresentationMode();
        handled = true;
        break;
      case 71: // g
        // focuses input#pageNumber field
        document.getElementById('pageNumber').select();
        handled = true;
        break;
    }
  }

  if (handled) {
    evt.preventDefault();
    return;
  }

  // Some shortcuts should not get handled if a control/input element
  // is selected.
  const curElement = document.activeElement || document.querySelector(':focus');
  const curElementTagName = curElement && curElement.tagName.toUpperCase();
  if (curElementTagName === 'INPUT' ||
      curElementTagName === 'TEXTAREA' ||
      curElementTagName === 'SELECT') {
    // Make sure that the secondary toolbar is closed when Escape is pressed.
    if (evt.keyCode !== 27) { // 'Esc'
      return;
    }
  }
  let ensureViewerFocused = false;

  if (cmd === 0) { // no control key pressed at all.
    switch (evt.keyCode) {
      case 38: // up arrow
      case 33: // pg up
      case 8: // backspace
        if (!isViewerInPresentationMode &&
            pdfViewer.currentScaleValue !== 'page-fit') {
          break;
        }
        /* in presentation mode */
        /* falls through */
      case 37: // left arrow
        // horizontal scrolling using arrow keys
        if (pdfViewer.isHorizontalScrollbarEnabled) {
          break;
        }
        /* falls through */
      case 75: // 'k'
      case 80: // 'p'
        PDFViewerApplication.page--;
        handled = true;
        break;
      case 27: // esc key
        if (SecondaryToolbar.opened) {
          SecondaryToolbar.close();
          handled = true;
        }
        if (!PDFViewerApplication.supportsIntegratedFind &&
            PDFViewerApplication.findBar.opened) {
          PDFViewerApplication.findBar.close();
          handled = true;
        }
        break;
      case 40: // down arrow
      case 34: // pg down
      case 32: // spacebar
        if (!isViewerInPresentationMode &&
            pdfViewer.currentScaleValue !== 'page-fit') {
          break;
        }
        /* falls through */
      case 39: // right arrow
        // horizontal scrolling using arrow keys
        if (pdfViewer.isHorizontalScrollbarEnabled) {
          break;
        }
        /* falls through */
      case 74: // 'j'
      case 78: // 'n'
        PDFViewerApplication.page++;
        handled = true;
        break;

      case 36: // home
        if (isViewerInPresentationMode || PDFViewerApplication.page > 1) {
          PDFViewerApplication.page = 1;
          handled = true;
          ensureViewerFocused = true;
        }
        break;
      case 35: // end
        if (isViewerInPresentationMode || (PDFViewerApplication.pdfDocument &&
            PDFViewerApplication.page < PDFViewerApplication.pagesCount)) {
          PDFViewerApplication.page = PDFViewerApplication.pagesCount;
          handled = true;
          ensureViewerFocused = true;
        }
        break;

      case 72: // 'h'
        if (!isViewerInPresentationMode) {
          HandTool.toggle();
        }
        break;
      case 82: // 'r'
        PDFViewerApplication.rotatePages(90);
        break;
    }
  }

  if (cmd === 4) { // shift-key
    switch (evt.keyCode) {
      case 32: // spacebar
        if (!isViewerInPresentationMode &&
            pdfViewer.currentScaleValue !== 'page-fit') {
          break;
        }
        PDFViewerApplication.page--;
        handled = true;
        break;

      case 82: // 'r'
        PDFViewerApplication.rotatePages(-90);
        break;
    }
  }

  if (!handled && !isViewerInPresentationMode) {
    // 33=Page Up  34=Page Down  35=End    36=Home
    // 37=Left     38=Up         39=Right  40=Down
    // 32=Spacebar
    if ((evt.keyCode >= 33 && evt.keyCode <= 40) ||
        (evt.keyCode === 32 && curElementTagName !== 'BUTTON')) {
      ensureViewerFocused = true;
    }
  }

  if (cmd === 2) { // alt-key
    switch (evt.keyCode) {
      case 37: // left arrow
        if (isViewerInPresentationMode) {
          PDFViewerApplication.pdfHistory.back();
          handled = true;
        }
        break;
      case 39: // right arrow
        if (isViewerInPresentationMode) {
          PDFViewerApplication.pdfHistory.forward();
          handled = true;
        }
        break;
    }
  }

  if (ensureViewerFocused && !pdfViewer.containsElement(curElement)) {
    // The page container is not focused, but a page navigation key has been
    // pressed. Change the focus to the viewer container to make sure that
    // navigation by keyboard works as expected.
    pdfViewer.focus();
  }

  if (handled) {
    evt.preventDefault();
  }
});

window.addEventListener('beforeprint', (evt) => {
  PDFViewerApplication.beforePrint();
});

window.addEventListener('afterprint', (evt) => {
  PDFViewerApplication.afterPrint();
});

(function animationStartedClosure() {
  // The offsetParent is not set until the pdf.js iframe or object is visible.
  // Waiting for first animation.
  PDFViewerApplication.animationStartedPromise = new Promise(
      (resolve) => {
        window.requestAnimationFrame(resolve);
      });
})();
