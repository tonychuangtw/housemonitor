#!/usr/bin/env node
// leju.js — 抓樂居的社區完整實價登錄歷史 → leju.json（前端「上一手實登」配對用）
//
// 為什麼要樂居：政府實登 API 只回溯到 2023，更早買進的屋主查不到上一手；
// 樂居有全史（回溯到 2012），而且地址解析到戶（「121號9樓-8」），配對更準。
//
// 怎麼繞過登入牆（2026-08-04 實測）：
//   - 樂居有 Cloudflare，純 HTTP 403 → 走本機 camofox（:9377）開頁面，用頁面 context fetch API
//   - api/search/transactions 未登入每次只回最新 20 筆、page=2 起回空
//     → 用「日期視窗」當游標：date_end 設成上一批最舊那筆的月底，一路往回翻
//   - 單月成交 >20 筆會卡住（同視窗翻不動）→ 改按樓層(floor=N)逐層掃那個月
//   - 社區名→樂居 oid 用 api/easySearch
//
// 用法：node leju.js [--only <watchId>]   跑完自行 commit leju.json
// 節奏：每個 API call 之間 600–1500ms，別打太快。

const fs = require('fs');
const path = require('path');

const CAMOFOX = 'http://localhost:9377';
const USER_ID = 'housemonitor';
const SESSION_KEY = 'leju-fetch';
// 任何樂居頁都行，要的只是同源 context + 過 Cloudflare 的 cookie
const CONTEXT_URL = 'https://www.leju.com.tw/';
const OUT = path.join(__dirname, 'leju.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => sleep(600 + Math.random() * 900);

async function camofox(method, urlPath, body) {
  const res = await fetch(CAMOFOX + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`camofox ${method} ${urlPath} -> ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

async function getTab() {
  const tabs = await camofox('GET', `/tabs?userId=${USER_ID}`);
  const existing = (tabs.tabs || []).find((t) => t.sessionKey === SESSION_KEY || t.listItemId === SESSION_KEY);
  if (existing) return existing.tabId;
  const created = await camofox('POST', '/tabs', { userId: USER_ID, sessionKey: SESSION_KEY, url: CONTEXT_URL });
  await sleep(8000); // 等 Cloudflare challenge 過
  return created.tabId;
}

// 在樂居頁面 context 裡 fetch 一個 URL，回傳 parsed JSON
async function pageFetch(tabId, url) {
  const expr = `(async function(){var r=await fetch(${JSON.stringify(url)});var t=await r.text();return JSON.stringify({s:r.status,t:t.slice(0,300000)});})()`;
  const out = await camofox('POST', `/tabs/${tabId}/evaluate`, { userId: USER_ID, expression: expr });
  const wrapped = JSON.parse(out.result);
  if (wrapped.s !== 200) throw new Error(`leju API ${wrapped.s}: ${url.slice(0, 120)} -> ${wrapped.t.slice(0, 200)}`);
  return JSON.parse(wrapped.t);
}

function stripEm(s) { return String(s || '').replace(/<\/?em>/g, ''); }

// ROC "115/02" -> "2026-02"
function rocToIso(d) {
  const m = /^(\d+)\/(\d+)$/.exec(String(d || ''));
  if (!m) return null;
  return `${parseInt(m[1], 10) + 1911}-${m[2].padStart(2, '0')}`;
}

// "2026-02" 的月底 ISO 日期（拿來當下一輪 date_end）
function monthEnd(iso) {
  const [y, mo] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
}
function prevMonthEnd(iso) {
  const [y, mo] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 0)).toISOString().slice(0, 10);
}

// watchlist 的 info.lejuName / info.lejuUrl 是 Tony 驗證過的（07-26 樂居補的資料），優先採用：
// 樂居的社區名常跟 591 不同（「國王一號院」樂居叫「國王1號院」；「大悅」會誤中「佳順大悅」）
async function searchCommunity(tabId, item) {
  const wantId = item.info && item.info.lejuUrl ? (item.info.lejuUrl.match(/community\/(L[0-9a-f]+)/) || [])[1] : null;
  const keyword = (item.info && item.info.lejuName) || item.name;
  const j = await pageFetch(tabId, `https://api.leju.com.tw/api/easySearch?keyword=${encodeURIComponent(keyword)}&city_code&page=1&type=1`);
  const cands = (j.data || []).filter((d) => d.result_type === 1);
  if (!cands.length) return null;
  let hit = wantId ? cands.find((d) => d.result_id === wantId) : null;
  if (!hit) {
    const score = (d) => (d.city === item.cityName ? 2 : 0)
      + ((d.areas || []).some((a) => a.name === item.districtName) ? 4 : 0)
      + (stripEm(d.text).includes(keyword) ? 1 : 0);
    hit = cands.slice().sort((a, b) => score(b) - score(a))[0];
  }
  return {
    lejuId: hit.result_id,
    lejuName: stripEm(hit.text),
    cityCode: hit.city_code,
    postCode: (hit.areas && hit.areas[0] && hit.areas[0].post_code) || '',
    district: (hit.areas && hit.areas[0] && hit.areas[0].name) || '',
  };
}

function txUrl(c, name, { dateEnd, floor = 999 }) {
  return 'https://api.leju.com.tw/api/search/transactions?' + [
    `city_code=${c.cityCode}`,
    `city_name=`, // 站方帶中文城市名，實測留空也可
    `post_code=${c.postCode}`,
    `tag=11`,
    `tag_id=${c.lejuId}`,
    `text=${encodeURIComponent(name)}`,
    `building_type=0`,
    `date_start=2005-01-01`,
    `date_end=${dateEnd}`,
    `lower_total_price=0`, `upper_total_price=9999`,
    `lower_unit_price=0`, `upper_unit_price=999`,
    `lower_total_area_ping=0`, `upper_total_area_ping=999`,
    `lower_house_area_ping=0`, `upper_house_area_ping=999`,
    `lower_transaction_age=-10`, `upper_transaction_age=999`,
    `floor=${floor}`,
    `special_trade=1`,
    `sort_by=1`, `sort_method=2`,
    `page=1`, `per_page=20`, `sessionToken=`,
  ].join('&');
}

function dealKey(d) { return `${d.address}|${d.transaction_date}|${d.total_price}`; }

function normalize(d) {
  return {
    date: rocToIso(d.transaction_date),          // "2026-02"（實登只給到月）
    address: d.address,                           // 例 "七賢一路121號9樓-8" — 到戶
    floorNum: Array.isArray(d.floor) ? d.floor[0] : null,
    totalWan: d.total_price,                      // 萬，含車位
    parkWan: d.total_parking_price || 0,
    size: d.total_area_ping,                      // 坪，含車位（對齊 591 的坪數口徑）
    houseSize: d.house_area_ping,                 // 坪，不含車位
    parkSize: d.parking_area_ping || 0,
    unitPrice: d.unit_price_ping,                 // 萬/坪，不含車位
    special: d.is_special_trade === 1 ? 1 : 0,
    note: (d.note_transform || []).join('、'),
  };
}

async function fetchAllDeals(tabId, c, name) {
  const seen = new Map();
  let total = null;
  let dateEnd = new Date().toISOString().slice(0, 10);
  let guard = 0;
  while (guard++ < 80) {
    const j = await pageFetch(tabId, txUrl(c, name, { dateEnd }));
    await jitter();
    if (total == null) total = (j.meta && j.meta.total) || 0;
    const rows = j.data || [];
    let fresh = 0;
    for (const d of rows) { if (!seen.has(dealKey(d))) { seen.set(dealKey(d), d); fresh++; } }
    if (seen.size >= total || !rows.length) break;
    const oldest = rocToIso(rows[rows.length - 1].transaction_date);
    if (!oldest) break;
    const nextEnd = monthEnd(oldest);
    if (fresh === 0 || nextEnd === dateEnd) {
      // 視窗卡住：這個月成交 >20 筆 → 該月逐層掃，然後跳到前一個月
      const floors = new Set([...seen.values()].map((d) => Array.isArray(d.floor) ? d.floor[0] : 0));
      const maxFloor = Math.max(30, ...floors);
      for (let f = 1; f <= maxFloor; f++) {
        const jf = await pageFetch(tabId, txUrl(c, name, { dateEnd, floor: f }));
        await jitter();
        for (const d of (jf.data || [])) {
          if (rocToIso(d.transaction_date) === oldest && !seen.has(dealKey(d))) seen.set(dealKey(d), d);
        }
      }
      dateEnd = prevMonthEnd(oldest);
    } else {
      dateEnd = nextEnd;
    }
  }
  return { total, deals: [...seen.values()].map(normalize) };
}

async function main() {
  const onlyIdx = process.argv.indexOf('--only');
  const onlyId = onlyIdx > -1 ? process.argv[onlyIdx + 1] : null;

  const watchlist = JSON.parse(fs.readFileSync(path.join(__dirname, 'watchlist.json'), 'utf8'));
  let out = { updated: null, communities: {} };
  try { out = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (_) {}

  const tabId = await getTab();

  for (const item of watchlist.items || []) {
    if (!item.active) continue;
    if (onlyId && item.id !== onlyId) continue;
    process.stdout.write(`[leju] ${item.name} (${item.cityName}${item.districtName}) ... `);
    try {
      const c = await searchCommunity(tabId, item);
      await jitter();
      if (!c) { console.log('查無社區'); out.communities[item.id] = { name: item.name, error: 'leju 查無社區', fetchedAt: new Date().toISOString() }; continue; }
      const { total, deals } = await fetchAllDeals(tabId, c, (item.info && item.info.lejuName) || item.name);
      deals.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      out.communities[item.id] = {
        name: item.name, lejuId: c.lejuId, lejuName: c.lejuName,
        fetchedAt: new Date().toISOString(), total, deals,
      };
      console.log(`${c.lejuName} (${c.lejuId}) 抓到 ${deals.length}/${total} 筆`);
    } catch (err) {
      console.log(`失敗: ${err.message}`);
      const prev = out.communities[item.id];
      if (!prev || !prev.deals) out.communities[item.id] = { name: item.name, error: String(err.message), fetchedAt: new Date().toISOString() };
      // 有舊資料就保留舊資料
    }
  }

  // 清掉已不在 watchlist 的社區
  const ids = new Set((watchlist.items || []).map((i) => i.id));
  for (const k of Object.keys(out.communities)) if (!ids.has(k)) delete out.communities[k];

  out.updated = new Date().toISOString().replace('T', ' ').slice(0, 19);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`[done] leju.json 寫入完成 (${Object.keys(out.communities).length} 社區)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
