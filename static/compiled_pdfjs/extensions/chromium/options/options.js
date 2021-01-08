/*
Copyright 2015 Mozilla Foundation

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
/* globals chrome, Promise */

'use strict';

Promise.all([
  new Promise((resolve) => {
    // Get preferences as set by the system administrator.
    chrome.storage.managed.get(null, (prefs) => {
      // Managed storage may be disabled, e.g. in Opera.
      resolve(prefs || {});
    });
  }),
  new Promise((resolve) => {
    chrome.storage.local.get(null, (prefs) => {
      resolve(prefs || {});
    });
  }),
  new Promise((resolve) => {
    // Get the storage schema - a dictionary of preferences.
    const x = new XMLHttpRequest();
    const schema_location = chrome.runtime.getManifest().storage.managed_schema;
    x.open('get', chrome.runtime.getURL(schema_location));
    x.onload = function () {
      resolve(x.response.properties);
    };
    x.responseType = 'json';
    x.send();
  }),
]).then((values) => {
  const managedPrefs = values[0];
  let userPrefs = values[1];
  const schema = values[2];
  function getPrefValue(prefName) {
    if (prefName in userPrefs) {
      return userPrefs[prefName];
    } else if (prefName in managedPrefs) {
      return managedPrefs[prefName];
    }
    return schema[prefName].default;
  }
  const prefNames = Object.keys(schema);
  const renderPreferenceFunctions = {};
  // Render options
  prefNames.forEach((prefName) => {
    const prefSchema = schema[prefName];
    if (!prefSchema.title) {
      // Don't show preferences if the title is missing.
      return;
    }

    // A DOM element with a method renderPreference.
    let renderPreference;
    if (prefSchema.type === 'boolean') {
      // Most prefs are booleans, render them in a generic way.
      renderPreference = renderBooleanPref(prefSchema.title,
          prefSchema.description,
          prefName);
    } else if (prefName === 'defaultZoomValue') {
      renderPreference = renderDefaultZoomValue(prefSchema.title);
    } else if (prefName === 'sidebarViewOnLoad') {
      renderPreference = renderSidebarViewOnLoad(prefSchema.title);
    } else {
      // Should NEVER be reached. Only happens if a new type of preference is
      // added to the storage manifest.
      console.error(`Don't know how to handle ${prefName}!`);
      return;
    }

    renderPreference(getPrefValue(prefName));
    renderPreferenceFunctions[prefName] = renderPreference;
  });

  // Names of preferences that are displayed in the UI.
  const renderedPrefNames = Object.keys(renderPreferenceFunctions);

  // Reset button to restore default settings.
  document.getElementById('reset-button').onclick = function () {
    userPrefs = {};
    chrome.storage.local.remove(prefNames, () => {
      renderedPrefNames.forEach((prefName) => {
        renderPreferenceFunctions[prefName](getPrefValue(prefName));
      });
    });
  };

  // Automatically update the UI when the preferences were changed elsewhere.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    const prefs = areaName === 'local' ? userPrefs
      : areaName === 'managed' ? managedPrefs : null;
    if (prefs) {
      renderedPrefNames.forEach((prefName) => {
        const prefChanges = changes[prefName];
        if (prefChanges) {
          if ('newValue' in prefChanges) {
            userPrefs[prefName] = prefChanges.newValue;
          } else {
            // Otherwise the pref was deleted
            delete userPrefs[prefName];
          }
          renderPreferenceFunctions[prefName](getPrefValue(prefName));
        }
      });
    }
  });
}).then(null, console.error.bind(console));

function importTemplate(id) {
  return document.importNode(document.getElementById(id).content, true);
}

// Helpers to create UI elements that display the preference, and return a
// function which updates the UI with the preference.

function renderBooleanPref(shortDescription, description, prefName) {
  const wrapper = importTemplate('checkbox-template');
  wrapper.title = description;

  const checkbox = wrapper.querySelector('input[type="checkbox"]');
  checkbox.onchange = function () {
    const pref = {};
    pref[prefName] = this.checked;
    chrome.storage.local.set(pref);
  };
  wrapper.querySelector('span').textContent = shortDescription;
  document.getElementById('settings-boxes').appendChild(wrapper);

  function renderPreference(value) {
    checkbox.checked = value;
  }
  return renderPreference;
}

function renderDefaultZoomValue(shortDescription) {
  const wrapper = importTemplate('defaultZoomValue-template');
  const select = wrapper.querySelector('select');
  select.onchange = function () {
    chrome.storage.local.set({
      defaultZoomValue: this.value,
    });
  };
  wrapper.querySelector('span').textContent = shortDescription;
  document.getElementById('settings-boxes').appendChild(wrapper);

  function renderPreference(value) {
    value = value || 'auto';
    select.value = value;
    const customOption = select.querySelector('option.custom-zoom');
    if (select.selectedIndex === -1 && value) {
      // Custom zoom percentage, e.g. set via managed preferences.
      // [zoom] or [zoom],[left],[top]
      customOption.text = value.indexOf(',') > 0 ? value : `${value}%`;
      customOption.value = value;
      customOption.hidden = false;
      customOption.selected = true;
    } else {
      customOption.hidden = true;
    }
  }
  return renderPreference;
}

function renderSidebarViewOnLoad(shortDescription) {
  const wrapper = importTemplate('sidebarViewOnLoad-template');
  const select = wrapper.querySelector('select');
  select.onchange = function () {
    chrome.storage.local.set({
      sidebarViewOnLoad: parseInt(this.value),
    });
  };
  wrapper.querySelector('span').textContent = shortDescription;
  document.getElementById('settings-boxes').appendChild(wrapper);

  function renderPreference(value) {
    select.value = value;
  }
  return renderPreference;
}
