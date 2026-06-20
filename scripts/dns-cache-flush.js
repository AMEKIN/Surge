// Surge 手动脚本：DNS 缓存清理
// 使用方法：在 Surge 的脚本列表中长按“DNS缓存清理”后执行。

(function () {
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
    if (result && result.error) return stringifyError(result.error);

    if (result && result.status && Number(result.status) >= 400) {
      return "HTTP " + result.status;
    }

    return "";
  }

  try {
    $httpAPI("POST", "/v1/dns/flush", {}, function (result) {
      var error = getApiError(result);

      if (error) {
        $notification.post("DNS 缓存清理", "执行失败", error);

        $done({
          title: "DNS 缓存清理",
          content: "清理失败：" + error,
          style: "error"
        });

        return;
      }

      $notification.post(
        "DNS 缓存清理",
        "已完成",
        "Surge DNS 缓存已清空；刷新 DNS 状态面板即可重新检测。"
      );

      $done({
        title: "DNS 缓存清理",
        content: "已清理 DNS 缓存",
        style: "good"
      });
    });
  } catch (error) {
    var message = stringifyError(error);

    $notification.post("DNS 缓存清理", "执行失败", message);

    $done({
      title: "DNS 缓存清理",
      content: "清理失败：" + message,
      style: "error"
    });
  }
})();
