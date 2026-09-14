/**
 * 开源版面板逻辑。
 *
 * 与商业版最大的区别：**没有服务端**。所有 AI 能力都在本地完成 ——
 * 统计与判定走规则（agents/*.js），个性化文案由用户自己配置的 LLM 端点生成。
 */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  let tabId = null;
  let page = 'unknown'; // jobs | chat | jobdetail | unknown
  let state = null; // 岗位页状态（来自 jobs.js）
  let chatState = null;
  let jobPageState = null;

  let currentScene = 'jobs';
  let filter = '';
  let statusFilter = 'all';
  let timer = null;

  let profiles = [];
  let currentProfileId = null;

  // 分析结果与聊天建议都在本地留存（商业版存在服务端）
  let lastReport = null;
  let history = [];
  const adviceCache = new Map();
  let lastAdvice = null;
  let lastAdviceKey = '';
  let chatGenerating = false;
  let chatAbort = null;
  let autoAdvice = false;
  let analyzing = false;

  const port = chrome.runtime.connect({ name: 'boss-oss-panel' });
  port.onMessage.addListener((msg) => {
    if (msg.type === 'STATE') { page = 'jobs'; state = msg.state; render(); }
    if (msg.type === 'CHAT_STATE') { page = 'chat'; chatState = msg.state; render(); }
    if (msg.type === 'JOBPAGE_STATE') { page = 'jobdetail'; jobPageState = msg.state; render(); }
    if (msg.type === 'CHAT_NEW_MSG') onChatNewMessage(msg.bossId);
    if (msg.type === 'TAB_CHANGED') refresh();
  });

  // ------------------------------------------------------------ 生命周期
  async function init() {
    await BossLLM.load();
    await loadProfiles();
    await loadHistory();
    try {
      const d = await chrome.storage.local.get(['bossoss_auto_advice']);
      autoAdvice = !!d.bossoss_auto_advice;
    } catch (_) {
      autoAdvice = false;
    }
    $('#chkAutoAdvice').checked = autoAdvice;

    const res = await sendToBackground({ cmd: 'ACTIVE_TAB' });
    const t = res && res.tab;
    if (!t || !t.id) { page = 'unknown'; render(); startPolling(); return; }
    tabId = t.id;
    page = pageOfUrl(t.url);
    await refresh();
    startPolling();
    await updateModeBadge();
  }

  function pageOfUrl(url) {
    if (!url || url.indexOf('zhipin.com') < 0) return 'unknown';
    if (url.indexOf('/web/geek/chat') >= 0) return 'chat';
    if (url.indexOf('/job_detail/') >= 0) return 'jobdetail';
    if (url.indexOf('/web/geek/jobs') >= 0) return 'jobs';
    return 'unknown';
  }

  function startPolling() {
    clearInterval(timer);
    timer = setInterval(refresh, 1500);
  }

  async function refresh() {
    if (tabId == null) return;
    await syncActiveTab();

    if (page === 'jobdetail') {
      const r = await sendToTab({ cmd: 'JOBPAGE_STATE' });
      if (r && r.ok) { jobPageState = r; render(); }
      return;
    }
    if (page === 'chat') {
      const r = await sendToTab({ cmd: 'CHAT_STATE' });
      if (r && r.ok) { chatState = r.state; render(); }
      return;
    }
    if (page === 'jobs') {
      const r = await sendToTab({ cmd: 'STATE' });
      if (r && r.ok) { state = r.state; render(); }
    }
  }

  /** 页面切换要自动跟随：panel 的 page 只在 init 判定一次，之后必须重新确认 URL */
  async function syncActiveTab() {
    const res = await sendToBackground({ cmd: 'ACTIVE_TAB' });
    const tab = res && res.tab;
    if (!tab || !tab.id) return;
    const next = pageOfUrl(tab.url);
    if (tab.id !== tabId || next !== page) {
      tabId = tab.id;
      page = next;
      state = null;
      chatState = null;
      jobPageState = null;
      updateNavLabels();
      render();
    }
  }

  function sendToTab(msg) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(tabId, msg, (res) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(res);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  function sendToBackground(msg) {
    return new Promise((resolve) => {
      try { chrome.runtime.sendMessage(msg, (r) => resolve(r)); }
      catch (_) { resolve(null); }
    });
  }

  // ------------------------------------------------------------ 场景
  function setScene(name) {
    currentScene = name;
    $$('.scene').forEach((s) => s.classList.toggle('on', s.dataset.scene === name));
    $$('#pNav button').forEach((b) => b.classList.toggle('on', b.dataset.nav === name));
    updateFoot();
    updateNavLabels();
  }

  function setSub(name) {
    $$('.subscene').forEach((s) => s.classList.toggle('on', s.dataset.sub === name));
  }

  /** 聊天页的「岗位」Tab 实际承载对话，改名避免误导 */
  function updateNavLabels() {
    const btn = document.querySelector('#pNav button[data-nav="jobs"]');
    if (btn) btn.textContent = page === 'chat' ? '对话' : '岗位';
  }

  function updateFoot() {
    if (currentScene === 'jobs' && page === 'jobs' && state) renderFoot();
    else $('#pFoot').style.display = 'none';
  }

  /** 配了 LLM 还不够 —— 没拿到该域名的权限，请求会被浏览器拦死 */
  async function updateModeBadge() {
    const el = $('#modeBadge');
    if (!el) return;
    const on = BossLLM.isConfigured();
    if (!on) {
      el.textContent = '规则模式';
      el.className = 'chip o';
      el.title = '未配置 LLM，仅使用本地规则计算';
      return;
    }
    const granted = await BossLLM.hasPermission((await BossLLM.settings()).baseUrl);
    el.textContent = granted ? 'AI 已启用' : '待授权';
    el.className = 'chip ' + (granted ? 'g' : 'o');
    el.title = granted
      ? '已配置 LLM，个性化文案由你的端点生成'
      : '已配置但缺少域名权限，请点「设置 → 测试连接」授权';
  }

  function render() {
    updateNavLabels();
    if (page === 'jobdetail') { setSub('jobdetail'); renderJobPage(); updateFoot(); return; }
    if (currentScene !== 'jobs') { updateFoot(); return; }

    if (page === 'unknown') { $('#pSub').textContent = '未连接'; setSub('off'); updateFoot(); return; }
    if (page === 'chat') { updateFoot(); return renderChat(); }
    if (!state) { $('#pSub').textContent = '加载中…'; setSub('off'); updateFoot(); return; }

    updateFoot();
    if (state.status === 'scraping') return renderScraping();
    if ((state.jobs || []).some((j) => j.jdFetched)) return renderTable();
    return renderIdle();
  }

  // ------------------------------------------------------------ 岗位页
  function renderIdle() {
    const jobs = state.jobs || [];
    $('#pSub').textContent = `${jobs.length} 个岗位`;
    $('#cntJobs').textContent = jobs.length;
    $('#quotaInfo').textContent = `今日已用 ${(state.quota && state.quota.usedToday) || 0} / 200 条`;

    const tag = $('#srcTag');
    tag.textContent = state.source === 'api' ? '接口' : state.source === 'dom' ? 'DOM 兜底' : '未识别';
    tag.className = 'chip ' + (state.source === 'api' ? 'g' : 'o');

    $('#miniList').innerHTML = jobs.length
      ? jobs.slice(0, 5).map((j) => `
          <div class="row" style="padding:4px 0;font-size:12.5px">
            <b>${esc(j.title)}</b>
            <span class="muted">${esc(j.company)}</span>
            <span style="margin-left:auto;color:#ff6a00">${esc(j.salaryText)}</span>
          </div>`).join('') +
        (jobs.length > 5 ? `<div class="hint" style="margin-top:4px">…还有 ${jobs.length - 5} 个</div>` : '')
      : '<p class="hint">还没有捕获到岗位。去列表页滚动或翻几页。</p>';

    const box = $('#errBox');
    if (state.lastError) {
      box.innerHTML = `<b>已暂停：</b>${esc(state.lastError)}`;
      box.style.display = 'block';
    } else box.style.display = 'none';

    setSub('idle');
  }

  function renderScraping() {
    const p = state.progress || { total: 0, done: 0, ok: 0, failed: 0 };
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    $('#pSub').textContent = '解析中';
    $('#pctText').textContent = pct + '%';
    $('#pbarFill').style.width = pct + '%';
    $('#progText').textContent = `${p.done} / ${p.total}`;
    $('#progStat').textContent = `成功 ${p.ok || 0} · 失败 ${p.failed || 0}`;
    $('#curText').textContent = p.current ? '当前：' + p.current : '准备中';

    const done = (state.jobs || []).filter((j) => j.jdFetched || j.jdError).slice(-15).reverse();
    $('#scrapeLog').innerHTML = done.length
      ? done.map((j) => j.jdFetched
        ? `<li><b>${esc(j.company)}</b> ${esc(j.title)} <span class="t">JD ${((j.jd && j.jd.duties.length) || 0) + ((j.jd && j.jd.requirements.length) || 0)} 条</span></li>`
        : `<li style="color:#b42318"><b>${esc(j.title)}</b> <span class="t">${esc(j.jdError || '失败')}</span></li>`
      ).join('')
      : '<li>正在准备…</li>';
    setSub('scraping');
  }

  function inScope(j) {
    if (statusFilter === 'parsed') return !!j.jdFetched;
    if (statusFilter === 'unparsed') return !j.jdFetched;
    return true;
  }

  function matchJobFilter(j, kw) {
    if (!kw) return true;
    const s = kw.toLowerCase();
    return [j.title, j.company, j.city, (j.skills || []).join(' ')]
      .filter(Boolean)
      .some((x) => String(x).toLowerCase().indexOf(s) >= 0);
  }

  function renderTable() {
    const all = state.jobs || [];
    const rows = all.filter((j) => inScope(j) && matchJobFilter(j, filter));

    $('#pSub').textContent = `${all.length} 个岗位`;
    $('#statBar').innerHTML = `
      <span>共 <b>${all.length}</b></span>
      <span>已解析 <b>${all.filter((j) => j.jdFetched).length}</b></span>
      <span>已选 <b>${all.filter((j) => j.checked).length}</b></span>`;
    $('#cntAll').textContent = all.length;
    $('#cntParsed').textContent = all.filter((j) => j.jdFetched).length;
    $('#cntUnparsed').textContent = all.filter((j) => !j.jdFetched).length;
    $('#chkAll').checked = rows.length > 0 && rows.every((j) => j.checked);

    $('#jobList').innerHTML = rows.length
      ? rows.map(jobRow).join('')
      : '<p class="hint">没有符合条件的岗位。</p>';
    bindRows();
    setSub('table');
  }

  function jobRow(j) {
    const d = j.jd;
    return `
    <div class="jrow ${j.checked ? 'sel' : ''} ${j.jdFetched ? 'parsed' : 'unparsed'}" data-key="${esc(j.key)}">
      <input type="checkbox" data-act="check" ${j.checked ? 'checked' : ''}>
      <div class="jr-b">
        <div class="jr-t"><b data-act="toggle-jd">${esc(j.title)}</b></div>
        <div class="jr-meta">
          <span class="sal">${esc(j.salaryText)}</span>
          <span class="jr-when">${relTime(j.collectedAt)}</span>
        </div>
        <div class="jr-c">
          <span>${esc(j.company)}</span><em>|</em>
          <span>${esc(j.city)}${j.district ? '·' + esc(j.district) : ''}</span><em>|</em>
          <span>${esc(j.experience)}</span><em>|</em><span>${esc(j.degree)}</span>
        </div>
        ${(j.skills || []).length ? `<div class="jr-tags">${j.skills.slice(0, 6).map((s) => `<span>${esc(s)}</span>`).join('')}</div>` : ''}
        <div class="jr-m">
          ${j.jdFetched
            ? `JD 已解析 · 职责 ${d ? d.duties.length : 0} 条 / 要求 ${d ? d.requirements.length : 0} 条 / 加分 ${d ? d.bonuses.length : 0} 条`
            : 'JD 未解析'}
        </div>
        <div class="jd">
          ${d && d.duties.length ? `<h6>岗位职责</h6><ul>${d.duties.slice(0, 8).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
          ${d && d.requirements.length ? `<h6>能力要求</h6><ul>${d.requirements.slice(0, 8).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
          ${d && d.bonuses.length ? `<h6>加分项</h6><ul>${d.bonuses.slice(0, 6).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
        </div>
      </div>
    </div>`;
  }

  function bindRows() {
    $$('#jobList .jrow').forEach((el) => {
      const key = el.dataset.key;
      const chk = el.querySelector('[data-act=check]');
      if (chk) {
        chk.addEventListener('change', (e) => {
          sendToTab({ cmd: 'TOGGLE', key, checked: e.target.checked });
          const job = (state.jobs || []).find((j) => j.key === key);
          if (job) job.checked = e.target.checked;
          el.classList.toggle('sel', e.target.checked);
          renderTable();
        });
      }
      const t = el.querySelector('[data-act=toggle-jd]');
      if (t) {
        t.addEventListener('click', () => el.querySelector('.jd').classList.toggle('on'));
      }
    });
  }

  function renderFoot() {
    const foot = $('#pFoot');
    foot.style.display = 'block';
    const jobs = state.jobs || [];
    const pending = jobs.filter((j) => !j.jdFetched && j.securityId);

    if (state.status === 'scraping') {
      const p = state.progress || { total: 0, done: 0, ok: 0, failed: 0 };
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
      $('#footIdle').style.display = 'none';
      $('#footProg').style.display = 'block';
      $('#footBar').style.width = pct + '%';
      $('#footProgText').textContent = `解析中 ${p.done} / ${p.total}`;
      $('#footProgStat').textContent = `成功 ${p.ok || 0} · 失败 ${p.failed || 0}`;
      return;
    }

    $('#footIdle').style.display = 'block';
    $('#footProg').style.display = 'none';
    const btn = $('#btnScrapeFoot');
    $('#cntTargetFoot').textContent = pending.length;
    btn.disabled = pending.length === 0;
    btn.style.opacity = pending.length === 0 ? '.5' : '1';
    $('#footHint').textContent = pending.length
      ? '逐条请求并本地解析，间隔 0.5–2 秒'
      : jobs.length ? '当前岗位均已解析（数据存本地）' : '还没有捕获到岗位，请滚动页面或翻页';
  }

  function renderDiag() {
    const diag = (state && state.diag) || [];
    $('#diagList').innerHTML = diag.length
      ? diag.slice().reverse().map((d) => `<li><b>${esc(d.url.split('?')[0])}</b><span class="t">${d.size}B</span></li>`).join('')
      : '<li>还没有捕获到 /wapi/ 请求，请刷新页面后再看。</li>';
    setSub('diag');
  }

  function renderJobPage() {
    const s = jobPageState;
    $('#pSub').textContent = '职位详情';
    const card = $('#jobPageCard');
    const actions = $('#jobPageActions');

    if (!s || !s.captured || !s.job) {
      card.innerHTML = `<div class="card-t">正在读取岗位…</div>
        <p class="hint" style="margin-top:6px">若长时间无结果，说明该页面没有触发详情接口，可刷新后重试。</p>`;
      actions.style.display = 'none';
      return;
    }

    const jd = s.jd || {};
    card.innerHTML = `
      <div class="row-between" style="margin-bottom:8px">
        <b style="font-size:13px">已抓取该岗位</b>
        <span class="chip ${s.source === 'api' ? 'g' : 'o'}">${s.source === 'api' ? '接口' : '页面结构'}</span>
      </div>
      <div class="row" style="gap:8px">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600">${esc(s.job.title || '—')}</div>
          <div class="hint">${esc([s.job.company, s.job.city, s.job.experience, s.job.degree].filter(Boolean).join(' · '))}</div>
        </div>
        ${s.job.salaryText ? `<span class="chip o" style="flex:none;align-self:flex-start">${esc(s.job.salaryText)}</span>` : ''}
      </div>
      <div class="intent" style="margin-top:8px">JD 解析：职责 ${jd.dutiesCount || 0} 条 / 要求 ${jd.requirementsCount || 0} 条 / 加分 ${jd.bonusesCount || 0} 条</div>`;
    actions.style.display = 'block';
    actions.innerHTML = '<p class="hint" style="margin:0">已加入岗位收集箱，返回聊天窗口会自动带入该岗位。</p>';
  }

  // ------------------------------------------------------------ 聊天
  function renderChat() {
    if (!chatState) { setSub('off'); return; }
    const c = chatState.current;
    $('#pSub').textContent = c ? `与 ${c.name || 'HR'} 沟通中` : '聊天页';

    const j = c && c.job;
    $('#chatJob').innerHTML = c
      ? `<div class="row" style="gap:8px">
           <div style="flex:1;min-width:0">
             <div class="row" style="gap:6px">
               <span style="font-size:13px;font-weight:600">${esc(j ? j.title : '（未识别岗位）')}</span>
               ${jobBadge(c)}
             </div>
             <div class="hint">${esc(c.company || '')}${c.name ? ' · ' + esc(c.name) : ''}</div>
             ${j ? `<div class="hint">${esc([j.city, j.experience, j.degree].filter(Boolean).join(' / '))}</div>` : ''}
             ${jobFromHint(c)}
           </div>
           ${j && j.salaryText ? `<span class="chip o" style="flex:none;align-self:flex-start">${esc(j.salaryText)}</span>` : ''}
         </div>`
      : '<p class="hint">打开一个会话后，这里会显示岗位与对话上下文。</p>';

    const msgs = (c && c.messages) || [];
    let lastHrIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i -= 1) if (!msgs[i].mine) { lastHrIdx = i; break; }
    $('#chatMsgs').innerHTML = msgs.length
      ? msgs.slice(-20).map((m, i) => {
        const idx = msgs.length - Math.min(msgs.length, 20) + i;
        if (m.jobCard) {
          return `<div class="msg sys">岗位卡片：${esc(m.jobCard.title || '')} ${esc(m.jobCard.salary || '')}</div>`;
        }
        return `<div class="msg ${m.mine ? 'me' : 'you'}${idx === lastHrIdx ? ' cur' : ''}">${esc(m.text)}</div>`;
      }).join('')
      : '<p class="hint">暂无消息</p>';

    const key = (c && c.encryptBossId) || '';
    if (lastAdviceKey !== key) {
      lastAdviceKey = key;
      const cached = adviceCache.get(key);
      lastAdvice = cached ? cached.data : null;
      $('#chatAdvice').innerHTML = lastAdvice ? chatAdviceHtml(lastAdvice) : '';
      if (!chatGenerating) {
        $('#chatHint').textContent = cached ? '已载入本会话上次生成的建议' : '';
      }
    }

    const btn = $('#btnChatAdvice');
    if (btn) btn.disabled = !c || chatGenerating;
    setSub('chat');
  }

  function jobBadge(c) {
    const from = c && c.jobFrom;
    if (from === 'boss') return '<span class="chip g">来自会话</span>';
    if (from === 'viewed') return '<span class="chip g">刚查看的职位</span>';
    if (from === 'recent') return '<span class="chip o">推测关联</span>';
    return '';
  }

  function jobFromHint(c) {
    if (!c || !c.jobFrom || c.jobFrom === 'boss' || !c.jobAt) return '';
    const ago = relTime(c.jobAt);
    return ago ? `<div class="hint" style="color:var(--muted)">来自你${ago === '刚刚' ? '刚刚' : ago}查看的职位</div>` : '';
  }

  function onChatNewMessage(bossId) {
    if (!autoAdvice || chatGenerating || page !== 'chat') return;
    const cur = chatState && chatState.current;
    if (cur && bossId && cur.encryptBossId && cur.encryptBossId !== bossId) return;
    const now = Date.now();
    if (now - (adviceCache.get(bossId) || { at: 0 }).at < 60000) return;
    generateChatAdvice();
  }

  function setChatGenerating(on) {
    chatGenerating = !!on;
    const btn = $('#btnChatAdvice');
    if (btn) { btn.disabled = on; btn.textContent = on ? '生成中…' : '生成回复建议'; }
    const abort = $('#btnChatAbort');
    if (abort) abort.disabled = !on;
    $('#chatBarWrap').style.display = on ? 'block' : 'none';
    if (!on) $('#chatBarFill').style.width = '0%';
  }

  async function generateChatAdvice() {
    if (chatGenerating) return;
    const profile = currentProfile();
    if (!profile) return toast('请先在「档案」页创建档案');

    const c = chatState && chatState.current;
    if (!c) return toast('请先打开一个会话');

    const ctx = await sendToTab({ cmd: 'ADVICE_CONTEXT' });
    if (!ctx || !ctx.ok) return toast((ctx && ctx.reason) || '无法读取会话，请刷新聊天页');

    setChatGenerating(true);
    $('#chatHint').textContent = '正在生成…';

    try {
      const job = ctx.job || {};
      const conversation = ctx.conversation || [];
      const jd = job.jdRaw ? window.BossShared.parseJD(job.jdRaw) : null;

      const args = {
        profile,
        job,
        jd,
        conversation
      };
      const rule = window.BossChatAdvisor.ruleAdvice(args);
      const risks = rule.risks;
      const missing = rule.missing;
      const leverage = rule.leverage;
      const hint = rule.salaryHint;

      let advice = rule;
      if (BossLLM.isConfigured()) {
        const data = await BossLLM.json({
          system: window.BossChatAdvisor.SYSTEM_PROMPT,
          user: window.BossChatAdvisor.buildPrompt(args),
          kind: 'strong'
        });
        if (data) {
          advice = window.BossChatAdvisor.finalize(data, {
            rule,
            risks,
            missing,
            leverage,
            hint,
            jdMatched: !!(job.jdRaw),
            model: 'llm'
          });
        }
      }

      const key = c.encryptBossId || '';
      adviceCache.set(key, { data: advice, at: Date.now() });
      lastAdvice = advice;
      lastAdviceKey = key;
      $('#chatAdvice').innerHTML = chatAdviceHtml(advice);
      $('#chatHint').textContent = advice.model === 'llm' ? '已生成（LLM）' : '已生成（本地规则）';
    } catch (err) {
      $('#chatHint').innerHTML = `<span style="color:#b42318">${esc(err.message || '生成失败')}</span>`;
    } finally {
      setChatGenerating(false);
      chatAbort = null;
    }
  }

  function chatAdviceHtml(a) {
    if (!a) return '';
    const badge = a.jdMatched
      ? '<span class="chip g">JD 已匹配</span>'
      : '<span class="chip o">未匹配到 JD</span>';

    const strategies = (a.strategies || []).map((s) => `
      <div class="strat">
        <div class="strat-hd">
          <b>${esc(s.name || '策略')}</b>
          <span class="more" data-act="why">为什么这么写</span>
          <span class="len">${(s.text || '').length} 字</span>
        </div>
        <textarea class="strat-ta" rows="3">${esc(s.text || '')}</textarea>
        <div class="strat-why">${esc(s.why || '')}</div>
        <div class="strat-ft">
          <button class="btn btn-ghost btn-sm" data-act="copy">复制</button>
          <button class="btn btn-primary btn-sm" data-act="fill">填入</button>
        </div>
      </div>`).join('');

    const risks = (a.risks || []).length
      ? `<div class="card"><div class="card-t">⚠️ 雷区预警</div>
         <ul class="risk">${a.risks.map((r) => `<li><b>${esc(r.topic)}</b> — ${esc(r.why)}<span class="do">应对：${esc(r.do)}</span></li>`).join('')}</ul></div>`
      : '';

    const lev = (a.leverage || []).length
      ? `<div class="card"><div class="card-t">可放大的优势</div>
         <div class="lev">${a.leverage.map((l) => `<span title="依据：${esc(l.evidence || '—')}">${esc(l.point)}</span>`).join('')}</div></div>`
      : '';

    const miss = (a.missing || []).length
      ? `<div class="card"><div class="card-t">还差这些信息没问清</div>
         <ul class="ask">${a.missing.map((m, i) => `
            <li><input type="checkbox" checked data-ask="${i}">
              <span>${esc(m.item)}<br><span class="q">${esc(m.question)}</span></span></li>`).join('')}</ul>
         <button class="btn btn-ghost btn-sm btn-block" data-act="copy-asks" style="margin-top:6px">复制追问</button></div>`
      : '';

    const salary = a.salaryHint
      ? `<div class="card"><div class="card-t">薪资锚定</div><p class="hint" style="margin:0">${esc(a.salaryHint)}</p></div>`
      : '';

    return `
      <div class="card">
        <div class="row-between" style="margin-bottom:8px"><b style="font-size:13px">回复建议</b>${badge}</div>
        <div class="intent">HR 真正在确认的是：<b>${esc(a.intent || '—')}</b></div>
        <div style="margin-top:10px">${strategies}</div>
        <p class="hint" style="margin-top:8px">插件只做建议与填入，发送始终由你点击。</p>
      </div>
      ${salary}${risks}${lev}${miss}`;
  }

  function bindChatAdvice() {
    const box = $('#chatAdvice');
    if (!box) return;
    box.addEventListener('click', async (e) => {
      const why = e.target.closest('[data-act=why]');
      if (why) {
        const panel = why.closest('.strat').querySelector('.strat-why');
        if (panel) panel.classList.toggle('on');
        return;
      }
      const strat = e.target.closest('.strat');
      const act = e.target.closest('[data-act]');
      if (!act) return;
      const kind = act.dataset.act;

      if (kind === 'copy' && strat) return copyText(strat.querySelector('.strat-ta').value);

      if (kind === 'fill' && strat) {
        if (page !== 'chat') return toast('请先打开聊天页');
        const text = strat.querySelector('.strat-ta').value;
        const r = await sendToTab({ cmd: 'FILL_INPUT', text });
        if (r && r.ok) {
          act.textContent = '已填入';
          setTimeout(() => { act.textContent = '填入'; }, 1500);
          toast('已填入输入框，确认后点击发送');
        } else {
          await copyText(text);
          toast('未能定位输入框，已复制');
        }
        return;
      }

      if (kind === 'copy-asks') {
        const items = (lastAdvice && lastAdvice.missing) || [];
        const picked = Array.from(box.querySelectorAll('[data-ask]:checked'))
          .map((el) => items[Number(el.dataset.ask)])
          .filter(Boolean)
          .map((m) => m.question);
        return copyText(picked.join('\n'));
      }
    });
  }

  // ------------------------------------------------------------ 话术
  async function generateScript() {
    const profile = currentProfile();
    if (!profile) return toast('请先在「档案」页创建档案');

    const picked = (state && (state.jobs || []).filter((j) => j.checked && j.jdFetched)) || [];
    if (!picked.length) return toast('请先在「岗位」页勾选至少一个已解析的岗位');

    const job = picked[0];
    const match = window.BossMatcher.matchJob({
      jdRequirements: (job.jd && job.jd.requirements) || [],
      jdSkills: job.skills || [],
      profileSkills: profile.skills || [],
      profileProjects: profile.projects || []
    });

    let script = window.BossScript.ruleScript(job, profile, match);
    let model = 'rule-based';

    if (BossLLM.isConfigured()) {
      const text = await BossLLM.text({
        system: '你是求职沟通教练。基于下面的素材，把开场白改得更自然、更像人话；不要新增任何事实或数据。',
        user: `岗位：${job.title} @ ${job.company}\n候选人：${profile.currentTitle || ''} / ${profile.years || '?'} 年\n开场白：${script.openings[0].text}`,
        kind: 'strong'
      });
      if (text) {
        script.openings[0].text = window.BossScript.shorten(text);
        model = 'llm';
      }
    }

    const issues = window.BossScript.selfCheck(script, profile);
    script.model = model;
    $('#scriptBody').innerHTML = scriptHtml(script) +
      (issues.length
        ? `<div class="warnbox" style="margin-top:8px"><b>自检提示：</b>${esc(issues.join('；'))}</div>`
        : '');
    $('#scriptHint').textContent = model === 'llm' ? '已生成（LLM 润色）' : '已生成（本地规则）';
  }

  function scriptHtml(s) {
    const canFill = page === 'chat';
    const block = (title, text, note) => text
      ? `<div class="script">
           <div class="sh"><b>${esc(title)}</b>
             ${canFill ? `<span class="copy" data-fill="${esc(text)}" style="margin-left:8px">填入聊天框</span>` : ''}
             <span class="copy" data-copy="${esc(text)}" style="margin-left:${canFill ? '6px' : 'auto'}">复制</span>
           </div>
           <div class="st">${esc(text)}</div>
           ${note ? `<div class="sn">${esc(note)}</div>` : ''}
         </div>`
      : '';

    const openings = (s.openings || []).map((o) => block(o.label, o.text, `${o.text.length} 字`)).join('');
    const hooks = (s.hooks || []).map((h, i) => block(`经历钩子 ${i + 1}`, h, '')).join('');
    return `
      <div class="card"><div class="card-t">开场白</div>${openings}</div>
      <div class="card"><div class="card-t">自我介绍</div>
        <div class="script"><div class="sh"><b>30 秒版本</b><span class="copy" data-copy="${esc(s.intro)}" style="margin-left:auto">复制</span></div>
        <div class="st">${esc(s.intro)}</div></div></div>
      ${hooks ? `<div class="card"><div class="card-t">经历钩子</div>${hooks}</div>` : ''}
      <div class="card"><div class="card-t">反问清单</div>
        <ul class="kv" style="margin-bottom:0">${(s.questions || []).map((q) => `<li>${esc(q)}</li>`).join('')}</ul></div>
      <div class="card"><div class="card-t">预判追问</div>
        ${(s.objections || []).map((o) => `<div class="script"><div class="sh"><b>${esc(o.q)}</b></div><div class="st">${esc(o.a)}</div></div>`).join('')}</div>`;
  }

  // ------------------------------------------------------------ 分析
  async function runAnalysis() {
    if (analyzing) return;
    const profile = currentProfile();
    if (!profile) return toast('请先在「档案」页创建档案');

    const picked = ((state && state.jobs) || []).filter((j) => j.checked && j.jdFetched).slice(0, 20);
    if (!picked.length) return toast('请先在「岗位」页勾选至少一个已解析的岗位');

    analyzing = true;
    $('#btnGenReport').disabled = true;
    $('#reportHint').textContent = `正在分析 ${picked.length} 个岗位…`;

    try {
      const result = window.BossAnalysis.buildAnalysis(
        picked.map((j) => ({
          key: j.key, title: j.title, company: j.company,
          salaryText: j.salaryText, city: j.city, jdRaw: j.jdRaw, skills: j.skills
        })),
        profile
      );

      if (BossLLM.isConfigured()) {
        const text = await BossLLM.text({
          system: '你是求职顾问。用 3 句话说清楚：这批岗位最看重什么、候选人最该突出什么、最该补什么。要有判断，不要罗列数字。',
          user: `共性要求：${result.commonRequirements.slice(0, 8).map((s) => `${s.name}(${Math.round(s.ratio * 100)}%)`).join('、')}
优势：${result.strengths.slice(0, 6).join('、')}
不足：${result.weaknesses.slice(0, 6).join('、')}
匹配最好：${result.jobRanking.length ? result.jobRanking[0].title : '无'}`,
          kind: 'fast'
        });
        if (text) { result.summary = text; result.model = 'llm'; }
      }

      lastReport = result;
      $('#reportBody').innerHTML = analysisHtml(result);
      $('#reportHint').textContent = result.model === 'llm' ? '已生成（LLM 总结）' : '已生成（本地规则）';
      await pushHistory(result);
      renderHistory();
    } catch (err) {
      $('#reportHint').innerHTML = `<span style="color:#b42318">${esc(err.message || '分析失败')}</span>`;
    } finally {
      analyzing = false;
      $('#btnGenReport').disabled = false;
    }
  }

  function analysisHtml(r) {
    const s = r.salary || {};
    const money = (v) => (v ? `${Math.round(v / 1000)}K` : '-');
    const bars = (items) => (items || []).map((x) => `
      <div class="bar-row">
        <span class="n">${esc(x.name)}</span>
        <span class="t"><i style="width:${Math.round((x.ratio || 0) * 100)}%"></i></span>
        <span class="p">${Math.round((x.ratio || 0) * 100)}%</span>
      </div>`).join('');

    const col = (title, items, cls) => (items && items.length)
      ? `<div class="match-col ${cls}"><h5>${title}</h5><ul>${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>`
      : '';

    const ranking = (r.jobRanking || []).map((x) => `
      <div class="row" style="padding:6px 0;border-top:1px solid var(--line);font-size:12.5px">
        <b>${esc(x.title || x.company)}</b>
        <span class="muted">${esc(x.salaryText || '')}</span>
        <span style="margin-left:auto;font-weight:700;color:var(--brand)">${x.score}</span>
      </div>
      <div class="hint" style="margin-bottom:2px">${esc(x.gap || '')}</div>`).join('');

    return `
      <div class="card">
        <div class="card-t">结论</div>
        <p class="hint" style="margin-bottom:8px">${esc(r.summary || '')}</p>
        <div class="statbar">
          <span>岗位 <b>${r.jobCount}</b></span>
          <span>P25 <b>${money(s.p25)}</b></span>
          <span>中位 <b>${money(s.median)}</b></span>
          <span>P75 <b>${money(s.p75)}</b></span>
        </div>
      </div>
      <div class="card"><div class="card-t">共性能力（出现率）</div>${bars(r.commonRequirements)}</div>
      <div class="card">
        <div class="card-t">对照你的档案</div>
        ${col('✅ 已具备 · 主推优势', r.strengths, 'm-ok')}
        ${col('⚠️ 有但技能栏没写', r.partial, 'm-warn')}
        ${col('❌ 明确缺失 · 按优先级补', r.weaknesses, 'm-bad')}
      </div>
      <div class="card">
        <div class="card-t">怎么补足（按 ROI）</div>
        <ul class="kv" style="margin-bottom:0">${(r.improveAdvice || []).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      </div>
      <div class="card">
        <div class="card-t">如何提炼优势</div>
        <ul class="kv" style="margin-bottom:0">${(r.pitchAdvice || []).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      </div>
      <div class="card"><div class="card-t">哪些岗位最值得投</div>${ranking || '<p class="hint">暂无</p>'}</div>`;
  }

  const HISTORY_KEY = 'bossoss_analysis_runs_v1';

  async function loadHistory() {
    try {
      const d = await chrome.storage.local.get([HISTORY_KEY]);
      history = (d && d[HISTORY_KEY]) || [];
    } catch (_) {
      history = [];
    }
    renderHistory();
  }

  async function pushHistory(result) {
    history.unshift({ at: Date.now(), jobCount: result.jobCount, summary: result.summary, result });
    history = history.slice(0, 10);
    try {
      await chrome.storage.local.set({ [HISTORY_KEY]: history });
    } catch (_) {
      // 超配额就丢掉最老的
      history = history.slice(0, 3);
      try { await chrome.storage.local.set({ [HISTORY_KEY]: history }); } catch (e2) { /* ignore */ }
    }
  }

  function renderHistory() {
    const card = $('#historyCard');
    if (!card) return;
    if (!history.length) { card.style.display = 'none'; return; }
    card.style.display = 'block';
    $('#historyBody').innerHTML = history.map((h, i) => `
      <div class="hist-item" data-run="${i}">
        <div class="t">${h.jobCount} 个岗位</div>
        <div class="m">${esc(relTime(h.at))} · ${esc(String(h.summary || '').slice(0, 50))}</div>
      </div>`).join('');
  }

  // ------------------------------------------------------------ 档案
  function currentProfile() {
    if (!profiles.length) return null;
    return profiles.find((p) => p.id === currentProfileId) || profiles[0];
  }

  async function loadProfiles() {
    profiles = await window.BossProfile.list();
    const cur = await window.BossProfile.current();
    currentProfileId = cur ? cur.id : null;
    renderProfileBar();
    renderProfileList();
  }

  function renderProfileBar() {
    const sel = $('#profileSel');
    sel.innerHTML = profiles.length
      ? profiles.map((p) => `<option value="${esc(p.id)}"${p.id === currentProfileId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')
      : '<option value="">（暂无档案）</option>';
  }

  function renderProfileList() {
    $('#profileList').innerHTML = profiles.length
      ? profiles.map((p) => `
        <div class="hist-item">
          <div class="t">${esc(p.name)}</div>
          <div class="m">${p.years ? p.years + ' 年 · ' : ''}${esc(p.currentTitle || '')}${esc(p.city ? ' · ' + p.city : '')}</div>
          <div class="m">技能：${esc((p.skills || []).slice(0, 10).join('、') || '—')}</div>
          <button class="btn btn-ghost btn-sm" data-del="${esc(p.id)}" style="margin-top:6px;color:#b42318">删除</button>
        </div>`).join('')
      : '<p class="hint">还没有档案。粘贴简历文本或手填关键信息即可创建。</p>';

    $$('#profileList [data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        await window.BossProfile.remove(b.dataset.del);
        await loadProfiles();
      })
    );
  }

  // ------------------------------------------------------------ 设置
  async function loadLlmForm() {
    const s = await BossLLM.load();
    $('#llmBase').value = s.baseUrl || '';
    $('#llmKey').value = s.apiKey || '';
    $('#llmFast').value = s.modelFast || '';
    $('#llmStrong').value = s.modelStrong || '';
  }

  async function saveLlm() {
    const patch = {
      baseUrl: $('#llmBase').value.trim(),
      apiKey: $('#llmKey').value.trim(),
      modelFast: $('#llmFast').value.trim(),
      modelStrong: $('#llmStrong').value.trim()
    };
    await BossLLM.save(patch);
    // 保存也是用户手势，顺手把域名权限申请了，省得用户再点一次测试
    if (patch.baseUrl) await BossLLM.requestPermission(patch.baseUrl);
    await updateModeBadge();
    $('#llmHint').textContent = '已保存（凭证只存在本机）';
    toast('已保存');
  }

  async function testLlm() {
    $('#llmHint').textContent = '测试中（若浏览器弹出权限询问，请选择允许）…';
    try {
      const r = await BossLLM.testConnection({
        baseUrl: $('#llmBase').value.trim(),
        apiKey: $('#llmKey').value.trim(),
        modelFast: $('#llmFast').value.trim(),
        modelStrong: $('#llmStrong').value.trim()
      });
      $('#llmHint').innerHTML =
        `✅ 连通 · 模型 <b>${esc(r.model)}</b> · ${r.ms}ms` +
        `<br><span class="muted">${esc(r.endpoint)}</span>`;
      await updateModeBadge();
    } catch (err) {
      $('#llmHint').innerHTML = `<span style="color:#b42318">❌ ${esc(err.message)}</span>`;
    }
  }

  async function clearData() {
    if (!confirm('将清除全部本地数据（岗位、档案、分析历史、LLM 配置），且无法恢复。确定继续？')) return;
    await chrome.storage.local.clear();
    profiles = [];
    currentProfileId = null;
    history = [];
    lastReport = null;
    adviceCache.clear();
    toast('已清除');
    await loadProfiles();
    await loadLlmForm();
  }

  // ------------------------------------------------------------ 工具
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('on');
    setTimeout(() => el.classList.remove('on'), 1600);
  }

  async function copyText(text) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制');
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('已复制'); } catch (e2) { toast('复制失败'); }
      ta.remove();
    }
  }

  function relTime(ts) {
    if (!ts) return '';
    const d = Date.now() - ts;
    const M = 60000; const H = 3600000; const D = 86400000;
    if (d < M) return '刚刚';
    if (d < H) return `${Math.floor(d / M)} 分钟前`;
    if (d < D) return `${Math.floor(d / H)} 小时前`;
    if (d < 30 * D) return `${Math.floor(d / D)} 天前`;
    return new Date(ts).toLocaleDateString('zh-CN');
  }

  function exportCsv() {
    const rows = ((state && state.jobs) || []).filter((j) => j.checked);
    if (!rows.length) return toast('请先勾选要导出的岗位');
    const header = ['公司', '职位', '薪资', '城市', '区域', '经验', '学历', 'HR', '技能', '岗位职责', '能力要求', '加分项', '链接'];
    const csv = [header].concat(rows.map((j) => [
      j.company, j.title, j.salaryText, j.city, j.district, j.experience, j.degree,
      `${j.hrName || ''}${j.hrTitle ? '·' + j.hrTitle : ''}`,
      (j.skills || []).join('/'),
      ((j.jd && j.jd.duties) || []).join('；'),
      ((j.jd && j.jd.requirements) || []).join('；'),
      ((j.jd && j.jd.bonuses) || []).join('；'),
      j.jobUrl
    ])).map((r) => r.map((c) => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\n');

    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `boss-jobs-${Date.now()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`已导出 ${rows.length} 条`);
  }

  // ------------------------------------------------------------ 事件
  function bind() {
    $$('#pNav button').forEach((b) => b.addEventListener('click', () => setScene(b.dataset.nav)));
    $('#btnRefresh').addEventListener('click', async () => { await init(); toast('已刷新'); });

    $('#btnScrapeFoot').addEventListener('click', async () => {
      const r = await sendToTab({ cmd: 'SCRAPE' });
      if (!r) return toast('无法连接页面，请刷新岗位列表页');
      if (r.ok && r.started) { toast(`开始解析 ${r.count || 0} 个岗位`); await refresh(); }
      else toast(r.reason || '没有待解析的岗位');
    });

    $('#btnRescan').addEventListener('click', async () => {
      await sendToTab({ cmd: 'RESCAN_DOM' });
      await refresh();
      toast(`已重新扫描，共 ${((state && state.jobs) || []).length} 个`);
    });
    $('#btnDiag').addEventListener('click', async () => { await refresh(); renderDiag(); });
    $('#btnDiagBack').addEventListener('click', render);

    $('#btnClear').addEventListener('click', async () => {
      const n = ((state && state.jobs) || []).length;
      if (!n) return toast('当前没有记录');
      if (!confirm(`将清空全部 ${n} 条岗位记录，且无法恢复。确定继续？`)) return;
      await sendToTab({ cmd: 'CLEAR' });
      await refresh();
      toast('已清空');
    });

    $('#filterInput').addEventListener('input', (e) => { filter = e.target.value.trim(); if (state) renderTable(); });
    $$('#statusSeg button').forEach((btn) => btn.addEventListener('click', () => {
      statusFilter = btn.dataset.f;
      $$('#statusSeg button').forEach((b) => b.classList.toggle('on', b === btn));
      if (state) renderTable();
    }));
    $('#chkAll').addEventListener('change', async (e) => {
      const checked = e.target.checked;
      const keys = ((state && state.jobs) || []).filter(inScope).map((j) => j.key);
      await sendToTab({ cmd: 'TOGGLE_ALL', checked, keys });
      (state.jobs || []).forEach((j) => { if (keys.indexOf(j.key) >= 0) j.checked = checked; });
      renderTable();
    });
    $('#btnCsv').addEventListener('click', exportCsv);
    $('#btnAnalyze').addEventListener('click', () => { setScene('report'); runAnalysis(); });

    $('#btnGenReport').addEventListener('click', runAnalysis);
    $('#historyBody').addEventListener('click', (e) => {
      const item = e.target.closest('[data-run]');
      if (!item) return;
      const h = history[Number(item.dataset.run)];
      if (!h) return;
      lastReport = h.result;
      $('#reportBody').innerHTML = analysisHtml(h.result);
      $('#reportHint').textContent = `历史记录（${relTime(h.at)}）`;
    });

    $('#btnGenScript').addEventListener('click', generateScript);
    $('#btnChatAdvice').addEventListener('click', () => generateChatAdvice());
    $('#btnChatAbort').addEventListener('click', () => { chatAbort && chatAbort(); setChatGenerating(false); });
    $('#chkAutoAdvice').addEventListener('change', (e) => {
      autoAdvice = e.target.checked;
      chrome.storage.local.set({ bossoss_auto_advice: autoAdvice });
      toast(autoAdvice ? '已开启自动生成' : '已关闭自动生成');
    });
    bindChatAdvice();

    $('#btnSaveText').addEventListener('click', async () => {
      const text = $('#textBody').value.trim();
      if (text.length < 10) return toast('请至少粘贴 10 个字');
      const p = window.BossProfile.parseProfileText(text, $('#textName').value.trim());
      await window.BossProfile.add(p);
      $('#textBody').value = '';
      $('#textName').value = '';
      await loadProfiles();
      toast(`已创建，识别 ${p.skills.length} 项技能`);
    });

    $('#btnSaveForm').addEventListener('click', async () => {
      const p = window.BossProfile.fromForm({
        name: $('#fName').value,
        currentTitle: $('#fTitle').value,
        years: $('#fYears').value,
        city: $('#fCity').value,
        skills: $('#fSkills').value,
        highlights: $('#fHighlights').value,
        projects: $('#fProjects').value
      });
      await window.BossProfile.add(p);
      await loadProfiles();
      toast('已保存');
    });

    $('#profileSel').addEventListener('change', async (e) => {
      currentProfileId = e.target.value || null;
      await window.BossProfile.setCurrent(currentProfileId);
    });
    $('#btnNewProfile').addEventListener('click', () => setScene('profile'));

    $('#btnSaveLlm').addEventListener('click', saveLlm);
    $('#btnTestLlm').addEventListener('click', testLlm);
    $('#btnClearData').addEventListener('click', clearData);

    // 复制 / 填入（话术区用的静态属性版）
    document.addEventListener('click', async (e) => {
      const cp = e.target.closest('[data-copy]');
      if (cp) return copyText(cp.dataset.copy);
      const fl = e.target.closest('[data-fill]');
      if (fl) {
        if (page !== 'chat') return toast('请先打开聊天页 /web/geek/chat');
        const r = await sendToTab({ cmd: 'FILL_INPUT', text: fl.dataset.fill });
        if (r && r.ok) toast('已填入输入框，确认后点击发送');
        else { await copyText(fl.dataset.fill); toast('未能定位输入框，已复制'); }
      }
    });
  }

  bind();
  loadLlmForm();
  init();
})();
