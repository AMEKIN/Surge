// Surge Panel：网络出口检测（紧凑稳定版）
// 展示：路径 / 当前节点 / 直连与代理的地区、平均延迟、抖动、丢包

const PANEL_TITLE = "网络出口检测";
const TARGET_GROUP = "FINAL";

// 保留 3 次采样；请在 [Script] 中设置 timeout=15。
const SAMPLE_COUNT = 3;
const SAMPLE_INTERVAL_MS = 80;
const REQUEST_TIMEOUT = 4;
const WATCHDOG_MS = 14000;

const PREFERRED_KEYWORDS = [
  "代理", "Proxy", "PROXY", "节点", "手动", "选择", "故障", "转移",
  "智能", "Smart", "香港", "日本", "台湾", "新加坡", "美国", "Final", "FINAL"
];

const EXCLUDE_KEYWORDS = [
  "Apple", "苹果", "Microsoft", "微软", "Google", "YouTube", "Telegram",
  "Netflix", "Disney", "TikTok", "Bilibili", "哔哩", "广告", "AdBlock",
  "Domestic", "China", "中国", "直连", "下载"
];

// 先使用 ip-api；失败时才回退，避免每次刷新产生不必要的并发请求。
const IP_APIS = [
  {
    name: "ip-api",
    url: "http://ip-api.com/json/?lang=zh-CN&fields=status,message,country,regionName,city,query",
    type: "json",
    parse(json) {
      if (json.status && json.status !== "success") {
        throw new Error(json.message || "ip-api 查询失败");
      }
      return {
        ip: json.query,
        country: json.country || "",
        region: json.regionName || "",
        city: json.city || ""
      };
    }
  },
  {
    name: "ip.sb",
    url: "https://api.ip.sb/geoip",
    type: "json",
    parse(json) {
      return {
        ip: json.ip,
        country: json.country || "",
        region: json.region || "",
        city: json.city || ""
      };
    }
  },
  {
    name: "Cloudflare Trace",
    url: "https://www.cloudflare.com/cdn-cgi/trace",
    type: "text",
    parse(text) {
      const obj = {};
      text.split("\n").forEach((line) => {
        const index = line.indexOf("=");
        if (index > -1) obj[line.slice(0, index)] = line.slice(index + 1);
      });
      return {
        ip: obj.ip,
        country: obj.loc || "",
        region: "",
        city: obj.colo ? "CF-" + obj.colo : ""
      };
    }
  },
  {
    name: "ipify",
    url: "https://api.ipify.org?format=json",
    type: "json",
    parse(json) {
      return { ip: json.ip, country: "", region: "", city: "" };
    }
  }
];

const QUALITY_TEST_URL = "http://connectivitycheck.gstatic.com/generate_204";

let finished = false;
let watchdog = null;

function finish(payload) {
  if (finished) return;
  finished = true;
  if (watchdog) clearTimeout(watchdog);
  $done(payload);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freshURL(url) {
  const separator = url.indexOf("?") === -1 ? "?" : "&";
  return url + separator + "_surge_panel=" + Date.now() + Math.floor(Math.random() * 1000);
}

function formatClock() {
  const now = new Date();
  const pad = (num) => String(num).padStart(2, "0");
  return pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds());
}

function httpAPI(method, path, body) {
  return new Promise((resolve) => {
    try {
      $httpAPI(method, path, body || null, (result) => resolve(result || null));
    } catch (_) {
      resolve(null);
    }
  });
}

function normalizeGroups(result) {
  if (!result) return [];
  if (typeof result === "object" && !Array.isArray(result)) return Object.keys(result);
  if (Array.isArray(result)) {
    return result.map((item) => {
      if (typeof item === "string") return item;
      return item && item.name ? item.name : null;
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
  if (typeof result === "string") return result;
  return result.policy || result.selected || result.current || result.now || result.name || null;
}

async function getTargetPolicyGroup() {
  const groupsResult = await httpAPI("GET", "/v1/policy_groups", null);
  const groups = normalizeGroups(groupsResult);

  if (!groups.length) {
    return { targetGroup: null, checkPolicy: null, currentUsing: null };
  }

  const targetGroup = TARGET_GROUP && groups.indexOf(TARGET_GROUP) !== -1
    ? TARGET_GROUP
    : groups
      .map((name, index) => ({ name, index, score: scoreGroupName(name) }))
      .sort((a, b) => b.score !== a.score ? b.score - a.score : a.index - b.index)[0].name;

  const resolved = await resolveUsablePolicy(targetGroup, groups);
  return {
    targetGroup,
    checkPolicy: resolved.checkPolicy,
    currentUsing: resolved.currentUsing
  };
}

async function resolveUsablePolicy(startGroup, allGroups) {
  const groupSet = {};
  allGroups.forEach((name) => { groupSet[name] = true; });

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
    break;
  }

  return { checkPolicy, currentUsing };
}

function requestOneAPI(api, policy) {
  return new Promise((resolve) => {
    const start = Date.now();
    const option = {
      url: freshURL(api.url),
      timeout: REQUEST_TIMEOUT,
      headers: {
        "User-Agent": "Surge Network Path Panel",
        "Cache-Control": "no-cache"
      }
    };

    if (policy) option.policy = policy;

    $httpClient.get(option, (error, response, data) => {
      const ms = Date.now() - start;
      if (error) {
        resolve({ ok: false, api: api.name, error: String(error), ms });
        return;
      }

      try {
        const parsed = api.type === "text" ? api.parse(data) : api.parse(JSON.parse(data));
        if (!parsed || !parsed.ip) {
          resolve({ ok: false, api: api.name, error: "接口未返回 IP", ms });
          return;
        }
        resolve({ ok: true, api: api.name, ms, ...parsed });
      } catch (error) {
        resolve({ ok: false, api: api.name, error: "解析失败：" + error.message, ms });
      }
    });
  });
}

async function queryIP(policy) {
  const failed = [];
  for (const api of IP_APIS) {
    const result = await requestOneAPI(api, policy);
    if (result.ok) return result;
    failed.push(result);
  }

  return {
    ok: false,
    error: failed.map((item) => item.api + "：" + item.error).join("；"),
    ms: Math.max.apply(null, failed.map((item) => item.ms || 0))
  };
}

async function queryProxyIP(checkPolicy, fallbackPolicy) {
  const result = await queryIP(checkPolicy);
  if (result.ok) return result;

  // 仅在子策略名称不可直接调用时，回退到顶层策略组。
  if (
    fallbackPolicy &&
    fallbackPolicy !== checkPolicy &&
    /doesn't exist|not exist|不存在/i.test(result.error || "")
  ) {
    return queryIP(fallbackPolicy);
  }
  return result;
}

function qualityProbe(policy) {
  return new Promise((resolve) => {
    const start = Date.now();
    const option = {
      url: freshURL(QUALITY_TEST_URL),
      timeout: REQUEST_TIMEOUT,
      headers: {
        "User-Agent": "Surge Network Quality Panel",
        "Cache-Control": "no-cache"
      }
    };
    if (policy) option.policy = policy;

    $httpClient.get(option, (error, response) => {
      const ms = Date.now() - start;
      if (error) {
        resolve({ ok: false, ms, error: String(error) });
        return;
      }
      const status = response ? response.status : 0;
      resolve(status >= 200 && status < 400
        ? { ok: true, ms }
        : { ok: false, ms, error: "HTTP " + status });
    });
  });
}

async function testNetworkQuality(policy) {
  const samples = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    samples.push(await qualityProbe(policy));
    if (i < SAMPLE_COUNT - 1) await sleep(SAMPLE_INTERVAL_MS);
  }

  const success = samples.filter((item) => item.ok);
  const lossRate = Math.round(((samples.length - success.length) / samples.length) * 100);
  if (!success.length) return { ok: false, lossRate };

  const times = success.map((item) => item.ms);
  const min = Math.min.apply(null, times);
  const max = Math.max.apply(null, times);
  const avg = Math.round(times.reduce((total, value) => total + value, 0) / times.length);

  return { ok: true, avg, jitter: max - min, lossRate };
}

function cleanPlace(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/[臺台]灣省?/g, "台湾")
    .replace(/^Taiwan$/i, "台湾")
    .replace(/^China$/i, "中国")
    .replace(/市$/, "")
    .trim();
}

function compactLocation(info) {
  let country = cleanPlace(info.country);
  let region = cleanPlace(info.region);
  let city = cleanPlace(info.city);

  if (country === "中国" && /台湾/.test(region + city)) country = "台湾";
  if (region === country) region = "";
  if (city === country || city === region) city = "";

  const parts = [country, region, city].filter(Boolean);
  return parts.length ? parts.slice(0, 2).join("·") : (info.ip || "未知位置");
}

function compactPolicyName(name) {
  const text = String(name || "未知策略");
  return text.length > 23 ? text.slice(0, 22) + "…" : text;
}

function compactMetrics(quality) {
  if (!quality || !quality.ok) return "测速失败";
  return quality.avg + "ms / 抖" + quality.jitter + " / 丢" + quality.lossRate + "%";
}

function formatExitLine(label, info, quality) {
  if (!info || !info.ok) {
    return label + "：检测失败" + (info && info.ms ? " · " + info.ms + "ms" : "");
  }
  return label + "：" + compactLocation(info) + " · " + compactMetrics(quality);
}

async function main() {
  const policyInfo = await getTargetPolicyGroup();
  const targetGroup = policyInfo.targetGroup;
  const checkPolicy = policyInfo.checkPolicy;
  const currentUsing = policyInfo.currentUsing;

  if (!targetGroup || !checkPolicy) {
    const [direct, quality] = await Promise.all([
      queryIP("DIRECT"),
      testNetworkQuality("DIRECT")
    ]);
    finish({
      title: PANEL_TITLE,
      content: "路径：无法读取策略组 · " + formatClock() + "\n" + formatExitLine("直连", direct, quality),
      style: "error"
    });
    return;
  }

  const [direct, proxy, directQuality, proxyQuality] = await Promise.all([
    queryIP("DIRECT"),
    queryProxyIP(checkPolicy, targetGroup),
    testNetworkQuality("DIRECT"),
    testNetworkQuality(checkPolicy)
  ]);

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
    mode = "直连检测失败";
    style = "alert";
  } else {
    mode = "全部检测失败";
    style = "error";
  }

  finish({
    title: PANEL_TITLE,
    content: [
      "路径：" + mode + " · " + targetGroup + " · " + formatClock(),
      "节点：" + compactPolicyName(currentUsing || checkPolicy),
      formatExitLine("直连", direct, directQuality),
      formatExitLine("代理", proxy, proxyQuality)
    ].join("\n"),
    style
  });
}

watchdog = setTimeout(() => {
  finish({
    title: PANEL_TITLE,
    content: "刷新超时，请再次点击刷新",
    style: "error"
  });
}, WATCHDOG_MS);

main().catch((error) => {
  finish({
    title: PANEL_TITLE,
    content: "脚本错误：" + (error && error.message ? error.message : String(error)),
    style: "error"
  });
});
