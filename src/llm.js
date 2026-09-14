/**
 * LLM 客户端：OpenAI 兼容的 /chat/completions。
 *
 * 只依赖 fetch，不引任何 SDK —— 用户可能接 DeepSeek / 通义 / 豆包 / 本地 Ollama，
 * 它们的 SDK 各不相同，但基本都兼容 OpenAI 的 HTTP 协议。
 *
 * ⚠️ 结构化输出必须做三层兜底：
 *   1) response_format: json_object（部分兼容端点不支持，会忽略或直接报错）
 *   2) 模型常把 JSON 包在 ```json 代码块里
 *   3) 前后还会夹带解释文字
 *   只做第 1 步的话，在不少兼容端点上会直接失败。
 */
(function (global) {
  'use strict';

  const STORE_KEY = 'bossoss_llm_v1';

  const DEFAULTS = {
    baseUrl: '',
    apiKey: '',
    modelFast: '',
    modelStrong: '',
    timeoutMs: 45000
  };

  let cache = null;

  async function load() {
    if (cache) return cache;
    let stored = {};
    try {
      const data = await chrome.storage.local.get([STORE_KEY]);
      stored = (data && data[STORE_KEY]) || {};
    } catch (_) {
      stored = {};
    }
    cache = { ...DEFAULTS, ...stored };
    return cache;
  }

  async function save(patch) {
    const cur = await load();
    cache = { ...cur, ...(patch || {}) };
    await chrome.storage.local.set({ [STORE_KEY]: cache });
    return cache;
  }

  async function settings() {
    return load();
  }

  function isConfigured(s) {
    const c = s || cache;
    return !!(c && c.baseUrl && c.apiKey && (c.modelFast || c.modelStrong));
  }

  function modelOf(s, kind) {
    const c = s || cache || {};
    if (kind === 'strong') return c.modelStrong || c.modelFast || '';
    return c.modelFast || c.modelStrong || '';
  }

  function normalizeBase(url) {
    let u = String(url || '').trim().replace(/\/+$/, '');
    if (!u) return '';
    // 允许用户填 https://api.deepseek.com 或 .../v1，两种情况都能用
    return /\/v\d+$/.test(u) ? u : u + '/v1';
  }

  /** 从各种脏输出里把 JSON 抠出来 */
  function extractJson(text) {
    if (!text) return null;
    let s = String(text).trim();

    try {
      return JSON.parse(s);
    } catch (_) {
      /* 继续兜底 */
    }

    // ```json ... ``` 代码块
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
    if (fence) {
      try {
        return JSON.parse(fence[1].trim());
      } catch (_) {
        s = fence[1].trim();
      }
    }

    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(s.slice(first, last + 1));
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  /**
   * ⚠️ 跨域是开源版最容易踩的坑：侧边栏的来源是 `chrome-extension://<id>`，
   *    LLM 服务商不会给这个来源放行，fetch 会在**网络层**就被拦掉（表现为 "Failed to fetch"，
   *    请求根本没发出去）。MV3 里唯一的解法是拿到该域名的主机权限 —— 拿到后 CORS 直接绕过。
   *
   *    所以用 `optional_host_permissions` + 运行时申请，而不是在 manifest 里写死全站权限
   *    （那样商店会提示「读取所有网站数据」，对这个工具完全没必要）。
   */
  function originOf(url) {
    try {
      return new URL(url).origin;
    } catch (_) {
      return '';
    }
  }

  async function hasPermission(baseUrl) {
    const origin = originOf(baseUrl);
    if (!origin) return false;
    try {
      return await chrome.permissions.contains({ origins: [`${origin}/*`] });
    } catch (_) {
      return false;
    }
  }

  /** 申请域名权限。**必须在用户手势里调用**（点「测试连接」），否则 Chrome 会直接拒绝。 */
  async function requestPermission(baseUrl) {
    const origin = originOf(baseUrl);
    if (!origin) return false;
    try {
      return await chrome.permissions.request({ origins: [`${origin}/*`] });
    } catch (_) {
      return false;
    }
  }

  /**
   * 发起一次对话。
   * @param {object} args {system, user, kind: 'fast'|'strong', json: bool, timeoutMs}
   * @returns {Promise<{text: string, data: object|null, model: string}>}
   */
  async function chat(args) {
    const a = args || {};
    const cfg = await load();
    if (!isConfigured(cfg)) throw new Error('尚未配置 LLM：请在「设置」里填写地址、模型与凭证');

    const origin = originOf(cfg.baseUrl);
    if (!(await hasPermission(cfg.baseUrl))) {
      throw new Error(
        `没有 ${origin || '该地址'} 的访问权限。请在「设置」点「测试连接」并允许域名权限`
      );
    }

    const url = normalizeBase(cfg.baseUrl) + '/chat/completions';
    const timeoutMs = a.timeoutMs || cfg.timeoutMs || 45000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    const body = {
      model: modelOf(cfg, a.kind),
      messages: [
        ...(a.system ? [{ role: 'system', content: a.system }] : []),
        { role: 'user', content: a.user || '' }
      ],
      temperature: 0.3,
      stream: false
    };
    // 有些端点不认识这个字段会报错，所以失败时会自动去掉重试一次
    if (a.json) body.response_format = { type: 'json_object' };

    try {
      let res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });

      // 兼容端点不支持 response_format 时，去掉它再试一次
      if (!res.ok && a.json) {
        const clone = { ...body };
        delete clone.response_format;
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${cfg.apiKey}`
          },
          body: JSON.stringify(clone),
          signal: ctrl.signal
        });
      }

      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const err = await res.json();
          msg = (err && (err.error && err.error.message)) || err.message || msg;
        } catch (_) {
          /* ignore */
        }
        throw new Error(`LLM 调用失败：${msg}`);
      }

      const payload = await res.json();
      const text = ((payload.choices || [])[0] || {}).message?.content || '';
      return {
        text,
        data: a.json ? extractJson(text) : null,
        model: payload.model || modelOf(cfg, a.kind)
      };
    } catch (err) {
      if (err && err.name === 'AbortError') throw new Error(`LLM 调用超时（${Math.round(timeoutMs / 1000)}s）`);
      // fetch 只在网络层失败时抛 TypeError（message 通常是 "Failed to fetch"）。
      // 这里必须翻译成人话，否则用户只会看到一句没有信息的英文报错。
      if (err instanceof TypeError) {
        throw new Error(
          `连不上 ${url}：请求被浏览器拦截或地址不可达。` +
            '请检查地址是否正确（本地 Ollama 需允许跨域），并确认已授予域名权限'
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 生成纯文本（失败返回 null，由调用方用规则结果兜底） */
  async function text(args) {
    try {
      const r = await chat(args);
      return String(r.text || '').trim() || null;
    } catch (err) {
      console.warn('[Boss 开源版] LLM 文本生成失败，使用规则结果', err.message);
      return null;
    }
  }

  /** 结构化输出：拿不到 JSON 就返回 null，调用方必须能降级 */
  async function json(args) {
    try {
      const r = await chat({ ...(args || {}), json: true });
      return r.data || null;
    } catch (err) {
      console.warn('[Boss 开源版] LLM 结构化输出失败，使用规则结果', err.message);
      return null;
    }
  }

  /**
   * 设置页的「测试连接」。
   * ⚠️ 必须在按钮点击里调用：申请域名权限需要用户手势。
   */
  async function testConnection(patch) {
    if (patch) await save(patch);
    const cfg = await load();
    if (!cfg.baseUrl) throw new Error('请先填写接口地址');
    if (!cfg.apiKey) throw new Error('请先填写 API Key');
    if (!(cfg.modelFast || cfg.modelStrong)) throw new Error('请至少填写一个模型名');

    // 先拿权限再发请求，否则必然是 "Failed to fetch"
    if (!(await hasPermission(cfg.baseUrl))) {
      const granted = await requestPermission(cfg.baseUrl);
      if (!granted) throw new Error(`未获得 ${originOf(cfg.baseUrl)} 的访问权限，无法调用`);
    }

    const started = Date.now();
    const r = await chat({ user: '回复两个字：正常', kind: 'fast', timeoutMs: 20000 });
    return {
      ok: true,
      model: r.model,
      reply: String(r.text || '').slice(0, 40),
      ms: Date.now() - started,
      endpoint: normalizeBase(cfg.baseUrl) + '/chat/completions'
    };
  }

  global.BossLLM = {
    STORE_KEY,
    DEFAULTS,
    load,
    save,
    settings,
    isConfigured,
    modelOf,
    normalizeBase,
    originOf,
    hasPermission,
    requestPermission,
    extractJson,
    chat,
    text,
    json,
    testConnection
  };
})(window);
