import { installListeners } from './wiring';

/**
 * chrome.privacy 的 ChromeSetting 在不同 @types/chrome 版本间对 Promise 的支持不一致，
 * 统一用 callback 形式包一层，行为在所有版本上都确定。
 */
const ipPolicy = {
  set: (details: { value: string }): Promise<void> =>
    new Promise((resolve) => {
      chrome.privacy.network.webRTCIPHandlingPolicy.set(
        // IpPolicyLike.set 的 value 类型是 string（Task 6 特意与 core/policy.ts 的
        // IpHandlingPolicy 字面量联合解耦，保持 SyncDeps 是窄接口）；而
        // @types/chrome 0.2.7 的 ChromeSetting<T> 要求 value 是字面量联合类型。
        // 实际传入的 value 只会是 ipHandlingPolicy() 产出的四个合法字面量之一，
        // 故在此按调用方保证的实际类型断言，而不放宽 IpPolicyLike。
        details as unknown as chrome.types.ChromeSettingSetDetails<
          | 'default'
          | 'default_public_and_private_interfaces'
          | 'default_public_interface_only'
          | 'disable_non_proxied_udp'
        >,
        () => resolve(),
      );
    }),
};

installListeners({
  onInstalled: chrome.runtime.onInstalled,
  onStartup: chrome.runtime.onStartup,
  onStorageChanged: chrome.storage.onChanged,
  onMessage: chrome.runtime.onMessage,
  onTabUpdated: chrome.tabs.onUpdated,
  onTabRemoved: chrome.tabs.onRemoved,
  settingsArea: chrome.storage.local,
  session: chrome.storage.session,
  badge: chrome.action,
  scripting: chrome.scripting,
  ipPolicy,
});
