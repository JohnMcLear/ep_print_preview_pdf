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
/* globals watchScroll, getVisibleElements, scrollIntoView, PDFThumbnailView,
           Promise */

'use strict';

const THUMBNAIL_SCROLL_MARGIN = -19;

// #include pdf_thumbnail_view.js

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
