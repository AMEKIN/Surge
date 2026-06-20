// Surge Panel：DNS 缓存清理 V3
// 点击此面板右侧刷新按钮，执行一次 Surge DNS 缓存清理。

(function () {
"use strict";

var finished = false;
var watchdog;

function pad(number) {
return number < 10 ? "0" + number : String(number);
}

function formatTime() {
var now = new Date();
return pad(now.getHours()) + ":" + pad(now.getMinutes());
}

function errorText(result) {
if (!result) return "";

```
if (typeof result === "object" && result.error) {
  if (typeof result.error === "string") {
    return result.error;
  }

  return "接口返回错误";
}

return "";
```

}

function finish(result) {
if (finished) return;

```
finished = true;

if (watchdog) clearTimeout(watchdog);

var error = errorText(result);

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
  content: "已执行 · " + formatTime() + "\n缓存会随新请求自动重建",
  style: "good"
});
```

}

watchdog = setTimeout(function () {
finish({
error: "执行超时"
});
}, 6500);

try {
// 注意：$httpAPI 使用 v1/... 路径，不带开头的 /。
$httpAPI("POST", "v1/dns/flush", {}, function (result) {
finish(result);
});
} catch (error) {
finish({
error: "调用失败"
});
}
})();
