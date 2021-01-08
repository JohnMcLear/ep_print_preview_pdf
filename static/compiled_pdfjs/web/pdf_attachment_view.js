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
/* globals getFileName, removeNullCharacters */

'use strict';

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
