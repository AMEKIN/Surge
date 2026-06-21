// Surge Panel: Proxy Speed Test V5
// 固定 10 秒 Cloudflare 测速。
// 使用 WebView 引擎，所有请求串行执行，降低 Surge 引擎内存压力。

(function () {
  "use strict";

  var DEFAULT_GROUP = "Proxy";
  var TOTAL_SECONDS = 10;

  var DOWN_URL = "https://speed.cloudflare.com/__down";
  var UP_URL = "https://speed.cloudflare.com/__up";

  // 单次请求大小与总流量上限。
  // 下载最多约 10 MiB，上传最多约 2 MiB。
  // 每次只保留一条请求，避免内存累积。
  var DOWNLOAD_CHUNK_BYTES = 1024 * 1024;
  var DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;
  var UPLOAD_CHUNK_BYTES = 256 * 1024;
  var UPLOAD_MAX_BYTES = 2 * 1024 * 1024;

  var args = parseArguments(typeof $argument === "string" ? $argument : "");
  var GROUP_NAME = args.PROXY_GROUP || DEFAULT_GROUP;

  var STARTED_AT = Date.now();
  var LATENCY_END_AT = STARTED_AT + 1000;
  var UPLOAD_START_AT = STARTED_AT + 7000;
  var DEADLINE_AT = STARTED_AT + TOTAL_SECONDS * 1000;

  var ended = false;
  var deadlineTimer = null;

  var state = {
    nodeName: "",
    latencySamples: [],
    downloadBytes: 0,
    downloadMs: 0,
    downloadAttempts: 0,
    uploadBytes: 0,
    uploadMs: 0,
    uploadAttempts: 0,
    failures: []
  };

  function parseArguments(text) {
    var output = {};
    var parts = text.split(",");
    var i;
    var position;
    var key;
    var value;

    for (i = 0; i < parts.length; i++) {
      position = parts[i].indexOf(":");

      if (position < 0) {
        continue;
      }

      key = parts[i].slice(0, position).replace(/^\s+|\s+$/g, "");
      value = parts[i].slice(position + 1).replace(/^\s+|\s+$/g, "");

      if (key) {
        output[key] = value;
      }
    }

    return output;
  }

  function trim(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/^\s+|\s+$/g, "");
  }

  function shortText(value, limit) {
    var text = trim(value);

    if (text.length <= limit) {
      return text;
    }

    return text.slice(0, Math.max(1, limit - 1)) + "…";
  }

  function randomId() {
    return String(Date.now()) + "-" + String(Math.floor(Math.random() * 1000000));
  }

  function responseStatus(response) {
    if (!response) {
      return 0;
    }

    return Number(response.status || response.statusCode || 0);
  }

  function isSuccess(response) {
    var status = responseStatus(response);

    return status >= 200 && status < 300;
  }

  function requestTimeout(stageEndAt) {
    var remaining = stageEndAt - Date.now();

    return Math.max(
      1,
      Math.min(5, Math.ceil(Math.max(1, remaining) / 1000))
    );
  }

  function addFailure(stage, error, response) {
    var status = responseStatus(response);
    var reason = error ? "连接失败" : (status ? "HTTP " + status : "无响应");

    state.failures.push(stage + " " + reason);
  }

  function median(values) {
    var sorted;
    var middle;

    if (!values.length) {
      return null;
    }

    sorted = values.slice().sort(function (a, b) {
      return a - b;
    });

    middle = Math.floor(sorted.length / 2);

    return sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
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

  function downUrl(bytes) {
    return DOWN_URL +
      "?bytes=" + encodeURIComponent(String(bytes)) +
      "&measId=" + encodeURIComponent(randomId());
  }

  function upUrl() {
    return UP_URL + "?measId=" + encodeURIComponent(randomId());
  }

  function makeUploadBody(size) {
    return new Array(size + 1).join("0");
  }

  function parseApiPayload(result) {
    var value = result;

    if (!value || typeof value !== "object") {
      return value;
    }

    if (typeof value.body === "string") {
      try {
        return JSON.parse(value.body);
      } catch (ignore) {}
    }

    if (value.response && typeof value.response.body === "string") {
      try {
        return JSON.parse(value.response.body);
      } catch (ignore2) {}
    }

    if (value.data && typeof value.data === "object") {
      return value.data;
    }

    return value;
  }

  function selectedPolicyFrom(payload) {
    var keys = [
      "policy",
      "selected",
      "current",
      "active",
      "selected_policy",
      "selectedPolicy"
    ];

    var i;
    var value;

    if (!payload || typeof payload !== "object") {
      return "";
    }

    for (i = 0; i < keys.length; i++) {
      value = payload[keys[i]];

      if (typeof value === "string" && trim(value)) {
        return trim(value);
      }
    }

    return "";
  }

  function resolveNode(groupName, path, depth) {
    if (depth > 3 || !groupName) {
      return;
    }

    try {
      $httpAPI(
        "GET",
        "/v1/policy_groups/select?group_name=" + encodeURIComponent(groupName),
        {},
        function (result) {
          var selected = selectedPolicyFrom(parseApiPayload(result));
          var i;

          if (!selected || selected === groupName) {
            return;
          }

          for (i = 0; i < path.length; i++) {
            if (path[i] === selected) {
              return;
            }
          }

          path.push(selected);
          state.nodeName = selected;

          // 支持 Proxy -> 子策略组 -> 节点 的最多 4 层嵌套读取。
          resolveNode(selected, path, depth + 1);
        }
      );
    } catch (ignore) {}
  }

  function waitUntil(time, callback) {
    var delay = Math.max(0, time - Date.now());

    setTimeout(function () {
      if (!ended) {
        callback();
      }
    }, delay);
  }

  function runLatency(index) {
    var requestStarted;

    if (ended) {
      return;
    }

    if (index >= 3 || Date.now() >= LATENCY_END_AT) {
      runDownload();
      return;
    }

    requestStarted = Date.now();

    try {
      $httpClient.get(
        {
          url: downUrl(1024),
          headers: {
            "Cache-Control": "no-cache",
            "Accept": "application/octet-stream"
          },
          timeout: requestTimeout(LATENCY_END_AT),
          policy: GROUP_NAME,
          "auto-cookie": false,
          "auto-redirect": false
        },
        function (error, response, data) {
          if (ended) {
            return;
          }

          if (error || !isSuccess(response)) {
            addFailure("延迟", error, response);
          } else {
            state.latencySamples.push(Math.max(0, Date.now() - requestStarted));
          }

          runLatency(index + 1);
        }
      );
    } catch (error) {
      addFailure("延迟", error, null);
      runLatency(index + 1);
    }
  }

  function runDownload() {
    var bytes;
    var requestStarted;

    if (ended) {
      return;
    }

    if (Date.now() >= UPLOAD_START_AT) {
      runUpload();
      return;
    }

    if (
      state.downloadBytes >= DOWNLOAD_MAX_BYTES ||
      state.downloadAttempts >= 12
    ) {
      waitUntil(UPLOAD_START_AT, runUpload);
      return;
    }

    bytes = Math.min(
      DOWNLOAD_CHUNK_BYTES,
      DOWNLOAD_MAX_BYTES - state.downloadBytes
    );

    state.downloadAttempts += 1;
    requestStarted = Date.now();

    try {
      $httpClient.get(
        {
          url: downUrl(bytes),
          headers: {
            "Cache-Control": "no-cache",
            "Accept": "application/octet-stream"
          },
          timeout: requestTimeout(UPLOAD_START_AT),
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
            addFailure("下行", error, response);
          } else {
            elapsed = Math.max(1, Date.now() - requestStarted);

            state.downloadBytes += bytes;
            state.downloadMs += elapsed;
          }

          runDownload();
        }
      );
    } catch (error) {
      addFailure("下行", error, null);
      runDownload();
    }
  }

  function runUpload() {
    var bytes;
    var requestStarted;
    var body;

    if (ended) {
      return;
    }

    if (Date.now() >= DEADLINE_AT) {
      finish();
      return;
    }

    if (
      state.uploadBytes >= UPLOAD_MAX_BYTES ||
      state.uploadAttempts >= 8
    ) {
      waitUntil(DEADLINE_AT, finish);
      return;
    }

    bytes = Math.min(
      UPLOAD_CHUNK_BYTES,
      UPLOAD_MAX_BYTES - state.uploadBytes
    );

    state.uploadAttempts += 1;
    requestStarted = Date.now();

    try {
      body = makeUploadBody(bytes);

      $httpClient.post(
        {
          url: upUrl(),
          headers: {
            "Content-Type": "application/octet-stream",
            "Cache-Control": "no-cache"
          },
          body: body,
          timeout: requestTimeout(DEADLINE_AT),
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
            addFailure("上行", error, response);
          } else {
            elapsed = Math.max(1, Date.now() - requestStarted);

            state.uploadBytes += bytes;
            state.uploadMs += elapsed;
          }

          runUpload();
        }
      );
    } catch (error) {
      addFailure("上行", error, null);
      runUpload();
    }
  }

  function styleFor(latency, download, upload) {
    if (latency === null && !download && !upload) {
      return "error";
    }

    if (state.failures.length > 0) {
      return "alert";
    }

    if (latency !== null && latency > 250) {
      return "error";
    }

    if (latency !== null && latency > 120) {
      return "alert";
    }

    return "good";
  }

  function finish() {
    var latency;
    var download;
    var upload;
    var nodeLine;

    if (ended) {
      return;
    }

    ended = true;

    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
    }

    latency = median(state.latencySamples);

    download = state.downloadMs > 0
      ? state.downloadBytes / (state.downloadMs / 1000)
      : 0;

    upload = state.uploadMs > 0
      ? state.uploadBytes / (state.uploadMs / 1000)
      : 0;

    nodeLine = state.nodeName
      ? GROUP_NAME + " → " + state.nodeName
      : GROUP_NAME + "（当前出口）";

    $done({
      title: "Proxy 节点测速",
      content: [
        shortText(nodeLine, 31),
        "延迟 " + formatLatency(latency) + " · 下行 " + formatSpeed(download),
        "上行 " + formatSpeed(upload) + " · Cloudflare " + TOTAL_SECONDS + " 秒测速"
      ].join("\n"),
      style: styleFor(latency, download, upload)
    });
  }

  resolveNode(GROUP_NAME, []);

  deadlineTimer = setTimeout(function () {
    finish();
  }, TOTAL_SECONDS * 1000);

  runLatency(0);
})();
