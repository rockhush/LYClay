import { invokeIpc } from './api-client';
import { subscribeHostEvent } from './host-events';

export type SecurityConfirmationChoice =
  | 'deny'
  | 'allow-once'
  | 'allow-session'
  | 'allow-persistent';

export type SecurityConfirmationResponse = {
  id: string;
  choice: SecurityConfirmationChoice;
};

export function subscribeSecurityConfirmationRequests<T>(
  handler: (payload: T) => void,
): () => void {
  return subscribeHostEvent<T>('security:confirmation-request', handler);
}

export async function sendSecurityConfirmationResponse(response: SecurityConfirmationResponse): Promise<void> {
  // Renderer 只回传用户在弹窗里的选择，真正授权写入和策略决策仍由 Main 进程完成。
  await invokeIpc('security:confirmation-response', response);
}
