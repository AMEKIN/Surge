// Surge Panel：DNS 状态 V4
// 点击面板右侧刷新后，对 AliDNS 与 DNSPod 发起真实 DoH 查询。

(function () {
  "use strict";

  var PANEL_TITLE = "DNS 状态";
  var TEST_DOMAIN = "www" + ".apple" + ".com";
  var TIMEOUT_SECONDS = 6;

  var SERVERS = [
    {
      name: "AliDNS",
      url: "https://dns.alidns.com/dns-query"
    },
    {
      name: "DNSPod",
      url: "https://doh.pub/dns-query"
    }
  ];

  var remaining = SERVERS.length;
  var results = {};
  var completed = {};
  var ended = false;
  var watchdog = null;

  function pad(value) {
    return value < 10 ? "0" + value : String(value);
  }

  function nowText() {
    var now = new Date();
    return pad(now.getHours()) + ":" + pad(now.getMinutes());
  }

  function toBase64Url(bytes) {
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var output = "";
    var index = 0;

    while (index < bytes.length) {
      var a = bytes[index++];
      var hasB = index < bytes.length;
      var b = hasB ? bytes[index++] : 0;
      var hasC = index < bytes.length;
      var c = hasC ? bytes[index++] : 0;

      output += chars.charAt(a >> 2);
      output += chars.charAt(((a & 3) << 4) | (b >> 4));
      output += hasB ? chars.charAt(((b & 15) << 2) | (c >> 6)) : "=";
      output += hasC ? chars.charAt(c & 63) : "=";
    }

    return output
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  function buildDnsQuery(domain) {
    var bytes = [];
    var id = Math.floor(Math.random() * 65536);
    var labels = domain.split(".");
    var i;
    var j;

    bytes.push((id >> 8) & 255, id & 255);
    bytes.push(1, 0);
    bytes.push(0, 1);
    bytes.push(0, 0);
    bytes.push(0, 0);
    bytes.push(0, 0);

    for (i = 0; i < labels.length; i++) {
      if (!labels[i] || labels[i].length > 63) {
        throw new Error("invalid domain");
      }

      bytes.push(labels[i].length);

      for (j = 0; j < labels[i].length; j++) {
        bytes.push(labels[i].charCodeAt(j) & 255);
      }
    }

    bytes.push(0);
    bytes.push(0, 1);
    bytes.push(0, 1);

    return toBase64Url(bytes);
  }

  function markDone(serverName, result) {
    if (completed[serverName]) {
      return;
    }

    completed[serverName] = true;
    results[serverName] = result;
    remaining -= 1;

    if (remaining <= 0) {
      finish();
    }
  }

  function requestDns(server) {
    var startedAt;
    var url;

    try {
      url = server.url + "?dns=" + encodeURIComponent(buildDnsQuery(TEST_DOMAIN));
      startedAt = new Date().getTime();

      $httpClient.get(
        {
          url: url,
          headers: {
            "Accept": "application/dns-message"
          },
          timeout: TIMEOUT_SECONDS,
          policy: "DIRECT"
        },
        function (error, response, data) {
          var elapsed = Math.max(0, new Date().getTime() - startedAt);
          var status = response && response.status ? Number(response.status) : 0;

          if (error || status !== 200) {
            markDone(server.name, {
              ok: false,
              text: error ? "失败" : (status ? "HTTP " + status : "无响应")
            });
            return;
          }

          markDone(server.name, {
            ok: true,
            text: Math.round(elapsed) + "ms",
            delay: elapsed
          });
        }
      );
    } catch (error) {
      markDone(server.name, {
        ok: false,
        text: "脚本异常"
      });
    }
  }

  function finish() {
    var success = 0;
    var failed = 0;
    var maxDelay = 0;
    var parts = [];
    var i;
    var item;
    var style = "good";

    if (ended) {
      return;
    }

    ended = true;

    if (watchdog) {
      clearTimeout(watchdog);
    }

    for (i = 0; i < SERVERS.length; i++) {
      item = results[SERVERS[i].name] || {
        ok: false,
        text: "超时"
      };

      parts.push(SERVERS[i].name + " " + item.text);

      if (item.ok) {
        success += 1;

        if (item.delay > maxDelay) {
          maxDelay = item.delay;
        }
      } else {
        failed += 1;
      }
    }

    if (success === 0) {
      style = "error";
    } else if (failed > 0 || maxDelay > 120) {
      style = "alert";
    }

    if (maxDelay > 250) {
      style = "error";
    }

    $done({
      title: PANEL_TITLE,
      content: [
        parts.join(" · "),
        "DoH 直连测试",
        "更新：" + nowText()
      ].join("\n"),
      style: style
    });
  }

  watchdog = setTimeout(function () {
    var i;

    for (i = 0; i < SERVERS.length; i++) {
      if (!completed[SERVERS[i].name]) {
        markDone(SERVERS[i].name, {
          ok: false,
          text: "超时"
        });
      }
    }
  }, 8000);

  SERVERS.forEach(requestDns);
})();
