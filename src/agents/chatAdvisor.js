/**
 * chatAdvisor：JD + 档案 + 对话 → 回复建议（从服务端 chat_advisor.py 移植）。
 *
 * 规则优先：3 条回复 + 雷区 + 信息清单都能本地出；LLM 只负责结合语境的个性化版本。
 * ⚠️ 红线：只允许使用档案里出现过的经历与数字，绝不编造。
 */
(function (global) {
  'use strict';

  const S = global.BossSkills;
  const Rules = global.BossChatRules;

  const MAX_REPLY = 80;
  const STRATEGY_NAMES = ['热情', '专业', '反问'];

  // 与服务端 context.py 一致：对话最近 12 条 × 200 字、JD 1500、档案 400
  const MSG_CLIP = 200;
  const MSG_LIMIT = 12;
  const JD_RAW_CLIP = 1500;
  const PROFILE_CLIP = 400;

  const SYSTEM_PROMPT = `你是资深求职沟通教练，帮候选人在 Boss 直聘上回复 HR。

硬约束（违反即作废）：
1. 只能使用【候选人档案】中出现过的经历、技能、公司和数字。**严禁编造**档案里没有的事实或数据，也不要替候选人承诺任何事情。
2. 每条 strategies[].text 不超过 80 字，口语化短句，像微信聊天，不要书面报告腔、不要排比句、不要"本人性格开朗/吃苦耐劳"这类空话。
3. 三条策略风格必须明显不同：热情（有亲和力、先给正向反馈）、专业（事实或数据前置）、反问（把主动权拿回来、顺势挖信息）。
4. 不确定的信息绝不承诺（到岗时间、薪资数字等），用"大致/左右"或反问代替。
5. risks 只输出 HR 这句话确实踩到的坑；missing 只输出对话里确实还没问清的关键信息，最多 4 条，每条给一句可直接发送的问法。
6. leverage 最多 3 条，每条必须附 evidence —— 证据只能来自档案里的技能/项目/亮点。

只输出 JSON，不要输出其它内容。`;

  function clip(text, limit) {
    const s = String(text || '').trim();
    return s.length <= limit ? s : s.slice(0, limit) + '…';
  }

  function fit(text, limit) {
    const cap = limit || MAX_REPLY;
    const s = String(text || '').trim();
    if (s.length <= cap) return s;
    const cut = s.slice(0, cap - 1);
    for (const sep of ['。', '！', '？', '，', '；', ' ']) {
      const idx = cut.lastIndexOf(sep);
      if (idx > cap * 0.6) {
        return (sep === '。' || sep === '！' || sep === '？') ? cut.slice(0, idx + 1) : cut.slice(0, idx) + '。';
      }
    }
    return cut + '…';
  }

  function yearsText(profile) {
    return profile && profile.years ? `${profile.years} 年` : '多年';
  }

  function domainOf(profile) {
    return String((profile && profile.currentTitle) || '开发').trim();
  }

  function topSkills(profile, limit) {
    const skills = (profile && profile.skills) || [];
    return skills.length ? skills.slice(0, limit || 2).join('、') : '相关技术栈';
  }

  function firstHighlight(profile) {
    for (const h of (profile && profile.highlights) || []) {
      const t = String(h).trim().replace(/^[。；，, ]+|[。；，, ]+$/g, '');
      if (t) return t.slice(0, 40);
    }
    return '';
  }

  function findEvidence(profile, skill) {
    const key = String(skill || '').toLowerCase();
    for (const h of [...((profile && profile.highlights) || []), ...((profile && profile.projects) || [])]) {
      if (String(h).toLowerCase().indexOf(key) >= 0) return String(h).slice(0, 60);
    }
    return '';
  }

  /** 挑出「这个 JD 最看重的 ∩ 我确实有的」作为可放大优势；没有证据的不能推 */
  function pickLeverage(job, profile, jd, limit) {
    const cap = limit || 3;
    const jdSkills = new Set((job && job.skills ? job.skills : []).map((s) => String(s).toLowerCase()));
    for (const s of ((jd && jd.skills) || [])) jdSkills.add(String(s).toLowerCase());
    const jdBlob = [...((jd && jd.duties) || []), ...((jd && jd.requirements) || [])].join(' ').toLowerCase();

    const candidates = [];
    for (const raw of (profile && profile.skills) || []) {
      const s = String(raw).trim();
      if (!s) continue;
      const hit = jdSkills.has(s.toLowerCase()) || (jdBlob && jdBlob.indexOf(s.toLowerCase()) >= 0);
      if (!hit) continue;
      const evidence = findEvidence(profile, s);
      candidates.push({ has: !!evidence, item: { point: s, evidence } });
    }

    let out = candidates.sort((a, b) => (a.has === b.has ? 0 : a.has ? -1 : 1)).map((c) => c.item);
    if (!out.some((i) => i.evidence)) {
      out = ((profile && profile.highlights) || [])
        .map((h) => String(h).trim())
        .filter(Boolean)
        .map((h) => ({ point: h.slice(0, 24), evidence: h.slice(0, 60) }));
    }
    return out.slice(0, cap);
  }

  /** 规则版 3 条策略（按话题分流） */
  function ruleStrategies(job, profile, topics) {
    job = job || {};
    profile = profile || {};
    const company = job.company || '贵司';
    const title = job.title || '这个岗位';
    const y = yearsText(profile);
    const domain = domainOf(profile);
    const ability = topSkills(profile);
    const ev = firstHighlight(profile);

    if (topics.indexOf('期望薪资') >= 0 || topics.indexOf('当前薪资') >= 0) {
      return [
        {
          name: '热情',
          text: fit('谢谢！我对这个方向挺感兴趣的。方便先了解下这边的薪资结构吗？比如几薪、年终和绩效大概怎么算～'),
          why: '先给正向反馈再反问结构，既不冷场也不先报价'
        },
        {
          name: '专业',
          text: fit('我这边主要看整体包（月薪 × 几薪 + 年终），期望会结合岗位职级来定。方便先说下这边的结构和区间吗？'),
          why: '用「整体包」替代具体数字，把锚点交回对方，避免被按涨幅压价'
        },
        {
          name: '反问',
          text: fit('想先确认下这个岗位的薪资结构和区间，我这边也好给一个更准确的期望，免得来回耽误您时间。'),
          why: '把「我在评估」的信号传过去，同时显得尊重对方时间'
        }
      ];
    }

    if (topics.indexOf('离职原因') >= 0) {
      return [
        {
          name: '热情',
          text: fit(`主要是想找业务量级更大的场景，我这边 ${y}${domain}经验，想再往上走一走。${company}这个${title}方向挺对口的～`),
          why: '正向表达诉求，完全不提对现状的不满'
        },
        {
          name: '专业',
          text: fit(`我在现在的岗位做了 ${y}，${ability}这块已经比较顺了，想找一个更有挑战的业务场景继续沉淀。`),
          why: '用「已到瓶颈 + 想要更大场景」解释，是最稳的跳槽叙事'
        },
        {
          name: '反问',
          text: fit(`主要是想做更复杂的业务，方便问下这个${title}进来后主要负责哪块吗？我判断下是不是我想深耕的方向。`),
          why: '把话题从「为什么走」转成「要去做什么」，主动权回到自己手上'
        }
      ];
    }

    if (topics.indexOf('到岗时间') >= 0) {
      return [
        {
          name: '热情',
          text: fit('顺利的话两周内可以到岗，中间需要把手上的事情交接清楚～'),
          why: '给确定时间 + 说明要交接，显得有责任心，而不是随时待命'
        },
        {
          name: '专业',
          text: fit('离职流程走完大概两周，如果这边比较急，我可以先配合做线上沟通。'),
          why: '给出可执行方案，而不是单纯讨价还价'
        },
        {
          name: '反问',
          text: fit('我这边交接完大约两周。想先确认下团队期望的到岗时间是？我尽量配合。'),
          why: '反问对方的真实时间预期，避免自己白报一个数字'
        }
      ];
    }

    return [
      {
        name: '热情',
        text: fit(
          `谢谢！我对${company}的${title}挺感兴趣的，我这边 ${y}${domain}经验，` +
            `${ability}用得比较多，${ev ? ev + '。' : ''}方便的话想进一步聊聊。`
        ),
        why: '先给正向反馈再亮最相关的经历，HR 最容易接话'
      },
      {
        name: '专业',
        text: fit(
          `${ability}是我主要的技术栈${ev ? '，' + ev : ''}。看 JD 里的方向比较契合，想了解下具体负责哪块业务。`
        ),
        why: '事实前置，直接建立「这人能对上」的判断'
      },
      {
        name: '反问',
        text: fit(
          `想先请教下这个${title}主要负责哪块业务？我 ${y}${domain}经验，` +
            `${ability}这块做得比较多，方向合适的话想深入聊聊。`
        ),
        why: '用提问把对话推进下去，顺便挖出判断岗位质量的信息'
      }
    ];
  }

  function lastHrText(messages) {
    for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
      if (!messages[i].mine) return String(messages[i].text || '');
    }
    return '';
  }

  function fmtConversation(messages, limit) {
    const rows = [];
    const list = (messages || []).slice(-(limit || MSG_LIMIT));
    for (const m of list) {
      const text = clip(m.text, MSG_CLIP);
      if (!text) continue;
      rows.push(`${m.mine ? '我' : 'HR'}：${text}`);
    }
    return rows.join('\n');
  }

  function fmtJob(job, jd) {
    job = job || {};
    jd = jd || {};
    const parts = [`职位：${job.title || '未知'}`, `公司：${job.company || '未知'}`];
    let salary = job.salaryText || '';
    if (!salary && job.salaryMax) salary = job.salaryMin ? `${job.salaryMin}-${job.salaryMax}K` : `${job.salaryMax}K`;
    if (salary) parts.push(`薪资：${salary}`);
    const extra = [job.city, job.experience, job.degree].filter(Boolean);
    if (extra.length) parts.push(`要求：${extra.join(' / ')}`);

    for (const [label, key] of [['职责', 'duties'], ['要求', 'requirements'], ['加分项', 'bonuses']]) {
      const items = (jd[key] || []).filter(Boolean);
      if (items.length) parts.push(`${label}：${items.slice(0, 6).join('；')}`);
    }
    const raw = jd.jdRaw || job.jdRaw || '';
    if (!(jd.duties || []).length && !(jd.requirements || []).length && raw) {
      parts.push(`JD 原文：${clip(raw, JD_RAW_CLIP)}`);
    }
    return parts.join('\n');
  }

  function fmtProfile(profile) {
    const p = profile || {};
    const parts = [];
    const head = p.years ? `${p.currentTitle || ''} / ${p.years} 年经验` : (p.currentTitle || '');
    if (String(head).trim()) {
      parts.push(`候选人：${head}${p.city ? `（${p.city}）` : ''}`);
    }
    for (const [label, key] of [['技能', 'skills'], ['项目', 'projects'], ['亮点', 'highlights']]) {
      const items = (p[key] || []).filter(Boolean);
      if (items.length) parts.push(`${label}：${items.slice(0, 12).join('、')}`);
    }
    if (p.summary) parts.push(`简介：${clip(p.summary, PROFILE_CLIP)}`);
    return parts.join('\n');
  }

  function buildPrompt(args) {
    const { profile, job, jd, conversation } = args || {};
    return (
      '【岗位】\n' + fmtJob(job, jd) +
      '\n\n【候选人档案】（唯一事实来源，不得超出这个范围发挥）\n' + fmtProfile(profile) +
      '\n\n【最近对话】\n' + (fmtConversation(conversation) || '（暂无对话记录）') +
      '\n\n【需要回复的那一句】\n' +
      (clip(lastHrText(conversation), MSG_CLIP) || '（HR 还没说话，需要主动打招呼）') +
      '\n\n请按硬约束输出 ChatAdvice。'
    );
  }

  /** 规则版建议（不调 LLM 也能用） */
  function ruleAdvice(args) {
    const { profile, job, jd, conversation } = args || {};
    const text = lastHrText(conversation);
    const risks = Rules.detectRisks(text);
    const topics = risks.map((r) => r.topic);
    const missing = Rules.infoChecklist(
      (conversation || []).slice(-24).map((m) => clip(m.text, MSG_CLIP)).join('\n')
    );
    const askedSalary = topics.indexOf('期望薪资') >= 0 || topics.indexOf('当前薪资') >= 0;

    let intent;
    if (!text) intent = 'HR 还没说话，这次是主动打招呼 —— 目标是争取一个回复';
    else if (topics.length) intent = `HR 在确认：${topics.join('、')}`;
    else intent = 'HR 在推进沟通，重点是接住话题并争取下一步';

    return {
      intent,
      strategies: ruleStrategies(job, profile, topics),
      risks,
      missing,
      leverage: pickLeverage(job, profile, jd),
      salaryHint: Rules.salaryHint(job, askedSalary),
      jdMatched: false,
      model: 'rule-based'
    };
  }

  /** 把 LLM 结果洗干净：约束字数、补齐缺失、合并规则层的雷区与清单 */
  function finalize(advice, args) {
    const rule = args.rule;
    const strategies = [];
    (advice.strategies || []).forEach((s, i) => {
      const text = fit(s && s.text);
      if (!text) return;
      strategies.push({
        name: String((s && s.name) || '').trim() || STRATEGY_NAMES[Math.min(i, 2)],
        text,
        why: String((s && s.why) || '').slice(0, 80)
      });
    });

    // LLM 给少了就用规则版补齐，保证永远有 3 条可选
    for (const fb of rule.strategies) {
      if (strategies.length >= 3) break;
      if (strategies.some((s) => s.text === fb.text)) continue;
      strategies.push(fb);
    }

    return {
      intent: String(advice.intent || '').trim() || rule.intent,
      strategies: strategies.slice(0, 3),
      risks: Rules.mergeRisks(advice.risks, args.risks),
      missing: Rules.mergeMissing(advice.missing, args.missing).slice(0, 4),
      leverage: (advice.leverage && advice.leverage.length) ? advice.leverage : args.leverage,
      salaryHint: advice.salaryHint || args.hint,
      jdMatched: !!args.jdMatched,
      model: args.model || 'llm'
    };
  }

  global.BossChatAdvisor = {
    SYSTEM_PROMPT,
    MAX_REPLY,
    MSG_CLIP,
    MSG_LIMIT,
    clip,
    fit,
    ruleAdvice,
    ruleStrategies,
    pickLeverage,
    buildPrompt,
    finalize,
    lastHrText,
    fmtConversation,
    fmtJob,
    fmtProfile
  };
})(window);
