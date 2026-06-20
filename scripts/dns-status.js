// Surge Panel：DNS 状态
// 功能：
// 1. 点击面板刷新时，调用 Surge 内置 DNS 延迟检测。
// 2. 读取当前 Surge DNS 缓存，并显示缓存条目数量。
// 3. 不设置自动刷新，避免频繁产生 DNS 测试请求。

(function () {
  var PANEL_TITLE = "DNS 状态";
  var MAX_DELAY_ITEMS = 2;
  var SLOW_THRESHOLD = 120;
  var BAD_THRESHOLD = 250;

  var cacheResponse = null;
  var delayResponse = null;
  var pending = 2;
  var errors = [];

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function stringifyError(value) {
    if (value === null || value === undefined) return "未知错误";
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch (e) {
      return String(value);
    }
  }

  function getApiError(result) {
    if (result === null || result === undefined) return "API 无响应";
    if (isObject(result) && result.error) return stringifyError(result.error);
    if (isObject(result) && result.status && Number(result.status) >= 400) {
      return "HTTP " + result.status;
    }
    return "";
  }

  function unwrapResponse(result) {
    if (!isObject(result)) return result;

    if (typeof result.body === "string") {
      try {
        return JSON.parse(result.body);
      } catch (e) {
        return result;
      }
    }

    if (result.data && isObject(result.data) && Object.keys(result).length <= 3) {
      return result.data;
    }

    return result;
  }

  function getCacheContainer(data) {
    if (Array.isArray(data)) return data;
    if (!isObject(data)) return null;

    var preferredKeys = ["cache", "entries", "records", "items", "result"];
    for (var i = 0; i < preferredKeys.length; i++) {
      var value = data[preferredKeys[i]];
      if (Array.isArray(value) || isObject(value)) return value;
    }

    return data;
  }

  function countCacheEntries(data) {
    var container = getCacheContainer(data);
    if (container === null) return null;
    if (Array.isArray(container)) return container.length;
    if (!isObject(container)) return null;

    var ignoredKeys = {
      error: true,
      status: true,
      message: true,
      success: true,
      code: true
    };

    return Object.keys(container).filter(function (key) {
      return !ignoredKeys[key];
    }).length;
  }

  function numberFrom(value) {
    if (typeof value === "number" && isFinite(value)) return value;

    if (typeof value === "string") {
      var match = value.match(/([0-9]+(?:\.[0-9]+)?)\s*ms/i);
      if (match) return Number(match[1]);
      if (/^[0-9]+(?:\.[0-9]+)?$/.test(value.trim())) return Number(value);
    }

    return null;
  }

  function getFirstNumber(object, keys) {
    for (var i = 0; i < keys.length; i++) {
      if (Object.prototype.hasOwnProperty.call(object, keys[i])) {
        var num = numberFrom(object[keys[i]]);
        if (num !== null) return num;
      }
    }

    return null;
  }

  function getLabel(object, fallback) {
    if (!isObject(object)) return fallback || "DNS";

    var keys = ["server", "name", "address", "ip", "host", "resolver", "dns"];
    for (var i = 0; i < keys.length; i++) {
      if (typeof object[keys[i]] === "string" && object[keys[i]]) {
        return object[keys[i]];
      }
    }

    return fallback || "DNS";
  }

  function collectDelayItems(value, keyHint, output, depth) {
    if (depth > 5 || value === null || value === undefined) return;

    var directNumber = numberFrom(value);
    if (directNumber !== null && keyHint) {
      output.push({ name: keyHint, delay: directNumber });
      return;
    }

    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        collectDelayItems(value[i], "", output, depth + 1);
      }
      return;
    }

    if (!isObject(value)) return;

    var delay = getFirstNumber(value, ["delay", "latency", "rtt", "ping", "time", "ms"]);
    if (delay !== null) {
      output.push({ name: getLabel(value, keyHint), delay: delay });
      return;
    }

    var skipKeys = {
      error: true,
      status: true,
      message: true,
      success: true,
      code: true
    };

    Object.keys(value).forEach(function (key) {
      if (!skipKeys[key]) {
        collectDelayItems(value[key], key, output, depth + 1);
      }
    });
  }

  function normalizeDelayItems(data) {
    var output = [];
    collectDelayItems(data, "", output, 0);

    var seen = {};

    return output.filter(function (item) {
      if (!item.name || item.delay === null || !isFinite(item.delay)) return false;

      var signature = item.name + "|" + item.delay;
      if (seen[signature]) return false;

      seen[signature] = true;
      return true;
    }).slice(0, MAX_DELAY_ITEMS);
  }

  function formatDelay(value) {
    return Math.round(value) + "ms";
  }

  function formatTime() {
    var now = new Date();

    function pad(number) {
      return number < 10 ? "0" + number : String(number);
    }

    return pad(now.getHours()) + ":" + pad(now.getMinutes());
  }

  function finish() {
    var cacheError = getApiError(cacheResponse);
    var delayError = getApiError(delayResponse);

    if (cacheError) errors.push("缓存读取失败");
    if (delayError) errors.push("延迟检测失败");

    var cacheData = unwrapResponse(cacheResponse);
    var delayData = unwrapResponse(delayResponse);

    var cacheCount = cacheError ? null : countCacheEntries(cacheData);
    var delayItems = delayError ? [] : normalizeDelayItems(delayData);

    var delayText = "DNS 延迟：";

    if (delayError) {
      delayText += "检测失败";
    } else if (delayItems.length) {
      delayText += delayItems.map(function (item) {
        return item.name + " " + formatDelay(item.delay);
      }).join(" · ");
    } else {
      delayText += "已完成";
    }

    var cacheText = "DNS 缓存：";
    cacheText += cacheCount === null ? "读取失败" : cacheCount + " 条";

    var stateText = errors.length
      ? "状态：" + errors.join(" / ")
      : "更新：" + formatTime();

    var style = "info";

    if (errors.length) {
      style = "alert";
    } else if (delayItems.length) {
      var maxDelay = Math.max.apply(null, delayItems.map(function (item) {
        return item.delay;
      }));

      if (maxDelay > BAD_THRESHOLD) {
        style = "error";
      } else if (maxDelay > SLOW_THRESHOLD) {
        style = "alert";
      } else {
        style = "good";
      }
    }

    $done({
      title: PANEL_TITLE,
      content: [delayText, cacheText, stateText].join("\n"),
      style: style
    });
  }

  function completeOne() {
    pending -= 1;
    if (pending <= 0) finish();
  }

  try {
    $httpAPI("POST", "/v1/test/dns_delay", {}, function (result) {
      delayResponse = result;
      completeOne();
    });
  } catch (error) {
    delayResponse = { error: stringifyError(error) };
    completeOne();
  }

  try {
    $httpAPI("GET", "/v1/dns", {}, function (result) {
      cacheResponse = result;
      completeOne();
    });
  } catch (error) {
    cacheResponse = { error: stringifyError(error) };
    completeOne();
  }
})();
