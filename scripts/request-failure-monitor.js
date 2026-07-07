// Surge Panel: Request Failure Monitor V2
// 手动扫描最近请求中的网络失败、超时与 HTTP 5xx。
// 默认排除 REJECT 与 HTTP 4xx，避免广告拦截和普通 404 造成噪声。

(function () {
  "use strict";

  var PANEL_TITLE = "请求失败监控";
  var SCAN_LIMIT = 100;
  var INCLUDE_HTTP_4XX = false;
  var INCLUDE_REJECT = false;
  var ended = false;
  var timer = null;

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function trim(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/^\s+|\s+$/g, "");
  }

  function shortText(value, limit) {
    var text = trim(value);
    return text.length <= limit ? text : text.slice(0, limit - 1) + "…";
  }

  function nowText() {
    var now = new Date();
    var hour = now.getHours() < 10 ? "0" + now.getHours() : String(now.getHours());
    var minute = now.getMinutes() < 10 ? "0" + now.getMinutes() : String(now.getMinutes());
    return hour + ":" + minute;
  }

  function apiError(result) {
    if (result === null || result === undefined) return "接口无响应";
    if (isObject(result) && result.error) return "接口返回错误";
    if (isObject(result) && Number(result.status) >= 400) return "HTTP " + result.status;
    if (isObject(result) && isObject(result.response) && Number(result.response.status) >= 400) {
      return "HTTP " + result.response.status;
    }
    return "";
  }

  function unwrap(result) {
    if (!isObject(result)) return result;

    if (typeof result.body === "string") {
      try {
        return JSON.parse(result.body);
      } catch (ignore) {}
    }

    if (isObject(result.response) && typeof result.response.body === "string") {
      try {
        return JSON.parse(result.response.body);
      } catch (ignore2) {}
    }

    return result;
  }

  function requestList(payload) {
    var keys = ["requests", "recent", "items", "results", "result", "data"];
    var i;

    if (Array.isArray(payload)) return payload;
    if (!isObject(payload)) return null;

    for (i = 0; i < keys.length; i++) {
      if (Array.isArray(payload[keys[i]])) return payload[keys[i]];
    }

    return null;
  }

  function containers(request) {
    var list = [request];
    var keys = ["request", "response", "detail", "metadata", "connection", "result"];
    var i;

    for (i = 0; i < keys.length; i++) {
      if (isObject(request[keys[i]])) list.push(request[keys[i]]);
    }

    return list;
  }

  function asText(value) {
    var keys = ["message", "description", "reason", "code", "name", "value"];
    var i;
    var text;

    if (typeof value === "string" || typeof value === "number") return trim(value);
    if (!isObject(value)) return "";

    for (i = 0; i < keys.length; i++) {
      if (value[keys[i]] !== undefined) {
        text = asText(value[keys[i]]);
        if (text) return text;
      }
    }

    return "";
  }

  function fieldText(request, fields) {
    var list = containers(request);
    var i;
    var j;
    var text;

    for (i = 0; i < list.length; i++) {
      for (j = 0; j < fields.length; j++) {
        if (list[i][fields[j]] !== undefined && list[i][fields[j]] !== null) {
          text = asText(list[i][fields[j]]);
          if (text) return text;
        }
      }
    }

    return "";
  }

  function fieldNumber(request, fields) {
    var list = containers(request);
    var i;
    var j;
    var value;

    for (i = 0; i < list.length; i++) {
      for (j = 0; j < fields.length; j++) {
        value = list[i][fields[j]];
        if (typeof value === "number" && isFinite(value)) return value;
        if (typeof value === "string" && /^\s*\d{3}\s*$/.test(value)) return Number(value);
      }
    }

    return null;
  }

  function isReject(request) {
    var list = containers(request);
    var fields = [
      "policy", "policyName", "policy_name", "outbound", "outboundPolicy",
      "outbound_policy", "rule", "matchedRule", "matched_rule"
    ];
    var i;
    var j;
    var text;

    for (i = 0; i < list.length; i++) {
      for (j = 0; j < fields.length; j++) {
        text = asText(list[i][fields[j]]);
        if (/(^|[\s,])REJECT(?:[-_A-Z]*|\b)/i.test(text)) return true;
      }
    }

    return false;
  }

  function shortReason(value) {
    var text = trim(value).toLowerCase();

    if (/timeout|timed out|timedout|etimedout|超时/.test(text)) return "超时";
    if (/dns|resolve|解析/.test(text)) return "DNS 失败";
    if (/reset|closed|broken|重置|断开/.test(text)) return "连接重置";
    if (/reject|denied|refus|拒绝/.test(text)) return "拒绝";
    if (/cancel|abort|取消|中止/.test(text)) return "已取消";
    if (/unreach|unavailable|不可达/.test(text)) return "不可达";

    return shortText(value, 12);
  }

  function failureReason(request) {
    var errorText;
    var stateText;
    var code;

    if (isReject(request)) return INCLUDE_REJECT ? "REJECT" : "";

    errorText = fieldText(request, [
      "error", "errorMessage", "error_message", "failure", "failureReason",
      "failure_reason", "networkError", "network_error", "lastError", "last_error"
    ]);

    if (errorText && /fail|error|timeout|timedout|etimedout|cancel|abort|reset|refus|unreach|unavailable|denied|closed|broken|connection|network|lost|失败|超时|拒绝|重置|不可达/i.test(errorText)) {
      return shortReason(errorText);
    }

    stateText = fieldText(request, ["state", "status", "phase", "result"]);

    if (stateText && /failed|error|timeout|timedout|etimedout|cancelled|canceled|aborted|reset|refused|unreachable|unavailable|denied|closed|broken|connection|network|lost|失败|超时|拒绝|重置|不可达/i.test(stateText)) {
      return shortReason(stateText);
    }

    code = fieldNumber(request, [
      "statusCode", "status_code", "httpStatus", "http_status",
      "responseStatus", "response_status"
    ]);

    if (code === null && isObject(request.response)) {
      code = fieldNumber(request.response, ["status", "statusCode", "status_code"]);
    }

    if (code >= 500 && code <= 599) return "HTTP " + code;
    if (INCLUDE_HTTP_4XX && code >= 400 && code <= 499) return "HTTP " + code;

    return "";
  }

  function hostFrom(value) {
    var text = trim(value);
    var match;

    if (!text) return "";

    match = text.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@\/?#]+@)?(\[[^\]]+\]|[^\/:?#]+)/i);
    if (match) return match[1].replace(/^\[|\]$/g, "");

    if (/^[^\s/:?#]+(?::\d+)?$/i.test(text)) return text.replace(/:\d+$/, "");

    return "";
  }

  function requestHost(request) {
    var host = fieldText(request, [
      "host", "hostname", "domain", "remoteHost", "remote_host", "targetHost",
      "target_host", "server", "url", "requestURL", "request_url"
    ]);

    return hostFrom(host) || trim(host) || "未知目标";
  }

  function finish(result) {
    var error;
    var requests;
    var scanned;
    var records = {};
    var list = [];
    var total = 0;
    var i;
    var reason;
    var host;
    var sorted;
    var display = [];
    var extra;

    if (ended) return;
    ended = true;
    if (timer) clearTimeout(timer);

    error = apiError(result);

    if (error) {
      $done({
        title: PANEL_TITLE,
        content: "读取失败：" + shortText(error, 24) + "\n请刷新后重试",
        style: "error"
      });
      return;
    }

    requests = requestList(unwrap(result));

    if (!requests) {
      $done({
        title: PANEL_TITLE,
        content: "未识别最近请求数据\n请打开 Surge 请求记录后重试",
        style: "alert"
      });
      return;
    }

    scanned = requests.slice(0, SCAN_LIMIT);

    for (i = 0; i < scanned.length; i++) {
      reason = failureReason(scanned[i]);
      if (!reason) continue;

      host = requestHost(scanned[i]);
      total += 1;

      if (!records[host]) {
        records[host] = { host: host, count: 0, order: list.length };
        list.push(records[host]);
      }

      records[host].count += 1;
    }

    if (total === 0) {
  $done({
    title: PANEL_TITLE,
    content: [
      "近 " + scanned.length + " 条：未发现失败请求",
      "更新：" + nowText()
    ].join("\n"),
    style: "good"
      });
  return;
    }

    sorted = list.sort(function (a, b) {
      return b.count !== a.count ? b.count - a.count : a.order - b.order;
    });

    for (i = 0; i < sorted.length && i < 2; i++) {
      display.push(shortText(sorted[i].host, 21) + " ×" + sorted[i].count);
    }

    extra = sorted.length - display.length;

    $done({
      title: PANEL_TITLE,
      content: [
        "近 " + scanned.length + " 条：失败 " + total + " 条",
        display.join(" · "),
        (extra > 0 ? "+" + extra + " 个域名 · " : "") + "更新：" + nowText()
      ].join("\n"),
      style: total >= 5 ? "error" : "alert"
    });
  }

  timer = setTimeout(function () {
    finish({ error: "读取超时" });
  }, 8000);

  try {
    $httpAPI("GET", "/v1/requests/recent", {}, finish);
  } catch (error) {
    finish({ error: "接口调用失败" });
  }
})();
