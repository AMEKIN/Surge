// Surge Panel：Proxy 节点测速 V1
// 功能：
// 1. 默认测试 Proxy 策略组当前实际出口。
// 2. 使用 Cloudflare Speed Test 的 __down / __up 接口。
// 3. 显示节点名、延迟、下行、上行与实际测速耗时。
// 4. 整体测速窗口上限默认为 10 秒。
// 5. 不自动测速，仅点击面板刷新按钮时执行。

(function () {
  "use strict";

  var DEFAULT_GROUP = "Proxy";
  var DEFAULT_TEST_SECONDS = 10;

  // 传输量控制：每次刷新约下载 4 MiB、上传 1 MiB。
  var DOWNLOAD_BYTES = 4 * 1024 * 1024;
  var UPLOAD_BYTES = 1 * 1024 * 1024;

  // 10 秒测速窗口的阶段分配。
  var LATENCY_WINDOW_MS = 1500;
  var DOWNLOAD_WINDOW_MS = 5000;

  var CLOUDFLARE_DOWN = "https://speed.cloudflare.com/__down";
  var CLOUDFLARE_UP = "https://speed.cloudflare.com/__up";

  var argument = parseArgument(typeof $argument === "string" ? $argument : "");
  var GROUP_NAME = argument.PROXY_GROUP || DEFAULT_GROUP;
  var TEST_SECONDS = toPositiveInt(
    argument.TEST_SECONDS,
    DEFAULT_TEST_SECONDS
  );

  var TEST_WINDOW_MS = TEST_SECONDS * 1000;
  var startedAt = Date.now();
  var testDeadline = startedAt + TEST_WINDOW_MS;

  var state = {
    nodeName: "",
    latency: null,
    download: null,
    upload: null,
    latencyError: "",
    downloadError: "",
    uploadError: ""
  };

  var finished = false;
  var globalTimer = null;

  function parseArgument(text) {
    var result = {};
    var parts = text.split(",");
    var i;
    var pair;
    var index;
    var key;
    var value;

    for (i = 0; i < parts.length; i++) {
      pair = parts[i];
      index = pair.indexOf(":");

      if (index < 0) {
        continue;
      }

      key = pair.slice(0, index).replace(/^\s+|\s+$/g, "");
      value = pair.slice(index + 1).replace(/^\s+|\s+$/g, "");

      if (key) {
        result[key] = value;
      }
    }

    return result;
  }

  function toPositiveInt(value, fallback) {
    var number = Number(value);

    if (!isFinite(number) || number <= 0) {
      return fallback;
    }

    return Math.round(number);
  }

  function shortText(text, limit) {
    text = String(text || "").replace(/^\s+|\s+$/g, "");

    if (!text) {
      return "";
    }

    if (text.length <= limit) {
      return text;
    }

    return text.slice(0, Math.max(1, limit - 1)) + "…";
  }

  function nowText() {
    var now = new Date();

    function pad(value) {
      return value < 10 ? "0" + value : String(value);
    }

    return pad(now.getHours()) + ":" + pad(now.getMinutes());
  }

  function randomId() {
    return String(Date.now()) + "-" + String(Math.floor(Math.random() * 1000000));
  }

  function unwrapApiResult(result) {
    if (!result || typeof result !== "object") {
      return result;
    }

    if (typeof result.body === "string") {
      try {
        return JSON.parse(result.body);
      } catch (error) {}
    }

    if (
      result.response &&
      typeof result.response === "object" &&
      typeof result.response.body === "string"
    ) {
      try {
        return JSON.parse(result.response.body);
      } catch (error2) {}
    }

    return result;
  }

  function getSelectedPolicyName(payload) {
    var keys = [
      "policy",
      "selected",
      "current",
      "active",
      "now",
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

      if (typeof value === "string" && value) {
        return value;
      }
    }

    return "";
  }

  function resolveCurrentNode(groupName, depth) {
    if (depth > 3 || !groupName) {
      return;
    }

    try {
      $httpAPI(
        "GET",
        "/v1/policy_groups/select?group_name=" + encodeURIComponent(groupName),
        {},
        function (result) {
          var payload = unwrapApiResult(result);
          var selected = getSelectedPolicyName(payload);

          if (!selected || selected === groupName) {
            if (!state.nodeName) {
              state.nodeName = groupName;
            }

            return;
          }

          state.nodeName = selected;

          // 兼容 Proxy -> 子策略组 -> 实际节点 的嵌套情况。
          resolveCurrentNode(selected, depth + 1);
        }
      );
    } catch (error) {
      if (!state.nodeName) {
        state.nodeName = groupName;
      }
    }
  }

  function getRemainingSeconds(deadline) {
    var remain = deadline - Date.now();

    if (remain <= 0) {
      return 1;
    }

    return Math.max(1, Math.ceil(remain / 1000));
  }

  function getBodyLength(data, fallback) {
    if (data === null || data === undefined) {
      return fallback;
    }

    if (typeof data.byteLength === "number") {
      return data.byteLength;
    }

    if (typeof data.length === "number") {
      return data.length;
    }

    return fallback;
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

  function formatLatency(milliseconds) {
    if (milliseconds === null || milliseconds === undefined) {
      return "失败";
    }

    return Math.round(milliseconds) + "ms";
  }

  function requestError(error, response) {
    var status = response && response.status ? Number(response.status) : 0;

    if (error) {
      return "超时或连接失败";
    }

    if (status && status !== 200) {
      return "HTTP " + status;
    }

    return "请求失败";
  }

  function makeUploadBody(size) {
    return new Uint8Array(size);
  }

  function cloudflareDownUrl(bytes) {
    return CLOUDFLARE_DOWN +
      "?bytes=" + encodeURIComponent(String(bytes)) +
      "&measId=" + encodeURIComponent(randomId());
  }

  function cloudflareUpUrl() {
    return CLOUDFLARE_UP +
      "?measId=" + encodeURIComponent(randomId());
  }

  function requestLatency(callback) {
    var phaseDeadline = Math.min(
      testDeadline,
      startedAt + LATENCY_WINDOW_MS
    );
    var requestStartedAt = Date.now();

    try {
      $httpClient.get(
        {
          url: cloudflareDownUrl(1024),
          headers: {
            "Accept": "application/octet-stream",
            "Cache-Control": "no-cache"
          },
          timeout: getRemainingSeconds(phaseDeadline),
          policy: GROUP_NAME,
          "binary-mode": true
        },
        function (error, response, data) {
          var elapsed = Date.now() - requestStartedAt;
          var status = response && response.status ? Number(response.status) : 0;

          if (finished) {
            return;
          }

          if (error || status !== 200) {
            state.latencyError = requestError(error, response);
          } else {
            state.latency = Math.max(0, elapsed);
          }

          callback();
        }
      );
    } catch (error) {
      state.latencyError = "脚本异常";
      callback();
    }
  }

  function requestDownload(callback) {
    var phaseDeadline = Math.min(
      testDeadline,
      startedAt + LATENCY_WINDOW_MS + DOWNLOAD_WINDOW_MS
    );
    var requestStartedAt = Date.now();

    if (Date.now() >= testDeadline) {
      state.downloadError = "总测速超时";
      callback();
      return;
    }

    try {
      $httpClient.get(
        {
          url: cloudflareDownUrl(DOWNLOAD_BYTES),
          headers: {
            "Accept": "application/octet-stream",
            "Cache-Control": "no-cache"
          },
          timeout: getRemainingSeconds(phaseDeadline),
          policy: GROUP_NAME,
          "binary-mode": true
        },
        function (error, response, data) {
          var elapsed = Date.now() - requestStartedAt;
          var status = response && response.status ? Number(response.status) : 0;
          var bytes;

          if (finished) {
            return;
          }

          if (error || status !== 200) {
            state.downloadError = requestError(error, response);
          } else {
            bytes = getBodyLength(data, DOWNLOAD_BYTES);
            state.download = bytes / Math.max(0.001, elapsed / 1000);
          }

          callback();
        }
      );
    } catch (error) {
      state.downloadError = "脚本异常";
      callback();
    }
  }

  function requestUpload(callback) {
    var requestStartedAt = Date.now();

    if (Date.now() >= testDeadline) {
      state.uploadError = "总测速超时";
      callback();
      return;
    }

    try {
      $httpClient.post(
        {
          url: cloudflareUpUrl(),
          headers: {
            "Content-Type": "application/octet-stream",
            "Cache-Control": "no-cache"
          },
          body: makeUploadBody(UPLOAD_BYTES),
          timeout: getRemainingSeconds(testDeadline),
          policy: GROUP_NAME
        },
        function (error, response, data) {
          var elapsed = Date.now() - requestStartedAt;
          var status = response && response.status ? Number(response.status) : 0;

          if (finished) {
            return;
          }

          if (error || status !== 200) {
            state.uploadError = requestError(error, response);
          } else {
            state.upload = UPLOAD_BYTES / Math.max(0.001, elapsed / 1000);
          }

          callback();
        }
      );
    } catch (error) {
      state.uploadError = "脚本异常";
      callback();
    }
  }

  function displayMetric(value, error, formatter) {
    if (value !== null && value !== undefined) {
      return formatter(value);
    }

    return error ? "失败" : "未测";
  }

  function chooseStyle() {
    var hasFailure =
      state.latencyError ||
      state.downloadError ||
      state.uploadError;

    if (hasFailure && state.latency === null) {
      return "error";
    }

    if (hasFailure) {
      return "alert";
    }

    if (state.latency !== null && state.latency > 250) {
      return "error";
    }

    if (state.latency !== null && state.latency > 120) {
      return "alert";
    }

    return "good";
  }

  function finish() {
    var elapsed;
    var node;
    var latencyText;
    var downloadText;
    var uploadText;

    if (finished) {
      return;
    }

    finished = true;

    if (globalTimer) {
      clearTimeout(globalTimer);
    }

    elapsed = Math.min(TEST_WINDOW_MS, Date.now() - startedAt);
    node = state.nodeName || (GROUP_NAME + "（当前出口）");

    latencyText = displayMetric(
      state.latency,
      state.latencyError,
      formatLatency
    );

    downloadText = displayMetric(
      state.download,
      state.downloadError,
      formatSpeed
    );

    uploadText = displayMetric(
      state.upload,
      state.uploadError,
      formatSpeed
    );

    $done({
      title: "Proxy 节点测速",
      content: [
        shortText(node, 25),
        "延迟 " + latencyText + " · 下行 " + downloadText,
        "上行 " + uploadText + " · " +
          (elapsed / 1000).toFixed(1) + "s/" + TEST_SECONDS + "s"
      ].join("\n"),
      style: chooseStyle()
    });
  }

  function startTest() {
    requestLatency(function () {
      if (finished) {
        return;
      }

      requestDownload(function () {
        if (finished) {
          return;
        }

        requestUpload(function () {
          finish();
        });
      });
    });
  }

  // 节点名称读取不阻塞测速；实际测速始终走 Proxy 策略组。
  resolveCurrentNode(GROUP_NAME, 0);

  globalTimer = setTimeout(function () {
    finish();
  }, TEST_WINDOW_MS);

  startTest();
})();
