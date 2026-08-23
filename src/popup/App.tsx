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
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [loaded, activeHost, blocked, syncError] = await Promise.all([
          api.getSettings(),
          api.getActiveHost(),
          api.getBlockedCount(),
          api.getSyncError(),
        ]);
        if (!alive) return;
        setSettings(loaded);
        setHost(activeHost);
        setCount(blocked);
        setWarning(syncError === null ? null : `拦截未生效：${syncError}`);
      } catch (error) {
        // 没有兜底的话，一次拒绝就把 popup 永久钉在「载入中…」上，用户只会以为它卡了。
        if (!alive) return;
        setWarning(`拦截状态未知：读取扩展状态失败（${errorMessage(error)}）`);
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
        setWarning(null);
      } catch (error) {
        setWarning(`设置未能保存：${errorMessage(error)}`);
      }
    },
    [api],
  );

  // 这是「扩展没有在保护你」的状态，必须一眼可见，不能只留在控制台里。
  const banner =
    warning === null ? null : (
      <p className="warning" role="alert">
        <span aria-hidden="true">⚠️ </span>
        {warning}
      </p>
    );

  if (settings === null) {
    return (
      <main className="popup">
        {banner}
        {warning === null && <p>载入中…</p>}
      </main>
    );
  }

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
