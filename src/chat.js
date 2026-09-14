/**
 * chat.js —— 聊天页（/web/geek/chat）的上下文捕获。
 *
 * 捕获链路（全部被动，零额外请求）：
 *   FRIEND_LIST  → 会话列表（拿到 HR 的 uid，用于判断消息方向）
 *   HISTORY_MSG  → 当前会话的历史消息
 *   BOSS_DATA    → 对方信息 + 当前岗位（含 lowSalary/highSalary）
 *
 * M1 只做「上下文采集 + 展示」；M4 起提供 ADVICE_CONTEXT 供面板生成回复建议。
 */
(function () {
  'use strict';

  const S = window.BossShared;
  if (!S) return;

  const state = {
    page: 'chat',
    friends: [],
    current: null, // { hrUid, name, company, title, job, messages }
    job: null,
    status: 'idle'
  };

  // 已上报过的「最后一条 HR 消息」mid。首次赋值只做基线，不触发自动建议，
  // 否则一进聊天页就自动生成，用户会莫名其妙被扣一次额度。
  let lastNotifiedMid = null;

  // ---------------------------------------------------------------- 岗位关联
  // HR 主动打招呼时 getBossData 里没有 job，此时用「最近查看过的职位」回填。
  // 用户路径：聊天页点「查看职位」→ /job_detail/?securityId=xxx → jobpage.js 抓取落盘 → 回到本页关联。
  const VIEW_KEY = 'bossoss_last_viewed_job_v1';
  const RECENT_WINDOW_MS = 30 * 60 * 1000;

  // bossId → getBossData 请求里的 securityId
  // ⚠️ 这是**会话标识**，不是岗位 securityId（docs/04 已标注）。
  // 但对「从聊天页点进职位详情」这条路径，两者同源，可用于精确匹配；匹配不上就走 30 分钟兜底。
  const securityCache = new Map();

  function viewToJob(v) {
    return {
      title: v.title || '',
      salaryText: v.salaryText || '',
      salaryMin: null,
      salaryMax: null,
      city: v.city || '',
      experience: v.experience || '',
      degree: v.degree || '',
      company: v.company || ''
    };
  }

  /**
   * 会话没有岗位时的兜底解析：
   *   ① securityId 精确命中最近查看的职位
   *   ② 30 分钟内最近查看的一条（标 recent，面板显示「推测关联」）
   */
  async function resolveJobFallback(bossId) {
    const sid = securityCache.get(bossId) || '';
    let data = null;
    try {
      data = await chrome.storage.local.get([VIEW_KEY]);
    } catch (_) {
      return null;
    }
    const views = (data && data[VIEW_KEY]) || [];
    if (!views.length) return null;

    if (sid) {
      const hit = views.find((v) => v.securityId && v.securityId === sid);
      if (hit) return { job: viewToJob(hit), from: 'viewed', at: hit.at || 0 };
    }

    const recent = views[0];
    if (recent && Date.now() - (recent.at || 0) <= RECENT_WINDOW_MS) {
      return { job: viewToJob(recent), from: 'recent', at: recent.at || 0 };
    }
    return null;
  }

  const bossDataCache = new Map(); // encryptBossId → {data, job}
  const historyCache = new Map(); // encryptBossId → messages[]

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || msg.__boss_oss !== true || msg.channel !== 'api' || !msg.ok) return;

    const json = S.API.parse(msg.body);
    const zp = S.API.dataOf(json);
    if (!S.API.OK(json) || !zp) return;

    if (msg.type === 'FRIEND_LIST') {
      const list = zp.result || zp.data || [];
      state.friends = list.map(S.parseFriend);
      state.status = 'ready';
      notify();
      return;
    }

    if (msg.type === 'BOSS_DATA') {
      const d = zp.data || {};
      const key = d.encryptBossId || '';
      if (key) {
        // 请求 URL 里带 securityId，用于与「最近查看的职位」精确匹配
        const sid = (msg.url || '').match(/securityId=([^&]+)/);
        if (sid) securityCache.set(key, decodeURIComponent(sid[1]));
        bossDataCache.set(key, { data: d, job: zp.job || null });
        trySelectCurrent(key);
      }
      notify();
      return;
    }

    if (msg.type === 'HISTORY_MSG') {
      // URL 里带 bossId，用它做 key
      const m = (msg.url || '').match(/bossId=([^&]+)/);
      const key = m ? decodeURIComponent(m[1]) : '';
      if (key) {
        historyCache.set(key, zp.messages || []);
        trySelectCurrent(key);
      }
      notify();
      return;
    }
  });

  function trySelectCurrent(bossId) {
    const friend = state.friends.find((f) => f.encryptBossId === bossId);
    const bd = bossDataCache.get(bossId);
    const history = historyCache.get(bossId);
    if (!friend && !bd) return;

    const job = bd && bd.job ? bd.job : null;

    // 会话没变、且之前是用「最近查看的职位」补上的 —— 必须保留。
    // 否则每次 HISTORY_MSG / BOSS_DATA 到达都会重建 state.current，把刚回填的岗位冲掉
    // （异步再解析回来之前，面板会闪一下「未识别岗位」）。
    const prev =
      state.current && state.current.encryptBossId === bossId ? state.current : null;
    const kept = !job && prev && prev.job && prev.jobFrom && prev.jobFrom !== 'boss' ? prev : null;

    state.current = {
      encryptBossId: bossId,
      hrUid: friend ? friend.uid : null,
      name: (bd && bd.data && bd.data.name) || (friend && friend.name) || '',
      title: (bd && bd.data && bd.data.title) || (friend && friend.title) || '',
      company: (bd && bd.data && bd.data.companyName) || (friend && friend.company) || '',
      job: job
        ? {
            title: job.jobName,
            salaryText: job.salaryDesc,
            salaryMin: job.lowSalary,
            salaryMax: job.highSalary,
            city: job.locationName,
            experience: job.experienceName,
            degree: job.degreeName,
            company: job.brandName
            }
            : kept
              ? kept.job
              : null,
              jobFrom: job ? 'boss' : kept ? kept.jobFrom : '',
              jobAt: job ? 0 : kept ? kept.jobAt : 0,
              messages: history ? S.parseMessages(history, friend ? friend.uid : null) : []
              };

            // 没有岗位（HR 主动打招呼）→ 用最近查看过的职位回填。
            // 存储读取是异步的，解析完必须再 notify 一次，否则面板停在「无岗位」的旧状态。
            if (!state.current.job) attachViewedJob(bossId);
            }

  function notify() {
    try {
      chrome.runtime.sendMessage({ type: 'BOSS_OSS_CHAT_STATE', state }).catch(() => {});
    } catch (_) {
      /* ignore */
    }
    notifyNewHrMessage();
  }

  /** 最后一条「HR 发的」消息（需要被回复的那一句）。 */
  function lastHrMessage() {
    const msgs = (state.current && state.current.messages) || [];
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (!msgs[i].mine) return msgs[i];
    }
    return null;
  }

  /**
   * 新 HR 消息检测：mid 变化才上报。
   * ⚠️ 只认「对方发的」—— 用自己的消息触发建议毫无意义。
   */
  function notifyNewHrMessage() {
    const last = lastHrMessage();
    if (!last || !last.mid) return;

    if (lastNotifiedMid === null) { lastNotifiedMid = last.mid; return; }
    if (last.mid === lastNotifiedMid) return;

    lastNotifiedMid = last.mid;
    try {
      chrome.runtime.sendMessage({
        type: 'BOSS_OSS_CHAT_NEW_MSG',
        bossId: (state.current && state.current.encryptBossId) || '',
        mid: last.mid
      }).catch(() => {});
    } catch (_) {
      /* ignore */
    }
  }

  /** 用「最近查看过的职位」补齐会话缺失的岗位。 */
  function attachViewedJob(bossId) {
    resolveJobFallback(bossId)
      .then((r) => {
        if (!r) return;
        // 解析期间用户可能已经切到别的会话
        if (!state.current || state.current.encryptBossId !== bossId) return;
        if (state.current.job) return;
        state.current.job = r.job;
        state.current.jobFrom = r.from;
        state.current.jobAt = r.at;
        notify();
      })
      .catch(() => {});
  }

  /** 生成回复建议所需的上下文（供面板直接转发给服务端）。 */
  function adviceContext() {
    const c = state.current;
    if (!c) return { ok: false, reason: '还没有打开会话' };
    const msgs = (c.messages || []).filter((m) => m.text && !m.jobCard);
    const last = lastHrMessage();
    return {
      ok: true,
      encryptBossId: c.encryptBossId || '',
      lastHrMid: (last && String(last.mid)) || '',
      job: S.jobKey(c.job || {}),
      // jobFrom 只是给面板渲染徽章用，服务端仍按四元组消费 job，不受影响
      jobFrom: c.jobFrom || '',
      jobAt: c.jobAt || 0,
      conversation: msgs.slice(-12).map((m) => ({ mine: !!m.mine, text: m.text }))
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.cmd === 'CHAT_STATE') {
      sendResponse({ ok: true, state });
      return false;
    }
    if (msg && msg.cmd === 'ADVICE_CONTEXT') {
      sendResponse(adviceContext());
      return false;
    }
    if (msg && msg.cmd === 'FILL_INPUT') {
      const res = fillInput(msg.text || '');
      sendResponse({ ok: res });
      return false;
    }
    return false;
  });

  // ------------------------------------------------ 一键填入聊天输入框
  /**
   * Boss 的输入框可能是 textarea 或 contenteditable，
   * 且通常受 React 受控组件管理 —— 直接改 value 不会触发 onChange，
   * 必须用原生 setter + input 事件。
   */
  function fillInput(text) {
    if (!text) return false;

    const selectors = [
      'textarea',
      '[contenteditable="true"]',
      '[class*="input"] textarea',
      '[class*="input"] [contenteditable="true"]'
    ];

    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (!isVisible(el)) continue;

        if (el.tagName === 'TEXTAREA') {
          const proto = Object.getPrototypeOf(el);
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, text);
          else el.value = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.focus();
          return true;
        }

        if (el.isContentEditable) {
          el.focus();
          const sel2 = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          sel2.removeAllRanges();
          sel2.addRange(range);
          document.execCommand('insertText', false, text);
          return true;
        }
      }
    }
    return false;
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 15;
  }

  notify();
  console.log('%c[Boss 求职助手] 聊天页已就绪', 'color:#4F5BD5;font-weight:bold');
})();
