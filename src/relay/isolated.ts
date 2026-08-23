import { isBlockEvent } from '../shared/messages';

// 运行在隔离世界，唯一职责是把 MAIN world 的遥测转给 Service Worker。
// 这条链路不承载任何安全决策，页面伪造消息最多让计数不准。
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!isBlockEvent(event.data)) return;
  void chrome.runtime.sendMessage(event.data).catch(() => {
    // Service Worker 尚未就绪或已终止，丢弃即可。
  });
});
