// Surge Panel：网络出口检测 Stable Group
// 功能：
// 1. 读取该策略组当前正在使用的子策略 / 节点
// 2. 检测时使用“最深层可用策略组”，避免直接使用节点名导致 Policy doesn't exist
// 3. 显示本地直连出口、代理出口、位置、ISP、接口延迟

const PANEL_TITLE = "网络出口检测";

// 如果你想固定检测某个策略组，可以在这里填写完整策略组名。
// 例如：const TARGET_GROUP = "🇯🇵 日本故障转移";
// 留空则自动识别。
const TARGET_GROUP = "FINAL";

// 优先匹配的主代理策略组关键词
const PREFERRED_KEYWORDS = [
  "代理",
  "Proxy",
  "PROXY",
  "节点",
  "手动",
  "选择",
  "故障",
  "转移",
  "智能",
  "Smart",
  "香港",
  "日本",
  "台湾",
  "新加坡",
  "美国",
  "Final",
  "FINAL"
];

// 排除明显不是主代理出口的策略组
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
  "下载"
];

// 顺序检测，只成功请求一个接口，避免多接口并发导致自动组切换
const IP_APIS = [
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
    name: "Cloudflare Trace",
    url: "https://www.cloudflare.com/cdn-cgi/trace",
    type: "text",
    parse: function (text) {
      const obj = {};
      text.split("\n").forEach(function (line) {
        const index = line.indexOf("=");
        if (index > -1) {
          obj[line.slice(0, index)] = line.slice(index + 1);
        }
      });

      return {
        ip: obj.ip,
        country: obj.loc || "未知国家",
        region: "",
        city: obj.colo ? "CF-" + obj.colo : "",
        isp: "Cloudflare Trace",
        org: obj.colo ? "Cloudflare Colo: " + obj.colo : "Cloudflare"
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
  return new Promise(function (resolve) {
    try {
      $httpAPI(method, path, body || null, function (result) {
        resolve(result || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function normalizeGroups(result) {
  if (!result) return [];

  if (typeof result === "object" && !Array.isArray(result)) {
    return Object.keys(result);
  }

  if (Array.isArray(result)) {
    return result.map(function (item) {
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
    if (name.indexOf(keyword) !== -1) score += 10;
  }

  for (const keyword of EXCLUDE_KEYWORDS) {
    if (name.indexOf(keyword) !== -1) score -= 20;
  }

  if (/Apple|Google|Telegram|Netflix|Disney|TikTok|Bilibili|Microsoft/i.test(name)) {
    score -= 30;
  }

  return score;
}

function getSelectedFromResult(result) {
  if (!result) return null;

  if (typeof result === "string") {
    return result;
  }

  return result.policy ||
    result.selected ||
    result.current ||
    result.now ||
    result.name ||
    null;
}

async function getTargetPolicyGroup() {
  const groupsResult = await httpAPI("GET", "/v1/policy_groups", null);
  const groups = normalizeGroups(groupsResult);

  if (!groups.length) {
    return {
      targetGroup: null,
      checkPolicy: null,
      currentUsing: null,
      allGroups: []
    };
  }

  if (TARGET_GROUP && groups.indexOf(TARGET_GROUP) !== -1) {
    const resolved = await resolveUsablePolicy(TARGET_GROUP, groups);

    return {
      targetGroup: TARGET_GROUP,
      checkPolicy: resolved.checkPolicy,
      currentUsing: resolved.currentUsing,
      allGroups: groups
    };
  }

  const sorted = groups
    .map(function (name, index) {
      return {
        name,
        index,
        score: scoreGroupName(name)
      };
    })
    .sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    });

  const targetGroup = sorted[0].name;
  const resolved = await resolveUsablePolicy(targetGroup, groups);

  return {
    targetGroup,
    checkPolicy: resolved.checkPolicy,
    currentUsing: resolved.currentUsing,
    allGroups: groups
  };
}

// 重点逻辑：
// 一直向下读取当前选中项。
// 如果选中项还是策略组，就继续往下。
// 如果选中项已经是具体节点，就停止。
// 检测时使用“最后一个真实存在的策略组”，不直接使用具体节点名。
async function resolveUsablePolicy(startGroup, allGroups) {
  const groupSet = {};
  allGroups.forEach(function (name) {
    groupSet[name] = true;
  });

  let currentGroup = startGroup;
  let checkPolicy = startGroup;
  let currentUsing = null;
  const visited = {};

  for (let i = 0; i < 10; i++) {
    if (!currentGroup || visited[currentGroup]) break;
    visited[currentGroup] = true;

    const result = await httpAPI(
      "GET",
      "/v1/policy_groups/select?group_name=" + encodeURIComponent(currentGroup),
      null
    );

    const selected = getSelectedFromResult(result);

    if (!selected) {
      currentUsing = currentGroup;
      checkPolicy = currentGroup;
      break;
    }

    currentUsing = selected;

    if (groupSet[selected]) {
      checkPolicy = selected;
      currentGroup = selected;
      continue;
    }

    // selected 已经是具体节点名。
    // 不把它作为 policy 使用，只显示它。
    break;
  }

  return {
    checkPolicy,
    currentUsing
  };
}

function requestOneAPI(api, policy) {
  return new Promise(function (resolve) {
    const start = Date.now();

    const option = {
      url: api.url,
      timeout: 5,
      headers: {
        "User-Agent": "Surge Network Path Panel"
      }
    };

    if (policy) {
      option.policy = policy;
    }

    $httpClient.get(option, function (error, response, data) {
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

async function queryIP(policy) {
  const failed = [];

  for (const api of IP_APIS) {
    const result = await requestOneAPI(api, policy);

    if (result.ok) {
      return result;
    }

    failed.push(result);
  }

  return {
    ok: false,
    policy,
    error: failed.map(function (x) {
      return x.api + ": " + x.error;
    }).join("\n"),
    ms: Math.max.apply(null, failed.map(function (x) {
      return x.ms || 0;
    }))
  };
}

async function queryProxyIP(checkPolicy, fallbackPolicy) {
  let result = await queryIP(checkPolicy);

  if (result.ok) {
    return result;
  }

  const err = result.error || "";

  if (
    fallbackPolicy &&
    fallbackPolicy !== checkPolicy &&
    err.indexOf("doesn't exist") !== -1
  ) {
    const fallbackResult = await queryIP(fallbackPolicy);

    if (fallbackResult.ok) {
      fallbackResult.policy = fallbackPolicy;
      fallbackResult.note = "已回退到顶层策略组检测";
      return fallbackResult;
    }
  }

  return result;
}

function formatLocation(info) {
  const arr = [info.country, info.region, info.city].filter(Boolean);
  return arr.length ? arr.join(" ") : "未知位置";
}

function formatInfo(title, info) {
  if (!info.ok) {
    return title + "\n" +
      "状态：失败\n" +
      "错误：" + (info.error || "未知错误") + "\n" +
      "延迟：" + (info.ms || "-") + "ms";
  }

  return title + "\n" +
    "IP：" + info.ip + "\n" +
    "位置：" + formatLocation(info) + "\n" +
    "ISP：" + info.isp + "\n" +
    "组织：" + info.org + "\n" +
    "接口：" + info.api + "\n" +
    "延迟：" + info.ms + "ms";
}

async function main() {
  const policyInfo = await getTargetPolicyGroup();

  const targetGroup = policyInfo.targetGroup;
  const checkPolicy = policyInfo.checkPolicy;
  const currentUsing = policyInfo.currentUsing;

  if (!targetGroup || !checkPolicy) {
    const directOnly = await queryIP("DIRECT");

    $done({
      title: PANEL_TITLE,
      content: [
        "当前路径：无法读取策略组",
        "",
        formatInfo("本地直连出口", directOnly)
      ].join("\n"),
      style: "error"
    });
    return;
  }

  const directPromise = queryIP("DIRECT");
  const proxyPromise = queryProxyIP(checkPolicy, targetGroup);

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

  const content = [
    "当前路径：" + mode,
    "检测策略组：" + targetGroup,
    "当前使用：" + (currentUsing || checkPolicy),
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
