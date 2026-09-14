/**
 * 岗位 + 简历 → 专属话术（从服务端 script_writer.py 移植）。
 *
 * 设计：规则路径就能产出可用话术（零成本、离线可用），LLM 只负责润色；
 * 并且带**自检**：开场白超字数 / 出现简历里没有的数据 / 模板腔 → 都要能被发现。
 *
 * ⚠️ 红线：只允许使用简历里真实存在的素材，绝不虚构经历与数字。
 */
(function (global) {
  'use strict';

  const MAX_OPENING = 80;

  // 话术里允许出现的数字必须能在简历素材里找到
  const NUM_RE = /\d+(?:\.\d+)?\s*(?:%|倍|万|K|k|ms|QPS|qps|TPS)/g;

  function skillsOf(d) {
    return (d && d.skills) || [];
  }

  function highlightsOf(d) {
    return (d && d.highlights) || [];
  }

  function projectsOf(d) {
    return (d && (d.projects || d.projectList)) || [];
  }

  /** 挑出「JD 要求 ∩ 我的技能」与「最匹配的量化成果」—— 话术的唯一素材来源 */
  function pickEvidence(job, profile, match) {
    const jdSkills = new Set(skillsOf(job).map((s) => String(s).toLowerCase()));
    const profSkills = skillsOf(profile);

    let overlap = profSkills.filter((s) => jdSkills.has(String(s).toLowerCase()));
    if (!overlap.length) {
      overlap = ((match && match.matched) || []).slice(0, 3).map(String);
    }
    if (!overlap.length) overlap = profSkills.slice(0, 3);

    let evidence = highlightsOf(profile).filter((h) =>
      overlap.some((s) => String(h).toLowerCase().indexOf(String(s).toLowerCase()) >= 0)
    );
    if (!evidence.length) evidence = highlightsOf(profile);

    return { overlap: overlap.slice(0, 3), evidence: evidence.slice(0, 2) };
  }

  /** 把一条成果压成干净短句：去掉句号结尾，超长截断 */
  function clause(text, limit) {
    const cap = limit || 42;
    let s = String(text || '').trim().replace(/^[。；，, ]+|[。；，, ]+$/g, '');
    if (!s) return '';
    return s.length <= cap ? s : s.slice(0, cap) + '…';
  }

  function shorten(text, limit) {
    const cap = limit || MAX_OPENING;
    const s = String(text || '').trim();
    if (s.length <= cap) return s;
    const cut = s.slice(0, cap);
    for (const sep of ['。', '，', '；', ' ']) {
      const idx = cut.lastIndexOf(sep);
      if (idx > cap * 0.6) {
        return cut.slice(0, idx) + '。';
      }
    }
    return cut + '…';
  }

  function numbers(text) {
    const out = [];
    const re = new RegExp(NUM_RE.source, 'g');
    let m;
    while ((m = re.exec(String(text || ''))) !== null) {
      out.push(m[0].replace(/\s+/g, ''));
    }
    return out;
  }

  /** 规则版话术（不调 LLM） */
  function ruleScript(job, profile, match) {
    job = job || {};
    profile = profile || {};
    match = match || {};

    const jobTitle = job.title || '这个岗位';
    const company = job.company || '贵司';
    const years = profile.years;
    const domain = profile.currentTitle || '开发';

    const { overlap, evidence } = pickEvidence(job, profile, match);
    const ability = overlap.length ? overlap.slice(0, 2).join('、') : '相关技术栈';
    const firstEv = evidence.length ? evidence[0] : '';

    const y = years ? `${years} 年` : '多年';
    const ev = clause(firstEv);

    const openings = [
      {
        label: '亮点前置版（推荐）',
        text: shorten(
          `您好，我有 ${y}${domain}经验，主要用${ability}。` +
            (ev ? `${ev}。` : '') +
            `看到${company}的${jobTitle}，跟我的经历比较对口，想进一步沟通。`
        )
      },
      {
        label: '稳重版',
        text: shorten(
          `您好，我对${jobTitle}很感兴趣。我目前做${domain}，${y}经验，` +
            `技术栈以${ability}为主，和 JD 要求比较匹配，方便聊聊吗？`
        )
      },
      {
        label: '提问式',
        text: shorten(
          `您好，想请教一下${company}这个${jobTitle}主要偏哪块业务？` +
            `我有${y}${domain}经验，技术栈是${ability}，如果方向合适想投递一下。`
        )
      }
    ];

    const intro =
      `我有 ${y}${domain}经验，主要用${ability}。` +
      (ev ? `${ev}。` : '') +
      '技术之外我习惯先对齐业务目标再动手，跨团队协作里比较受用。';

    const hooks = evidence.length
      ? evidence.map(
          (e) => `JD 里提到${ability}这块，我之前正好做过：${clause(e, 60)}。方便的话可以展开聊聊。`
        )
      : [`我的主要经验在${ability}，具体项目细节可以在面试时展开讲。`];

    const questions = [
      '这个岗位主要负责哪块业务？',
      '团队目前的技术栈和协作方式是怎样的？',
      '现阶段最希望新人先解决什么问题？'
    ];

    const objections = [
      {
        q: '期望薪资多少？',
        a: '先反问薪资结构（月薪 × 几薪、有无年终/股票），再给区间，不要先报价。'
      },
      {
        q: '为什么看机会？',
        a: '用正向表达：想做更高并发 / 更复杂的业务场景，而不是吐槽现公司。'
      }
    ];

    return { openings, intro, hooks, questions, objections, model: 'rule-based' };
  }

  /**
   * 自检：返回问题列表（空数组表示通过）。
   * 虚构检测很关键 —— 话术里出现简历没有的数据，等于让用户说谎。
   */
  function selfCheck(script, profile) {
    const issues = [];

    for (const o of script.openings || []) {
      if ((o.text || '').length > MAX_OPENING) {
        issues.push(`开场白「${o.label || ''}」超过 ${MAX_OPENING} 字`);
        break;
      }
    }

    const allowed = new Set(
      numbers([...highlightsOf(profile), ...projectsOf(profile)].join(' '))
    );
    const blob = [script.intro || '', ...(script.hooks || []), ...(script.questions || [])].join(' ');
    for (const n of numbers(blob)) {
      if (n && !allowed.has(n)) {
        issues.push(`话术出现了简历里没有的数据：${n}`);
        break;
      }
    }

    if (['本人性格开朗', '吃苦耐劳', '乐于学习', '团队合作精神'].some((p) => blob.indexOf(p) >= 0)) {
      issues.push('模板化表述过多');
    }

    return issues;
  }

  global.BossScript = {
    MAX_OPENING,
    ruleScript,
    selfCheck,
    shorten,
    clause,
    numbers,
    pickEvidence
  };
})(window);
