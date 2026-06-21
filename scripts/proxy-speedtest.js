// Surge Panel: Proxy Speed Test V4
// 低内存设计：WebView 引擎 + 单次小体积下载/上传。
// 默认走 Proxy 策略组当前出口。

(function () {
  "use strict";

  var GROUP_NAME = "Proxy";
  var TEST_SECONDS = 10;

  var DOWN_URL = "https://speed.cloudflare.com/__down";
  var UP_URL = "https://speed.cloudflare.com/__up";

  // 总有效传输量约 160 KiB，显著低于旧版。
  var DOWNLOAD_BYTES = 128 * 1024;
  var UPLOAD_BYTES = 32 * 1024;

  var startedAt = Date.now();
  var deadlineAt = startedAt + TEST_SECONDS * 1000;
  var ended = false;
  var deadlineTimer = null;

  var state = {
    latency: null,
    download: null,
    upload: null,
    errors: []
  };

  function makeId() {
    return String(Date.now()) + "-" + String(Math.floor(Math.random() * 1000000));
  }

  function requestTimeout() {
    var remaining = deadlineAt - Date.now();

    return Math.max(
      1,
      Math.min(4, Math.ceil(Math.max(1, remaining) / 1000))
    );
  }

  function hasTime() {
    return !ended && deadlineAt - Date.now() > 250;
  }

  function responseStatus(response) {
    if (!response) return 0;

    return Number(response.status || response.statusCode || 0);
  }

  function isSuccess(response) {
    var status = responseStatus(response);

    return status >= 200 && status < 300;
  }

  function fail(stage, error, response) {
    var status = responseStatus(response);
    var reason = error ? "连接失败" : (status ? "HTTP " + status : "无响应");

    state.errors.push(stage + " " + reason);
  }

  function formatLatency(value) {
    return value === null ? "失败" : Math.round(value) + "ms";
  }

  function formatSpeed(bytesPerSecond) {
    var mbps;

    if (!bytesPerSecond || bytesPerSecond <= 0) {
      return "失败";
    }

    mbps = bytesPerSecond * 8 / 1000000;

    if (mbps >= 1000) {
      return (mbps / 1000).toFixed(2) + "Gbps";
    }

    if (mbps >= 100) {
      return Math.round(mbps) + "Mbps";
    }

    if (mbps >= 10) {
      return mbps.toFixed(1) + "Mbps";
    }

    return mbps.toFixed(2) + "Mbps";
  }

  function shortText(value, limit) {
    var text = String(value || "").replace(/^\s+|\s+$/g, "");

    if (text.length <= limit) {
      return text;
    }

    return text.slice(0, Math.max(1, limit - 1)) + "…";
  }

  function nowText() {
    var now = new Date();
    var hour = now.getHours() < 10 ? "0" + now.getHours() : String(now.getHours());
    var minute = now.getMinutes() < 10 ? "0" + now.getMinutes() : String(now.getMinutes());

    return hour + ":" + minute;
  }

  function downUrl(bytes) {
    return DOWN_URL +
      "?bytes=" + String(bytes) +
      "&measId=" + encodeURIComponent(makeId());
  }

  function upUrl() {
    return UP_URL +
      "?measId=" + encodeURIComponent(makeId());
  }

  function finish(reason) {
    var elapsed;
    var style;
    var note;

    if (ended) {
      return;
    }

    ended = true;

    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
    }

    elapsed = Math.min(
      TEST_SECONDS * 1000,
      Math.max(0, Date.now() - startedAt)
    );

    style = "good";

    if (state.latency === null && !state.download && !state.upload) {
      style = "error";
    } else if (
      state.errors.length > 0 ||
      (state.latency !== null && state.latency > 120)
    ) {
      style = "alert";
    }

    if (state.latency !== null && state.latency > 250) {
      style = "error";
    }

    note = reason === "deadline"
      ? "达到 " + TEST_SECONDS + "s 上限"
      : "完成 " + (elapsed / 1000).toFixed(1) + "s/" + TEST_SECONDS + "s";

    if (
      state.errors.length > 0 &&
      !(state.latency === null && !state.download && !state.upload)
    ) {
      note += " · 部分失败";
    }

    $done({
      title: "Proxy 节点测速",
      content: [
        GROUP_NAME + "（当前出口）",
        "延迟 " + formatLatency(state.latency) +
          " · 下行 " + formatSpeed(state.download),
        "上行 " + formatSpeed(state.upload) +
          " · " + shortText(note, 25) +
          " · " + nowText()
      ].join("\n"),
      style: style
    });
  }

  function testLatency(callback) {
    var requestStarted = Date.now();

    if (!hasTime()) {
      callback();
      return;
    }

    try {
      $httpClient.get(
        {
          url: downUrl(1),
          headers: {
            "Cache-Control": "no-cache",
            "Accept": "application/octet-stream"
          },
          timeout: requestTimeout(),
          policy: GROUP_NAME,
          "auto-cookie": false,
          "auto-redirect": false
        },
        function (error, response, data) {
          if (ended) {
            return;
          }

          if (error || !isSuccess(response)) {
            fail("延迟", error, response);
          } else {
            state.latency = Math.max(0, Date.now() - requestStarted);
          }

          callback();
        }
      );
    } catch (error) {
      fail("延迟", error, null);
      callback();
    }
  }

  function testDownload(callback) {
    var requestStarted = Date.now();

    if (!hasTime()) {
      callback();
      return;
    }

    try {
      $httpClient.get(
        {
          url: downUrl(DOWNLOAD_BYTES),
          headers: {
            "Cache-Control": "no-cache",
            "Accept": "application/octet-stream"
          },
          timeout: requestTimeout(),
          policy: GROUP_NAME,
          "auto-cookie": false,
          "auto-redirect": false
        },
        function (error, response, data) {
          var elapsed;

          if (ended) {
            return;
          }

          if (error || !isSuccess(response)) {
            fail("下行", error, response);
          } else {
            elapsed = Math.max(1, Date.now() - requestStarted);
            state.download = DOWNLOAD_BYTES / (elapsed / 1000);
          }

          callback();
        }
      );
    } catch (error) {
      fail("下行", error, null);
      callback();
    }
  }

  function makeUploadBody(size) {
    return new Array(size + 1).join("0");
  }

  function testUpload(callback) {
    var requestStarted = Date.now();
    var body;

    if (!hasTime()) {
      callback();
      return;
    }

    try {
      body = makeUploadBody(UPLOAD_BYTES);

      $httpClient.post(
        {
          url: upUrl(),
          headers: {
            "Content-Type": "application/octet-stream",
            "Cache-Control": "no-cache"
          },
          body: body,
          timeout: requestTimeout(),
          policy: GROUP_NAME,
          "auto-cookie": false,
          "auto-redirect": false
        },
        function (error, response, data) {
          var elapsed;

          if (ended) {
            return;
          }

          if (error || !isSuccess(response)) {
            fail("上行", error, response);
          } else {
            elapsed = Math.max(1, Date.now() - requestStarted);
            state.upload = UPLOAD_BYTES / (elapsed / 1000);
          }

          callback();
        }
      );
    } catch (error) {
      fail("上行", error, null);
      callback();
    }
  }

  deadlineTimer = setTimeout(function () {
    finish("deadline");
  }, TEST_SECONDS * 1000);

  testLatency(function () {
    testDownload(function () {
      testUpload(function () {
        finish("complete");
      });
    });
  });
})();
