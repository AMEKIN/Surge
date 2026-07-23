// Surge Panel: DeepSeek Balance Monitor V1
// 手动查询 DeepSeek API 账户余额。
// API Key 由 Surge 模块参数传入，不应直接写进公开脚本。

(function () {
  "use strict";

  var PANEL_TITLE = "DeepSeek 余额";
  var BALANCE_URL = "https://api.deepseek.com/user/balance";

  var args = parseArguments(
    typeof $argument === "string" ? $argument : ""
  );

  var API_KEY = trim(args.DEEPSEEK_API_KEY);
  var POLICY = trim(args.POLICY);
  var LOW_BALANCE = parseNonNegativeNumber(args.LOW_BALANCE, 5);

  var finished = false;
  var timeoutTimer = null;

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

  function parseNonNegativeNumber(value, fallback) {
    var number = Number(value);

    if (!isFinite(number) || number < 0) {
      return fallback;
    }

    return number;
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

  function currencySymbol(currency) {
    var normalized = trim(currency).toUpperCase();

    if (normalized === "CNY") {
      return "¥";
    }

    if (normalized === "USD") {
      return "$";
    }

    return normalized ? normalized + " " : "";
  }

  function formatMoney(value, currency) {
    var amount = Number(value);

    if (!isFinite(amount)) {
      amount = 0;
    }

    return currencySymbol(currency) + amount.toFixed(2);
  }

  function shortText(value, limit) {
    var text = trim(value);

    if (text.length <= limit) {
      return text;
    }

    return text.slice(0, Math.max(1, limit - 1)) + "…";
  }

  function errorMessage(status, data) {
    var payload;
    var detail = "";

    try {
      payload = JSON.parse(String(data || ""));

      if (payload && typeof payload.error === "object") {
        detail =
          payload.error.message ||
          payload.error.type ||
          "";
      } else if (payload && typeof payload.error === "string") {
        detail = payload.error;
      } else if (payload && typeof payload.message === "string") {
        detail = payload.message;
      }
    } catch (ignore) {}

    if (status === 401) {
      return "API Key 无效或已失效";
    }

    if (status === 403) {
      return "API Key 无访问权限";
    }

    if (status === 429) {
      return "请求过于频繁";
    }

    if (status >= 500) {
      return "DeepSeek 服务暂时异常";
    }

    if (status > 0) {
      return detail
        ? "HTTP " + status + "：" + shortText(detail, 22)
        : "HTTP " + status;
    }

    return detail || "网络连接失败";
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
        trim(list[i].currency).toUpperCase() === "CNY"
      ) {
        return list[i];
      }
    }

    return list[0];
  }

  function finishError(message) {
    if (finished) {
      return;
    }

    finished = true;

    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }

    $done({
      title: PANEL_TITLE,
      content: [
        "查询失败：" + shortText(message, 28),
        "请检查 API Key、网络和策略组",
        "更新：" + nowText()
      ].join("\n"),
      style: "error"
    });
  }

  function finishSuccess(payload) {
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

    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }

    balance = selectBalanceInfo(payload.balance_infos);

    if (!balance) {
      $done({
        title: PANEL_TITLE,
        content: [
          "未返回余额明细",
          "账户状态：" +
            (payload.is_available === true
              ? "可正常调用"
              : "不可用"),
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

    available = payload.is_available === true;

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
        "总余额：" + formatMoney(total, currency),
        "充值：" +
          formatMoney(toppedUp, currency) +
          " · 赠送：" +
          formatMoney(granted, currency),
        "状态：" +
          statusText +
          " · 更新：" +
          nowText()
      ].join("\n"),
      style: style
    });
  }

  if (
    !API_KEY ||
    API_KEY === "replace_with_your_key"
  ) {
    finishError("尚未配置 DeepSeek API Key");
    return;
  }

  timeoutTimer = setTimeout(function () {
    finishError("请求超时");
  }, 9000);

  try {
    var request = {
      url: BALANCE_URL,
      headers: {
        "Authorization": "Bearer " + API_KEY,
        "Accept": "application/json",
        "Cache-Control": "no-cache"
      },
      timeout: 8,
      "auto-cookie": false,
      "auto-redirect": true
    };

    if (POLICY) {
      request.policy = POLICY;
    }

    $httpClient.get(
      request,
      function (error, response, data) {
        var status;
        var payload;

        if (finished) {
          return;
        }

        status = responseStatus(response);

        if (error) {
          finishError("网络连接失败");
          return;
        }

        if (status < 200 || status >= 300) {
          finishError(
            errorMessage(status, data)
          );
          return;
        }

        try {
          payload = JSON.parse(String(data || ""));
        } catch (parseError) {
          finishError("返回数据格式错误");
          return;
        }

        if (
          !payload ||
          typeof payload !== "object" ||
          !Array.isArray(payload.balance_infos)
        ) {
          finishError("接口未返回有效余额数据");
          return;
        }

        finishSuccess(payload);
      }
    );
  } catch (error) {
    finishError("脚本调用失败");
  }
})();