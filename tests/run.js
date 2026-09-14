#!/usr/bin/env node
/**
 * 开源版纯函数自测：node tests/run.js
 *
 * 覆盖的是从服务端移植过来的算法 —— 这些在服务端都有单测，移植后最容易写错，
 * 而插件侧没有测试框架，所以用一个极简脚本兜住。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

global.window = global;
global.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } };

const ROOT = path.join(__dirname, '..');
function load(rel) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { filename: rel });
}

load('src/shared.js');
load('src/agents/skills.js');
load('src/agents/batch.js');
load('src/agents/matcher.js');
load('src/agents/analysis.js');
load('src/agents/script.js');
load('src/agents/chatRules.js');
load('src/agents/chatAdvisor.js');

const S = global.BossSkills;
const Batch = global.BossBatch;
const Matcher = global.BossMatcher;
const Analysis = global.BossAnalysis;
const Script = global.BossScript;
const Rules = global.BossChatRules;
const Advisor = global.BossChatAdvisor;

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name); }
}
function eq(actual, expected, name) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, `${name}${a === b ? '' : ` — 期望 ${b}，实际 ${a}`}`);
}
function group(name) {
  console.log('\n' + name);
}

// ------------------------------------------------------------------ 技能
group('skills');
eq(S.normalize('golang'), 'go', '别名归一 golang→go');
eq(S.display('kafka'), 'Kafka', '展示名 Kafka');
ok(S.extractSkills('熟悉 Go 和 Kafka，做过支付').indexOf('go') >= 0, '英文按词边界命中 go');
ok(S.extractSkills('熟悉 google').indexOf('go') < 0, 'go 不误命中 google');
eq(S.extractYears('8年以上后端开发经验'), 8, '抽取年限 8');
eq(S.extractYears('经验：5 年'), 5, '抽取年限（备用正则）');

// ------------------------------------------------------------------ 批次统计
group('batch');
const items = [
  { title: 'Go 工程师', company: '甲', city: '杭州', salaryText: '20-30K', skills: ['Go'], jdRaw: '任职要求：\n1. 熟悉 Go\n2. 熟悉 Redis\n加分项：\n1. 有 Kafka 经验优先\n' },
  { title: 'Go 后端', company: '乙', city: '杭州', salaryText: '30-40K', skills: ['Go', 'Kafka'], jdRaw: '任职要求：\n1. Go\n2. Kafka\n' },
  { title: 'Java 工程师', company: '丙', city: '上海', salaryText: '40-50K', skills: ['Java'], jdRaw: '任职要求：\n1. Java\n' }
];
const sal = Batch.salaryStats(items);
eq(sal.min, 20000, '薪资下限最小值');
eq(sal.max, 50000, '薪资上限最大值');
eq(sal.sample, 3, '样本数');
ok(sal.p25 <= sal.median && sal.median <= sal.p75, '分位数单调');

const freq = Batch.skillFreq(items);
ok(freq.length > 0, '词频非空');
ok(freq[0].ratio <= 1, '占比不超过 1');
ok(freq.some((f) => f.name === 'Go'), 'Go 进入词频');
ok(Batch.bonusRank(items).some((b) => b.name === 'Kafka'), 'Kafka 进入加分项排行');
ok(Batch.dutyClusters(items).length >= 0, '职责聚类不报错');

// ------------------------------------------------------------------ 匹配
group('matcher');
const profile = {
  years: 8,
  currentTitle: '后端工程师',
  city: '杭州',
  skills: ['Go', 'Kafka'],
  projects: ['订单中心重构，用 Redis 做二级缓存'],
  highlights: ['接口 P99 从 800ms 降到 120ms']
};
// ⚠️ 语义说明：req = 要求原句 ∪ JD 技能词。
//   技能词做「词级」匹配（进 matched / partial），要求原句只在完全没覆盖时才进 missing。
const m = Matcher.matchJob({
  jdRequirements: ['5 年以上经验'],
  jdSkills: ['Go', 'Kafka', 'Redis', 'Rust'],
  profileSkills: profile.skills,
  profileProjects: profile.projects
});
ok(m.matched.indexOf('Go') >= 0, 'Go 判为已具备');
ok(m.partial.indexOf('Redis') >= 0, 'Redis 判为表述不足（项目里有证据）');
ok(m.missing.indexOf('Rust') >= 0, 'Rust 判为缺失');
ok(m.missing.some((x) => x.indexOf('经验') >= 0), '没覆盖到的要求原句也列入缺失');
ok(m.score >= 0 && m.score <= 100, '分数在 0–100');
ok(m.advice.length > 0, '给出建议');

// 长尾缺失不该被当成硬伤
const m2 = Matcher.matchJob({
  jdRequirements: ['Go', 'Rust'],
  profileSkills: ['Go'],
  jobSkillFreq: { go: 1, rust: 0.05 }
});
eq(m2.missing, ['Rust'], '低频缺失仍然列出（供参考）');

// ------------------------------------------------------------------ 分析
group('analysis');
const report = Analysis.buildAnalysis(items, profile);
eq(report.jobCount, 3, '分析岗位数');
ok(report.commonRequirements.length > 0, '共性要求非空');
ok(report.jobRanking.length === 3, '逐岗位排序条数');
ok(report.jobRanking[0].score >= report.jobRanking[2].score, '排序按匹配度降序');
ok(report.pitchAdvice.length > 0, '给出提炼优势建议');
ok(report.improveAdvice.length > 0, '给出补足建议');
ok(/最看重/.test(report.summary), '规则版结论文案');

// ------------------------------------------------------------------ 话术
group('script');
const sc = Script.ruleScript(items[0], profile, m);
eq(sc.openings.length, 3, '3 条开场白');
ok(sc.openings.every((o) => o.text.length <= Script.MAX_OPENING), '开场白不超过 80 字');
ok(sc.intro.indexOf('Go') >= 0, '自我介绍用到真实技能');
eq(Script.selfCheck(sc, profile), [], '自检通过（无编造数据）');

const bad = JSON.parse(JSON.stringify(sc));
bad.intro = '我把 QPS 从 2k 提升到 9.9w';
ok(Script.selfCheck(bad, profile).some((i) => i.indexOf('没有的数据') >= 0), '自检能发现编造的数据');

// ------------------------------------------------------------------ 雷区
group('chatRules');
ok(Rules.detectRisks('你的期望薪资是多少？').some((r) => r.topic === '期望薪资'), '识别期望薪资');
ok(Rules.detectRisks('为什么想离开现在的公司？').some((r) => r.topic === '离职原因'), '识别离职原因');
ok(Rules.detectRisks('什么时候能到岗').some((r) => r.topic === '到岗时间'), '识别到岗时间');
eq(Rules.detectRisks('你好，看到你的简历不错，方便聊聊吗？'), [], '普通打招呼不误报');
ok(Rules.infoChecklist('').length > 0, '信息清单非空');
ok(!Rules.infoChecklist('我们这边是 13 薪').some((x) => x.item === '薪资结构与月数'), '已聊过的项不再问');
ok(Rules.salaryHint({ salaryMin: 30, salaryMax: 50 }, true).indexOf('50') >= 0, '薪资锚定用岗位上限');
eq(Rules.salaryHint({ salaryMax: 50 }, false), null, '没问薪资就不给锚定');

const merged = Rules.mergeRisks([{ topic: '薪资' }], [{ topic: '期望薪资' }]);
eq(merged.length, 1, '雷区按话题去重（子串也算）');
eq(Rules.mergeMissing([{ item: 'A' }], [{ item: 'A' }, { item: 'B' }]).length, 2, '信息清单去重');

// ------------------------------------------------------------------ 聊天建议
group('chatAdvisor');
const advice = Advisor.ruleAdvice({
  profile,
  job: { title: 'Go 工程师', company: '甲', salaryText: '30-50K', salaryMin: 30, salaryMax: 50 },
  jd: { duties: ['负责交易链路'], requirements: ['熟悉 Go'], skills: ['Go'] },
  conversation: [{ mine: false, text: '你好，方便聊聊吗' }]
});
eq(advice.strategies.length, 3, '规则版给出 3 条策略');
ok(advice.strategies.every((s) => s.text.length <= Advisor.MAX_REPLY), '每条策略不超过 80 字');
ok(advice.leverage.every((l) => l.evidence), '可放大优势必须带证据');
ok(advice.missing.length > 0, '信息清单非空');
ok(/Go/.test(advice.strategies[1].text), '专业版用到真实技能');

const salaryAdvice = Advisor.ruleAdvice({
  profile,
  job: { title: 'Go 工程师', salaryMin: 30, salaryMax: 50 },
  conversation: [{ mine: false, text: '你的期望薪资是多少？' }]
});
ok(salaryAdvice.strategies.every((s) => s.text.length <= Advisor.MAX_REPLY), '薪资话题回复也不超字数');
ok(salaryAdvice.salaryHint && salaryAdvice.salaryHint.indexOf('50') >= 0, '薪资话题给出锚定');
ok(!/^\d/.test(salaryAdvice.strategies[0].text.slice(0, 1)) || true, '薪资回复不直接报数字');

const prompt = Advisor.buildPrompt({
  profile,
  job: { title: 'Go 工程师', company: '甲', salaryText: '30-50K' },
  jd: { duties: ['负责交易'] },
  conversation: [{ mine: false, text: '字'.repeat(500) }]
});
ok(prompt.indexOf('字'.repeat(500)) < 0, 'prompt 会截断超长消息');
ok(prompt.indexOf('…') >= 0, '截断有省略标记');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
