// Surge Panel: Proxy Speed Test V3

(function () {
  "use strict";

  var DEFAULT_GROUP = "Proxy";
  var DEFAULT_SECONDS = 10;

  var LATENCY_SIZES = [1024, 1024, 1024];
  var DOWNLOAD_SIZES = [131072, 262144, 524288];
  var UPLOAD_SIZES = [65536, 131072, 262144];

  var DOWN_URL = "https://speed.cloudflare.com/__down";
  var UP_URL = "https://speed.cloudflare.com/__up";

  var GROUP_NAME = DEFAULT_GROUP;
  var TEST_SECONDS = DEFAULT_SECONDS;

  var STARTED_AT = Date.now();
  var DEADLINE = STARTED_AT + TEST_SECONDS * 1000;
  var ENDED = false;
  var DEADLINE_TIMER = null;

  var STATE = {
    selected: "",
    latencySamples: [],
    downloadBytes: 0,
    downloadMs: 0,
    uploadBytes: 0,
    uploadMs: 0,
    failures: []
  };

  function trim(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/^\s+|\s+$/g, "");
  }

  function shortText(value, limit) {
    var text = trim(value);

    if (text.length <= limit) {
      return text;
    }

    return text.slice(0, limit - 1) + "…";
  }

  function nowText() {
    var now = new Date();
    var hour = now.getHours() < 10 ? "0" + now.getHours() : String(now.getHours());
    var minute = now.getMinutes() < 10 ? "0" + now.getMinutes() : String(now.getMinutes());

    return hour + ":" + minute;
  }

  function randomId() {
    return String(Date.now()) + String(Math.floor(Math.random() * 1000000));
  }

  function remainingSeconds() {
    var remain = DEADLINE - Date.now();

    return Math.max(1, Math.min(4, Math.ceil(Math.max(1, remain) / 1000)));
  }

  function canContinue() {
    return !ENDED && DEADLINE - Date.now() > 200;
  }

  function statusOf(response) {
    if (!response) {
      return 0;
    }

    return Number(response.status || response.statusCode || 0);
  }

  function isSuccess(response) {
    var status = statusOf(response);

    return status >= 200 && status < 300;
  }

  function addFailure(stage, error, response) {
    var status = statusOf(response);
    var reason = error ? "连接失败" : (status ? "HTTP " + status : "无响应");

    STATE.failures.push(stage + " " + reason);
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

  function responseLength(data, fallback) {
    if (data && typeof data.byteLength === "number") {
      return data.byteLength;
    }

    if (data && typeof data.length === "number") {
      return data.length;
    }

    return fallback;
  }

  function downUrl(bytes) {
    return DOWN_URL +
      "?bytes=" + bytes +
      "&measId=" + encodeURIComponent(randomId());
  }

  function upUrl() {
    return UP_URL +
      "?measId=" + encodeURIComponent(randomId());
  }

  function parseApiPayload(result) {
    if (!result || typeof result !== "object") {
      return result;
    }

    if (typeof result.body === "string") {
      try {
        return JSON.parse(result.body);
      } catch (ignore) {}
    }

    return result;
  }

  function resolveCurrentNode() {
    try {
      $httpAPI(
        "GET",
        "/v1/policy_groups/select?group_name=" + encodeURIComponent(GROUP_NAME),
        {},
        function (result) {
          var payload = parseApiPayload(result);

          if (payload && typeof payload.policy === "string" && payload.policy) {
            STATE.selected = payload.policy;
          }
        }
      );
    } catch (ignore) {}
  }

  function runLatency(index) {
    var requestStarted;

    if (!canContinue() || index >= LATENCY_SIZES.length) {
      runDownload(0);
      return;
    }

    requestStarted = Date.now();

    try {
      $httpClient.get(
        {
          url: downUrl(LATENCY_SIZES[index]),
          headers: {
            "Cache-Control": "no-cache",
            "Accept": "application/octet-stream"
          },
          timeout: remainingSeconds(),
          policy: GROUP_NAME,
          "binary-mode": true,
          "auto-cookie": false,
          "auto-redirect": false
        },
        function (error, response, data) {
          if (ENDED) {
            return;
          }

          if (error || !isSuccess(response)) {
            addFailure("延迟", error, response);
          } else {
            STATE.latencySamples.push(Math.max(0, Date.now() - requestStarted));
          }

          runLatency(index + 1);
        }
      );
    } catch (error) {
      addFailure("延迟", error, null);
      runLatency(index + 1);
    }
  }

  function runDownload(index) {
    var bytes;
    var requestStarted;

    if (!canContinue() || index >= DOWNLOAD_SIZES.length) {
      runUpload(0);
      return;
    }

    bytes = DOWNLOAD_SIZES[index];
    requestStarted = Date.now();

    try {
      $httpClient.get(
        {
          url: downUrl(bytes),
          headers: {
            "Cache-Control": "no-cache",
            "Accept": "application/octet-stream"
          },
          timeout: remainingSeconds(),
          policy: GROUP_NAME,
          "binary-mode": true,
          "auto-cookie": false,
          "auto-redirect": false
        },
        function (error, response, data) {
          var received;
          var elapsed;

          if (ENDED) {
            return;
          }

          if (error || !isSuccess(response)) {
            addFailure("下行", error, response);
          } else {
            received = responseLength(data, bytes);
            elapsed = Math.max(1, Date.now() - requestStarted);

            STATE.downloadBytes += Math.min(bytes, received || bytes);
            STATE.downloadMs += elapsed;
          }

          runDownload(index + 1);
        }
      );
    } catch (error) {
      addFailure("下行", error, null);
      runDownload(index + 1);
    }
  }

  function runUpload(index) {
    var bytes;
    var requestStarted;
    var body;

    if (!canContinue() || index >= UPLOAD_SIZES.length) {
      finish("complete");
      return;
    }

    bytes = UPLOAD_SIZES[index];
    requestStarted = Date.now();
    body = new Uint8Array(bytes);

    try {
      $httpClient.post(
        {
          url: upUrl(),
          headers: {
            "Content-Type": "application/octet-stream",
            "Cache-Control": "no-cache"
          },
          body: body,
          timeout: remainingSeconds(),
          policy: GROUP_NAME,
          "auto-cookie": false,
          "auto-redirect": false
        },
        function (error, response, data) {
          var elapsed;

          if (ENDED) {
            return;
          }

          if (error || !isSuccess(response)) {
            addFailure("上行", error, response);
          } else {
            elapsed = Math.max(1, Date.now() - requestStarted);

            STATE.uploadBytes += bytes;
            STATE.uploadMs += elapsed;
          }

          runUpload(index + 1);
        }
      );
    } catch (error) {
      addFailure("上行", error, null);
      runUpload(index + 1);
    }
  }

  function styleFor(latency, download, upload) {
    if (latency === null && !download && !upload) {
      return "error";
    }

    if (STATE.failures.length > 0) {
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

  function finish(reason) {
    var elapsed;
    var latency;
    var download;
    var upload;
    var label;
    var note;

    if (ENDED) {
      return;
    }

    ENDED = true;

    if (DEADLINE_TIMER) {
      clearTimeout(DEADLINE_TIMER);
    }

    elapsed = Math.min(TEST_SECONDS * 1000, Math.max(0, Date.now() - STARTED_AT));
    latency = median(STATE.latencySamples);
    download = STATE.downloadMs
      ? STATE.downloadBytes / (STATE.downloadMs / 1000)
      : 0;
    upload = STATE.uploadMs
      ? STATE.uploadBytes / (STATE.uploadMs / 1000)
      : 0;

    label = STATE.selected
      ? GROUP_NAME + " → " + STATE.selected
      : GROUP_NAME + "（当前出口）";

    note = reason === "deadline"
      ? "达到 " + TEST_SECONDS + "s 上限"
      : "完成 " + (elapsed / 1000).toFixed(1) + "s/" + TEST_SECONDS + "s";

    if (STATE.failures.length > 0 && !(latency === null && !download && !upload)) {
      note += " · 部分失败";
    }

    $done({
      title: "Proxy 节点测速",
      content: [
        shortText(label, 28),
        "延迟 " + formatLatency(latency) + " · 下行 " + formatSpeed(download),
        "上行 " + formatSpeed(upload) + " · " + note + " · " + nowText()
      ].join("\n"),
      style: styleFor(latency, download, upload)
    });
  }

  resolveCurrentNode();

  DEADLINE_TIMER = setTimeout(function () {
    finish("deadline");
  }, TEST_SECONDS * 1000);

  runLatency(0);
})();
