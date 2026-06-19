// Surge Panel：网络出口检测 Enhanced
// 功能：
// 1. 自动读取 Surge 策略组
// 2. 自动选择最像“主代理”的策略组
// 3. 检测 DIRECT 出口 IP
// 4. 检测代理组出口 IP
// 5. 显示当前是否直连 / 代理中转
// 6. 显示 IP 大概位置、ISP、组织、查询延迟

const PANEL_TITLE = "网络出口检测";

// 优先匹配这些关键词的策略组
// 你可以按自己的配置继续补充，比如 “日本故障转移”、“香港智能组”
const PREFERRED_KEYWORDS = [
  "FINAL",
  "Final",
  "代理",
  "Proxy",
  "PROXY",
  "手动",
  "选择",
];

// 不适合作为主代理出口检测的组
const EXCLUDE_KEYWORDS = [
  "Apple",
  "苹果",
  "Microsoft",
  "微软",
  "Google",
  "YouTube",
  "Telegram",
  "Netflix",
  "Disney",
  "TikTok",
  "Bilibili",
  "哔哩",
  "广告",
  "AdBlock",
  "Domestic",
  "China",
  "中国",
  "直连",
  "下载",
];

// 多个 IP 查询接口并发，哪个最快用哪个
const IP_APIS = [
  {
    name: "Cloudflare Trace",
    url: "https://www.cloudflare.com/cdn-cgi/trace",
    type: "text",
    parse: function (text) {
      const obj = {};
      text.split("\n").forEach(line => {
        const index = line.indexOf("=");
        if (index > -1) {
          obj[line.slice(0, index)] = line.slice(index + 1);
        }
      });

      return {
        ip: obj.ip,
        country: obj.loc || "未知国家",
        region: "",
        city: obj.colo ? `CF-${obj.colo}` : "",
        isp: "Cloudflare Trace",
        org: obj.colo ? `Cloudflare Colo: ${obj.colo}` : "Cloudflare"
      };
    }
  },
  {
    name: "ip-api",
    url: "http://ip-api.com/json/?lang=zh-CN&fields=status,message,country,regionName,city,isp,org,query",
    type: "json",
    parse: function (json) {
      if (json.status && json.status !== "success") {
        throw new Error(json.message || "ip-api 查询失败");
      }

      return {
        ip: json.query,
        country: json.country,
        region: json.regionName,
        city: json.city,
        isp: json.isp,
        org: json.org
      };
    }
  },
  {
    name: "ip.sb",
    url: "https://api.ip.sb/geoip",
    type: "json",
    parse: function (json) {
      return {
        ip: json.ip,
        country: json.country,
        region: json.region,
        city: json.city,
        isp: json.isp,
        org: json.organization || json.asn_organization || ""
      };
    }
  },
  {
    name: "ipify",
    url: "https://api.ipify.org?format=json",
    type: "json",
    parse: function (json) {
      return {
        ip: json.ip,
        country: "仅 IP 检测",
        region: "",
        city: "",
        isp: "未知 ISP",
        org: "ipify fallback"
      };
    }
  }
];

function httpAPI(method, path, body) {
  return new Promise((resolve) => {
    try {
      $httpAPI(method, path, body || null, (result) => {
        resolve(result || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function normalizeGroups(result) {
  if (!result) return [];

  // 常见情况：{ "策略组A": [...], "策略组B": [...] }
  if (typeof result === "object" && !Array.isArray(result)) {
    return Object.keys(result);
  }

  // 兜底情况：[{"name":"xxx"}] 或 ["xxx"]
  if (Array.isArray(result)) {
    return result.map((item) => {
      if (typeof item === "string") return item;
      if (item && item.name) return item.name;
      return null;
    }).filter(Boolean);
  }

  return [];
}

function scoreGroupName(name) {
  let score = 0;

  for (const keyword of PREFERRED_KEYWORDS) {
    if (name.includes(keyword)) score += 10;
  }

  for (const keyword of EXCLUDE_KEYWORDS) {
    if (name.includes(keyword)) score -= 20;
  }

  // 太像规则分流组的，降低优先级
  if (/Apple|Google|Telegram|Netflix|Disney|TikTok|Bilibili|Microsoft/i.test(name)) {
    score -= 30;
  }

  return score;
}

async function getBestPolicyGroup() {
  const groupsResult = await httpAPI("GET", "/v1/policy_groups", null);
  const groups = normalizeGroups(groupsResult);

  if (!groups.length) {
    return {
      group: null,
      selected: null,
      allGroups: []
    };
  }

  const sorted = groups
    .map((name, index) => ({
      name,
      index,
      score: scoreGroupName(name)
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    });

  const bestGroup = sorted[0].name;

  let selected = null;
  const selectedResult = await httpAPI(
    "GET",
    "/v1/policy_groups/select?group_name=" + encodeURIComponent(bestGroup),
    null
  );

  if (selectedResult && selectedResult.policy) {
    selected = selectedResult.policy;
  }

  return {
    group: bestGroup,
    selected,
    allGroups: groups
  };
}

function requestOneAPI(api, policy) {
  return new Promise((resolve) => {
    const start = Date.now();

    const option = {
      url: api.url,
      timeout: 4,
      headers: {
        "User-Agent": "Surge Network Path Panel"
      }
    };

    if (policy) {
      option.policy = policy;
    }

    $httpClient.get(option, (error, response, data) => {
      const ms = Date.now() - start;

      if (error) {
        resolve({
          ok: false,
          api: api.name,
          policy,
          error: String(error),
          ms
        });
        return;
      }

      try {
        const parsed = api.type === "text"
          ? api.parse(data)
          : api.parse(JSON.parse(data));

        if (!parsed || !parsed.ip) {
          resolve({
            ok: false,
            api: api.name,
            policy,
            error: "接口返回中没有 IP",
            ms
          });
          return;
        }

        resolve({
          ok: true,
          api: api.name,
          policy,
          ip: parsed.ip || "未知",
          country: parsed.country || "未知国家",
          region: parsed.region || "",
          city: parsed.city || "",
          isp: parsed.isp || "未知 ISP",
          org: parsed.org || "未知组织",
          ms
        });
      } catch (e) {
        resolve({
          ok: false,
          api: api.name,
          policy,
          error: "解析失败：" + e.message,
          ms
        });
      }
    });
  });
}

function queryIP(policy) {
  return new Promise((resolve) => {
    let finished = false;
    let failed = [];
    let pending = IP_APIS.length;

    for (const api of IP_APIS) {
      requestOneAPI(api, policy).then((result) => {
        if (finished) return;

        if (result.ok) {
          finished = true;
          resolve(result);
          return;
        }

        failed.push(result);
        pending -= 1;

        if (pending <= 0) {
          finished = true;
          resolve({
            ok: false,
            policy,
            error: failed.map(x => `${x.api}: ${x.error}`).join("\n"),
            ms: Math.max.apply(null, failed.map(x => x.ms || 0))
          });
        }
      });
    }
  });
}

function formatLocation(info) {
  const arr = [info.country, info.region, info.city].filter(Boolean);
  return arr.length ? arr.join(" ") : "未知位置";
}

function formatInfo(title, info) {
  if (!info.ok) {
    return `${title}
状态：失败
错误：${info.error || "未知错误"}
延迟：${info.ms || "-"}ms`;
  }

  return `${title}
IP：${info.ip}
位置：${formatLocation(info)}
ISP：${info.isp}
组织：${info.org}
接口：${info.api}
延迟：${info.ms}ms`;
}

async function main() {
  const policyInfo = await getBestPolicyGroup();
  const proxyGroup = policyInfo.group;
  const selectedPolicy = policyInfo.selected;

  if (!proxyGroup) {
    const directOnly = await queryIP("DIRECT");

    $done({
      title: PANEL_TITLE,
      content: [
        "当前路径：无法读取策略组",
        "说明：只完成了本地直连检测。",
        "",
        formatInfo("本地直连出口", directOnly)
      ].join("\n"),
      style: "error"
    });
    return;
  }

  const directPromise = queryIP("DIRECT");

  // 重点：这里使用自动识别到的真实策略组名，不再写死 PROXY
  const proxyPromise = queryIP(proxyGroup);

  const results = await Promise.all([directPromise, proxyPromise]);
  const direct = results[0];
  const proxy = results[1];

  let mode = "未知";
  let style = "info";

  if (direct.ok && proxy.ok) {
    if (direct.ip === proxy.ip) {
      mode = "直连 / 代理未生效";
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

  const selectedText = selectedPolicy
    ? `当前子策略：${selectedPolicy}`
    : "当前子策略：自动组 / 非手动选择组 / 未返回";

  const content = [
    `当前路径：${mode}`,
    `检测策略组：${proxyGroup}`,
    selectedText,
    "",
    formatInfo("本地直连出口", direct),
    "",
    formatInfo("代理出口检测", proxy)
  ].join("\n");

  $done({
    title: PANEL_TITLE,
    content,
    style
  });
}

main();
