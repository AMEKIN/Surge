// Surge Panel: DeepSeek Balance Monitor V2
// 默认先按照 Surge 现有规则访问 DeepSeek。
// 仅在传输层连接失败时，再通过备用策略组重试。

(function () {
  "use strict";

  var PANEL_TITLE = "DeepSeek 余额";
  var BALANCE_URL = "https://api.deepseek.com/user/balance";

  var args = parseArguments(
    typeof $argument === "string" ? $argument : ""
  );

  var API_KEY = trim(args.DEEPSEEK_API_KEY);
  var PRIMARY_POLICY = trim(args.PRIMARY_POLICY) || "RULE";
  var FALLBACK_POLICY = trim(args.FALLBACK_POLICY) || "Proxy";
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

  function isRuleMode(policy) {
    var normalized = trim(policy).toUpperCase();

    return (
      normalized === "" ||
      normalized === "RULE" ||
      normalized === "AUTO" ||
      normalized === "DEFAULT"
    );
  }

  function policyLabel(policy) {
    return isRuleMode(policy)
      ? "规则分流"
      : trim(policy);
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

  function describeTransportError(error) {
    var message = "";

    if (typeof error === "string") {
      message = error;
    } else if (error && typeof error === "object") {
      message =
        error.localizedDescription ||
        error.message ||
        error.error ||
        error.reason ||
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
      return "连接失败";
    }

    if (/timed?\s*out|timeout|超时/i.test(message)) {
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

    if (/network|connection|connect|socket|网络|连接/i.test(message)) {
      return shortText(message, 28);
    }

    return shortText(message, 28);
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

  function apiErrorDetail(status, data) {
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

    if (status === 429) {
      return "请求过于频繁";
    }

    if (status === 500) {
      return "DeepSeek 服务器错误";
    }

    if (status === 503) {
      return "DeepSeek 服务繁忙";
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
          "未返回余额明细",
          "路由：" + shortText(routeText, 28),
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
          policyLabel(routeText) +
          " · " +
          nowText()
      ].join("\n"),
      style: style
    });
  }

  function buildRoutes() {
    var routes = [];
    var primary = trim(PRIMARY_POLICY);
    var fallback = trim(FALLBACK_POLICY);

    routes.push(primary || "RULE");

    if (
      fallback &&
      fallback.toUpperCase() !==
        (primary || "RULE").toUpperCase()
    ) {
      routes.push(fallback);
    }

    return routes;
  }

  function requestBalance(
    policy,
    callback
  ) {
    var request = {
      url: BALANCE_URL,
      headers: {
        "Authorization": "Bearer " + API_KEY,
        "Accept": "application/json",
        "Cache-Control": "no-cache",
        "User-Agent": "Surge-DeepSeek-Balance/2.0"
      },
      timeout: 4,
      "auto-cookie": false,
      "auto-redirect": true
    };

    if (!isRuleMode(policy)) {
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

  function runAttempt(
    routes,
    index,
    previousErrors
  ) {
    var route;

    if (finished) {
      return;
    }

    if (index >= routes.length) {
      finishError(
        previousErrors.join(" / ") ||
          "所有路由均连接失败",
        routes.map(policyLabel).join(" → ")
      );

      return;
    }

    route = routes[index];

    requestBalance(
      route,
      function (error, response, data) {
        var status;
        var payload;
        var transportError;

        if (finished) {
          return;
        }

        status = responseStatus(response);

        if (error || status === 0) {
          transportError =
            describeTransportError(error);

          previousErrors.push(
            policyLabel(route) +
              "：" +
              transportError
          );

          runAttempt(
            routes,
            index + 1,
            previousErrors
          );

          return;
        }

        if (
          status < 200 ||
          status >= 300
        ) {
          finishError(
            apiErrorDetail(status, data),
            policyLabel(route)
          );

          return;
        }

        try {
          payload = parsePayload(data);
        } catch (parseError) {
          finishError(
            "返回数据格式错误",
            policyLabel(route)
          );

          return;
        }

        if (
          !payload ||
          typeof payload !== "object" ||
          !Array.isArray(
            payload.balance_infos
          )
        ) {
          finishError(
            "接口未返回有效余额数据",
            policyLabel(route)
          );

          return;
        }

        finishSuccess(
          payload,
          policyLabel(route)
        );
      }
    );
  }

  if (
    !API_KEY ||
    API_KEY === "replace_with_your_key"
  ) {
    finishError(
      "尚未配置 DeepSeek API Key",
      "未执行"
    );

    return;
  }

  globalTimer = setTimeout(function () {
    finishError(
      "整体请求超时",
      buildRoutes()
        .map(policyLabel)
        .join(" → ")
    );
  }, 10000);

  runAttempt(
    buildRoutes(),
    0,
    []
  );
})();