// Surge Panel：DNS 状态 V3
// 功能：
// 1. 对两个 DoH 服务发送真实 DNS 查询。
// 2. 显示实际请求往返时间。
// 3. 不依赖 Surge 未公开结构的 /v1/test/dns_delay 返回数据。
// 4. 默认测试 AliDNS 与 DNSPod，均使用 DIRECT 路径。

(function () {
"use strict";

var PANEL_TITLE = "DNS 状态";
var TEST_DOMAIN = "[www.apple.com](http://www.apple.com)";
var TIMEOUT_SECONDS = 6;
var TEST_POLICY = "DIRECT";

var DNS_SERVERS = [
{
name: "AliDNS",
url: "https://dns.alidns.com/dns-query"
},
{
name: "DNSPod",
url: "https://doh.pub/dns-query"
}
];

var results = [];
var pending = DNS_SERVERS.length;
var finished = false;
var watchdog;

function pad(number) {
return number < 10 ? "0" + number : String(number);
}

function formatTime() {
var now = new Date();
return pad(now.getHours()) + ":" + pad(now.getMinutes());
}

function base64Url(bytes) {
var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var output = "";
var i = 0;

```
while (i < bytes.length) {
  var a = bytes[i++];
  var b = i < bytes.length ? bytes[i++] : -1;
  var c = i < bytes.length ? bytes[i++] : -1;

  output += chars.charAt(a >> 2);
  output += chars.charAt(((a & 3) << 4) | (b >= 0 ? b >> 4 : 0));
  output += b >= 0
    ? chars.charAt(((b & 15) << 2) | (c >= 0 ? c >> 6 : 0))
    : "=";
  output += c >= 0
    ? chars.charAt(c & 63)
    : "=";
}

return output
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/g, "");
```

}

function buildDnsQuery(domain) {
var bytes = [];
var id = Math.floor(Math.random() * 65536);
var labels = domain.split(".");

```
// Header：递归查询、1 个问题、A 记录。
bytes.push((id >> 8) & 255, id & 255);
bytes.push(1, 0);
bytes.push(0, 1);
bytes.push(0, 0);
bytes.push(0, 0);
bytes.push(0, 0);

for (var i = 0; i < labels.length; i++) {
  var label = labels[i];

  if (!label || label.length > 63) {
    throw new Error("测试域名无效");
  }

  bytes.push(label.length);

  for (var j = 0; j < label.length; j++) {
    bytes.push(label.charCodeAt(j) & 255);
  }
}

bytes.push(0);
bytes.push(0, 1);
bytes.push(0, 1);

return base64Url(bytes);
```

}

function makeQueryUrl(baseUrl, dnsQuery) {
return baseUrl + (baseUrl.indexOf("?") >= 0 ? "&" : "?") + "dns=" + encodeURIComponent(dnsQuery);
}

function shortError(error, response) {
if (error) {
if (typeof error === "string") return "连接失败";
return "请求失败";
}

```
if (response && response.status) {
  return "HTTP " + response.status;
}

return "无响应";
```

}

function testDnsServer(server, callback) {
var query;
var startedAt;

```
try {
  query = buildDnsQuery(TEST_DOMAIN);
  startedAt = Date.now();

  $httpClient.get(
    {
      url: makeQueryUrl(server.url, query),
      headers: {
        Accept: "application/dns-message"
      },
      timeout: TIMEOUT_SECONDS,
      policy: TEST_POLICY
    },
    function (error, response, data) {
      var elapsed = Math.max(0, Date.now() - startedAt);

      if (error || !response || Number(response.status) !== 200) {
        callback({
          name: server.name,
          ok: false,
          reason: shortError(error, response)
        });

        return;
      }

      callback({
        name: server.name,
        ok: true,
        delay: elapsed
      });
    }
  );
} catch (error) {
  callback({
    name: server.name,
    ok: false,
    reason: "脚本异常"
  });
}
```

}

function currentSystemDns() {
try {
if ($network && Array.isArray($network.dns) && $network.dns.length) {
return $network.dns.slice(0, 2).join(" · ");
}
} catch (error) {}

```
return "未读取";
```

}

function finish() {
if (finished) return;

```
finished = true;

if (watchdog) clearTimeout(watchdog);

var successItems = results.filter(function (item) {
  return item.ok;
});

var failedItems = results.filter(function (item) {
  return !item.ok;
});

var testLine = results.map(function (item) {
  return item.ok
    ? item.name + " " + item.delay + "ms"
    : item.name + " 失败";
}).join(" · ");

var style = "good";

if (successItems.length === 0) {
  style = "error";
} else if (failedItems.length > 0) {
  style = "alert";
} else {
  var maxDelay = Math.max.apply(null, successItems.map(function (item) {
    return item.delay;
  }));

  if (maxDelay > 250) {
    style = "error";
  } else if (maxDelay > 120) {
    style = "alert";
  }
}

$done({
  title: PANEL_TITLE,
  content: [
    testLine,
    "系统 DNS：" + currentSystemDns(),
    "更新：" + formatTime()
  ].join("\n"),
  style: style
});
```

}

function completeOne(result) {
results.push(result);
pending -= 1;

```
if (pending <= 0) {
  finish();
}
```

}

watchdog = setTimeout(function () {
while (pending > 0) {
completeOne({
name: DNS_SERVERS[results.length]
? DNS_SERVERS[results.length].name
: "DNS",
ok: false,
reason: "超时"
});
}
}, (TIMEOUT_SECONDS + 2) * 1000);

DNS_SERVERS.forEach(function (server) {
testDnsServer(server, completeOne);
});
})();
