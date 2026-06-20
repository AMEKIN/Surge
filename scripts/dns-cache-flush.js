// Surge Panel：DNS 缓存清理 V4
// 点击面板右侧刷新后，调用 Surge 内置 DNS 缓存清理接口。

(function () {
  "use strict";

  var finished = false;
  var timer = null;

  function pad(value) {
    return value < 10 ? "0" + value : String(value);
  }

  function nowText() {
    var now = new Date();
    return pad(now.getHours()) + ":" + pad(now.getMinutes());
  }

  function errorFrom(result) {
    if (!result) {
      return "";
    }

    if (result.error) {
      return typeof result.error === "string"
        ? result.error
        : "接口返回错误";
    }

    if (result.status && Number(result.status) >= 400) {
      return "HTTP " + result.status;
    }

    return "";
  }

  function finish(result) {
    var error;

    if (finished) {
      return;
    }

    finished = true;

    if (timer) {
      clearTimeout(timer);
    }

    error = errorFrom(result);

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
      content: "已清理 · " + nowText() + "\n缓存会随新请求自动重建",
      style: "good"
    });
  }

  timer = setTimeout(function () {
    finish({
      error: "执行超时"
    });
  }, 7000);

  try {
    $httpAPI("POST", "/v1/dns/flush", {}, function (result) {
      finish(result);
    });
  } catch (error) {
    finish({
      error: "接口调用失败"
    });
  }
})();
