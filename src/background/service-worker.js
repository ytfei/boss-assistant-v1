/**
 * background / service worker —— 只做三件事：
 *   1. 点击图标打开 Side Panel
 *   2. 把 content script 的状态变更转发给已打开的面板
 *   3. 记录当天用量（面板查询用）
 *
 * 不做抓取编排、不做流式请求（SW 会被休眠，见 docs/02 三条铁律）。
 */

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ installedAt: Date.now() });
});

// 面板连接时注册 port，用于实时推送
const panelPorts = new Set();

// 切换标签页 / 当前页导航都要立刻通知面板重判页面类型，
// 否则它会一直用旧页面的分支去问 content script，看起来就是「功能没切换」。
chrome.tabs.onActivated.addListener(() => broadcast({ type: 'TAB_CHANGED' }));
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url) broadcast({ type: 'TAB_CHANGED' });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'boss-oss-panel') return;
  panelPorts.add(port);
  port.onDisconnect.addListener(() => panelPorts.delete(port));
});

function broadcast(msg) {
  for (const port of panelPorts) {
    try {
      port.postMessage(msg);
    } catch (_) {
      panelPorts.delete(port);
    }
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'BOSS_OSS_STATE') broadcast({ type: 'STATE', state: msg.state });
  if (msg.type === 'BOSS_OSS_CHAT_STATE') broadcast({ type: 'CHAT_STATE', state: msg.state });
  // HR 发了新消息 —— 面板据此决定是否自动生成回复建议（仅建议，绝不代发）
  if (msg.type === 'BOSS_OSS_CHAT_NEW_MSG') {
    broadcast({ type: 'CHAT_NEW_MSG', bossId: msg.bossId || '', mid: msg.mid || '' });
  }
  // 职位详情页抓到岗位 —— 面板显示「已抓取，返回聊天即可用」
  if (msg.type === 'BOSS_OSS_JOBPAGE_STATE') {
    broadcast({ type: 'JOBPAGE_STATE', state: msg.state });
  }
});

/** 面板请求：当前激活的 tab */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.cmd === 'ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      sendResponse({ ok: true, tab: tabs[0] || null });
    });
    return true;
  }
  return false;
});
