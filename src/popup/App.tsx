import { useCallback, useEffect, useState } from 'react';
import type { Settings } from '../core/types';
import { addToWhitelist, isWhitelisted, removeFromWhitelist } from '../core/whitelist';
import './style.css';

export interface PopupApi {
  getSettings(): Promise<Settings>;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;
  getActiveHost(): Promise<string>;
  getBlockedCount(): Promise<number>;
}

export function App({ api }: { api: PopupApi }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [host, setHost] = useState('');
  const [count, setCount] = useState(0);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [loaded, activeHost, blocked] = await Promise.all([
        api.getSettings(),
        api.getActiveHost(),
        api.getBlockedCount(),
      ]);
      if (!alive) return;
      setSettings(loaded);
      setHost(activeHost);
      setCount(blocked);
    })();
    return () => {
      alive = false;
    };
  }, [api]);

  const update = useCallback(
    async (patch: Partial<Settings>) => {
      setSettings(await api.saveSettings(patch));
    },
    [api],
  );

  if (settings === null) return <main className="popup">载入中…</main>;

  const allowed = !settings.enabled || (host !== '' && isWhitelisted(host, settings.whitelist));

  return (
    <main className="popup">
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
