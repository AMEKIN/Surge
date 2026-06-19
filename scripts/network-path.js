// 修改成你 Surge 里的策略组名称
const PROXY_POLICY = "PROXY";

// IP 查询接口
const API = "https://ipwho.is/";

function queryIP(policy) {
  return new Promise((resolve) => {
    const start = Date.now();

    $httpClient.get(
      {
        url: API,
        policy: policy,
        timeout: 8,
        headers: {
          "User-Agent": "Surge Network Path Panel"
        }
      },
      (error, response, data) => {
        const ms = Date.now() - start;

        if (error) {
          resolve({
            policy,
            ok: false,
            error: String(error),
            ms
          });
          return;
        }

        try {
          const json = JSON.parse(data);

          resolve({
            policy,
            ok: true,
            ip: json.ip || "未知",
            country: json.country || "未知国家",
            region: json.region || "未知地区",
            city: json.city || "未知城市",
            isp: json.connection?.isp || "未知 ISP",
            org: json.connection?.org || "",
            timezone: json.timezone?.id || "",
            ms
          });
        } catch (e) {
          resolve({
            policy,
            ok: false,
            error: "IP 信息解析失败",
            ms
          });
        }
      }
    );
  });
}

function formatInfo(title, info) {
  if (!info.ok) {
    return `${title}\n状态：失败\n错误：${info.error}\n延迟：${info.ms}ms`;
  }

  return `${title}
IP：${info.ip}
位置：${info.country} ${info.region} ${info.city}
ISP：${info.isp}
组织：${info.org || "未知"}
延迟：${info.ms}ms`;
}

Promise.all([
  queryIP("DIRECT"),
  queryIP(PROXY_POLICY)
]).then(([direct, proxy]) => {
  let mode = "未知";
  let style = "info";

  if (direct.ok && proxy.ok) {
    if (direct.ip === proxy.ip) {
      mode = "直连 / 未经过代理";
      style = "alert";
    } else {
      mode = "代理 / 中转";
      style = "good";
    }
  } else if (proxy.ok) {
    mode = "代理检测成功，直连检测失败";
    style = "info";
  } else {
    mode = "检测失败";
    style = "error";
  }

  const content = [
    `当前路径：${mode}`,
    "",
    formatInfo("本地直连出口", direct),
    "",
    formatInfo(`代理出口：${PROXY_POLICY}`, proxy)
  ].join("\n");

  $done({
    title: "网络出口检测",
    content,
    style
  });
});
