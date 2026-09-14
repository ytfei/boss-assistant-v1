/**
 * 岗位 × 简历 → 三档匹配矩阵（从服务端 matcher.py 移植）。
 *
 * 三档定义（产品差异化的核心）：
 *   ✅ matched 已具备     —— JD 要求 ∩ 简历技能            → 作为主推优势
 *   ⚠️ partial 有但没写透 —— 项目描述里有证据，但技能栏没写 → 需改表述
 *   ❌ missing 明确缺失   —— JD 要求 − 简历技能            → 按 ROI 排序补
 *
 * 本地规则即可算出三档；LLM 只用来生成「怎么说」的建议。
 */
(function (global) {
  'use strict';

  const S = global.BossSkills;

  // 出现率高于该阈值的要求，视为「这个岗位的核心要求」
  const CORE_RATIO = 0.3;

  function normSet(words) {
    const out = new Set();
    for (const w of words || []) {
      if (w) out.add(S.normalize(w));
    }
    return out;
  }

  /**
   * @param {object} args
   * @param {string[]} args.jdRequirements
   * @param {string[]} args.jdSkills
   * @param {string[]} [args.jdBonuses]
   * @param {string[]} args.profileSkills
   * @param {string[]} [args.profileProjects]
   * @param {Record<string, number>} [args.jobSkillFreq]
   */
  function matchJob(args) {
    const a = args || {};
    const reqWords = new Set([...normSet(a.jdRequirements), ...normSet(a.jdSkills)]);
    const profWords = normSet(a.profileSkills);

    // 简历里隐含的证据：项目描述中出现、但没写进技能栏的词
    const projectText = (a.profileProjects || []).join(' ');
    const implicit = new Set(
      [...normSet(S.extractSkills(projectText))].filter((w) => !profWords.has(w))
    );

    const matched = [...reqWords].filter((w) => profWords.has(w)).sort();
    const partial = [...reqWords].filter((w) => implicit.has(w)).sort();
    const missingAll = [...reqWords].filter((w) => !profWords.has(w) && !implicit.has(w)).sort();

    // 结合批次词频：只把「核心要求」的缺失算作真缺失，长尾不吓唬用户
    const freq = a.jobSkillFreq || null;
    let missingCore = missingAll;
    let missingLow = [];
    if (freq) {
      missingCore = missingAll.filter((m) => (freq[m] || 0) >= CORE_RATIO);
      missingLow = missingAll.filter((m) => missingCore.indexOf(m) < 0);
    }

    const denominator = Math.max(1, reqWords.size);
    let score = Math.round((100 * (matched.length + 0.5 * partial.length)) / denominator);
    score = Math.max(0, Math.min(100, score));

    return {
      score,
      matched: matched.map(S.display),
      partial: partial.map(S.display),
      missing: missingCore.map(S.display).concat(missingLow.map(S.display)),
      advice: localAdvice(matched, partial, missingCore),
      model: 'rule-based'
    };
  }

  function localAdvice(matched, partial, missing) {
    const advice = [];
    if (matched.length) {
      advice.push(
        `主推优势：${matched.slice(0, 3).map(S.display).join('、')} —— 放到简历摘要最前面`
      );
    }
    if (partial.length) {
      advice.push(
        `你有 ${partial.slice(0, 3).map(S.display).join('、')} 的落地经验，` +
          '但技能栏没写，建议补上并附量化结果'
      );
    }
    if (missing.length) {
      advice.push(
        `明确缺失：${missing.slice(0, 3).map(S.display).join('、')} —— 建议优先补第一项`
      );
    }
    if (!advice.length) {
      advice.push('简历与该岗位要求重合度较低，建议确认方向是否匹配');
    }
    return advice;
  }

  global.BossMatcher = { matchJob, CORE_RATIO };
})(window);
