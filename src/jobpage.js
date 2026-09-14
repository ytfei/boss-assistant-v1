/**
 * jobpage.js —— 职位详情页（/job_detail/）抓取。
 *
 * 解决的场景：HR 主动打招呼时，聊天页 getBossData 里没有岗位。
 * 用户点聊天窗口的「查看职位」跳到这里，本脚本接住页面自己发出的详情请求，
 * 落进岗位收集箱，并返回聊天时由 chat.js 关联回会话。
 *
 * 数据来源（与 jobs.js 一致的三级降级思路，这里两级）：
 *   1. 接口旁路捕获 JOB_DETAIL（最准，含 JD 全文）
 *   2. DOM 兜底（接口没拦到时；仍能拿到标题/薪资/JD 文本）
 *
 * ⚠️ 不主动发任何请求 —— 详情页自己会请求 detail.json，我们只是旁听。
 */
(function () {
  'use strict';

  const S = window.BossShared;
  if (!S) return;

  // 与 jobs.js 严格对齐（改这里必须同步改 jobs.js）
  const STORE_KEY = 'bossoss_jobs_v1';
  const MAX_STORED = 500;
  const MAX_JD_CHARS = 10000;
  // 最近查看：只留几条，供聊天页快速关联（收集箱被清空也能兜底）
  const VIEW_KEY = 'bossoss_last_viewed_job_v1';
  const MAX_VIEWS = 10;
  // 接口没来就退回 DOM，避免 MutationObserver 常驻
  const DOM_FALLBACK_MS = 4000;

  const state = {
    captured: false,
    source: '', // api | dom | ''
    job: null,
    at: 0,
    securityId: urlSecurityId(),
    encryptJobId: pathJobId()
  };

  // ------------------------------------------------------------ URL 解析
  /**
   * ⚠️ 这里刻意用 location.search 里的 securityId，而不是详情响应里的。
   *
   * 详情响应（zpData.securityId）返回的是**下一次请求的新凭证**（jobs.js 里已有同款警告）。
   * 而在本页我们没有列表侧原值，且要与「聊天页点进来的那个链接」对齐，
   * 所以取 URL 上的那个 —— 它与聊天页 查看职位 链接里的 securityId 同源。
   */
  function urlSecurityId() {
    try {
      return new URL(location.href).searchParams.get('securityId') || '';
    } catch (_) {
      return '';
    }
  }

  function pathJobId() {
    const m = (location.pathname || '').match(/\/job_detail\/([^.?]+)/);
    return m ? m[1] : '';
  }

  function pageJobUrl() {
    return state.encryptJobId
      ? `https://www.zhipin.com/job_detail/${state.encryptJobId}.html`
      : location.href.split('?')[0];
  }

  // ------------------------------------------------------------ 建记录
  /** 补上 parseJobDetail 不产出、但收集箱需要的字段（尤其 jobUrl：CSV 导出要用）。 */
  function buildJob(base) {
    const jdRaw = String((base && base.jdRaw) || '').slice(0, MAX_JD_CHARS);
    const job = Object.assign({}, base || {}, {
      jdRaw,
      jd: (base && base.jd) || S.parseJD(jdRaw),
      jobUrl: (base && base.jobUrl) || pageJobUrl(),
      encryptJobId: (base && base.encryptJobId) || state.encryptJobId || '',
      // 详情页没有列表侧原值，统一用 URL 上的 securityId
      securityId: state.securityId || (base && base.securityId) || '',
      source: 'detail',
      collectedAt: Date.now(),
      checked: false
    });
    job.key = S.dedupeKey(job);
    if (jdRaw) {
      job.jdFetched = true;
      job.jdFetchedAt = Date.now();
    } else {
      job.jdFetched = false;
    }
    return job;
  }

  // ------------------------------------------------------------ DOM 兜底
  function parseDom() {
    const pick = (sels) => {
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (el && el.textContent && el.textContent.trim()) return el.textContent.trim();
      }
      return '';
    };
    const title = pick(['.job-title', 'h1', '[class*="job-title"]']);
    if (!title) return null;

    const jdParts = Array.from(
      document.querySelectorAll('.job-sec-text, .detail-content, [class*="job-sec-text"]')
    )
      .map((n) => (n.innerText || '').trim())
      .filter(Boolean);

    return buildJob({
      title,
      salaryText: pick(['.salary', '[class*="salary"]']),
      company: pick(['.company-info a', '.company-name', '[class*="company-name"]']),
      city: pick(['.text-city', '[class*="location"]']),
      experience: pick(['.text-experience', '[class*="experience"]']),
      degree: pick(['.text-degree', '[class*="degree"]']),
      jdRaw: jdParts.join('\n\n'),
      jd: null
    });
  }

  // ------------------------------------------------------------ 落盘
  /**
   * ⚠️ 收集箱是**整表覆盖写**（jobs.js 的 saveNow 也是）。
   * 必须先 get 全表 → 按 key 去重合并 → 整体 set，绝不能只写自己这一条。
   */
  async function persist(job) {
    const data = await chrome.storage.local.get([STORE_KEY]);
    const list = Array.isArray(data[STORE_KEY]) ? data[STORE_KEY].slice() : [];

    const idx = list.findIndex(
      (j) =>
        j &&
        (j.key === job.key ||
          (job.encryptJobId && j.encryptJobId && j.encryptJobId === job.encryptJobId))
    );

    if (idx >= 0) {
      // 已有条目：这些字段必须保住，Object.assign 之后再写回去
      // - securityId：详情响应里的是新凭证，覆盖会让这条记录以后重抓失效
      // - collectedAt：首次采集时间，排序/裁剪/「新」标记都依赖它
      // - checked：用户已经勾过的不该被重置
      const keepSecurityId = list[idx].securityId || job.securityId;
      const keepCollectedAt = list[idx].collectedAt || job.collectedAt;
      const keepChecked = !!list[idx].checked;
      Object.assign(list[idx], job);
      list[idx].securityId = keepSecurityId;
      list[idx].collectedAt = keepCollectedAt;
      list[idx].checked = keepChecked;
      // jdFetched 不下降
      list[idx].jdFetched = !!list[idx].jdFetched || job.jdFetched;
    } else {
      list.unshift(job);
    }

    const trimmed = list
      .slice()
      .sort((a, b) => (b.collectedAt || 0) - (a.collectedAt || 0))
      .slice(0, MAX_STORED)
      .map((j) => ({ ...j, jdRaw: (j.jdRaw || '').slice(0, MAX_JD_CHARS) }));

    await chrome.storage.local.set({ [STORE_KEY]: trimmed, jobsSavedAt: Date.now() });

    // 最近查看（最新在前）
    const vd = await chrome.storage.local.get([VIEW_KEY]);
    const views = Array.isArray(vd[VIEW_KEY]) ? vd[VIEW_KEY].slice() : [];
    views.unshift({
      securityId: state.securityId,
      encryptJobId: state.encryptJobId,
      key: job.key,
      title: job.title || '',
      company: job.company || '',
      salaryText: job.salaryText || '',
      city: job.city || '',
      experience: job.experience || '',
      degree: job.degree || '',
      jobUrl: job.jobUrl || '',
      hasJd: !!job.jdRaw,
      at: Date.now()
    });
    await chrome.storage.local.set({ [VIEW_KEY]: views.slice(0, MAX_VIEWS) });
  }

  function statePayload() {
    return {
      ok: true,
      captured: state.captured,
      source: state.source,
      at: state.at,
      securityId: state.securityId,
      job: state.job
        ? {
            // key 让面板能回查收集箱拿 jdRaw，避免把整份 JD 塞进消息里
            key: state.job.key || '',
            title: state.job.title || '',
            company: state.job.company || '',
            salaryText: state.job.salaryText || '',
            city: state.job.city || '',
            experience: state.job.experience || '',
            degree: state.job.degree || '',
            jobUrl: state.job.jobUrl || '',
            securityId: state.job.securityId || ''
          }
        : null,
      jd: state.job && state.job.jd
        ? {
            dutiesCount: (state.job.jd.duties || []).length,
            requirementsCount: (state.job.jd.requirements || []).length,
            bonusesCount: (state.job.jd.bonuses || []).length
          }
        : { dutiesCount: 0, requirementsCount: 0, bonusesCount: 0 }
    };
  }

  function notify() {
    try {
      chrome.runtime.sendMessage({ type: 'BOSS_OSS_JOBPAGE_STATE', state: statePayload() }).catch(() => {});
    } catch (_) {
      /* ignore */
    }
  }

  function accept(job, source) {
    if (state.captured) return; // 接口优先，只认第一次
    state.job = job;
    state.source = source;
    state.captured = true;
    state.at = Date.now();
    persist(job).catch(() => {});
    notify();
    console.log('%c[Boss 求职助手] 已抓取岗位：' + (job.title || ''), 'color:#4F5BD5;font-weight:bold');
  }

  // ------------------------------------------------------------ 消息
  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || msg.__boss_oss !== true || msg.channel !== 'api' || !msg.ok) return;
    if (msg.type !== 'JOB_DETAIL') return;

    const json = S.API.parse(msg.body);
    const zp = S.API.dataOf(json);
    if (!S.API.OK(json) || !zp || !zp.jobInfo) return;

    accept(buildJob(S.parseJobDetail(zp)), 'api');
  });

  // DOM 兜底：给接口一点时间，超时还没抓到就直接读页面
  setTimeout(() => {
    if (state.captured) return;
    try {
      const job = parseDom();
      if (job) accept(job, 'dom');
      else notify();
    } catch (_) {
      notify();
    }
  }, DOM_FALLBACK_MS);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.cmd === 'JOBPAGE_STATE') {
      sendResponse(statePayload());
      return false;
    }
    return false;
  });

  notify();
})();
