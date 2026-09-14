/**
 * 本地档案（开源版没有服务端，档案只存在浏览器里）。
 *
 * 支持两种建法：粘贴简历文本（规则抽取）+ 手填表单（补齐抽取不准的字段）。
 * 抽取是**尽力而为** —— 抽不准不猜，留给用户改，免得 AI 拿着错误素材编话术。
 */
(function (global) {
  'use strict';

  const S = global.BossSkills;

  const STORE_KEY = 'bossoss_profile_v1';
  const CURRENT_KEY = 'bossoss_profile_current_v1';
  const MAX_PROFILES = 20;

  const CITIES = [
    '北京', '上海', '广州', '深圳', '杭州', '成都', '南京', '武汉', '西安', '苏州',
    '厦门', '长沙', '重庆', '天津', '郑州', '合肥', '济南', '青岛', '福州', '宁波',
    '无锡', '东莞', '珠海', '沈阳', '大连', '昆明', '南昌', '贵阳', '南宁', '石家庄',
    '哈尔滨', '长春', '海口', '常州', '温州', '佛山', '惠州', '嘉兴', '绍兴', '金华'
  ];

  const TITLE_RE = /[\u4e00-\u9fa5A-Za-z]{0,8}(工程师|架构师|开发|研发|经理|总监|专家|负责人|技术专家)/;

  function splitSentences(text) {
    return String(text || '')
      .split(/[\n。；;]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 4);
  }

  /** 从粘贴的文本里抽取档案（规则版，不调 LLM） */
  function parseProfileText(text, name) {
    const raw = String(text || '').trim();
    const sentences = splitSentences(raw);

    const years = S.extractYears(raw);

    const titleM = TITLE_RE.exec(raw);
    const currentTitle = titleM ? titleM[0].replace(/^[^\u4e00-\u9fa5A-Za-z]+/, '') : '';

    let city = '';
    for (const c of CITIES) {
      if (raw.indexOf(c) >= 0) { city = c; break; }
    }

    const skills = S.extractSkills(raw).map(S.display);

    // 项目：提到项目/负责/主导/搭建/重构，或带编号的句子
    const projects = sentences
      .filter((s) => /项目|负责|主导|搭建|重构|从零|设计并实现|落地/.test(s))
      .slice(0, 6);

    // 亮点：含量化结果的句子（数字 + 单位）
    const highlights = sentences
      .filter((s) => /\d/.test(s) && /%|倍|万|k|K|ms|QPS|qps|TPS|提升|降低|减少|增长/.test(s))
      .slice(0, 6);

    return {
      id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: (name || '').trim() || `文本档案 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`,
      source: 'text',
      years: years || null,
      currentTitle,
      city,
      skills,
      projects,
      highlights,
      summary: raw.slice(0, 400),
      rawInput: raw.slice(0, 20000),
      createdAt: Date.now()
    };
  }

  /** 手填表单：字段直接用用户填的，不猜 */
  function fromForm(form) {
    const f = form || {};
    const toList = (v) =>
      String(v || '')
        .split(/[，,、\n]/)
        .map((x) => x.trim())
        .filter(Boolean);

    return {
      id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: (f.name || '').trim() || `手填档案 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`,
      source: 'form',
      years: f.years ? Number(f.years) : null,
      currentTitle: (f.currentTitle || '').trim(),
      city: (f.city || '').trim(),
      skills: toList(f.skills),
      projects: toList(f.projects),
      highlights: toList(f.highlights),
      summary: (f.summary || '').trim(),
      rawInput: '',
      createdAt: Date.now()
    };
  }

  async function list() {
    try {
      const data = await chrome.storage.local.get([STORE_KEY]);
      return (data && data[STORE_KEY]) || [];
    } catch (_) {
      return [];
    }
  }

  async function currentId() {
    try {
      const data = await chrome.storage.local.get([CURRENT_KEY]);
      return (data && data[CURRENT_KEY]) || '';
    } catch (_) {
      return '';
    }
  }

  async function current() {
    const rows = await list();
    if (!rows.length) return null;
    const id = await currentId();
    return rows.find((p) => p.id === id) || rows[0];
  }

  async function add(profile) {
    const rows = await list();
    rows.unshift(profile);
    const trimmed = rows.slice(0, MAX_PROFILES);
    await chrome.storage.local.set({ [STORE_KEY]: trimmed });
    await chrome.storage.local.set({ [CURRENT_KEY]: profile.id });
    return profile;
  }

  async function remove(id) {
    const rows = (await list()).filter((p) => p.id !== id);
    await chrome.storage.local.set({ [STORE_KEY]: rows });
    if ((await currentId()) === id) {
      await chrome.storage.local.set({ [CURRENT_KEY]: rows.length ? rows[0].id : '' });
    }
  }

  async function setCurrent(id) {
    await chrome.storage.local.set({ [CURRENT_KEY]: id });
  }

  global.BossProfile = {
    STORE_KEY,
    CURRENT_KEY,
    parseProfileText,
    fromForm,
    list,
    current,
    currentId,
    add,
    remove,
    setCurrent
  };
})(window);
