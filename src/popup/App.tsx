import { useCallback, useEffect, useState } from 'react';
import type { Settings } from '../core/types';
import { addToWhitelist, isWhitelisted, removeFromWhitelist } from '../core/whitelist';
import { errorMessage } from '../shared/sync-error';
import { pageStatus, type PageStatus } from './page-status';
import './style.css';

export interface PopupApi {
  getSettings(): Promise<Settings>;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;
  getActiveHost(): Promise<string>;
  getBlockedCount(): Promise<number>;
  /** Service Worker 最近一次注册同步的失败原因；没有失败时为 null。 */
  getSyncError(): Promise<string | null>;
  /**
   * 请求 Service Worker 立刻同步一次，并返回**这一次**的结果。
   * 读 getSyncError 拿到的是上一次留下的记录，改完设置后拿它当结论会漏报。
   * 送不到 Service Worker 时抛错——调用方必须按「无法确认」处理，不能当作没问题。
   */
  requestSync(): Promise<string | null>;
  /**
   * 实测当前标签页里 WebRTC 是不是真的用不了（而不是「按设置推断应该用不了」）。
   * 判定不了时返回 null。
   */
  isPageBlocked(): Promise<boolean | null>;
  /** 重新加载当前标签页——补丁只在文档加载时进入，改了设置只能靠重新加载生效。 */
  reloadPage(): Promise<void>;
}

/**
 * 品牌栏里的图形：WebRTC 官方标志加一道阻断斜杠，与工具栏图标是同一组几何。
 *
 * 官方标志版权归 The WebRTC project authors，依 3-clause BSD 授权
 * （https://webrtc.org/license/，出处 https://webrtc.org/press/）。
 * 坐标由 scripts/make-icons.mjs 里那组官方几何按 viewBox 24 换算而来，
 * 那边改了比例，这里要跟着换算，否则工具栏和 popup 会显示成两个不一样的标志。
 *
 * 这里刻意不吃 currentColor：官方标志是多色的，跟着文字颜色走就不是它了。
 */
function BrandGlyph() {
  return (
    <svg viewBox="0 0 24 24">
      <circle cx="8.224" cy="17.741" r="4.968" fill="#f60" />
      <circle cx="18.05" cy="10.785" r="4.968" fill="#fc0" />
      <circle cx="5.906" cy="10.675" r="4.968" fill="#0089cc" />
      <circle cx="15.842" cy="17.741" r="4.968" fill="#009939" />
      <circle cx="11.978" cy="6.259" r="4.968" fill="#bf0000" />
      <rect x="5.474" y="7.609" width="12.234" height="9.516" rx="1.238" fill="#fff" />
      <path d="M13.144 17.126L6.482 20.391L7.495 17.126Z" fill="#fff" />
      <path d="M5.478 6.118L18.522 19.162" stroke="#1b1d21" strokeWidth="2.49" />
    </svg>
  );
}

/**
 * 站点状态标记。**只有实测确认拦住了**才给实心黄的禁止符，
 * 其余一律空心灰圆环——「需重新加载」和「无法确认」都不是保护生效的状态，
 * 给它们一个和「已拦截」相同的标记，等于用图形替设置撒谎。
 * 两种状态的**形状**就不一样，不只是颜色不一样，色觉障碍下同样分得清。
 * 纯装饰，语义由旁边的文字承担，故对无障碍树隐藏。
 */
function StatusMark({ status }: { status: DisplayStatus }) {
  if (status !== 'blocked') {
    return (
      <svg className="mark" viewBox="0 0 26 26" aria-hidden="true">
        <circle cx="13" cy="13" r="8.6" fill="none" stroke="var(--ink-3)" strokeWidth="1.8" />
      </svg>
    );
  }
  return (
    <svg className="mark" viewBox="0 0 26 26" aria-hidden="true">
      <circle cx="13" cy="13" r="13" fill="var(--mt-yellow)" />
      <circle cx="13" cy="13" r="7.4" fill="none" stroke="#1b1d21" strokeWidth="2.2" />
      <line
        x1="7.8"
        y1="18.2"
        x2="18.2"
        y2="7.8"
        stroke="#1b1d21"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * 'probing' 不进 PageStatus：那是个纯粹的判定函数，不该知道「还没测完」这种界面时序。
 * 但它必须存在——实测是异步的，没有这一格的话首屏会闪一下「无法确认」，
 * 而「无法确认」是个需要用户警觉的状态，不能拿它当加载占位符。
 */
type DisplayStatus = PageStatus | 'probing';

const STATE_TEXT: Record<DisplayStatus, string> = {
  blocked: '已拦截',
  allowed: '已放行',
  stale: '需重新加载',
  unknown: '无法确认',
  probing: '检测中…',
};

const STATE_CLASS: Record<DisplayStatus, string> = {
  blocked: 'state state-blocked',
  allowed: 'state state-allowed',
  stale: 'state state-stale',
  unknown: 'state state-unknown',
  probing: 'state state-unknown',
};

function Brand() {
  return (
    <header className="brand">
      <span className="brand-mark" aria-hidden="true">
        <BrandGlyph />
      </span>
      <span className="brand-name">WebRTC Blocker</span>
    </header>
  );
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
  // 第四种：同步请求根本送不到 Service Worker。它既不是「同步失败」也不是「同步成功」，
  // 混进上面任何一个都会变成谎话，所以单独一格。
  const [syncUnknown, setSyncUnknown] = useState<string | null>(null);
  // 实测结果：当前页面里 WebRTC 到底还能不能用。null 表示没测出来。
  // probed 单独一格，用来区分「测过了，测不出来」和「还没测完」。
  const [pageBlocked, setPageBlocked] = useState<boolean | null>(null);
  const [probed, setProbed] = useState(false);

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

    // 实测当前页面的状态，同样独立失败：测不出来只该让状态显示成「无法确认」，
    // 不该把整个设置界面拖垮。
    void (async () => {
      try {
        const outcome = await api.isPageBlocked();
        if (!alive) return;
        setPageBlocked(outcome);
      } catch {
        if (!alive) return;
        setPageBlocked(null);
      } finally {
        if (alive) setProbed(true);
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
      // 才是横幅接下来该不该继续显示的依据。
      //
      // 这里必须是请求-应答，不能读 storage：storage.onChanged 触发的那次同步是个
      // 浮动 Promise，和这里的读之间没有先后关系，读到的会是**上一次**的结果——
      // 于是「这次改动恰好把注册搞坏」时横幅不出现，popup 继续显示「已拦截」。
      try {
        setSyncError(await api.requestSync());
        setSyncUnknown(null);
      } catch (error) {
        // 送不到就是送不到，不许当作「没问题」。
        setSyncUnknown(errorMessage(error));
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
          <span aria-hidden="true">⚠️</span>
          <span>{loadError}</span>
        </p>
      );
    return (
      <main className="popup">
        <Brand />
        {banner}
        {loadError === null && <p className="loading">载入中…</p>}
      </main>
    );
  }

  // 这是「扩展没有在保护你」/「你的改动没有落地」的状态，必须一眼可见，
  // 不能只留在控制台里。两条互不相关，都在时都要看得到，谁也不该盖住谁。
  const warnings = [
    syncError === null ? null : `拦截未生效：${syncError}`,
    syncUnknown === null ? null : `无法确认拦截是否生效：${syncUnknown}`,
    saveError === null ? null : `设置未能保存：${saveError}`,
  ].filter((message): message is string => message !== null);
  const banner = warnings.map((message) => (
    <p key={message} className="warning" role="alert">
      <span aria-hidden="true">⚠️</span>
      <span>{message}</span>
    </p>
  ));

  // 设置说「这个页面应该被拦」，与「这个页面实际被拦住了」是两件事，
  // 对不上的时候要如实说对不上，而不是照着设置报喜。
  const shouldBlock =
    settings.enabled && host !== '' && !isWhitelisted(host, settings.whitelist);
  const status: DisplayStatus = probed ? pageStatus(shouldBlock, pageBlocked) : 'probing';

  return (
    <main className="popup">
      <Brand />

      {banner}

      <div className="stack">
        {host !== '' && (
          <section className="card site">
            <div className="site-head">
              <StatusMark status={status} />
              <div className="site-text">
                <p className="host">{host}</p>
                <p className={STATE_CLASS[status]}>{STATE_TEXT[status]}</p>
              </div>
            </div>

            {status === 'stale' && (
              <p className="stale" role="alert">
                <span>
                  {shouldBlock
                    ? '此页在拦截生效前就已加载，WebRTC 仍然可用。'
                    : '此页在放行生效前就已加载，WebRTC 仍然被拦着。'}
                </span>
                <button type="button" className="stale-action" onClick={() => void api.reloadPage()}>
                  重新加载
                </button>
              </p>
            )}

            <p className="count">
              本页已拦截 <strong>{count}</strong> 次
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

        <section className="card switches">
          <label className="row">
            <span className="row-label">启用 WebRTC 拦截</span>
            <input
              type="checkbox"
              aria-label="启用 WebRTC 拦截"
              checked={settings.enabled}
              onChange={(event) => void update({ enabled: event.target.checked })}
            />
            <span className="switch" aria-hidden="true" />
          </label>

          <label className="row">
            <span className="row-label">同时拦截摄像头与麦克风</span>
            <input
              type="checkbox"
              aria-label="同时拦截摄像头与麦克风"
              checked={settings.blockMedia}
              onChange={(event) => void update({ blockMedia: event.target.checked })}
            />
            <span className="switch" aria-hidden="true" />
          </label>
        </section>
      </div>
    </main>
  );
}
