import { installRtcBlocker } from '../core/patch';
import { report } from './report';

// 无状态、无异步、无条件分支：是否注入本脚本由 Service Worker 在注入前裁决。
installRtcBlocker(window as unknown as Record<string, unknown>, report);
