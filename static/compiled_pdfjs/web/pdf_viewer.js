/* Copyright 2014 Mozilla Foundation
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
/* globals watchScroll, PDFPageView, UNKNOWN_SCALE,
           SCROLLBAR_PADDING, VERTICAL_PADDING, MAX_AUTO_SCALE, CSS_UNITS,
           DEFAULT_SCALE, scrollIntoView, getVisibleElements, RenderingStates,
           PDFJS, Promise, TextLayerBuilder, PDFRenderingQueue,
           AnnotationsLayerBuilder, DEFAULT_SCALE_VALUE */

'use strict';

const PresentationModeState = {
  UNKNOWN: 0,
  NORMAL: 1,
  CHANGING: 2,
  FULLSCREEN: 3,
};

const IGNORE_CURRENT_POSITION_ON_ZOOM = false;
const DEFAULT_CACHE_SIZE = 10;

// #include pdf_rendering_queue.js
// #include pdf_page_view.js
// #include text_layer_builder.js
// #include annotations_layer_builder.js

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
