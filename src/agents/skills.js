/**
 * 技能词典与归一化（从服务端 skills.py 移植，保持一致以免两边结论不同）。
 *
 * 作用：给词频统计、匹配三档、档案抽取提供统一词表 —— 也顺带给 LLM 提供候选词，减少幻觉。
 */
(function (global) {
  'use strict';

  const SKILLS = [
    // 语言
    'go', 'golang', 'java', 'python', 'c++', 'rust', 'node.js', 'nodejs',
    'typescript', 'javascript', 'php', 'kotlin', 'swift', 'scala', 'erlang', 'lua',
    // 后端
    '微服务', '分布式', '高并发', '高可用', '服务治理', 'api网关', 'grpc', 'restful',
    '消息队列', 'kafka', 'rocketmq', 'rabbitmq', 'pulsar', 'redis', 'mysql',
    'postgresql', 'mongodb', 'elasticsearch', 'clickhouse', 'tidb', 'etcd',
    'zookeeper', 'consul', '分布式事务', '分库分表', '缓存设计', '性能优化', '性能调优',
    '熔断降级', '限流', 'docker', 'k8s', 'kubernetes', 'service mesh', 'istio',
    // 前端
    'react', 'vue', 'angular', 'webpack', 'vite', '小程序', 'flutter',
    // 数据与算法
    'spark', 'flink', 'hadoop', 'hive', '数据仓库', 'etl', '推荐算法', '机器学习',
    '深度学习', '大模型', 'llm', 'rag', 'nlp',
    // 工程能力
    '数据结构', '算法', '设计模式', '重构', '单元测试', 'ci/cd', 'devops',
    '可观测性', '技术文档', 'code review',
    // 业务域
    '支付', '交易', '订单', '风控', '电商', '金融', '信贷', 'saas', 'erp', 'crm',
    '低代码', '中台', '供应链', '物流', '广告', '增长',
    // 软素质 / 管理
    '团队管理', '项目管理', '跨部门协作', '需求分析', '架构设计', '技术选型'
  ];

  // 单向归一：避免 a→b、b→a 导致结果不幂等
  const ALIAS = {
    golang: 'go',
    nodejs: 'node.js',
    kubernetes: 'k8s',
    性能调优: '性能优化',
    大模型: 'llm'
  };

  const CANONICAL = {
    go: 'Go', java: 'Java', python: 'Python', 'c++': 'C++', rust: 'Rust',
    'node.js': 'Node.js', typescript: 'TypeScript', javascript: 'JavaScript',
    php: 'PHP', kotlin: 'Kotlin', swift: 'Swift', scala: 'Scala',
    erlang: 'Erlang', lua: 'Lua',
    api网关: 'API网关', grpc: 'gRPC', restful: 'RESTful',
    kafka: 'Kafka', rocketmq: 'RocketMQ', rabbitmq: 'RabbitMQ', pulsar: 'Pulsar',
    redis: 'Redis', mysql: 'MySQL', postgresql: 'PostgreSQL', mongodb: 'MongoDB',
    elasticsearch: 'Elasticsearch', clickhouse: 'ClickHouse', tidb: 'TiDB',
    etcd: 'etcd', zookeeper: 'ZooKeeper', consul: 'Consul',
    docker: 'Docker', k8s: 'K8s', 'service mesh': 'Service Mesh', istio: 'Istio',
    react: 'React', vue: 'Vue', angular: 'Angular', webpack: 'Webpack',
    vite: 'Vite', flutter: 'Flutter',
    spark: 'Spark', flink: 'Flink', hadoop: 'Hadoop', hive: 'Hive', etl: 'ETL',
    llm: 'LLM', rag: 'RAG', nlp: 'NLP',
    'ci/cd': 'CI/CD', devops: 'DevOps', 'code review': 'Code Review',
    saas: 'SaaS', erp: 'ERP', crm: 'CRM'
  };

  function normalize(skill) {
    const s = String(skill || '').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(ALIAS, s) ? ALIAS[s] : s;
  }

  function display(skill) {
    const n = normalize(skill);
    return CANONICAL[n] || String(skill || '').trim();
  }

  /** 英文按词边界匹配（避免 "go" 命中 "google"），中文直接包含即可 */
  function matchesSkill(lowerText, key) {
    if (/^[a-z0-9.+#/ ]+$/.test(key)) {
      const re = new RegExp('(?<![a-z0-9])' + escapeRe(key) + '(?![a-z0-9])');
      return re.test(lowerText);
    }
    return lowerText.indexOf(key) >= 0;
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** 从一段文本里抽出命中的技能（去重、保序） */
  function extractSkills(text) {
    const low = String(text || '').toLowerCase();
    const found = [];
    for (const s of SKILLS) {
      if (!matchesSkill(low, s.toLowerCase())) continue;
      const n = normalize(s);
      if (found.indexOf(n) < 0) found.push(n);
    }
    return found;
  }

  // 兼容「8年经验」「8年以上后端开发经验」「10年以上工作经验」
  const RE_YEARS = /(\d{1,2})\s*年(?:以上)?[\u4e00-\u9fa5]{0,8}?经验/;
  const RE_YEARS_ALT = /经验[:：]?\s*(\d{1,2})\s*年/;

  function extractYears(text) {
    const s = String(text || '');
    let m = RE_YEARS.exec(s);
    if (m) return parseInt(m[1], 10);
    m = RE_YEARS_ALT.exec(s);
    return m ? parseInt(m[1], 10) : null;
  }

  global.BossSkills = {
    SKILLS,
    ALIAS,
    CANONICAL,
    normalize,
    display,
    extractSkills,
    extractYears,
    escapeRe
  };
})(window);
