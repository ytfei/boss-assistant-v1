/**
 * 聊天雷区与信息清单的**规则层**（从服务端 chat_rules.py 移植）。
 *
 * 为什么「有没有坑」不用 LLM 判断：
 *   - 必须确定性，LLM 会漏判
 *   - 零成本、零延迟、可离线单测
 *   - LLM 漏掉的雷区，由这一层补上（端点层做合并去重）
 */
(function (global) {
  'use strict';

  // [话题, 正则, 为什么是坑, 怎么应对]
  const TOPIC_RULES = [
    [
      '期望薪资',
      /期望?薪[资酬]|薪[资酬]期望|想要多少|期望多少|薪[资酬]要求|薪[资酬]预期|报个?价/,
      '先报价会失去锚点：说低了后面难涨，说高了直接出局',
      '先反问薪资结构（月薪 × 几薪、年终、股票），再给区间，上限贴着岗位上限'
    ],
    [
      '当前薪资',
      /目前薪[资酬]|现在薪[资酬]|当前薪[资酬]|税前|到手|base|现在拿多少|上家给多少/,
      '说出当前薪资会被按「涨幅 20–30%」压价，等于把议价空间让出去',
      '不报明细，只说整体包的区间，并把话题拉回期望而非现状'
    ],
    [
      '离职原因',
      /离职原因|跳槽原因|为什么[^。？！\n]{0,6}(离开|离职|走|换|看机会)|不要你了吗/,
      '抱怨前公司 / 领导 / 同事是最常见的减分项，会被判定为不稳定',
      '正向表达：想做更复杂、更高量级的业务，而不是吐槽现在'
    ],
    [
      '到岗时间',
      /什么时候(能|可以)?(到岗|入职|来|上班)|到岗时间|入职时间|多久能到|什么时候能来/,
      '回答「随时」会被判定为不好卖，回答太久又可能直接错失',
      '给确定区间（如「两周内」），并说明需要交接，显得靠谱'
    ],
    [
      '加班与强度',
      /加班|995|996|007|大小周|工作强度|强度能接受|能接受.*(强度|加班)|节奏/,
      '直接拒绝可能出局，直接答应会给后面埋雷',
      '先反问团队真实节奏，再表达「关键节点能配合」，不要承诺无条件'
    ],
    [
      '学历',
      /学历|统招|全日制|专升本|自考|第一学历|是不是(本科|专科)|哪个学校/,
      '回避或含糊会显得心虚，反而放大劣势',
      '如实一句话说明，立刻把话题拉回项目与能力，不要展开解释'
    ],
    [
      '是否海投 / 其他 offer',
      /投了(哪些|多少|几家)|其他offer|有没有其他|在看哪些|面试了几家|拿到几个/,
      '说「只投了你们」会削弱议价；说太多会显得骑驴找马',
      '说在看几家同方向的机会、都还在初筛阶段，并强调这家是最匹配的'
    ],
    [
      '婚育与年龄',
      /结婚|生育|婚育|有孩子|打算要(孩子|宝宝)|二胎|年龄|多大了|几几年的/,
      '涉及隐私，回答不当既可能踩歧视也可能被风险判定',
      '简短回答个人规划，随即转到岗位本身；不想答可直接跳过'
    ]
  ];

  // [还差什么, 已经聊过的信号, 可直接发送的问法]
  const INFO_RULES = [
    [
      '薪资结构与月数',
      // 「13薪」常被写成「13 薪」，\s* 必须有，否则会重复追问 HR 已经回答过的问题
      /几薪|年终|1[3-9]\s*薪|绩效|奖金|期权|股票|薪资结构/,
      '方便问下薪资结构是几薪吗？年终和绩效大致怎么算？'
    ],
    [
      '团队规模与汇报对象',
      /团队(规模|多少人|多大)|汇报|几个人|组织架构|带几个人/,
      '这个岗位所在团队多大规模？日常向谁汇报？'
    ],
    [
      '到岗时间',
      /到岗|入职时间|什么时候(能|可以)?(来|入职)/,
      '如果顺利的话，这边期望什么时候到岗？'
    ],
    [
      '工作地点与节奏',
      /办公(地点|地址)|加班|出差|大小周|通勤|上班时间/,
      '办公地点在哪？团队日常的节奏大概是怎样的？'
    ],
    [
      '试用期与五险一金',
      /试用|五险|公积金|基数|社保/,
      '试用期多久？五险一金是按什么基数缴纳的？'
    ],
    [
      '业务方向与日常产出',
      /业务(方向|线)?|主要负责|日常(做|工作)|KPI|OKR|做什么(业务|方向)/,
      '这个岗位进来后主要负责哪块业务？前三个月最希望解决什么问题？'
    ],
    [
      '面试流程',
      /面试(流程|几轮)?|几面|笔[试经]|二面|终面/,
      '后续面试流程大概是怎样的？我好提前准备一下。'
    ]
  ];

  /** 识别 HR 这句话里的谈判雷区；空数组表示没踩坑 */
  function detectRisks(text) {
    const s = String(text || '').trim();
    if (!s) return [];
    const out = [];
    for (const [topic, re, why, doWhat] of TOPIC_RULES) {
      if (re.test(s)) out.push({ topic, why, do: doWhat });
    }
    return out;
  }

  /** 已经聊过的信息会被跳过 —— 问 HR 已经回答过的问题很减分 */
  function infoChecklist(conversationText, limit) {
    const s = String(conversationText || '');
    const out = [];
    for (const [item, re, question] of INFO_RULES) {
      if (re.test(s)) continue;
      out.push({ item, question });
    }
    return out.slice(0, limit || 4);
  }

  function sameTopic(a, b) {
    const x = String(a || '').trim();
    const y = String(b || '').trim();
    if (!x || !y) return false;
    return x === y || x.indexOf(y) >= 0 || y.indexOf(x) >= 0;
  }

  /** 合并 LLM 与规则的雷区：LLM 在前（更贴合语境），规则补漏 */
  function mergeRisks(primary, fallback) {
    const out = [];
    for (const r of [...(primary || []), ...(fallback || [])]) {
      if (!String(r.topic || '').trim()) continue;
      if (out.some((k) => sameTopic(r.topic, k.topic))) continue;
      out.push(r);
    }
    return out;
  }

  function mergeMissing(primary, fallback) {
    const out = [];
    const seen = new Set();
    for (const m of [...(primary || []), ...(fallback || [])]) {
      const key = String(m.item || '').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
    return out;
  }

  /** 只在 HR 问到薪资时给锚定建议；数字全部取自岗位本身，不推测 */
  function salaryHint(job, askedSalary) {
    if (!askedSalary) return null;
    const low = job ? job.salaryMin : null;
    const high = job ? job.salaryMax : null;
    if (!high) return '先反问薪资结构（几薪、年终、绩效占比），把锚点交回给对方再报数。';
    if (low) {
      return (
        `岗位标注 ${low}-${high}K，可先反问结构，再报 ${high}K 附近；` +
        '不要主动报下限，也不要先于对方给区间。'
      );
    }
    return `岗位标注上限 ${high}K，先反问结构再报数，别先给区间。`;
  }

  global.BossChatRules = {
    TOPIC_RULES,
    INFO_RULES,
    detectRisks,
    infoChecklist,
    mergeRisks,
    mergeMissing,
    salaryHint
  };
})(window);
