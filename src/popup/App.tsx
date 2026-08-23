import { useCallback, useEffect, useState } from 'react';
import type { Settings } from '../core/types';
import { addToWhitelist, isWhitelisted, removeFromWhitelist } from '../core/whitelist';
import { errorMessage } from '../shared/sync-error';
import './style.css';

export interface PopupApi {
  getSettings(): Promise<Settings>;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;
  getActiveHost(): Promise<string>;
  getBlockedCount(): Promise<number>;
  /** Service Worker 最近一次注册同步的失败原因；没有失败时为 null。 */
  getSyncError(): Promise<string | null>;
}

export function App({ api }: { api: PopupApi }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [host, setHost] = useState('');
  const [count, setCount] = useState(0);
  // 三个状态互不相关，谁都不能覆盖谁：
  // - loadError：设置/站点/计数这三样基本信息读不出来，整个界面都没法渲染；
  // - syncError：Service Worker 最近一次注册同步失败，扩展其实没在拦截；
  // - saveError：这一次保存操作本身失败了，设置没有落盘。
  // 一次成功的保存只能证明"这一次保存成功了"，不能证明"注册也同步成功了"——
  // 那要靠重新读一次 getSyncError 才知道，所以两者必须分开存。
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    // 同步状态是次要信号，独立读取、独立失败：它读不出来不该连累下面
    // 已经能正常渲染的设置界面，所以绝不能和主状态放进同一个 Promise.all。
    void (async () => {
      try {
        const syncErr = await api.getSyncError();
        if (!alive) return;
        setSyncError(syncErr);
      } catch {
        // 读取失败时维持上一次已知的结果（初始为「没有已知问题」），
        // 不额外报错——这里失败的只是"要不要展示一条提示"，不是拦截本身。
      }
    })();

    void (async () => {
      try {
        const [loaded, activeHost, blocked] = await Promise.all([
          api.getSettings(),
          api.getActiveHost(),
          api.getBlockedCount(),
        ]);
        if (!alive) return;
        setSettings(loaded);
        setHost(activeHost);
        setCount(blocked);
      } catch (error) {
        // 没有兜底的话，一次拒绝就把 popup 永久钉在「载入中…」上，用户只会以为它卡了。
        if (!alive) return;
        setLoadError(`拦截状态未知：读取扩展状态失败（${errorMessage(error)}）`);
      }
    })();

    return () => {
      alive = false;
    };
  }, [api]);

  const update = useCallback(
    async (patch: Partial<Settings>) => {
      try {
        setSettings(await api.saveSettings(patch));
        setSaveError(null);
      } catch (error) {
        setSaveError(`设置未能保存：${errorMessage(error)}`);
        return;
      }
      // 保存会触发 Service Worker 重新同步注册，这次同步是否成功
      // 才是横幅接下来该不该继续显示的依据，所以必须重新读一遍，
      // 不能因为"保存"本身成功就想当然地把横幅摘掉。
      try {
        setSyncError(await api.getSyncError());
      } catch {
        // 保存已经成功；刷新同步状态失败就维持上一次已知的结果，不必因此再报错。
      }
    },
    [api],
  );

  if (settings === null) {
    // 这是"设置/站点/计数读不出来"，比下面的 syncError / saveError 更基础——
    // 没有它们连界面骨架都搭不起来，所以单独用一条横幅顶替整个 popup。
    const banner =
      loadError === null ? null : (
        <p className="warning" role="alert">
          <span aria-hidden="true">⚠️ </span>
          {loadError}
        </p>
      );
    return (
      <main className="popup">
        {banner}
        {loadError === null && <p>载入中…</p>}
      </main>
    );
  }

  // 这是「扩展没有在保护你」/「你的改动没有落地」的状态，必须一眼可见，
  // 不能只留在控制台里。两条互不相关，都在时都要看得到，谁也不该盖住谁。
  const warnings = [
    syncError === null ? null : `拦截未生效：${syncError}`,
    saveError === null ? null : `设置未能保存：${saveError}`,
  ].filter((message): message is string => message !== null);
  const banner = warnings.map((message) => (
    <p key={message} className="warning" role="alert">
      <span aria-hidden="true">⚠️ </span>
      {message}
    </p>
  ));

  const allowed = !settings.enabled || (host !== '' && isWhitelisted(host, settings.whitelist));

  return (
    <main className="popup">
      {banner}

      <label className="row">
        <input
          type="checkbox"
          aria-label="启用 WebRTC 拦截"
          checked={settings.enabled}
          onChange={(event) => void update({ enabled: event.target.checked })}
        />
        <span>启用 WebRTC 拦截</span>
      </label>

      <label className="row">
        <input
          type="checkbox"
          aria-label="同时拦截摄像头与麦克风"
          checked={settings.blockMedia}
          onChange={(event) => void update({ blockMedia: event.target.checked })}
        />
        <span>同时拦截摄像头与麦克风</span>
      </label>

      {host !== '' && (
        <section className="site">
          <p className="host">{host}</p>
          <p className={allowed ? 'state state-allowed' : 'state state-blocked'}>
            {allowed ? '已放行' : '已拦截'}
          </p>
          <button
            type="button"
            onClick={() =>
              void update({
                whitelist: isWhitelisted(host, settings.whitelist)
                  ? removeFromWhitelist(settings.whitelist, host)
                  : addToWhitelist(settings.whitelist, host),
              })
            }
          >
            {isWhitelisted(host, settings.whitelist) ? '恢复拦截本站' : '放行本站'}
          </button>
        </section>
      )}

      <p className="count">
        本页已拦截 <strong>{count}</strong> 次
      </p>
    </main>
  );
}
