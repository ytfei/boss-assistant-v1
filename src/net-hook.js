/**
 * net-hook.js —— MAIN world，只读旁路监听 fetch / XHR。
 *
 * 三条铁律：
 *   1. 只 clone 响应再读取，绝不消费原始流 —— 页面功能完全不受影响
 *   2. 被动捕获（列表/会话/消息）不产生任何额外请求
 *   3. 主动拉取（JD 详情）由 content script 显式指令触发，且由调用方限速
 *
 * ⚠️ 关键设计：端点识别**以响应内容为准，URL 只作辅助**。
 *    原因：推荐页走 /wapi/zpgeek/pc/recommend/job/list.json，
 *    搜索页（带 ?query=）走另一条路径；按 URL 硬匹配会在搜索页失效。
 */

(() => {
  if (window.__BOSS_OSS_HOOKED__) return;
  window.__BOSS_OSS_HOOKED__ = true;

  const MAX_BODY = 500000;

  /** 按响应内容判定类型（最稳，不依赖 URL） */
  function classifyByContent(zp) {
    if (!zp || typeof zp !== 'object') return null;
    if (Array.isArray(zp.jobList)) return 'JOB_LIST';
    if (Array.isArray(zp.joblist)) return 'JOB_LIST';
    if (zp.jobInfo) return 'JOB_DETAIL';
    if (Array.isArray(zp.messages)) return 'HISTORY_MSG';
    if (zp.data && zp.data.encryptBossId) return 'BOSS_DATA';
    if (Array.isArray(zp.result) && zp.result.length && zp.result[0].lastMsg !== undefined) {
      return 'FRIEND_LIST';
    }
    // 搜索页有些版本包在 zpData.list / zpData.data.list 里
    const list = zp.list || (zp.data && zp.data.list);
    if (Array.isArray(list) && list.length && (list[0].jobName || list[0].jobTitle)) {
      return 'JOB_LIST';
    }
    return null;
  }

  function post(msg) {
    try {
      window.postMessage({ __boss_oss: true, ...msg }, '*');
    } catch (_) {
      /* ignore */
    }
  }

  // ------------------------------------------------------- 响应处理
  function handle(url, text) {
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {
      return;
    }
    if (!json || json.code !== 0) return;

    // 所有 /wapi/ 响应都记一笔"诊断信息"（只有 URL 与体积，不含内容）
    if (/\/wapi\//.test(url)) {
      post({
        channel: 'diag',
        url: url.replace(/^https?:\/\/[^/]+/, ''),
        size: text.length
      });
    }

    const zp = json.zpData !== undefined ? json.zpData : null;
    const type = classifyByContent(zp);
    if (type) {
      post({ channel: 'api', type, ok: true, url, body: text.slice(0, MAX_BODY) });
    }
  }

  // ------------------------------------------------------------- fetch 捕获
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const input = args[0];
    const url =
      typeof input === 'string' ? input : input && input.url ? input.url : String(input);

    let res;
    try {
      res = await origFetch.apply(this, args);
    } catch (err) {
      throw err;
    }

    if (/\/wapi\//.test(url)) {
      try {
        const text = await res.clone().text();
        handle(url, text);
      } catch (_) {
        /* ignore */
      }
    }
    return res;
  };

  // --------------------------------------------------------------- XHR 捕获
  const P = XMLHttpRequest.prototype;
  const origOpen = P.open;
  const origSend = P.send;

  P.open = function (method, url, ...rest) {
    try {
      this.__bossOss = { method, url: String(url), hit: /\/wapi\//.test(String(url)) };
    } catch (_) {
      /* ignore */
    }
    return origOpen.call(this, method, url, ...rest);
  };

  P.send = function (body) {
    const meta = this.__bossOss;
    if (meta && meta.hit) {
      this.addEventListener('load', function () {
        let text = '';
        try {
          if (this.responseType === '' || this.responseType === 'text') {
            text = this.responseText || '';
          } else if (this.response) {
            text =
              typeof this.response === 'string'
                ? this.response
                : JSON.stringify(this.response);
          }
        } catch (_) {
          /* ignore */
        }
        if (text) handle(meta.url, text);
      });
    }
    return origSend.call(this, body);
  };

  // -------------------------------------------------- 受控的详情拉取通道
  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || msg.__bossCmd !== 'FETCH_JOB_DETAIL') return;
    const { requestId, securityId } = msg;

    const url = `/wapi/zpgeek/job/detail.json?securityId=${encodeURIComponent(securityId)}`;
    fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json, text/plain, */*' }
    })
      .then((r) => {
        if (r.status === 429 || r.status === 403) {
          // 触发风控：交给上层退避
          return Promise.reject(new Error('RATE_LIMITED:' + r.status));
        }
        return r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status));
      })
      .then((text) => post({ channel: 'cmd', requestId, ok: true, body: text }))
      .catch((err) => post({ channel: 'cmd', requestId, ok: false, error: String(err) }));
  });
})();
