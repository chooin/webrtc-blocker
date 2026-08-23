import type { RegistrationSpec, Settings } from '../core/types';
import { desiredRegistrations, ipHandlingPolicy, reconcile } from '../core/policy';

/** 只声明用得到的方法，好让测试传入普通对象而不必 mock 整个 chrome 命名空间。 */
export interface ScriptingLike {
  getRegisteredContentScripts(): Promise<{ id: string }[]>;
  registerContentScripts(scripts: RegistrationSpec[]): Promise<void>;
  updateContentScripts(scripts: RegistrationSpec[]): Promise<void>;
  unregisterContentScripts(filter: { ids: string[] }): Promise<void>;
}

export interface IpPolicyLike {
  set(details: { value: string }): Promise<void>;
}

export interface SyncDeps {
  scripting: ScriptingLike;
  ipPolicy: IpPolicyLike;
}

export async function syncBlocking(settings: Settings, deps: SyncDeps): Promise<void> {
  const current = await deps.scripting.getRegisteredContentScripts();
  const plan = reconcile(
    current.map((script) => script.id),
    desiredRegistrations(settings),
  );

  // 顺序要紧：先注销再注册，否则复用同一 id 时 register 会因 id 已存在而失败。
  if (plan.unregister.length > 0) {
    await deps.scripting.unregisterContentScripts({ ids: plan.unregister });
  }
  if (plan.register.length > 0) {
    await deps.scripting.registerContentScripts(plan.register);
  }
  if (plan.update.length > 0) {
    await deps.scripting.updateContentScripts(plan.update);
  }

  await deps.ipPolicy.set({ value: ipHandlingPolicy(settings) });
}
