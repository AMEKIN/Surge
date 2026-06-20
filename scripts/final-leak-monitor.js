// Surge Panel：FINAL 命中监控 V1
// 手动读取最近请求，找出实际匹配到 FINAL 规则的项目。

(function () {
  "use strict";

  var PANEL_TITLE = "FINAL 命中监控";
  var SCAN_LIMIT = 80;
  var MAX_TARGET_LENGTH = 25;
  var MAX_POLICY_LENGTH = 13;
  var finished = false;
  var watchdog = null;

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function trimText(value) {
    if (value === null || value === undefined) return "";
    return String(value).replace(/^\s+|\s+$/g, "");
  }

  function shortText(value, limit) {
    var text = trimText(value);
    if (text.length <= limit) return text;
    return text.slice(0, Math.max(1, limit - 1)) + "…";
  }

  function nowText() {
    var now = new Date();

    function pad(value) {
      return value < 10 ? "0" + value : String(value);
    }

    return pad(now.getHours()) + ":" + pad(now.getMinutes());
  }

  function resultError(result) {
    if (result === null || result === undefined) return "接口无响应";

    if (isObject(result) && result.error) {
      return typeof result.error === "string" ? result.error : "接口返回错误";
    }

    if (isObject(result) && result.status && Number(result.status) >= 400) {
      return "HTTP " + result.status;
    }

    if (isObject(result) && isObject(result.response)) {
      if (result.response.error) return "接口返回错误";

      if (result.response.status && Number(result.response.status) >= 400) {
        return "HTTP " + result.response.status;
      }
    }

    return "";
  }

  function unwrap(result) {
    var value = result;

    if (!isObject(value)) return value;

    if (typeof value.body === "string") {
      try {
        return JSON.parse(value.body);
      } catch (error) {}
    }

    if (isObject(value.response) && typeof value.response.body === "string") {
      try {
        return JSON.parse(value.response.body);
      } catch (error2) {}
    }

    if (value.data !== undefined && (Array.isArray(value.data) || isObject(value.data))) {
      return value.data;
    }

    return value;
  }

  function looksLikeRequest(value) {
    if (!isObject(value)) return false;

    var keys = [
      "id",
      "rule",
      "matchedRule",
      "matched_rule",
      "url",
      "host",
      "hostname",
      "domain",
      "policy",
      "outbound",
      "remoteHost",
      "remote_host"
    ];

    for (var i = 0; i < keys.length; i++) {
      if (Object.prototype.hasOwnProperty.call(value, keys[i])) return true;
    }

    return false;
  }

  function requestArray(payload) {
    var i;
    var key;
    var value;
    var keys;
    var preferred = ["requests", "recent", "items", "data", "result", "results"];

    if (Array.isArray(payload)) return payload;
    if (!isObject(payload)) return null;

    for (i = 0; i < preferred.length; i++) {
      key = preferred[i];
      value = payload[key];

      if (Array.isArray(value)) return value;
    }

    keys = Object.keys(payload);

    for (i = 0; i < keys.length; i++) {
      value = payload[keys[i]];

      if (Array.isArray(value) && (value.length === 0 || looksLikeRequest(value[0]))) {
        return value;
      }
    }

    var mapValues = [];

    for (i = 0; i < keys.length; i++) {
      value = payload[keys[i]];

      if (looksLikeRequest(value)) {
        mapValues.push(value);
      }
    }

    return mapValues.length ? mapValues : null;
  }

  function containsFinal(value, depth) {
    var i;
    var keys;

    if (depth > 4 || value === null || value === undefined) return false;

    if (typeof value === "string") {
      return /(^|[\s,])FINAL(?:$|[\s,])/i.test(value);
    }

    if (Array.isArray(value)) {
      for (i = 0; i < value.length; i++) {
        if (containsFinal(value[i], depth + 1)) return true;
      }

      return false;
    }

    if (!isObject(value)) return false;

    keys = Object.keys(value);

    for (i = 0; i < keys.length; i++) {
      if (containsFinal(value[keys[i]], depth + 1)) return true;
    }

    return false;
  }

  function hitFinalRule(request) {
    var fields = [
      "rule",
      "matchedRule",
      "matched_rule",
      "ruleName",
      "rule_name",
      "routingRule",
      "routing_rule",
      "matchRule",
      "match_rule"
    ];

    for (var i = 0; i < fields.length; i++) {
      if (
        request[fields[i]] !== undefined &&
        containsFinal(request[fields[i]], 0)
      ) {
        return true;
      }
    }

    return false;
  }

  function valueText(value) {
    if (typeof value === "string" || typeof value === "number") {
      return trimText(value);
    }

    if (isObject(value)) {
      var keys = ["name", "value", "policy", "label", "type", "title"];

      for (var i = 0; i < keys.length; i++) {
        if (value[keys[i]] !== undefined) {
          var nested = valueText(value[keys[i]]);

          if (nested) return nested;
        }
      }
    }

    return "";
  }

  function urlHost(value) {
    var text = trimText(value);
    var match;

    if (!text) return "";

    match = text.match(
      /^[a-z][a-z0-9+.-]*:\/\/(?:[^@\/?#]+@)?(\[[^\]]+\]|[^\/:?#]+)/i
    );

    if (match) return match[1];

    return text;
  }

  function firstRequestText(request, keys) {
    var i;
    var text;

    for (i = 0; i < keys.length; i++) {
      if (request[keys[i]] !== undefined) {
        text = valueText(request[keys[i]]);

        if (text) return text;
      }
    }

    if (isObject(request.request)) {
      for (i = 0; i < keys.length; i++) {
        if (request.request[keys[i]] !== undefined) {
          text = valueText(request.request[keys[i]]);

          if (text) return text;
        }
      }
    }

    return "";
  }

  function requestHost(request) {
    var host = firstRequestText(request, [
      "host",
      "hostname",
      "domain",
      "targetHost",
      "target_host",
      "remoteHost",
      "remote_host",
      "server",
      "url",
      "requestURL",
      "request_url"
    ]);

    host = urlHost(host);

    return host || "未知目标";
  }

  function requestPolicy(request) {
    var policy = firstRequestText(request, [
      "policy",
      "policyName",
      "policy_name",
      "outbound",
      "outboundPolicy",
      "outbound_policy",
      "proxy",
      "proxyName",
      "proxy_name",
      "group"
    ]);

    return policy || "FINAL";
  }

  function finalize(result) {
    var error;
    var payload;
    var requests;
    var scan;
    var hits = [];
    var unique = [];
    var seen = {};
    var i;
    var request;
    var host;
    var policy;
    var key;
    var content;
    var style;

    if (finished) return;
    finished = true;

    if (watchdog) clearTimeout(watchdog);

    error = resultError(result);

    if (error) {
      $done({
        title: PANEL_TITLE,
        content: "读取失败：" + shortText(error, 28) + "\n请刷新后重试",
        style: "error"
      });

      return;
    }

    payload = unwrap(result);
    requests = requestArray(payload);

    if (!requests) {
      $done({
        title: PANEL_TITLE,
        content: "读取失败：未识别请求数据\n请打开 Dashboard 后再刷新",
        style: "error"
      });

      return;
    }

    scan = requests.slice(0, SCAN_LIMIT);

    for (i = 0; i < scan.length; i++) {
      request = scan[i];

      if (!isObject(request) || !hitFinalRule(request)) continue;

      host = requestHost(request);
      policy = requestPolicy(request);

      hits.push({
        host: host,
        policy: policy
      });

      key = host + "|" + policy;

      if (!seen[key]) {
        seen[key] = true;

        unique.push({
          host: host,
          policy: policy
        });
      }
    }

    if (hits.length === 0) {
      content = [
        "近 " + scan.length + " 条：未命中 FINAL",
        "打开目标 App 后再刷新",
        "更新：" + nowText()
      ].join("\n");

      style = "good";
    } else {
      var first = unique[0];
      var more = unique.length > 1 ? " · +" + (unique.length - 1) : "";

      content = [
        "近 " + scan.length + " 条：FINAL " + hits.length + " 条",
        shortText(first.host, MAX_TARGET_LENGTH) +
          " → " +
          shortText(first.policy, MAX_POLICY_LENGTH) +
          more,
        "更新：" + nowText()
      ].join("\n");

      style = "alert";
    }

    $done({
      title: PANEL_TITLE,
      content: content,
      style: style
    });
  }

  watchdog = setTimeout(function () {
    finalize({
      error: "读取超时"
    });
  }, 7000);

  try {
    $httpAPI("GET", "/v1/requests/recent", {}, function (result) {
      finalize(result);
    });
  } catch (error) {
    finalize({
      error: "接口调用失败"
    });
  }
})();
