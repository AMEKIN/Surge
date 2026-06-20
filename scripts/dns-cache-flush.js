// Surge Panel：DNS 缓存清理 V2
// 点击此面板右上角的刷新按钮，即执行一次清理。

(function () {
  var finished = false;
  var watchdog;

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function toErrorText(value) {
    if (value === null || value === undefined) return "未知错误";
    if (typeof value === "string") return value;

    try {
      return JSON.stringify(value);
    } catch (e) {
      return String(value);
    }
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

  function formatTime() {
    var now = new Date();

    function pad(number) {
      return number < 10 ? "0" + number : String(number);
    }

    return pad(now.getHours()) + ":" + pad(now.getMinutes());
  }

  function finish(result) {
    if (finished) return;

    finished = true;

    if (watchdog) clearTimeout(watchdog);

    var error = getApiError(result);
    var payload = parsePayload(result);

    console.log("[DNS缓存清理V2] /v1/dns/flush => " + toErrorText(payload));

    if (error) {
      $done({
        title: "DNS 缓存清理",
        content: "清理失败：" + error,
        style: "error"
      });

      return;
    }

    $done({
      title: "DNS 缓存清理",
      content: "已清理 · " + formatTime() + "\n请刷新“DNS 状态”确认",
      style: "good"
    });
  }

  watchdog = setTimeout(function () {
    finish({ error: "超时" });
  }, 6500);

  try {
    $httpAPI("POST", "/v1/dns/flush", {}, function (result) {
      finish(result);
    });
  } catch (error) {
    finish({ error: toErrorText(error) });
  }
})();
