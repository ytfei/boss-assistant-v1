/**
 * AI 分析：勾选岗位的共性要求 × 我的档案 → 优势 / 不足 / 应对 / 补足 / 岗位排序
 * （从服务端 analysis.py 移植）
 *
 * 关键：逐岗位匹配是**本地集合运算**，不是 LLM 调用 —— 20 个岗位的匹配毫秒级完成，
 * 所以「信息量全」和「成本可控」可以同时满足。
 */
(function (global) {
  'use strict';

  const S = global.BossSkills;
  const Batch = global.BossBatch;
  const Matcher = global.BossMatcher;

  // 单个岗位缺多少才算「关键差距」
  const GAP_CORE_RATIO = 0.3;

  function freqMap(skillFreq) {
    const out = {};
    for (const s of skillFreq || []) out[S.normalize(s.name)] = s.ratio;
    return out;
  }

  /** 按出现次数降序，去掉空值 */
  function rank(items, limit) {
    const counter = new Map();
    for (const s of items || []) {
      if (!s) continue;
      counter.set(s, (counter.get(s) || 0) + 1);
    }
    return Array.from(counter.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([s]) => S.display(s));
  }

  /**
   * 纯规则版分析（不调 LLM）。
   * @param {Array} jobs [{key,title,company,salaryText,city,jdRaw,skills}]
   * @param {object} profile {skills, projects, highlights, years, currentTitle}
   */
  function buildAnalysis(jobs, profile, maxJobs) {
    const items = (jobs || []).slice(0, maxJobs || 20);
    const report = Batch.buildReport(items);
    const freq = freqMap(report.skillFreq);

    const profileSkills = (profile && profile.skills) || [];
    const profileProjects = (profile && profile.projects) || [];

    const matchedAll = [];
    const partialAll = [];
    const missingAll = [];
    const ranking = [];

    for (const item of items) {
      const b = Batch.brief(item);
      const m = Matcher.matchJob({
        jdRequirements: b.requirements,
        jdSkills: b.skills,
        jdBonuses: b.bonuses,
        profileSkills,
        profileProjects,
        jobSkillFreq: freq
      });

      matchedAll.push(...m.matched);
      partialAll.push(...m.partial);
      missingAll.push(...m.missing);

      // 关键差距：只保留高频要求里缺的，避免长尾项吓唬用户
      const coreMissing = m.missing.filter((s) => (freq[S.normalize(s)] || 0) >= GAP_CORE_RATIO);
      let gap;
      if (coreMissing.length) {
        gap = `核心差距：${coreMissing.slice(0, 3).join('、')}`;
      } else if (m.score >= 50) {
        gap = '无明显硬伤，可重点打磨表达方式';
      } else {
        gap = '与岗位要求重合度较低';
      }

      ranking.push({
        key: item.key || '',
        title: item.title || '',
        company: item.company || '',
        salaryText: item.salaryText || '',
        score: m.score,
        matched: m.matched.slice(0, 6),
        missing: (coreMissing.length ? coreMissing : m.missing).slice(0, 6),
        gap
      });
    }

    ranking.sort((a, b) => b.score - a.score);

    const result = {
      jobCount: items.length,
      commonRequirements: report.skillFreq,
      dutyClusters: report.dutyClusters,
      salary: report.salary,
      strengths: rank(matchedAll, 8),
      weaknesses: rank(missingAll, 8),
      partial: rank(partialAll, 5),
      jobRanking: ranking,
      summary: '',
      model: 'rule-based'
    };

    result.pitchAdvice = pitchAdvice(result, profile || {});
    result.improveAdvice = improveAdvice(result, freq);
    result.summary = ruleSummary(result);
    return result;
  }

  /** 如何提炼优势应对这类岗位 */
  function pitchAdvice(r, profile) {
    const advice = [];
    const top = r.strengths.slice(0, 3);
    if (top.length) {
      advice.push(
        `开场就把 ${top.join('、')} 摆在最前 —— 这是这批岗位最高频、你也确实具备的能力`
      );
    }

    const highlights = profile.highlights || [];
    if (highlights.length) {
      advice.push(
        `用量化成果证明能力，而不是罗列技能。你手上最有力的一条：「${String(
          highlights[0]
        ).slice(0, 60)}」`
      );
    } else {
      advice.push(
        '简历里补 1–2 条量化成果（如“QPS 从 2k 提升到 1.2w”）。这类岗位普遍看结果，光写技术栈没有说服力'
      );
    }

    if (r.partial.length) {
      advice.push(`${r.partial.slice(0, 3).join('、')} 你有实际经验但技能栏没写，务必补上并附一句落地说明`);
    }

    if (r.jobRanking.length) {
      const best = r.jobRanking[0];
      advice.push(`优先投「${best.title || best.company}」这类（匹配度 ${best.score}），命中率最高`);
    }

    return advice.slice(0, 4);
  }

  /** 不足如何补足，按 ROI = 出现频次 排序（越高频越先补） */
  function improveAdvice(r, freq) {
    const scored = r.weaknesses.map((s) => [freq[S.normalize(s)] || 0, s]).sort((a, b) => b[0] - a[0]);
    const advice = [];
    for (const [ratio, s] of scored.slice(0, 4)) {
      const pct = Math.round(ratio * 100);
      const level =
        ratio >= 0.5
          ? '高频要求，优先补'
          : ratio >= GAP_CORE_RATIO
            ? '中频要求，了解核心用法即可'
            : '长尾项，面试前了解概念即可';
      advice.push(`${s}（${pct}% 岗位要求）— ${level}`);
    }
    if (!advice.length) advice.push('当前没有明显的能力缺口，重点放在表达与项目复盘上');
    return advice;
  }

  function ruleSummary(r) {
    const top = r.strengths.slice(0, 3).join('、') || '暂无明显重合技能';
    const gap = r.weaknesses.slice(0, 3).join('、') || '无明显硬伤';
    const common = r.commonRequirements.slice(0, 4).map((s) => s.name).join('、');
    return `这批 ${r.jobCount} 个岗位最看重：${common}。你的优势在 ${top}；主要差距是 ${gap}。`;
  }

  global.BossAnalysis = { buildAnalysis, ruleSummary };
})(window);
