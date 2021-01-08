/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

// Dummy XML Parser

function DOMNodeMock(nodeName, nodeValue) {
  this.nodeName = nodeName;
  this.nodeValue = nodeValue;
  Object.defineProperty(this, 'parentNode', {value: null, writable: true});
}
DOMNodeMock.prototype = {
  get firstChild() {
    return this.childNodes[0];
  },
  get nextSibling() {
    const index = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[index + 1];
  },
  get textContent() {
    if (!this.childNodes) {
      return this.nodeValue || '';
    }
    return this.childNodes.map((child) => child.textContent).join('');
  },
  hasChildNodes() {
    return this.childNodes && this.childNodes.length > 0;
  },
};

function decodeXML(text) {
  if (text.indexOf('&') < 0) {
    return text;
  }
  return text.replace(/&(#(x[0-9a-f]+|\d+)|\w+);/gi, (all, entityName, number) => {
    if (number) {
      return String.fromCharCode(number[0] === 'x' ? parseInt(number.substring(1), 16) : +number);
    }
    switch (entityName) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '\"';
      case 'apos':
        return '\'';
    }
    return `&${entityName};`;
  });
}

function DOMParserMock() {}
DOMParserMock.prototype = {
  parseFromString(content) {
    content = content.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g, '').trim();
    const nodes = [];
    content = content.replace(/>([\s\S]+?)</g, (all, text) => {
      const i = nodes.length;
      const node = new DOMNodeMock('#text', decodeXML(text));
      nodes.push(node);
      if (node.textContent.trim().length === 0) {
        return '><'; // ignoring whitespaces
      }
      return `>${i},<`;
    });
    content = content.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (all, text) => {
      const i = nodes.length;
      const node = new DOMNodeMock('#text', text);
      nodes.push(node);
      return `${i},`;
    });
    let lastLength;
    do {
      lastLength = nodes.length;
      content = content.replace(/<([\w\:]+)((?:[\s\w:=]|'[^']*'|"[^"]*")*)(?:\/>|>([\d,]*)<\/[^>]+>)/g,
          (all, name, attrs, content) => {
            const i = nodes.length;
            const node = new DOMNodeMock(name);
            const children = [];
            if (content) {
              content = content.split(',');
              content.pop();
              content.forEach((child) => {
                const childNode = nodes[+child];
                childNode.parentNode = node;
                children.push(childNode);
              });
            }
            node.childNodes = children;
            nodes.push(node);
            return `${i},`;
          });
    } while (lastLength < nodes.length);
    return {
      documentElement: nodes.pop(),
    };
  },
};

exports.DOMParserMock = DOMParserMock;
