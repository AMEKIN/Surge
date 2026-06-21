// Surge Panel：Proxy 节点测速 V2
// 安全版：
// 1. 默认测速 Proxy 策略组当前出口。
// 2. 使用 Cloudflare __down / __up。
// 3. 单次下载最大 512 KiB，避免触发 Surge NE 内存压力。
// 4. TEST_SECONDS 为总测速上限，默认 10 秒。
// 5. 显示延迟、下载、上传与当前策略组实际选择项。

(function () {
"use strict";

var DEFAULT_GROUP = "Proxy";
var DEFAULT_TEST_SECONDS = 10;

var LATENCY_COUNT = 3;
var DOWNLOAD_SIZES = [131072, 262144, 524288];
var UPLOAD_SIZES = [65536, 131072, 262144];

var DOWN_URL = "https://speed.cloudflare.com/__down";
var UP_URL = "https://speed.cloudflare.com/__up";

var args = parseArguments(typeof $argument === "string" ? $argument : "");
var GROUP_NAME = args.PROXY_GROUP || DEFAULT_GROUP;
var TEST_SECONDS = clampInt(args.TEST_SECONDS, DEFAULT_TEST_SECONDS, 3, 20);

var STARTED_AT = Date.now();
var DEADLINE = STARTED_AT + TEST_SECONDS * 1000;

var state = {
selectedName: "",
latencySamples: [],
downloadBytes: 0,
downloadMs: 0,
downloadCount: 0,
uploadBytes: 0,
uploadMs: 0,
uploadCount: 0,
failures: []
};

var finished = false;
var deadlineTimer = null;

function parseArguments(text) {
var result = {};
var pairs = text.split(",");
var i;
var index;
var key;
var value;

```
for (i = 0; i < pairs.length; i++) {
  index = pairs[i].indexOf(":");
  if (index < 0) continue;

  key = pairs[i].slice(0, index).replace(/^\s+|\s+$/g, "");
  value = pairs[i].slice(index + 1).replace(/^\s+|\s+$/g, "");

  if (key) result[key] = value;
}

return result;
```

}

function clampInt(value, fallback, min, max) {
var number = Number(value);

```
if (!isFinite(number)) number = fallback;

number = Math.round(number);

if (number < min) number = min;
if (number > max) number = max;

return number;
```

}

function trim(value) {
return String(value === null || value === undefined ? "" : value)
.replace(/^\s+|\s+$/g, "");
}

function shortText(value, limit) {
var text = trim(value);

```
if (text.length <= limit) return text;

return text.slice(0, Math.max(1, limit - 1)) + "…";
```

}

function pad(value) {
return value < 10 ? "0" + value : String(value);
}

function nowText() {
var now = new Date();

```
return pad(now.getHours()) + ":" + pad(now.getMinutes());
```

}

function randomId() {
return Date.now().toString(36) +
Math.floor(Math.random() * 1000000).toString(36);
}

function remainingMs() {
return DEADLINE - Date.now();
}

function requestTimeout() {
return Math.max(
1,
Math.min(4, Math.ceil(Math.max(1, remainingMs()) / 1000))
);
}

function hasTime() {
return !finished && remainingMs() > 250;
}

function responseStatus(response) {
if (!response) return 0;

```
return Number(response.status || response.statusCode || 0);
```

}

function dataLength(data, fallback) {
if (data && typeof data.byteLength === "number") {
return data.byteLength;
}

```
if (data && typeof data.length === "number") {
  return data.length;
}

return fallback;
```

}

function median(values) {
var list = values.slice().sort(function (a, b) {
return a - b;
});

```
var middle;

if (!list.length) return null;

middle = Math.floor(list.length / 2);

return list.length % 2
  ? list[middle]
  : (list[middle - 1] + list[middle]) / 2;
```

}

function formatLatency(value) {
return value === null ? "失败" : Math.round(value) + "ms";
}

function formatSpeed(bytesPerSecond) {
var mbps;

```
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
```

}

function parseApiResult(result) {
if (!result || typeof result !== "object") {
return result;
}

```
if (typeof result.body === "string") {
  try {
    return JSON.parse(result.body);
  } catch (ignore) {}
}

if (
  result.response &&
  typeof result.response.body === "string"
) {
  try {
    return JSON.parse(result.response.body);
  } catch (ignore2) {}
}

return result;
```

}

function resolveCurrentNode(groupName, depth) {
if (depth > 2 || !groupName) return;

```
try {
  $httpAPI(
    "GET",
    "/v1/policy_groups/select?group_name=" +
      encodeURIComponent(groupName),
    {},
    function (result) {
      var payload = parseApiResult(result);
      var selected = payload &&
        typeof payload.policy === "string"
        ? trim(payload.policy)
        : "";

      if (!selected || selected === groupName) return;

      state.selectedName = selected;

      resolveCurrentNode(selected, depth + 1);
    }
  );
} catch (ignore) {}
```

}

function downloadUrl(bytes) {
return DOWN_URL +
"?bytes=" + encodeURIComponent(String(bytes)) +
"&measId=" + encodeURIComponent(randomId());
}

function uploadUrl() {
return UP_URL +
"?measId=" + encodeURIComponent(randomId());
}

function addFailure(stage, error, response) {
var status = responseStatus(response);
var text;

```
if (error) {
  text = "连接失败";
} else if (status) {
  text = "HTTP " + status;
} else {
  text = "无响应";
}

state.failures.push(stage + " " + text);
```

}

function runLatency(index) {
var requestStarted;

```
if (!hasTime() || index >= LATENCY_COUNT) {
  runDownload(0);
  return;
}

requestStarted = Date.now();

try {
  $httpClient.get(
    {
      url: downloadUrl(0),
      headers: {
        "Cache-Control": "no-cache",
        "Accept": "application/octet-stream"
      },
      timeout: requestTimeout(),
      policy: GROUP_NAME,
      "binary-mode": true,
      "auto-cookie": false,
      "auto-redirect": false
    },
    function (error, response, data) {
      var status = responseStatus(response);
      var elapsed = Date.now() - requestStarted;

      if (finished) return;

      if (error || status !== 200) {
        addFailure("延迟", error, response);
      } else {
        state.latencySamples.push(Math.max(0, elapsed));
      }

      runLatency(index + 1);
    }
  );
} catch (error) {
  addFailure("延迟", error, null);
  runLatency(index + 1);
}
```

}

function runDownload(index) {
var bytes;
var requestStarted;

```
if (!hasTime() || index >= DOWNLOAD_SIZES.length) {
  runUpload(0);
  return;
}

bytes = DOWNLOAD_SIZES[index];
requestStarted = Date.now();

try {
  $httpClient.get(
    {
      url: downloadUrl(bytes),
      headers: {
        "Cache-Control": "no-cache",
        "Accept": "application/octet-stream"
      },
      timeout: requestTimeout(),
      policy: GROUP_NAME,
      "binary-mode": true,
      "auto-cookie": false,
      "auto-redirect": false
    },
    function (error, response, data) {
      var status = responseStatus(response);
      var elapsed = Date.now() - requestStarted;
      var received;

      if (finished) return;

      if (error || status !== 200) {
        addFailure("下行", error, response);
      } else {
        received = dataLength(data, bytes);

        state.downloadBytes += Math.min(bytes, received || bytes);
        state.downloadMs += Math.max(1, elapsed);
        state.downloadCount += 1;
      }

      runDownload(index + 1);
    }
  );
} catch (error) {
  addFailure("下行", error, null);
  runDownload(index + 1);
}
```

}

function runUpload(index) {
var bytes;
var requestStarted;
var body;

```
if (!hasTime() || index >= UPLOAD_SIZES.length) {
  finish("complete");
  return;
}

bytes = UPLOAD_SIZES[index];
requestStarted = Date.now();

try {
  body = new Uint8Array(bytes);

  $httpClient.post(
    {
      url: uploadUrl(),
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
      var status = responseStatus(response);
      var elapsed = Date.now() - requestStarted;

      if (finished) return;

      if (error || status !== 200) {
        addFailure("上行", error, response);
      } else {
        state.uploadBytes += bytes;
        state.uploadMs += Math.max(1, elapsed);
        state.uploadCount += 1;
      }

      runUpload(index + 1);
    }
  );
} catch (error) {
  addFailure("上行", error, null);
  runUpload(index + 1);
}
```

}

function chooseStyle(latency, downSpeed, upSpeed) {
if (latency === null && !downSpeed && !upSpeed) {
return "error";
}

```
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
```

}

function finish(reason) {
var elapsed;
var latency;
var downSpeed;
var upSpeed;
var label;
var note;

```
if (finished) return;

finished = true;

if (deadlineTimer) {
  clearTimeout(deadlineTimer);
}

elapsed = Math.min(
  TEST_SECONDS * 1000,
  Math.max(0, Date.now() - STARTED_AT)
);

latency = median(state.latencySamples);

downSpeed = state.downloadMs > 0
  ? state.downloadBytes / (state.downloadMs / 1000)
  : 0;

upSpeed = state.uploadMs > 0
  ? state.uploadBytes / (state.uploadMs / 1000)
  : 0;

label = state.selectedName
  ? GROUP_NAME + " → " + state.selectedName
  : GROUP_NAME + "（当前出口）";

note = reason === "deadline"
  ? "达到 " + TEST_SECONDS + "s 上限"
  : "完成 " + (elapsed / 1000).toFixed(1) +
    "s/" + TEST_SECONDS + "s";

if (
  state.failures.length > 0 &&
  !(latency === null && !downSpeed && !upSpeed)
) {
  note += " · 部分失败";
}

$done({
  title: "Proxy 节点测速",
  content: [
    shortText(label, 28),
    "延迟 " + formatLatency(latency) +
      " · 下行 " + formatSpeed(downSpeed),
    "上行 " + formatSpeed(upSpeed) +
      " · " + note
  ].join("\n"),
  style: chooseStyle(latency, downSpeed, upSpeed)
});
```

}

resolveCurrentNode(GROUP_NAME, 0);

deadlineTimer = setTimeout(function () {
finish("deadline");
}, TEST_SECONDS * 1000);

runLatency(0);
})();
