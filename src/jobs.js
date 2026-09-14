/**
 * jobs.js —— 岗位页（/web/geek/jobs）的抓取编排。
 *
 * 为什么放在 content script 而不是 service worker：
 *   MV3 的 SW 空闲 30s 会被休眠，抓 30 份 JD 的任务会被杀掉。
 *
 * 数据来源（三级降级）：
 *   1. 接口旁路捕获（最准，含 securityId，可自动抓 JD）
 *   2. DOM 兜底（搜索页 SSR 时用；无 securityId，JD 需另想办法）
 *   3. 用户点开卡片时页面自己发的详情请求 —— 白捡一份
 */
(function () {
  'use strict';

  const S = window.BossShared;
  if (!S) return;

  const LIMIT = {
    perRun: 30,
    perDay: 200,
    minDelayMs: 1000, // 正常间隔 0.5–2s
    maxDelayMs: 3000,
    backoffMs: 4000, // 出错后的退避基准
    maxBackoffMs: 15000,
    maxConsecutiveErrors: 3
  };

  const state = {
    page: 'jobs',
    jobs: [],
    status: 'idle', // idle | scraping | done | error
    progress: { total: 0, done: 0, ok: 0, failed: 0, current: '', errors: [] },
    lastError: '',
    source: 'none', // api | dom | none
    diag: [], // 最近捕获的 /wapi/ 端点（仅 URL + 体积）
    quota: { usedToday: 0, date: todayKey() }
  };

  const pendingDetail = new Map();
  let scraping = false;
  let domTimer = null;

  function todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  // ------------------------------------------------------------ 持久化
  // 页面跳转 / 刷新会销毁 content script 的内存状态，所以岗位必须落盘。
  // chrome.storage.local 配额 10MB，按每条约 6KB 估算可存 ~1000 条，这里保守取 500。
  const STORE_KEY = 'bossoss_jobs_v1';
  const MAX_STORED = 500;
  const MAX_JD_CHARS = 10000;
  let saveTimer = null;

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 600);
  }

  async function saveNow() {
    const trimmed = state.jobs
      .slice()
      .sort((a, b) => (b.collectedAt || 0) - (a.collectedAt || 0))
      .slice(0, MAX_STORED)
      .map((j) => ({ ...j, jdRaw: (j.jdRaw || '').slice(0, MAX_JD_CHARS) }));

    try {
      await chrome.storage.local.set({ [STORE_KEY]: trimmed, jobsSavedAt: Date.now() });
    } catch (_) {
      // 配额超限：丢掉最早的一半再存一次
      const keep = trimmed.slice(0, Math.floor(trimmed.length / 2));
      state.jobs = keep;
      try {
        await chrome.storage.local.set({ [STORE_KEY]: keep, jobsSavedAt: Date.now() });
      } catch (e2) {
        console.warn('[Boss] 持久化失败', e2);
      }
    }
  }

  /** 启动时恢复历史记录；已解析过的保持 jdFetched，不会被重复解析 */
  async function loadStored() {
    try {
      const data = await chrome.storage.local.get([STORE_KEY]);
      const list = data[STORE_KEY] || [];
      for (const j of list) {
        if (!j || !j.key) continue;
        const idx = state.jobs.findIndex((x) => x.key === j.key);
        if (idx >= 0) {
          // 已解析状态以「内存优先」，避免覆盖刚抓到的 JD
          Object.assign(state.jobs[idx], j, { jdFetched: state.jobs[idx].jdFetched || !!j.jdFetched });
        } else {
          state.jobs.push(j);
        }
      }
      if (list.length) state.source = state.source === 'none' ? 'store' : state.source;
    } catch (_) {
      /* ignore */
    }
  }

  // ------------------------------------------------------------ 被动：捕获
  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || msg.__boss_oss !== true) return;

    if (msg.channel === 'diag') {
      state.diag.push({ url: msg.url, size: msg.size, t: Date.now() });
      if (state.diag.length > 60) state.diag.shift();
      return;
    }

    if (msg.channel === 'api' && msg.type === 'JOB_LIST' && msg.ok) {
      const json = S.API.parse(msg.body);
      const zp = S.API.dataOf(json);
      if (!S.API.OK(json)) return;
      const list = (zp && (zp.jobList || zp.joblist || zp.list || (zp.data && zp.data.list))) || [];
      if (!list.length) return;
      mergeList(list);
      state.source = 'api';
      scheduleSave();
      notify();
      return;
    }

    if (msg.channel === 'api' && msg.type === 'JOB_DETAIL' && msg.ok) {
      const json = S.API.parse(msg.body);
      const zp = S.API.dataOf(json);
      if (!S.API.OK(json) || !zp || !zp.jobInfo) return;
      attachDetail(zp);
      scheduleSave();
      notify();
      return;
    }

    if (msg.channel === 'cmd') {
      const key = pendingDetail.get(msg.requestId);
      pendingDetail.delete(msg.requestId);
      if (!key) return;
      const job = state.jobs.find((j) => j.key === key);
      if (job) {
        if (msg.ok) {
          const json = S.API.parse(msg.body);
          const zp = S.API.dataOf(json);
          if (S.API.OK(json) && zp && zp.jobInfo) {
            // ⚠️ 详情响应里的 securityId 是新值，不能覆盖原值（否则重试会失效）
            const keepSecurityId = job.securityId;
            Object.assign(job, S.parseJobDetail(zp));
            job.securityId = keepSecurityId;
            job.jdFetched = true;
            job.jdFetchedAt = Date.now();
            state.progress.ok = (state.progress.ok || 0) + 1;
            scheduleSave();
          } else {
            job.jdError = 'JD 解析失败';
            state.progress.failed = (state.progress.failed || 0) + 1;
          }
        } else {
          job.jdError = msg.error || '请求失败';
          state.progress.failed = (state.progress.failed || 0) + 1;
          state.progress.errors.push({ title: job.title, error: job.jdError });
        }
      }
      notify();
    }
  });

  function mergeList(list) {
    for (const raw of list) {
      const job = S.parseJobListItem(raw);
      if (!job.title && !job.company) continue;
      job.key = S.dedupeKey(job);
      // 默认不勾选：勾选只用于 AI 分析 / 导出等批处理，避免一进来就全选
      job.checked = false;
      job.collectedAt = Date.now();

      const idx = state.jobs.findIndex((j) => j.key === job.key);
      if (idx >= 0) {
        const old = state.jobs[idx];
        // 已有条目：补全字段，但保留已抓到的 JD 与勾选状态
        Object.assign(old, {
          securityId: old.securityId || job.securityId,
          encryptJobId: old.encryptJobId || job.encryptJobId,
          skills: old.skills.length ? old.skills : job.skills,
          source: 'api'
        });
      } else {
        state.jobs.push({ ...job, jdFetched: false });
      }
    }
  }

  function attachDetail(zp) {
    const detail = S.parseJobDetail(zp);
    const key = [detail.company, detail.title, detail.city, detail.salaryText].join('|');
    const job =
      state.jobs.find((j) => j.key === key) ||
      state.jobs.find((j) => j.encryptJobId && j.encryptJobId === detail.encryptJobId);
    if (job) {
      const keepSecurityId = job.securityId || detail.securityId;
      Object.assign(job, detail);
      job.securityId = keepSecurityId;
      job.jdFetched = true;
      job.jdFetchedAt = Date.now();
    }
  }

  // ------------------------------------------------- DOM 兜底（搜索页 SSR）
  function scanDom() {
    if (state.source === 'api') return; // 接口可用就不走 DOM
    const cards = S.parseDomJobCards(document);
    if (!cards.length) return;

    let added = 0;
    for (const job of cards) {
      job.key = S.dedupeKey(job);
      if (state.jobs.some((j) => j.key === job.key)) continue;
      job.jdFetched = false;
      job.checked = false;
      job.collectedAt = Date.now();
      state.jobs.push(job);
      added++;
    }
    if (added) {
      state.source = 'dom';
      scheduleSave();
      notify();
    }
  }

  // 首次 1s 后扫一次，之后每 3s 扫（列表是懒加载的）
  setTimeout(scanDom, 1000);
  domTimer = setInterval(scanDom, 3000);
  // 用户滚动/翻页时补扫
  window.addEventListener('scroll', () => scanDom(), { passive: true });

  // ------------------------------------------------------------ 主动：抓 JD
  function requestDetail(job, requestId) {
    pendingDetail.set(requestId, job.key);
    window.postMessage(
      { __bossCmd: 'FETCH_JOB_DETAIL', requestId, securityId: job.securityId },
      '*'
    );
  }

  async function scrape() {
    if (scraping) return { started: false, reason: '已有任务在进行' };

    // 「解析全部」名副其实：不看勾选状态。
    // 勾选只作用于 AI 分析 / 导出等批处理；解析是主流程，不该因为没勾选就点不动。
    const all = state.jobs;
    // 「JD 未抓取」= 还没成功解析过的都算（含上次失败的，自动重试）
    const targets = all.filter((j) => !j.jdFetched && j.securityId);
    targets.forEach((j) => (j.jdError = ''));
    const noSecurity = all.filter((j) => !j.jdFetched && !j.securityId).length;

    if (!targets.length) {
      return {
        started: false,
        reason: noSecurity
          ? `没有可解析的岗位（${noSecurity} 条缺少标识，请滚动页面或翻页后再试）`
          : '没有待抓取的岗位'
      };
    }

    const quota = await loadQuota();
    const room = LIMIT.perDay - quota.usedToday;
    if (room <= 0) {
      state.status = 'error';
      state.lastError = `今日额度已用完（${LIMIT.perDay} 条）`;
      notify();
      return { started: false, reason: state.lastError };
    }

    const queue = targets.slice(0, Math.min(LIMIT.perRun, room));
    scraping = true;
    state.status = 'scraping';
    state.lastError = '';
    state.progress = { total: queue.length, done: 0, ok: 0, failed: 0, current: '', errors: [] };
    notify();

    let used = 0;
    let consecutive = 0;

    for (const job of queue) {
      state.progress.current = `${job.company} · ${job.title}`;
      notify();

      const before = state.progress.failed;
      requestDetail(job, S.uid());

      // 等待该条结果落地（轮询，最长 15s）
      await waitFor(() => job.jdFetched || job.jdError, 15000, 100);
      used++;
      state.progress.done = used;

      const failedNow = state.progress.failed > before;
      if (failedNow) {
        consecutive++;
      } else {
        consecutive = 0;
      }

      // 连续失败 → 退避，避免撞上风控
      if (consecutive >= LIMIT.maxConsecutiveErrors) {
        state.lastError = '连续失败，已暂停。可能触发了平台限流，请稍后再试。';
        state.status = 'error';
        notify();
        break;
      }

      await saveQuota(quota.usedToday + used);
      notify();

      if (used < queue.length) {
        const wait =
          consecutive > 0
            ? Math.min(LIMIT.maxBackoffMs, LIMIT.backoffMs * consecutive)
            : S.rand(LIMIT.minDelayMs, LIMIT.maxDelayMs);
        await S.sleep(wait);
      }
    }

    scraping = false;
    state.status = state.progress.failed ? 'done' : 'done';
    state.progress.current = '';
    notify();
    return { started: true, count: used, ok: state.progress.ok, failed: state.progress.failed };
  }

  function waitFor(predicate, timeoutMs, stepMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        let done = false;
        try {
          done = !!predicate();
        } catch (_) {
          done = false;
        }
        if (done || Date.now() - start > timeoutMs) return resolve(done);
        setTimeout(tick, stepMs);
      };
      tick();
    });
  }

  async function loadQuota() {
    const data = await chrome.storage.local.get('quota');
    const q = data.quota;
    if (!q || q.date !== todayKey()) return { usedToday: 0, date: todayKey() };
    return q;
  }

  async function saveQuota(usedToday) {
    const q = { usedToday, date: todayKey() };
    state.quota = q;
    await chrome.storage.local.set({ quota: q });
  }

  // ------------------------------------------------------------ 对外通信
  function notify() {
    try {
      chrome.runtime.sendMessage({ type: 'BOSS_OSS_STATE', state }).catch(() => {});
    } catch (_) {
      /* ignore */
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg && msg.cmd) {
      case 'STATE':
        sendResponse({ ok: true, state });
        return false;

      case 'SCRAPE':
        scrape().then((r) => sendResponse({ ok: true, ...r }));
        return true;

      case 'RESCAN_DOM':
        scanDom();
        sendResponse({ ok: true, count: state.jobs.length });
        return false;

      case 'TOGGLE': {
        const job = state.jobs.find((j) => j.key === msg.key);
        if (job) job.checked = msg.checked;
        sendResponse({ ok: true });
        scheduleSave();
        notify();
        return false;
      }
      case 'TOGGLE_ALL': {
        // 传 keys 时只作用于当前筛选视图，避免误选用户看不见的条目
        if (Array.isArray(msg.keys)) {
          const set = new Set(msg.keys);
          state.jobs.forEach((j) => {
            if (set.has(j.key)) j.checked = msg.checked;
          });
        } else {
          state.jobs.forEach((j) => (j.checked = msg.checked));
        }
        sendResponse({ ok: true });
        scheduleSave();
        notify();
        return false;
      }
      case 'CLEAR':
        state.jobs = [];
        state.status = 'idle';
        state.source = 'none';
        state.progress = { total: 0, done: 0, ok: 0, failed: 0, current: '', errors: [] };
        chrome.storage.local.remove([STORE_KEY]).catch(() => {});
        sendResponse({ ok: true });
        notify();
        return false;
      default:
        return false;
    }
  });

  // 先恢复历史记录再对外广播，面板一打开就能看到之前解析过的岗位
  loadStored().then(() => {
    notify();
    console.log(
      `%c[Boss 求职助手] 岗位页已就绪，已恢复 ${state.jobs.length} 条历史记录`,
      'color:#4F5BD5;font-weight:bold'
    );
  });
})();
