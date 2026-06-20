// Surge Panel：DNS 状态 V2
// 只在点击面板右上角刷新时检测；不会定时请求。

(function () {
  var PANEL_TITLE = "DNS 状态";
  var MAX_DELAY_ITEMS = 2;
  var SLOW_THRESHOLD = 120;
  var BAD_THRESHOLD = 250;

  var cacheResult;
  var delayResult;
  var pending = 2;
  var finished = false;
  var watchdog;

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function safeStringify(value) {
    try {
      var text = JSON.stringify(value);
      return text.length > 1800 ? text.slice(0, 1800) + "..." : text;
    } catch (e) {
      return String(value);
    }
  }

  function toErrorText(value) {
    if (value === null || value === undefined) return "未知错误";
    if (typeof value === "string") return value;
    return safeStringify(value);
  }

  function parsePayload(result) {
    if (!isObject(result)) return result;

    if (typeof result.body === "string") {
      try {
        return JSON.parse(result.body);
      } catch (e) {
        return result;
      }
    }

    if (isObject(result.response) && typeof result.response.body === "string") {
      try {
        return JSON.parse(result.response.body);
      } catch (e2) {
        return result;
      }
    }

    return result;
  }

  function getApiError(result) {
    if (result === null || result === undefined) return "API 无响应";

    if (
      isObject(result) &&
      result.error !== undefined &&
      result.error !== null &&
      result.error !== ""
    ) {
      return toErrorText(result.error);
    }

    if (isObject(result) && typeof result.status === "number" && result.status >= 400) {
      return "HTTP " + result.status;
    }

    return "";
  }

  function positiveNumber(value) {
    if (typeof value === "number" && isFinite(value) && value > 0) {
      return value;
    }

    if (typeof value === "string") {
      var match = value.match(/^\s*([0-9]+(?:\.[0-9]+)?)\s*(?:ms)?\s*$/i);

      if (match) {
        var parsed = Number(match[1]);
        return isFinite(parsed) && parsed > 0 ? parsed : null;
      }
    }

    return null;
  }

  function getDelayValue(object) {
    if (!isObject(object)) return null;

    var keys = ["delay", "latency", "rtt", "ms", "duration"];

    for (var i = 0; i < keys.length; i++) {
      if (Object.prototype.hasOwnProperty.call(object, keys[i])) {
        var value = positiveNumber(object[keys[i]]);
        if (value !== null) return value;
      }
    }

    return null;
  }

  function looksLikeResolverKey(value) {
    if (typeof value !== "string") return false;

    var key = value.trim();
    if (!key) return false;

    if (/^(https?|h3|quic):\/\//i.test(key)) return true;
    if (/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(key)) return true;
    if (/^\[[0-9a-f:]+\](?::\d+)?$/i.test(key)) return true;
    if (/^[0-9a-f:]+$/i.test(key) && key.indexOf(":") >= 0) return true;
    if (/^(system|local|default)$/i.test(key)) return true;
    if (/^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?$/i.test(key)) return true;

    return false;
  }

  function getResolverName(object, fallback) {
    if (isObject(object)) {
      var keys = ["server", "resolver", "address", "host", "dns", "name"];

      for (var i = 0; i < keys.length; i++) {
        var value = object[keys[i]];

        if (typeof value === "string" && looksLikeResolverKey(value)) {
          return value;
        }
      }
    }

    return looksLikeResolverKey(fallback) ? fallback : "";
  }

  function compactResolverName(value) {
    var name = String(value || "DNS");

    name = name.replace(/^[a-z0-9+.-]+:\/\//i, "");
    name = name.replace(/\/.*$/, "");

    return name.length > 22 ? name.slice(0, 21) + "…" : name;
  }

  function collectDelayItems(node, inheritedName, output, seen, depth) {
    if (depth > 6 || node === null || node === undefined) return;

    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) {
        collectDelayItems(node[i], inheritedName, output, seen, depth + 1);
      }
      return;
    }

    if (!isObject(node)) return;

    var resolver = getResolverName(node, inheritedName);
    var delay = getDelayValue(node);

    // 只有带明确服务器名且延迟大于 0 的结果才采纳。
    // 避免把顶层 delay:0 / time 等字段误显示成 DNS 延迟。
    if (resolver && delay !== null) {
      var signature = resolver + "|" + delay;

      if (!seen[signature]) {
        seen[signature] = true;
        output.push({
          name: resolver,
          delay: delay
        });
      }
    }

    var skip = {
      error: true,
      message: true,
      status: true,
      code: true,
      time: true,
      timestamp: true,
      delay: true,
      latency: true,
      rtt: true,
      ms: true,
      duration: true,
      server: true,
      resolver: true,
      address: true,
      host: true,
      dns: true,
      name: true
    };

    Object.keys(node).forEach(function (key) {
      if (skip[key]) return;

      var value = node[key];
      var mapDelay = positiveNumber(value);

      // 支持 {"223.5.5.5":18}、{"https://dns.example":30} 这类映射。
      if (mapDelay !== null && looksLikeResolverKey(key)) {
        var mapSignature = key + "|" + mapDelay;

        if (!seen[mapSignature]) {
          seen[mapSignature] = true;
          output.push({
            name: key,
            delay: mapDelay
          });
        }

        return;
      }

      if (isObject(value) || Array.isArray(value)) {
        collectDelayItems(
          value,
          looksLikeResolverKey(key) ? key : inheritedName,
          output,
          seen,
          depth + 1
        );
      }
    });
  }

  function extractDelayItems(payload) {
    var output = [];

    collectDelayItems(payload, "", output, {}, 0);

    output.sort(function (a, b) {
      return a.delay - b.delay;
    });

    return output.slice(0, MAX_DELAY_ITEMS);
  }

  function looksLikeCacheKey(key) {
    if (typeof key !== "string") return false;

    return key.indexOf(".") >= 0 || key.indexOf(":") >= 0 || key === "localhost";
  }

  function isCacheRecord(value) {
    if (Array.isArray(value)) return true;
    if (!isObject(value)) return false;

    var recordKeys = [
      "address",
      "addresses",
      "answer",
      "answers",
      "ttl",
      "expire",
      "expired",
      "domain",
      "hostname",
      "type"
    ];

    for (var i = 0; i < recordKeys.length; i++) {
      if (Object.prototype.hasOwnProperty.call(value, recordKeys[i])) {
        return true;
      }
    }

    return false;
  }

  function countDirectCacheEntries(node) {
    if (Array.isArray(node)) return node.length;
    if (!isObject(node)) return null;

    var keys = Object.keys(node);

    if (keys.length === 0) return 0;

    var domainKeys = keys.filter(function (key) {
      return looksLikeCacheKey(key);
    });

    if (domainKeys.length > 0) return domainKeys.length;

    var recordValues = keys.filter(function (key) {
      return isCacheRecord(node[key]);
    });

    if (recordValues.length > 0) return recordValues.length;

    return null;
  }

  function findCacheCount(node, depth) {
    if (depth > 6 || node === null || node === undefined) return null;
    if (Array.isArray(node)) return node.length;
    if (!isObject(node)) return null;

    // 优先进入常见包装字段，避免把根对象的两个字段误数为“2 条”。
    var preferred = [
      "cache",
      "caches",
      "entries",
      "records",
      "items",
      "result",
      "results",
      "data",
      "dns"
    ];

    for (var i = 0; i < preferred.length; i++) {
      var key = preferred[i];

      if (Object.prototype.hasOwnProperty.call(node, key)) {
        var nestedCount = findCacheCount(node[key], depth + 1);

        if (nestedCount !== null) return nestedCount;
      }
    }

    return countDirectCacheEntries(node);
  }

  function formatTime() {
    var now = new Date();

    function pad(number) {
      return number < 10 ? "0" + number : String(number);
    }

    return pad(now.getHours()) + ":" + pad(now.getMinutes());
  }

  function finish() {
    if (finished) return;

    finished = true;

    if (watchdog) clearTimeout(watchdog);

    var cacheError = getApiError(cacheResult);
    var delayError = getApiError(delayResult);

    var cachePayload = parsePayload(cacheResult);
    var delayPayload = parsePayload(delayResult);

    console.log("[DNS状态V2] /v1/dns => " + safeStringify(cachePayload));
    console.log("[DNS状态V2] /v1/test/dns_delay => " + safeStringify(delayPayload));

    var cacheCount = cacheError ? null : findCacheCount(cachePayload, 0);
    var delayItems = delayError ? [] : extractDelayItems(delayPayload);

    var delayLine;

    if (delayError) {
      delayLine = "DNS 延迟：检测失败";
    } else if (delayItems.length > 0) {
      delayLine =
        "DNS 延迟：" +
        delayItems
          .map(function (item) {
            return compactResolverName(item.name) + " " + Math.round(item.delay) + "ms";
          })
          .join(" · ");
    } else {
      delayLine = "DNS 延迟：未返回有效明细";
    }

    var cacheLine =
      "DNS 缓存：" +
      (cacheCount === null ? "未识别" : cacheCount + " 条");

    var noteLine = "更新：" + formatTime();
    var style = "good";

    if (cacheError || delayError) {
      style = "error";

      noteLine =
        "状态：" +
        [
          cacheError ? "缓存读取失败" : "",
          delayError ? "延迟检测失败" : ""
        ]
          .filter(Boolean)
          .join(" / ");
    } else if (!delayItems.length || cacheCount === null) {
      style = "alert";
      noteLine = "状态：接口未返回完整明细";
    } else {
      var maxDelay = 0;

      for (var i = 0; i < delayItems.length; i++) {
        if (delayItems[i].delay > maxDelay) {
          maxDelay = delayItems[i].delay;
        }
      }

      if (maxDelay > BAD_THRESHOLD) {
        style = "error";
      } else if (maxDelay > SLOW_THRESHOLD) {
        style = "alert";
      }
    }

    $done({
      title: PANEL_TITLE,
      content: [delayLine, cacheLine, noteLine].join("\n"),
      style: style
    });
  }

  function completeOne() {
    pending -= 1;

    if (pending <= 0) {
      finish();
    }
  }

  watchdog = setTimeout(function () {
    if (cacheResult === undefined) {
      cacheResult = { error: "超时" };
    }

    if (delayResult === undefined) {
      delayResult = { error: "超时" };
    }

    finish();
  }, 8500);

  try {
    $httpAPI("GET", "/v1/dns", {}, function (result) {
      cacheResult = result;
      completeOne();
    });
  } catch (error) {
    cacheResult = { error: toErrorText(error) };
    completeOne();
  }

  try {
    $httpAPI("POST", "/v1/test/dns_delay", {}, function (result) {
      delayResult = result;
      completeOne();
    });
  } catch (error) {
    delayResult = { error: toErrorText(error) };
    completeOne();
  }
})();
