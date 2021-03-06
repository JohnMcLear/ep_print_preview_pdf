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

exports.optimizeCMap = function (data) {
  var i = 1;
  while (i < data.body.length) {
    if (data.body[i - 1].type === data.body[i].type) {
      data.body[i - 1].items = data.body[i - 1].items.concat(data.body[i].items);
      data.body.splice(i, 1);
    } else {
      i++;
    }
  }
  // split into groups with different lengths
  var i = 0;
  while (i < data.body.length) {
    var item = data.body[i];
    const keys = Object.keys(item.items[0]).filter((i) => typeof item.items[0][i] === 'string');
    var j = 1;
    while (j < item.items.length) {
      let different = false;
      for (var q = 0; q < keys.length && !different; q++) {
        different = item.items[j - 1][keys[q]].length !== item.items[j][keys[q]].length;
      }
      if (different) {
        break;
      }
      j++;
    }
    if (j < item.items.length) {
      data.body.splice(i + 1, 0, {
        type: item.type,
        items: item.items.splice(j, item.items.length - j),
      });
    }
    i++;
  }
  // find sequences of single char ranges
  var i = 0;
  while (i < data.body.length) {
    var item = data.body[i];
    if (item.type === 3 || item.type === 5) {
      var j = 0;
      while (j < item.items.length) {
        var q = j;
        while (j < item.items.length && item.items[j].start === item.items[j].end) {
          j++;
        }
        if ((j - q) >= 9) {
          if (j < item.items.length) {
            data.body.splice(i + 1, 0, {
              type: item.type,
              items: item.items.splice(j, item.items.length - j),
            });
          }
          if (q > 0) {
            data.body.splice(i + 1, 0, {
              type: item.type - 1,
              items: item.items.splice(q, j - q).map((i) => ({char: i.start, code: i.code})),
            });
            i++;
          } else {
            item.type -= 1;
            item.items = item.items.map((i) => ({char: i.start, code: i.code}));
          }
          continue;
        }
        j++;
      }
    }
    i++;
  }

  //  find sequences of increasing code/ranges order
  var i = 0;
  while (i < data.body.length) {
    var item = data.body[i];
    if (item.type >= 2 && item.type <= 5) {
      var j = 1;
      const startProp = item.type === 2 || item.type === 4 ? 'char' : 'start';
      const endProp = item.type === 2 || item.type === 4 ? 'char' : 'end';
      while (j < item.items.length) {
        var q = j - 1;
        while (j < item.items.length && incHex(item.items[j - 1][endProp]) === item.items[j][startProp]) {
          j++;
        }
        if ((j - q) >= 9) {
          if (j < item.items.length) {
            data.body.splice(i + 1, 0, {
              type: item.type,
              items: item.items.splice(j, item.items.length - j),
            });
          }
          if (q > 0) {
            data.body.splice(i + 1, 0, {
              type: item.type,
              items: item.items.splice(q, j - q),
              sequence: true,
            });
            i++;
          } else {
            item.sequence = true;
          }
          continue;
        }
        j++;
      }
    }
    i++;
  }

  // split non-sequences two groups where codes are close
  var i = 0;
  while (i < data.body.length) {
    var item = data.body[i];
    if (!item.sequence && (item.type === 2 || item.type === 3)) {
      const subitems = item.items;
      const codes = subitems.map((i) => i.code);
      codes.sort((a, b) => a - b);
      var maxDistance = 100; const minItems = 10; const
        itemsPerBucket = 50;
      if (subitems.length > minItems && codes[codes.length - 1] - codes[0] > maxDistance) {
        const gapsCount = Math.max(2, (subitems.length / itemsPerBucket) | 0);
        const gaps = [];
        for (var q = 0; q < gapsCount; q++) {
          gaps.push({length: 0});
        }
        for (var j = 1; j < codes.length; j++) {
          const gapLength = codes[j] - codes[j - 1];
          var q = 0;
          while (q < gaps.length && gaps[q].length > gapLength) {
            q++;
          }
          if (q >= gaps.length) {
            continue;
          }
          let q0 = q;
          while (q < gaps.length) {
            if (gaps[q].length < gaps[q0].length) {
              q0 = q;
            }
            q++;
          }
          gaps[q0] = {length: gapLength, boundary: codes[j]};
        }
        const groups = gaps.filter((g) => g.length >= maxDistance).map((g) => g.boundary);
        groups.sort((a, b) => a - b);
        if (groups.length > 1) {
          const buckets = [item.items = []];
          for (var j = 0; j < groups.length; j++) {
            const newItem = {type: item.type, items: []};
            buckets.push(newItem.items);
            i++;
            data.body.splice(i, 0, newItem);
          }
          for (var j = 0; j < subitems.length; j++) {
            const code = subitems[j].code;
            var q = 0;
            while (q < groups.length && groups[q] <= code) {
              q++;
            }
            buckets[q].push(subitems[j]);
          }
        }
      }
    }
    i++;
  }
};

function incHex(a) {
  let c = 1; let
    s = '';
  for (let i = a.length - 1; i >= 0; i--) {
    c += parseInt(a[i], 16);
    if (c >= 16) {
      s = `0${s}`;
      c = 1;
    } else {
      s = c.toString(16) + s;
      c = 0;
    }
  }
  return s;
}
