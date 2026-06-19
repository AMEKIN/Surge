// Surge Panel：网络出口检测
// 自动读取第一个策略组，并检测 DIRECT 与代理出口 IP

const API = "https://ipwho.is/";

function httpAPI(method, path, body = null) {
  return new Promise((resolve) => {
    $httpAPI(method, path, body, (result) => {
      resolve(result);
    });
  });
}

async function getFirstPolicyGroup() {
  try {
    const result = await httpAPI("GET", "/v1/policy_groups");

    const groups = Object.keys(result || {});

    // 排除一些明显不适合作为代理出口检测的组名
    const blacklist = ["DIRECT", "REJECT", "REJECT-DROP", "GLOBAL"];

    const usableGroups = groups.filter(name => !blacklist.includes(name));

    return usableGroups[0] || groups[0] || null;
  } catch (e) {
    return null;
  }
}

function queryIP(policy) {
  return new Promise((resolve) => {
    const start = Date.now();

    $httpClient.get(
      {
        url: API,
        policy,
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
            org: json.connection?.org || "未知组织",
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
    return `${title}
策略：${info.policy}
状态：失败
错误：${info.error}
延迟：${info.ms}ms`;
  }

  return `${title}
策略：${info.policy}
IP：${info.ip}
位置：${info.country} ${info.region} ${info.city}
ISP：${info.isp}
组织：${info.org}
延迟：${info.ms}ms`;
}

async function main() {
  const proxyPolicy = await getFirstPolicyGroup();

  if (!proxyPolicy) {
    $done({
      title: "网络出口检测",
      content: "未能读取到 Surge 策略组。\n请检查 Surge HTTP API 是否可用。",
      style: "error"
    });
    return;
  }

  const [direct, proxy] = await Promise.all([
    queryIP("DIRECT"),
    queryIP(proxyPolicy)
  ]);

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
  } else if (direct.ok && !proxy.ok) {
    mode = "代理检测失败";
    style = "error";
  } else if (!direct.ok && proxy.ok) {
    mode = "直连检测失败，代理检测成功";
    style = "info";
  } else {
    mode = "全部检测失败";
    style = "error";
  }

  const content = [
    `当前策略组：${proxyPolicy}`,
    `当前路径：${mode}`,
    "",
    formatInfo("本地直连出口", direct),
    "",
    formatInfo("代理出口检测", proxy)
  ].join("\n");

  $done({
    title: "网络出口检测",
    content,
    style
  });
}

main();
