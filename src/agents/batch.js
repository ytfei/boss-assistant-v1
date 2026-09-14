/**
 * 批次画像的统计层（从服务端 batch_insight.py 移植）。
 *
 * ⚠️ 这一层**完全不调 LLM**：薪资分布、技能词频、职责聚类都是本地运算，
 *    零成本、零延迟、离线可用，也不会因为上下文截断丢信息。
 *    只有叙述性的 summary 才交给 LLM（在 analysis.js 里决定）。
 */
(function (global) {
  'use strict';

  const S = global.BossSkills;

  /** 线性取分位（与 Python 实现一致：round 后 clamp） */
  function percentile(sortedValues, p) {
    if (!sortedValues.length) return null;
    const idx = Math.min(
      sortedValues.length - 1,
      Math.max(0, Math.round((sortedValues.length - 1) * p))
    );
    return sortedValues[idx];
  }

  /**
   * 薪资分布：以「月薪下限」为基准（更贴近实际给到的水平）。
   * 依赖 shared.js 的 parseSalary。
   */
  function salaryStats(items) {
    const parse = global.BossShared ? global.BossShared.parseSalary : null;
    const lows = [];
    const highs = [];

    for (const it of items || []) {
      const text = it.salaryText || it.salary_text || '';
      const s = parse ? parse(text) : { min: null, max: null };
      if (typeof s.min === 'number') lows.push(s.min);
      if (typeof s.max === 'number') highs.push(s.max);
    }

    if (!lows.length && !highs.length) {
      return { p25: null, median: null, p75: null, min: null, max: null, sample: 0 };
    }

    const base = (lows.length ? lows : highs).slice().sort((a, b) => a - b);
    const hs = highs.slice().sort((a, b) => a - b);
    return {
      p25: percentile(base, 0.25),
      median: percentile(base, 0.5),
      p75: percentile(base, 0.75),
      min: base[0],
      max: hs.length ? hs[hs.length - 1] : base[base.length - 1],
      sample: base.length
    };
  }

  /** 技能词频：JD 原文 + 职位名 + 技能标签一起统计，按出现次数降序 */
  function skillFreq(items, top) {
    const limit = top || 12;
    const counter = new Map();

    for (const it of items || []) {
      const text = [
        it.jdRaw || it.jd_raw || '',
        it.title || '',
        (it.skills || []).join(' ')
      ].join(' ');
      for (const s of S.extractSkills(text)) {
        counter.set(s, (counter.get(s) || 0) + 1);
      }
    }

    const total = (items || []).length || 1;
    return Array.from(counter.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([name, count]) => ({
        name: S.display(name),
        count,
        ratio: Math.round((count / total) * 1000) / 1000
      }));
  }

  /** 加分项排行 */
  function bonusRank(items, top) {
    const limit = top || 6;
    const counter = new Map();
    const parseJD = global.BossShared ? global.BossShared.parseJD : null;

    for (const it of items || []) {
      const parsed = parseJD ? parseJD(it.jdRaw || it.jd_raw || '') : { bonuses: [] };
      for (const s of S.extractSkills((parsed.bonuses || []).join(' '))) {
        counter.set(s, (counter.get(s) || 0) + 1);
      }
    }

    const total = (items || []).length || 1;
    return Array.from(counter.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([name, count]) => ({
        name: S.display(name),
        count,
        ratio: Math.round((count / total) * 1000) / 1000
      }));
  }

  /** 职责聚类：按句首动词归并，取出现最多的几条，每簇挑最短的一句作代表 */
  function dutyClusters(items, top) {
    const limit = top || 5;
    const parseJD = global.BossShared ? global.BossShared.parseJD : null;
    const buckets = new Map();

    for (const it of items || []) {
      const parsed = parseJD ? parseJD(it.jdRaw || it.jd_raw || '') : { duties: [], requirements: [] };
      const pool = (parsed.duties && parsed.duties.length) ? parsed.duties : (parsed.requirements || []);
      for (const d of pool) {
        if (d.length < 4 || d.length > 120) continue;
        const key = verbKey(d);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(d);
      }
    }

    return Array.from(buckets.entries())
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, limit)
      .map(([, group]) => group.slice().sort((a, b) => a.length - b.length)[0].slice(0, 80));
  }

  function verbKey(text) {
    const m = /^[^，。；：,]{0,8}(?:负责|参与|主导|搭建|设计|开发|优化|推进|维护|承担)/.exec(text || '');
    if (m) return m[0].replace(/\d+[.、)）]\s*/g, '').slice(0, 8);
    return String(text || '').slice(0, 6);
  }

  /** 单份 JD 的本地要点（对应服务端的 _local_brief，不调 LLM） */
  function brief(item) {
    const parseJD = global.BossShared ? global.BossShared.parseJD : null;
    const raw = item.jdRaw || item.jd_raw || '';
    const parsed = parseJD ? parseJD(raw) : { duties: [], requirements: [], bonuses: [] };
    return {
      title: item.title || '',
      company: item.company || '',
      salaryText: item.salaryText || item.salary_text || '',
      city: item.city || '',
      duties: parsed.duties || [],
      requirements: parsed.requirements || [],
      bonuses: parsed.bonuses || [],
      skills: S.extractSkills(`${item.title || ''} ${raw}`).map(S.display)
    };
  }

  /** 组装批次报告（统计部分；summary 留空由上层决定是否用 LLM 生成） */
  function buildReport(items) {
    const list = items || [];
    return {
      jobCount: list.length,
      salary: salaryStats(list),
      skillFreq: skillFreq(list),
      dutyClusters: dutyClusters(list),
      bonusRank: bonusRank(list),
      summary: '',
      model: 'rule-based'
    };
  }

  global.BossBatch = {
    percentile,
    salaryStats,
    skillFreq,
    bonusRank,
    dutyClusters,
    brief,
    buildReport
  };
})(window);
