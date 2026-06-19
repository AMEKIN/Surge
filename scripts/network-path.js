// Surge Panel：网络出口检测 Fixed Leaf Policy
// 功能：
// 1. 自动读取 Surge 策略组
// 2. 自动选择最像“主代理”的策略组
// 3. 解析该策略组当前正在使用的最终节点
// 4. 固定使用最终节点检测代理出口 IP，避免刷新时来回切换节点
// 5. 检测 DIRECT 出口 IP
// 6. 显示当前是否直连 / 代理中转
// 7. 显示 IP 大概位置、ISP、组织、查询延迟

const PANEL_TITLE = "网络出口检测";

// 优先匹配这些关键词的策略组
// 注意：FINAL 如果只是最终规则组，可以保留；如果不是代理选择组，建议删掉 FINAL
const PREFERRED_KEYWORDS = [
  "FINAL",
  "Final",
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
  "美国"
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
  "下载"
];

// 顺序检测，避免并发请求导致策略组/负载均衡切换
const IP_APIS = [
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

  // 常见情况：{ "策略组A": [...], "策略组B": [...] }
  if (typeof result === "object" && !Array.isArray(result)) {
    return Object.keys(result);
  }

  // 兜底情况：[{"name":"xxx"}] 或 ["xxx"]
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

  // 兼容不同 Surge 版本/返回字段
  return result.policy ||
    result.selected ||
    result.current ||
    result.now ||
    result.name ||
    null;
}

async function getBestPolicyGroup() {
  const groupsResult = await httpAPI("GET", "/v1/policy_groups", null);
  const groups = normalizeGroups(groupsResult);

  if (!groups.length) {
    return {
      group: null,
      selected: null,
      finalPolicy: null,
      chain: [],
      allGroups: []
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

  const bestGroup = sorted[0].name;
  const resolved = await resolveFinalPolicy(bestGroup, groups);

  return {
    group: bestGroup,
    selected: resolved.selected,
    finalPolicy: resolved.finalPolicy,
    chain: resolved.chain,
    allGroups: groups
  };
}

// 递归解析：策略组 -> 当前子策略 -> 如果还是策略组继续解析 -> 最终节点
async function resolveFinalPolicy(startGroup, allGroups) {
  const groupSet = {};
  allGroups.forEach(function (name) {
    groupSet[name] = true;
  });

  let current = startGroup;
  let selected = null;
  let finalPolicy = startGroup;
  const chain = [startGroup];
  const visited = {};

  for (let i = 0; i < 10; i++) {
    if (!current || visited[current]) break;
    visited[current] = true;

    const result = await httpAPI(
      "GET",
      "/v1/policy_groups/select?group_name=" + encodeURIComponent(current),
      null
    );

    const next = getSelectedFromResult(result);

    if (!next) {
      finalPolicy = current;
      break;
    }

    if (!selected) {
      selected = next;
    }

    chain.push(next);

    // 如果 next 不是策略组名，说明它大概率已经是最终节点名
    if (!groupSet[next]) {
      finalPolicy = next;
      break;
    }

    // 如果 next 还是策略组，继续往下解析
    current = next;
    finalPolicy = next;
  }

  return {
    selected,
    finalPolicy,
    chain
  };
}

function requestOneAPI(api, policy) {
  return new Promise(function (resolve) {
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

// 顺序 fallback：先 Cloudflare，再 ip-api，再 ip.sb，再 ipify
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
  const policyInfo = await getBestPolicyGroup();
  const proxyGroup = policyInfo.group;
  const firstSelected = policyInfo.selected;
  const finalPolicy = policyInfo.finalPolicy;
  const chain = policyInfo.chain || [];

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

  // 关键修改：
  // 这里不再使用 proxyGroup，而是使用最终解析出来的 finalPolicy。
  // 这样可以固定检测当前正在使用的节点，避免每次刷新都触发策略组重新选择。
  const proxyPromise = queryIP(finalPolicy);

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

  const selectedText = firstSelected
    ? "当前子策略：" + firstSelected
    : "当前子策略：未返回";

  const finalText = finalPolicy
    ? "固定检测节点：" + finalPolicy
    : "固定检测节点：未解析";

  const chainText = chain.length
    ? "策略链路：" + chain.join(" → ")
    : "策略链路：未解析";

  const content = [
    "当前路径：" + mode,
    "检测策略组：" + proxyGroup,
    selectedText,
    finalText,
    chainText,
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
