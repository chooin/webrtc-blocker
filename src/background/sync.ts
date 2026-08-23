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

async function syncScripts(settings: Settings, deps: SyncDeps): Promise<void> {
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
}

/**
 * 脚本注册失败时仍然下发 IP 策略：它是第二道防线，恰恰在 JS 层没能就位时最需要生效。
 * 失败原因照常向上抛，由调用方记录并让 popup 如实告知用户。
 */
export async function syncBlocking(settings: Settings, deps: SyncDeps): Promise<void> {
  // 用对象包一层而不是直接存 error：抛出来的值可能就是 undefined。
  let failure: { error: unknown } | null = null;

  try {
    await syncScripts(settings, deps);
  } catch (error) {
    failure = { error };
  }

  try {
    await deps.ipPolicy.set({ value: ipHandlingPolicy(settings) });
  } catch (error) {
    // 先发生的失败信息更接近根因，故只在还没有失败时才记录这一个。
    failure ??= { error };
  }

  if (failure !== null) throw failure.error;
}
