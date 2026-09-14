# Boss 求职助手 · 开源版

一个**完全本地运行**的 Chrome 插件，帮助你在 Boss 直聘上更高效地筛岗位、写话术、回消息。

> 与同仓库 `extension/`（商业版）的区别：**没有服务端**。
> 所有数据留在你的浏览器里，AI 能力用的是**你自己配置的 LLM 端点**。
> 不填 LLM 凭证也能用 —— 薪资分布、技能词频、匹配三档、雷区预警都是本地规则计算。

---

## 快速开始

1. `chrome://extensions/` → 开**开发者模式** → **加载已解压的扩展程序** → 选本目录
2. 打开 https://www.zhipin.com/web/geek/jobs，**刷新一次**（抓取在 `document_start` 注入）
3. 点工具栏图标，右侧出现侧边栏
4. 想用 AI：到「设置」填 LLM 地址 / 模型 / 凭证 → 「测试连接」

**零构建**：原生 JS + HTML + CSS，改完代码回 `chrome://extensions/` 点刷新即可。

---

## 支持哪些页面

| 页面 | 能力 |
|---|---|
| `/web/geek/jobs` | 旁路捕获岗位、一键解析全部 JD、表格筛选、导出 CSV |
| `/job_detail/*` | 自动抓取该职位（含 JD 全文），返回聊天时自动带入会话 |
| `/web/geek/chat` | 基于「岗位 JD × 我的档案 × 对话」生成回复建议，支持一键填入 |

---

## 功能

### 免配置就能用（本地规则）

- **岗位抓取**：滚动/翻页自动捕获；一键解析全部 JD（0.5–2 秒随机间隔 + 失败自动退避）
- **结构化表格**：筛选、去重、导出 CSV；浅绿=已解析，浅灰=未解析
- **批次画像**：薪资 P25 / 中位 / P75、高频能力、职责聚类、加分项排行
- **三档匹配矩阵**：✅ 已具备 / ⚠️ 有但技能栏没写 / ❌ 明确缺失
- **逐岗位排序**：哪些岗位最值得投
- **雷区预警**：薪资、离职原因、到岗时间、加班、学历、婚育等 8 类敏感话题

### 填了 LLM 才启用

- **专属话术**：开场白 / 自我介绍 / 经历钩子 / 反问清单
- **聊天回复建议**：意图判断 + 3 种策略（热情 / 专业 / 反问）+ 可放大优势 + 信息清单
- **分析总结**：用自然语言概括这批岗位与你的差距

---

## LLM 配置

任何 **OpenAI 兼容**的端点都可以：

| 服务商 | 地址示例 |
|---|---|
| DeepSeek | `https://api.deepseek.com` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode` |
| 火山豆包 | `https://ark.cn-beijing.volces.com/api/v3` |
| 本地 Ollama | `http://localhost:11434`（需允许跨域） |

可分别填「快模型」（抽取/分类）与「强模型」（话术/建议）；只填一个也可以。

> 结构化输出做了三层兜底（`response_format` → ```json 代码块 → 首个 `{`），
> 兼容端点返回格式不标准时也不会直接失败，最多降级为规则结果。

---

## 目录结构

```
extension-opensource/
├── manifest.json
├── README.md / LICENSE
└── src/
    ├── net-hook.js     MAIN world：旁路监听 fetch/XHR（全站注入）
    ├── shared.js       协议解析 + JD 切分 + 薪资解析（纯函数）
    ├── jobs.js         岗位页：抓取编排与限速
    ├── chat.js         聊天页：会话上下文 + 一键填入
    ├── jobpage.js      职位详情页抓取
    ├── llm.js          OpenAI 兼容客户端
    ├── profile.js      本地档案：文本抽取 + 手填
    ├── agents/         移植自服务端的算法（纯函数，可用 node tests/run.js 验证）
    │   ├── skills.js       技能词典与归一化
    │   ├── batch.js        薪资分布 / 词频 / 职责聚类
    │   ├── matcher.js      三档匹配矩阵
    │   ├── analysis.js     批次 × 档案 → 优势 / 不足 / 排序
    │   ├── script.js       规则话术 + 自检
    │   ├── chatRules.js    雷区正则 + 信息清单
    │   └── chatAdvisor.js  回复建议契约与规则兜底
    ├── background/service-worker.js
    └── sidepanel/     面板 UI
```

---

## 与原版共存

两个插件可以同时安装，不会互相干扰：

| 项 | 原版 | 开源版 |
|---|---|---|
| hook 全局标志 | `__BOSS_HOOKED__` | `__BOSS_OSS_HOOKED__` |
| postMessage 通道 | `__boss` | `__boss_oss` |
| storage 键 | `boss_*` | `bossoss_*` |
| runtime 消息 | `BOSS_*` | `BOSS_OSS_*` |
| 面板 port | `boss-panel` | `boss-oss-panel` |

---

## 自测

```bash
node tests/run.js     # 纯函数：薪资分位、词频、匹配三档、雷区、话术自检、prompt 截断
```

---

## 数据与隐私

- 岗位、档案、分析结果**全部存在本浏览器**（`chrome.storage.local`），不上传任何自有服务器
- 启用 AI 后，JD 与档案片段会发送给你**自己配置的 LLM 端点**
- 插件**不会**自动打招呼或自动投递；发送动作永远由你本人完成
- 只采集你本人登录后可见的内容

## 免责声明

本项目仅供学习与技术交流。使用本插件可能涉及与招聘平台用户协议的边界问题，请自行评估并在合规前提下使用；作者对因使用本插件导致的账号限制或其它后果不承担责任。
