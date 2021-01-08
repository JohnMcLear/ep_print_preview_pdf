'use strict';

const TestReporter = function (browser, appPath) {
  function send(action, json, cb) {
    const r = new XMLHttpRequest();
    // (The POST URI is ignored atm.)
    r.open('POST', action, true);
    r.setRequestHeader('Content-Type', 'application/json');
    r.onreadystatechange = function sendTaskResultOnreadystatechange(e) {
      if (r.readyState === 4) {
        // Retry until successful
        if (r.status !== 200) {
          send(action, json, cb);
        } else if (cb) {
          cb();
        }
      }
    };
    json.browser = browser;
    r.send(JSON.stringify(json));
  }

  function sendInfo(message) {
    send('/info', {message});
  }

  function sendResult(status, description, error) {
    const message = {
      status,
      description,
    };
    if (typeof error !== 'undefined') {
      message.error = error;
    }
    send('/submit_task_results', message);
  }

  function sendQuitRequest() {
    send(`/tellMeToQuit?path=${escape(appPath)}`, {});
  }

  this.now = function () {
    return new Date().getTime();
  };

  this.reportRunnerStarting = function () {
    this.runnerStartTime = this.now();
    sendInfo(`Started unit tests for ${browser}.`);
  };

  this.reportSpecStarting = function () { };

  this.reportSpecResults = function (spec) {
    const results = spec.results();
    if (results.skipped) {
      sendResult('TEST-SKIPPED', results.description);
    } else if (results.passed()) {
      sendResult('TEST-PASSED', results.description);
    } else {
      let failedMessages = '';
      const items = results.getItems();
      for (let i = 0, ii = items.length; i < ii; i++) {
        if (!items[i].passed()) {
          failedMessages += `${items[i].message} `;
        }
      }
      sendResult('TEST-UNEXPECTED-FAIL', results.description, failedMessages);
    }
  };

  this.reportSuiteResults = function (suite) { };

  this.reportRunnerResults = function (runner) {
    // Give the test.py some time process any queued up requests
    setTimeout(sendQuitRequest, 500);
  };
};
