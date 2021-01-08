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
/* globals PDFJS, Util, AnnotationType, AnnotationBorderStyleType, warn,
           CustomStyle, isExternalLinkTargetSet, LinkTargetStringMap */

'use strict';

const ANNOT_MIN_SIZE = 10; // px

const AnnotationUtils = (function AnnotationUtilsClosure() {
  // TODO(mack): This dupes some of the logic in CanvasGraphics.setFont()
  function setTextStyles(element, item, fontObj) {
    const style = element.style;
    style.fontSize = `${item.fontSize}px`;
    style.direction = item.fontDirection < 0 ? 'rtl' : 'ltr';

    if (!fontObj) {
      return;
    }

    style.fontWeight = fontObj.black
      ? (fontObj.bold ? 'bolder' : 'bold')
      : (fontObj.bold ? 'bold' : 'normal');
    style.fontStyle = fontObj.italic ? 'italic' : 'normal';

    const fontName = fontObj.loadedName;
    const fontFamily = fontName ? `"${fontName}", ` : '';
    // Use a reasonable default font if the font doesn't specify a fallback
    const fallbackName = fontObj.fallbackName || 'Helvetica, sans-serif';
    style.fontFamily = fontFamily + fallbackName;
  }

  function initContainer(item) {
    const container = document.createElement('section');
    const cstyle = container.style;
    let width = item.rect[2] - item.rect[0];
    let height = item.rect[3] - item.rect[1];

    // Border
    if (item.borderStyle.width > 0) {
      // Border width
      container.style.borderWidth = `${item.borderStyle.width}px`;
      if (item.borderStyle.style !== AnnotationBorderStyleType.UNDERLINE) {
        // Underline styles only have a bottom border, so we do not need
        // to adjust for all borders. This yields a similar result as
        // Adobe Acrobat/Reader.
        width -= 2 * item.borderStyle.width;
        height -= 2 * item.borderStyle.width;
      }

      // Horizontal and vertical border radius
      const horizontalRadius = item.borderStyle.horizontalCornerRadius;
      const verticalRadius = item.borderStyle.verticalCornerRadius;
      if (horizontalRadius > 0 || verticalRadius > 0) {
        const radius = `${horizontalRadius}px / ${verticalRadius}px`;
        CustomStyle.setProp('borderRadius', container, radius);
      }

      // Border style
      switch (item.borderStyle.style) {
        case AnnotationBorderStyleType.SOLID:
          container.style.borderStyle = 'solid';
          break;

        case AnnotationBorderStyleType.DASHED:
          container.style.borderStyle = 'dashed';
          break;

        case AnnotationBorderStyleType.BEVELED:
          warn('Unimplemented border style: beveled');
          break;

        case AnnotationBorderStyleType.INSET:
          warn('Unimplemented border style: inset');
          break;

        case AnnotationBorderStyleType.UNDERLINE:
          container.style.borderBottomStyle = 'solid';
          break;

        default:
          break;
      }

      // Border color
      if (item.color) {
        container.style.borderColor =
          Util.makeCssRgb(item.color[0] | 0,
              item.color[1] | 0,
              item.color[2] | 0);
      } else {
        // Transparent (invisible) border, so do not draw it at all.
        container.style.borderWidth = 0;
      }
    }

    cstyle.width = `${width}px`;
    cstyle.height = `${height}px`;
    return container;
  }

  function getHtmlElementForTextWidgetAnnotation(item, commonObjs) {
    const element = document.createElement('div');
    const width = item.rect[2] - item.rect[0];
    const height = item.rect[3] - item.rect[1];
    element.style.width = `${width}px`;
    element.style.height = `${height}px`;
    element.style.display = 'table';

    const content = document.createElement('div');
    content.textContent = item.fieldValue;
    const textAlignment = item.textAlignment;
    content.style.textAlign = ['left', 'center', 'right'][textAlignment];
    content.style.verticalAlign = 'middle';
    content.style.display = 'table-cell';

    const fontObj = item.fontRefName
      ? commonObjs.getData(item.fontRefName) : null;
    setTextStyles(content, item, fontObj);

    element.appendChild(content);

    return element;
  }

  function getHtmlElementForTextAnnotation(item) {
    const rect = item.rect;

    // sanity check because of OOo-generated PDFs
    if ((rect[3] - rect[1]) < ANNOT_MIN_SIZE) {
      rect[3] = rect[1] + ANNOT_MIN_SIZE;
    }
    if ((rect[2] - rect[0]) < ANNOT_MIN_SIZE) {
      rect[2] = rect[0] + (rect[3] - rect[1]); // make it square
    }

    const container = initContainer(item);
    container.className = 'annotText';

    const image = document.createElement('img');
    image.style.height = container.style.height;
    image.style.width = container.style.width;
    const iconName = item.name;
    image.src = `${PDFJS.imageResourcesPath}annotation-${
      iconName.toLowerCase()}.svg`;
    image.alt = '[{{type}} Annotation]';
    image.dataset.l10nId = 'text_annotation_type';
    image.dataset.l10nArgs = JSON.stringify({type: iconName});

    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'annotTextContentWrapper';
    contentWrapper.style.left = `${Math.floor(rect[2] - rect[0] + 5)}px`;
    contentWrapper.style.top = '-10px';

    const content = document.createElement('div');
    content.className = 'annotTextContent';
    content.setAttribute('hidden', true);

    let i, ii;
    if (item.hasBgColor && item.color) {
      const color = item.color;

      // Enlighten the color (70%)
      const BACKGROUND_ENLIGHT = 0.7;
      const r = BACKGROUND_ENLIGHT * (255 - color[0]) + color[0];
      const g = BACKGROUND_ENLIGHT * (255 - color[1]) + color[1];
      const b = BACKGROUND_ENLIGHT * (255 - color[2]) + color[2];
      content.style.backgroundColor = Util.makeCssRgb(r | 0, g | 0, b | 0);
    }

    const title = document.createElement('h1');
    const text = document.createElement('p');
    title.textContent = item.title;

    if (!item.content && !item.title) {
      content.setAttribute('hidden', true);
    } else {
      const e = document.createElement('span');
      const lines = item.content.split(/(?:\r\n?|\n)/);
      for (i = 0, ii = lines.length; i < ii; ++i) {
        const line = lines[i];
        e.appendChild(document.createTextNode(line));
        if (i < (ii - 1)) {
          e.appendChild(document.createElement('br'));
        }
      }
      text.appendChild(e);

      let pinned = false;

      const showAnnotation = function showAnnotation(pin) {
        if (pin) {
          pinned = true;
        }
        if (content.hasAttribute('hidden')) {
          container.style.zIndex += 1;
          content.removeAttribute('hidden');
        }
      };

      const hideAnnotation = function hideAnnotation(unpin) {
        if (unpin) {
          pinned = false;
        }
        if (!content.hasAttribute('hidden') && !pinned) {
          container.style.zIndex -= 1;
          content.setAttribute('hidden', true);
        }
      };

      const toggleAnnotation = function toggleAnnotation() {
        if (pinned) {
          hideAnnotation(true);
        } else {
          showAnnotation(true);
        }
      };

      image.addEventListener('click', () => {
        toggleAnnotation();
      }, false);
      image.addEventListener('mouseover', () => {
        showAnnotation();
      }, false);
      image.addEventListener('mouseout', () => {
        hideAnnotation();
      }, false);

      content.addEventListener('click', () => {
        hideAnnotation(true);
      }, false);
    }

    content.appendChild(title);
    content.appendChild(text);
    contentWrapper.appendChild(content);
    container.appendChild(image);
    container.appendChild(contentWrapper);

    return container;
  }

  function getHtmlElementForLinkAnnotation(item) {
    const container = initContainer(item);
    container.className = 'annotLink';

    const link = document.createElement('a');
    link.href = link.title = item.url || '';

    if (item.url && isExternalLinkTargetSet()) {
      link.target = LinkTargetStringMap[PDFJS.externalLinkTarget];
    }

    container.appendChild(link);

    return container;
  }

  function getHtmlElement(data, objs) {
    switch (data.annotationType) {
      case AnnotationType.WIDGET:
        return getHtmlElementForTextWidgetAnnotation(data, objs);
      case AnnotationType.TEXT:
        return getHtmlElementForTextAnnotation(data);
      case AnnotationType.LINK:
        return getHtmlElementForLinkAnnotation(data);
      default:
        throw new Error(`Unsupported annotationType: ${data.annotationType}`);
    }
  }

  return {
    getHtmlElement,
  };
})();
PDFJS.AnnotationUtils = AnnotationUtils;
