// Surge Panel: DeepSeek Balance Monitor V3
// 第一遍按照 Surge 现有规则分流。
// 传输层连接失败时，再通过 PROXY_GROUP 指定的策略组重试。

(function () {
  "use strict";

  var PANEL_TITLE = "DeepSeek 余额";
  var BALANCE_URL = "https://api.deepseek.com/user/balance";

  var args = parseArguments(
    typeof $argument === "string" ? $argument : ""
  );

  var API_KEY = trim(args.API_KEY);
  var PROXY_GROUP = trim(args.PROXY_GROUP) || "Proxy";
  var LOW_BALANCE = parseNonNegativeNumber(
    args.LOW_BALANCE,
    5
  );

  var finished = false;
  var globalTimer = null;

  function parseArguments(text) {
    var result = {};
    var items = String(text || "").split("&");
    var i;
    var position;
    var key;
    var value;

    for (i = 0; i < items.length; i++) {
      position = items[i].indexOf("=");

      if (position < 0) {
        continue;
      }

      key = items[i].slice(0, position);
      value = items[i].slice(position + 1);

      try {
        key = decodeURIComponent(
          key.replace(/\+/g, "%20")
        );

        value = decodeURIComponent(
          value.replace(/\+/g, "%20")
        );
      } catch (ignore) {}

      result[key] = value;
    }

    return result;
  }

  function trim(value) {
    return String(
      value === null || value === undefined ? "" : value
    ).replace(/^\s+|\s+$/g, "");
  }

  function isUnresolvedPlaceholder(value) {
    var text = trim(value);

    return (
      /^%[^%]+%$/.test(text) ||
      /^\{\{\{[^}]+\}\}\}$/.test(text)
    );
  }

  function parseNonNegativeNumber(value, fallback) {
    var number = Number(value);

    if (!isFinite(number) || number < 0) {
      return fallback;
    }

    return number;
  }

  function shortText(value, limit) {
    var text = trim(value);

    if (text.length <= limit) {
      return text;
    }

    return text.slice(
      0,
      Math.max(1, limit - 1)
    ) + "…";
  }

  function nowText() {
    var now = new Date();
    var hour = now.getHours();
    var minute = now.getMinutes();

    return (
      (hour < 10 ? "0" : "") +
      hour +
      ":" +
      (minute < 10 ? "0" : "") +
      minute
    );
  }

  function responseStatus(response) {
    if (!response) {
      return 0;
    }

    return Number(
      response.status ||
      response.statusCode ||
      0
    );
  }

  function currencySymbol(currency) {
    var normalized = trim(currency).toUpperCase();

    if (normalized === "CNY") {
      return "¥";
    }

    if (normalized === "USD") {
      return "$";
    }

    return normalized
      ? normalized + " "
      : "";
  }

  function formatMoney(value, currency) {
    var amount = Number(value);

    if (!isFinite(amount)) {
      amount = 0;
    }

    return (
      currencySymbol(currency) +
      amount.toFixed(2)
    );
  }

  function parsePayload(data) {
    if (
      data &&
      typeof data === "object"
    ) {
      return data;
    }

    return JSON.parse(
      String(data || "")
    );
  }

  function transportErrorText(error) {
    var message = "";

    if (typeof error === "string") {
      message = error;
    } else if (
      error &&
      typeof error === "object"
    ) {
      message =
        error.localizedDescription ||
        error.message ||
        error.reason ||
        error.error ||
        "";

      if (!message) {
        try {
          message = JSON.stringify(error);
        } catch (ignore) {
          message = String(error);
        }
      }
    }

    message = trim(message);

    if (!message) {
      return "网络连接失败";
    }

    if (/timeout|timed out|超时/i.test(message)) {
      return "连接超时";
    }

    if (/dns|resolve|host|解析/i.test(message)) {
      return "DNS 解析失败";
    }

    if (/certificate|ssl|tls|证书/i.test(message)) {
      return "TLS 或证书错误";
    }

    if (/policy|策略/i.test(message)) {
      return "策略组不存在或不可用";
    }

    return shortText(message, 28);
  }

  function apiErrorText(status, data) {
    var payload;
    var detail = "";

    try {
      payload = parsePayload(data);

      if (
        payload &&
        typeof payload.error === "object"
      ) {
        detail =
          payload.error.message ||
          payload.error.type ||
          payload.error.code ||
          "";
      } else if (
        payload &&
        typeof payload.error === "string"
      ) {
        detail = payload.error;
      } else if (
        payload &&
        typeof payload.message === "string"
      ) {
        detail = payload.message;
      }
    } catch (ignore) {}

    if (status === 400) {
      return "请求格式错误";
    }

    if (status === 401) {
      return "API Key 无效或已失效";
    }

    if (status === 402) {
      return "账户余额不足";
    }

    if (status === 403) {
      return "API Key 无访问权限";
    }

    if (status === 404) {
      return "余额接口不存在";
    }

    if (status === 422) {
      return "接口参数无效";
    }

    if (status === 429) {
      return "请求过于频繁";
    }

    if (status >= 500) {
      return "DeepSeek 服务暂时异常";
    }

    if (status > 0) {
      return detail
        ? "HTTP " +
            status +
            "：" +
            shortText(detail, 20)
        : "HTTP " + status;
    }

    return detail || "未知接口错误";
  }

  function selectBalanceInfo(balanceInfos) {
    var list = Array.isArray(balanceInfos)
      ? balanceInfos
      : [];

    var i;

    if (!list.length) {
      return null;
    }

    for (i = 0; i < list.length; i++) {
      if (
        trim(list[i].currency).toUpperCase() ===
        "CNY"
      ) {
        return list[i];
      }
    }

    return list[0];
  }

  function finishError(message, routeText) {
    if (finished) {
      return;
    }

    finished = true;

    if (globalTimer) {
      clearTimeout(globalTimer);
    }

    $done({
      title: PANEL_TITLE,
      content: [
        "查询失败：" + shortText(message, 29),
        "路由：" + shortText(routeText, 28),
        "更新：" + nowText()
      ].join("\n"),
      style: "error"
    });
  }

  function finishSuccess(payload, routeText) {
    var balance;
    var currency;
    var total;
    var toppedUp;
    var granted;
    var available;
    var style;
    var statusText;

    if (finished) {
      return;
    }

    finished = true;

    if (globalTimer) {
      clearTimeout(globalTimer);
    }

    balance = selectBalanceInfo(
      payload.balance_infos
    );

    if (!balance) {
      $done({
        title: PANEL_TITLE,
        content: [
          "接口未返回余额明细",
          "路由：" + routeText,
          "更新：" + nowText()
        ].join("\n"),
        style: "alert"
      });

      return;
    }

    currency = trim(balance.currency);

    total = parseNonNegativeNumber(
      balance.total_balance,
      0
    );

    toppedUp = parseNonNegativeNumber(
      balance.topped_up_balance,
      0
    );

    granted = parseNonNegativeNumber(
      balance.granted_balance,
      0
    );

    available =
      payload.is_available === true;

    if (!available) {
      style = "error";
      statusText = "余额不足或不可调用";
    } else if (total <= LOW_BALANCE) {
      style = "alert";
      statusText = "余额偏低";
    } else {
      style = "good";
      statusText = "可正常调用";
    }

    $done({
      title: PANEL_TITLE,
      content: [
        "总余额：" +
          formatMoney(total, currency),

        "充值：" +
          formatMoney(toppedUp, currency) +
          " · 赠送：" +
          formatMoney(granted, currency),

        "状态：" +
          statusText +
          " · " +
          routeText +
          " · " +
          nowText()
      ].join("\n"),
      style: style
    });
  }

  function requestBalance(policy, callback) {
    var request = {
      url: BALANCE_URL,
      headers: {
        "Authorization": "Bearer " + API_KEY,
        "Accept": "application/json",
        "Cache-Control": "no-cache"
      },
      timeout: 5,
      "auto-cookie": false,
      "auto-redirect": true
    };

    if (policy) {
      request.policy = policy;
    }

    try {
      $httpClient.get(
        request,
        function (error, response, data) {
          callback(
            error,
            response,
            data
          );
        }
      );
    } catch (error) {
      callback(
        error,
        null,
        null
      );
    }
  }

  function processResponse(
    error,
    response,
    data,
    routeText,
    allowFallback
  ) {
    var status;
    var payload;

    if (finished) {
      return;
    }

    status = responseStatus(response);

    if (error || status === 0) {
      if (
        allowFallback &&
        PROXY_GROUP &&
        !isUnresolvedPlaceholder(PROXY_GROUP)
      ) {
        requestBalance(
          PROXY_GROUP,
          function (
            fallbackError,
            fallbackResponse,
            fallbackData
          ) {
            processResponse(
              fallbackError,
              fallbackResponse,
              fallbackData,
              PROXY_GROUP,
              false
            );
          }
        );

        return;
      }

      finishError(
        transportErrorText(error),
        routeText
      );

      return;
    }

    if (
      status < 200 ||
      status >= 300
    ) {
      finishError(
        apiErrorText(status, data),
        routeText
      );

      return;
    }

    try {
      payload = parsePayload(data);
    } catch (parseError) {
      finishError(
        "返回数据格式错误",
        routeText
      );

      return;
    }

    if (
      !payload ||
      typeof payload !== "object" ||
      !Array.isArray(payload.balance_infos)
    ) {
      finishError(
        "接口未返回有效余额数据",
        routeText
      );

      return;
    }

    finishSuccess(
      payload,
      routeText
    );
  }

  if (
    !API_KEY ||
    API_KEY === "replace_with_your_key" ||
    isUnresolvedPlaceholder(API_KEY)
  ) {
    finishError(
      "模块中的 API Key 尚未正确替换",
      "未执行"
    );

    return;
  }

  if (isUnresolvedPlaceholder(PROXY_GROUP)) {
    PROXY_GROUP = "Proxy";
  }

  globalTimer = setTimeout(function () {
    finishError(
      "整体请求超时",
      "规则分流 → " + PROXY_GROUP
    );
  }, 10500);

  requestBalance(
    "",
    function (error, response, data) {
      processResponse(
        error,
        response,
        data,
        "规则分流",
        true
      );
    }
  );
})();