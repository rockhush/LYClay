import crypto from 'node:crypto';

interface PendingSkillUploadConfirmation {
  fileName: string;
  fileDigest: string;
  expiresAt: number;
}

/**
 * Main 进程签发的一次性安装确认令牌。
 * Renderer 只能展示权限并带回令牌，不能直接构造 autoInstall 请求跳过预览。
 */
export class SkillUploadConfirmationStore {
  private readonly pending = new Map<string, PendingSkillUploadConfirmation>();

  constructor(
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  create(fileName: string, fileDigest: string): string {
    this.removeExpired();
    const token = crypto.randomUUID();
    this.pending.set(token, {
      fileName,
      fileDigest,
      expiresAt: this.now() + this.ttlMs,
    });
    return token;
  }

  consume(token: string | undefined, fileName: string, fileDigest: string): boolean {
    if (!token) return false;

    const confirmation = this.pending.get(token);
    this.pending.delete(token);
    return Boolean(
      confirmation
      && confirmation.expiresAt > this.now()
      && confirmation.fileName === fileName
      && confirmation.fileDigest === fileDigest,
    );
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [token, confirmation] of this.pending) {
      if (confirmation.expiresAt <= now) {
        this.pending.delete(token);
      }
    }
  }
}
