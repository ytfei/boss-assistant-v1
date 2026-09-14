/**
 * shared.js —— ISOLATED world 公共层：协议解析 + 本地规则解析 + 轻量工具。
 * 被 jobs.js / chat.js 共用（content_scripts 按顺序加载，共享全局变量）。
 */
(function (global) {
  'use strict';

  const API = {
    OK: (b) => b && b.code === 0,
    parse(text) {
      try {
        return JSON.parse(text);
      } catch (_) {
        return null;
      }
    },
    dataOf(json) {
      return json && json.zpData !== undefined ? json.zpData : null;
    }
  };

  // ---------------------------------------------------------------- 岗位解析
  /**
   * 列表接口 zpData.jobList[] → 结构化岗位。
   * 字段名做多重兜底：搜索页与推荐页返回的键名不完全一致。
   */
  function parseJobListItem(j) {
    const gps = j.gps || j.location || null;
    return {
      source: 'list',
      securityId: j.securityId || j.encryptSecurityId || '',
      encryptJobId: j.encryptJobId || j.encryptId || j.jobId || '',
      encryptBossId: j.encryptBossId || j.encryptUserId || '',
      title: j.jobName || j.jobTitle || j.title || '',
      salaryText: j.salaryDesc || j.salary || '',
      experience: j.jobExperience || j.experienceName || j.experience || '',
      degree: j.jobDegree || j.degreeName || j.degree || '',
      city: j.cityName || j.locationName || j.city || '',
      cityCode: j.city || j.location || null,
      district: j.areaDistrict || j.district || '',
      businessDistrict: j.businessDistrict || '',
      address: j.address || '',
      company: j.brandName || j.companyName || j.brandComName || '',
      companyStage: j.brandStageName || j.stageName || '',
      companyIndustry: j.brandIndustry || j.industryName || '',
      companyScale: j.brandScaleName || j.scaleName || '',
      companyLogo: j.brandLogo || j.logo || '',
      hrName: j.bossName || j.hrName || '',
      hrTitle: j.bossTitle || j.hrTitle || '',
      hrOnline: !!(j.bossOnline || j.online),
      skills: j.skills || j.showSkills || [],
      labels: j.jobLabels || j.labels || [],
      welfare: j.welfareList || [],
      gps: gps
        ? { lng: gps.longitude || gps.lng, lat: gps.latitude || gps.lat }
        : null,
      proxyJob: j.proxyJob === 1 || j.proxyType === 1,
      jobUrl: (j.encryptJobId || j.jobId)
        ? `https://www.zhipin.com/job_detail/${j.encryptJobId || j.jobId}.html`
        : '',
      jd: null
    };
  }

  /**
   * DOM 兜底：当接口没被拦到时（如搜索页 SSR），直接从卡片抓字段。
   * 这条路拿不到 securityId，所以 JD 需要后续补抓。
   */
  function parseDomJobCards(root) {
    const doc = root || document;
    const cards = Array.from(
      doc.querySelectorAll('[class*="job-card"], li[class*="job-card"], .job-card-wrapper')
    );
    const seen = new Set();
    const out = [];

    for (const el of cards) {
      const pick = (sels) => {
        for (const s of sels) {
          const n = el.querySelector(s);
          if (n && n.textContent) {
            const t = n.textContent.trim();
            if (t) return t;
          }
        }
        return '';
      };
      const title = pick(['[class*="job-name"]', '[class*="job-title"]', '.job-title']);
      const company = pick(['[class*="company-name"]', '[class*="brand-name"]', '[class*="company"]']);
      const salary = pick(['[class*="salary"]', '[class*="job-salary"]']);
      if (!title && !company) continue;

      const area = pick(['[class*="job-area"]', '[class*="area"]']);
      const tags = Array.from(el.querySelectorAll('[class*="tag-item"], .tag-item'))
        .map((n) => n.textContent.trim())
        .filter(Boolean);
      const linkEl = el.querySelector('a[href*="/job_detail/"]');
      const href = linkEl ? linkEl.getAttribute('href') : '';
      const encryptJobId = (href.match(/\/job_detail\/([^.?]+)/) || [])[1] || '';

      const key = [company, title, area, salary].join('|');
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        source: 'dom',
        securityId: '',
        encryptJobId,
        encryptBossId: '',
        title,
        salaryText: salary,
        experience: tags[0] || '',
        degree: tags[1] || '',
        city: (area || '').split(/[·•\s]/)[0] || '',
        cityCode: null,
        district: '',
        businessDistrict: '',
        address: '',
        company,
        companyStage: '',
        companyIndustry: '',
        companyScale: '',
        companyLogo: '',
        hrName: '',
        hrTitle: '',
        hrOnline: false,
        skills: tags.slice(2),
        labels: tags,
        welfare: [],
        gps: null,
        proxyJob: false,
        jobUrl: href ? new URL(href, location.origin).href : '',
        jd: null
      });
    }
    return out;
  }

  /** 详情接口 zpData → 补充 JD 与地址等 */
  function parseJobDetail(zp) {
    const ji = (zp && zp.jobInfo) || {};
    const bc = (zp && zp.brandComInfo) || {};
    const bi = (zp && zp.bossInfo) || {};
    const desc = ji.postDescription || '';
    const parsed = parseJD(desc);

    return {
      securityId: zp.securityId || '',
      encryptJobId: ji.encryptId || '',
      title: ji.jobName || '',
      positionName: ji.positionName || '',
      salaryText: ji.salaryDesc || '',
      experience: ji.experienceName || '',
      degree: ji.degreeName || '',
      city: ji.locationName || '',
      address: ji.address || '',
      gps: ji.longitude ? { lng: ji.longitude, lat: ji.latitude } : null,
      company: bc.brandName || '',
      companyStage: bc.stageName || '',
      companyScale: bc.scaleName || '',
      hrName: bi.name || '',
      hrTitle: bi.title || '',
      skills: ji.showSkills || [],
      jobStatus: ji.jobStatusDesc || '',
      jdRaw: desc,
      jd: parsed
    };
  }

  // ------------------------------------------------- JD 本地规则解析（零成本）
  const RE_REQUIRE =
    /(任职要求|岗位要求|职位要求|任职资格|应聘条件|岗位要求：|要求：)/;
  const RE_BONUS = /(加分项|优先考虑|优先条件|加分|以下为加分|具备以下条件者优先)/;

  /**
   * 把一整段 postDescription 拆成 职责 / 要求 / 加分项。
   * 规则依据见 docs/04 第 2 节：JD 是纯文本，靠小标题分段。
   */
  function parseJD(raw) {
    const result = { duties: [], requirements: [], bonuses: [], raw: raw || '' };
    if (!raw) return result;

    const lines = String(raw)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    let section = 'duties';
    for (const line of lines) {
      if (RE_BONUS.test(line) && line.length < 20) {
        section = 'bonuses';
        continue;
      }
      if (RE_REQUIRE.test(line) && line.length < 20) {
        section = 'requirements';
        continue;
      }
      const cleaned = line.replace(/^\d+[.、)）]\s*/, '').replace(/^\d+）\s*/, '');
      if (cleaned.length < 2) continue;
      result[section === 'bonuses' ? 'bonuses' : section].push(cleaned);
    }

    // 标题行没识别到时，做一次兜底：含"优先"的句子归入加分项
    if (!result.bonuses.length) {
      result.requirements = result.requirements.filter((t) => {
        if (/优先|加分/.test(t)) {
          result.bonuses.push(t);
          return false;
        }
        return true;
      });
    }
    return result;
  }

  /** "40-70K" / "80-100K·15薪" → {min,max,months} */
  function parseSalary(text) {
    if (!text) return { min: null, max: null, months: null, text: '' };
    const m = String(text).match(/(\d+(?:\.\d+)?)\s*[-~]\s*(\d+(?:\.\d+)?)/);
    const months = String(text).match(/(\d+)\s*薪/);
    const unit = /K|k/.test(text) ? 1000 : 1;
    return {
      min: m ? Number(m[1]) * unit : null,
      max: m ? Number(m[2]) * unit : null,
      months: months ? Number(months[1]) : null,
      text: String(text)
    };
  }

  // ---------------------------------------------------------------- 聊天解析
  /** 会话列表项 */
  function parseFriend(f) {
    return {
      securityId: f.securityId || '',
      encryptBossId: f.encryptBossId || '',
      uid: f.uid || null,
      name: f.name || '',
      avatar: f.avatar || f.tinyUrl || '',
      title: f.title || '',
      company: f.brandName || '',
      lastMsg: f.lastMsg || '',
      unread: f.unreadMsgCount || 0,
      lastTS: f.lastTS || 0,
      isTop: f.isTop === 1
    };
  }

  /**
   * 历史消息 → 精简对话。
   * ⚠️ received 恒为 true，必须用 from.uid 与 HR 的 uid 比对判断方向。
   */
  function parseMessages(messages, hrUid) {
    return (messages || [])
      .map((m) => {
        const body = m.body || {};
        const isBoss = hrUid != null && m.from && m.from.uid === hrUid;
        return {
          mid: m.mid,
          time: m.time,
          type: m.type,
          mine: !isBoss,
          from: m.from ? m.from.name : '',
          text: body.text || '',
          jobCard: body.jobDesc
            ? {
                title: body.jobDesc.title,
                salary: body.jobDesc.salary,
                city: body.jobDesc.city,
                experience: body.jobDesc.experience,
                education: body.jobDesc.education
              }
            : null
        };
      })
      .filter((m) => m.text || m.jobCard);
  }

  // ---------------------------------------------------------------- 其它工具
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (min, max) => min + Math.random() * (max - min);
  const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

  function dedupeKey(job) {
    return [job.company, job.title, job.city, job.salaryText].join('|');
  }

  /**
   * 岗位四元组 —— 服务端据此算 source_hash 回查已抓 JD。
   * ⚠️ 不要在插件端算哈希：md5 需要额外实现，且两端顺序一旦不一致就永远匹配不上。
   *    这里只传原始字段，由服务端 `repositories.source_hash()` 统一计算。
   */
  function jobKey(job) {
    const j = job || {};
    return {
      company: j.company || '',
      title: j.title || '',
      city: j.city || '',
      salaryText: j.salaryText || '',
      salaryMin: j.salaryMin == null ? null : j.salaryMin,
      salaryMax: j.salaryMax == null ? null : j.salaryMax,
      experience: j.experience || '',
      degree: j.degree || ''
    };
  }

  global.BossShared = {
    API,
    parseJobListItem,
    parseDomJobCards,
    parseJobDetail,
    parseJD,
    parseSalary,
    parseFriend,
    parseMessages,
    jobKey,
    sleep,
    rand,
    uid,
    dedupeKey
  };
})(window);
