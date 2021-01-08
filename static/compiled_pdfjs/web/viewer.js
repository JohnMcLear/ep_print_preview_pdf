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
// #if (FIREFOX || MOZCENTRAL || GENERIC || CHROME)
// PDFJS.workerSrc = '../build/pdf.worker.js';
// #endif
// #if !PRODUCTION
PDFJS.cMapUrl = '../external/bcmaps/';
PDFJS.cMapPacked = true;
// #else
// PDFJS.cMapUrl = '../web/cmaps/';
// PDFJS.cMapPacked = true;
// #endif

const mozL10n = document.mozL10n || document.webL10n;

// #include ui_utils.js
// #include preferences.js

// #if !(FIREFOX || MOZCENTRAL)
// #include mozPrintCallback_polyfill.js
// #endif

// #if GENERIC || CHROME
// #include download_manager.js
// #endif

// #if FIREFOX || MOZCENTRAL
// #include firefoxcom.js
// #endif

// #if CHROME
// #include chromecom.js
// #endif

// #include view_history.js
// #include pdf_find_bar.js
// #include pdf_find_controller.js
// #include pdf_link_service.js
// #include pdf_history.js
// #include secondary_toolbar.js
// #include pdf_presentation_mode.js
// #include hand_tool.js
// #include overlay_manager.js
// #include password_prompt.js
// #include pdf_document_properties.js
// #include pdf_viewer.js
// #include pdf_thumbnail_viewer.js
// #include pdf_outline_view.js
// #include pdf_attachment_view.js

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
    // #if (FIREFOX || MOZCENTRAL)
    //  support = FirefoxCom.requestSync('supportsIntegratedFind');
    // #endif

    return PDFJS.shadow(this, 'supportsIntegratedFind', support);
  },

  get supportsDocumentFonts() {
    const support = true;
    // #if (FIREFOX || MOZCENTRAL)
    //  support = FirefoxCom.requestSync('supportsDocumentFonts');
    // #endif

    return PDFJS.shadow(this, 'supportsDocumentFonts', support);
  },

  get supportsDocumentColors() {
    const support = true;
    // #if (FIREFOX || MOZCENTRAL)
    //  support = FirefoxCom.requestSync('supportsDocumentColors');
    // #endif

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
    // #if (FIREFOX || MOZCENTRAL)
    //  support = FirefoxCom.requestSync('supportedMouseWheelZoomModifierKeys');
    // #endif

    return PDFJS.shadow(this, 'supportedMouseWheelZoomModifierKeys', support);
  },

  // #if (FIREFOX || MOZCENTRAL)
  initPassiveLoading: function pdfViewInitPassiveLoading() {
    function FirefoxComDataRangeTransport(length, initialData) {
      PDFJS.PDFDataRangeTransport.call(this, length, initialData);
    }
    FirefoxComDataRangeTransport.prototype =
      Object.create(PDFJS.PDFDataRangeTransport.prototype);
    FirefoxComDataRangeTransport.prototype.requestDataRange =
        function FirefoxComDataRangeTransport_requestDataRange(begin, end) {
          FirefoxCom.request('requestDataRange', {begin, end});
        };
    FirefoxComDataRangeTransport.prototype.abort =
        function FirefoxComDataRangeTransport_abort() {
          // Sync call to ensure abort is really started.
          FirefoxCom.requestSync('abortLoading', null);
        };

    let pdfDataRangeTransport;

    window.addEventListener('message', (e) => {
      if (e.source !== null) {
        // The message MUST originate from Chrome code.
        console.warn(`Rejected untrusted message from ${e.origin}`);
        return;
      }
      const args = e.data;

      if (typeof args !== 'object' || !('pdfjsLoadAction' in args)) {
        return;
      }
      switch (args.pdfjsLoadAction) {
        case 'supportsRangedLoading':
          pdfDataRangeTransport =
            new FirefoxComDataRangeTransport(args.length, args.data);

          PDFViewerApplication.open(args.pdfUrl,
              {range: pdfDataRangeTransport});

          if (args.length) {
            PDFViewerApplication.pdfDocumentProperties
                .setFileSize(args.length);
          }
          break;
        case 'range':
          pdfDataRangeTransport.onDataRange(args.begin, args.chunk);
          break;
        case 'rangeProgress':
          pdfDataRangeTransport.onDataProgress(args.loaded);
          break;
        case 'progressiveRead':
          pdfDataRangeTransport.onDataProgressiveRead(args.chunk);
          break;
        case 'progress':
          PDFViewerApplication.progress(args.loaded / args.total);
          break;
        case 'complete':
          if (!args.data) {
            PDFViewerApplication.error(mozL10n.get('loading_error', null,
                'An error occurred while loading the PDF.'), e);
            break;
          }
          PDFViewerApplication.open(args.data);
          break;
      }
    });
    FirefoxCom.requestSync('initPassiveLoading', null);
  },
  // #endif

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
    // #if !PRODUCTION
    if (true) {
      return;
    }
    // #endif
    // #if (FIREFOX || MOZCENTRAL)
    // Only trigger the fallback once so we don't spam the user with messages
    // for one PDF.
    if (this.fellback) {
      return;
    }
    this.fellback = true;
    const url = this.url.split('#')[0];
    FirefoxCom.request('fallback', {featureId, url},
        (download) => {
          if (!download) {
            return;
          }
          PDFViewerApplication.download();
        });
    // #endif
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

    // #if !(FIREFOX || MOZCENTRAL)
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
    // #else
    //  console.error(message + '\n' + moreInfoText);
    //  this.fallback();
    // #endif
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

    // #if GENERIC
    const baseDocumentUrl = null;
    // #endif
    // #if (FIREFOX || MOZCENTRAL)
    //  var baseDocumentUrl = this.url.split('#')[0];
    // #endif
    // #if CHROME
    //  var baseDocumentUrl = location.href.split('#')[0];
    // #endif
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

      // #if !PRODUCTION
      if (true) {
        return;
      }
      // #endif
      // #if (FIREFOX || MOZCENTRAL)
      const versionId = String(info.PDFFormatVersion).slice(-1) | 0;
      let generatorId = 0;
      const KNOWN_GENERATORS = [
        'acrobat distiller',
        'acrobat pdfwriter',
        'adobe livecycle',
        'adobe pdf library',
        'adobe photoshop',
        'ghostscript',
        'tcpdf',
        'cairo',
        'dvipdfm',
        'dvips',
        'pdftex',
        'pdfkit',
        'itext',
        'prince',
        'quarkxpress',
        'mac os x',
        'microsoft',
        'openoffice',
        'oracle',
        'luradocument',
        'pdf-xchange',
        'antenna house',
        'aspose.cells',
        'fpdf',
      ];
      if (info.Producer) {
        KNOWN_GENERATORS.some(((generator, s, i) => {
          if (generator.indexOf(s) < 0) {
            return false;
          }
          generatorId = i + 1;
          return true;
        }).bind(null, info.Producer.toLowerCase()));
      }
      const formType = !info.IsAcroFormPresent ? null : info.IsXFAPresent
        ? 'xfa' : 'acroform';
      FirefoxCom.request('reportTelemetry', JSON.stringify({
        type: 'documentInfo',
        version: versionId,
        generator: generatorId,
        formType,
      }));
      // #endif
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

    // #if !PRODUCTION
    if (true) {
      return;
    }
    // #endif
    // #if (FIREFOX || MOZCENTRAL)
    FirefoxCom.request('reportTelemetry', JSON.stringify({
      type: 'print',
    }));
    // #endif
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
// #if GENERIC
window.PDFView = PDFViewerApplication; // obsolete name, using it as an alias
// #endif

// #if CHROME
// (function rewriteUrlClosure() {
//  // Run this code outside DOMContentLoaded to make sure that the URL
//  // is rewritten as soon as possible.
//  var queryString = document.location.search.slice(1);
//  var params = parseQueryString(queryString);
//  DEFAULT_URL = params.file || '';
//
//  // Example: chrome-extension://.../http://example.com/file.pdf
//  var humanReadableUrl = '/' + DEFAULT_URL + location.hash;
//  history.replaceState(history.state, '', humanReadableUrl);
//  if (top === window) {
//    chrome.runtime.sendMessage('showPageAction');
//  }
// })();
// #endif

function webViewerLoad(evt) {
  PDFViewerApplication.initialize().then(webViewerInitialized);
}

function webViewerInitialized() {
// #if GENERIC
  const queryString = document.location.search.substring(1);
  const params = parseQueryString(queryString);
  const file = 'file' in params ? params.file : DEFAULT_URL;
  // #endif
  // #if (FIREFOX || MOZCENTRAL)
  // var file = window.location.href.split('#')[0];
  // #endif
  // #if CHROME
  // var file = DEFAULT_URL;
  // #endif

  // #if GENERIC
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
  // #else
  // document.getElementById('openFile').setAttribute('hidden', 'true');
  // document.getElementById('secondaryOpenFile').setAttribute('hidden', 'true');
  // #endif

  // #if !(FIREFOX || MOZCENTRAL)
  let locale = PDFJS.locale || navigator.language;
  // #endif

  // #if !PRODUCTION
  if (true) {
    // #else
    // if (PDFViewerApplication.preferencePdfBugEnabled) {
    // #endif
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
    // #if !PRODUCTION
    if ('disablebcmaps' in hashParams && hashParams.disablebcmaps) {
      PDFJS.cMapUrl = '../external/cmaps/';
      PDFJS.cMapPacked = false;
    }
    // #endif
    // #if !(FIREFOX || MOZCENTRAL)
    if ('locale' in hashParams) {
      locale = hashParams.locale;
    }
    // #endif
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

  // #if !(FIREFOX || MOZCENTRAL)
  mozL10n.setLanguage(locale);
  // #endif
  // #if (FIREFOX || MOZCENTRAL)
  if (!PDFViewerApplication.supportsDocumentFonts) {
    PDFJS.disableFontFace = true;
    console.warn(mozL10n.get('web_fonts_disabled', null,
        'Web fonts are disabled: unable to use embedded PDF fonts.'));
  }
  // #endif

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

  // #if (FIREFOX || MOZCENTRAL)
  // PDFViewerApplication.setTitleUsingUrl(file);
  // PDFViewerApplication.initPassiveLoading();
  // return;
  // #endif

  // #if GENERIC
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
// #endif
// #if CHROME
// if (file) {
//  ChromeCom.openPDFFile(file);
// }
// #endif
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

  // #if !PRODUCTION
  if (true) {
    return;
  }
  // #endif
  // #if (FIREFOX || MOZCENTRAL)
  FirefoxCom.request('reportTelemetry', JSON.stringify({
    type: 'pageInfo',
  }));
  // It is a good time to report stream and font types.
  PDFViewerApplication.pdfDocument.getStats().then((stats) => {
    FirefoxCom.request('reportTelemetry', JSON.stringify({
      type: 'documentStats',
      stats,
    }));
  });
// #endif
}, true);

document.addEventListener('textlayerrendered', (e) => {
  const pageIndex = e.detail.pageNumber - 1;
  const pageView = PDFViewerApplication.pdfViewer.getPageView(pageIndex);

  // #if !PRODUCTION
  if (true) {
    return;
  }
  // #endif
  // #if (FIREFOX || MOZCENTRAL)
  if (pageView.textLayer && pageView.textLayer.textDivs &&
      pageView.textLayer.textDivs.length > 0 &&
      !PDFViewerApplication.supportsDocumentColors) {
    console.error(mozL10n.get('document_colors_not_allowed', null,
        'PDF documents are not allowed to use their own colors: ' +
      '\'Allow pages to choose their own colors\' ' +
      'is deactivated in the browser.'));
    PDFViewerApplication.fallback();
  }
// #endif
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

// #if GENERIC
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
// #endif

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

  // #if !(FIREFOX || MOZCENTRAL)
  // CTRL or META without shift
  if (cmd === 1 || cmd === 8) {
    switch (evt.keyCode) {
      case 83: // s
        PDFViewerApplication.download();
        handled = true;
        break;
    }
  }
  // #endif

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
