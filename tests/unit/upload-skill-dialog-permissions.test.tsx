import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UploadSkillDialog } from '@/components/skills/UploadSkillDialog';
import { invokeIpc } from '@/lib/api-client';
import { toast } from 'sonner';

vi.mock('@/lib/api-client', () => ({
  invokeIpc: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

const labels: Record<string, string> = {
  'upload.title': '上传技能',
  'upload.subtitle': '从本地 ZIP 文件安装技能',
  'upload.dragDrop': '拖拽文件或点击上传',
  'upload.browse': '浏览文件',
  'upload.requirements': '文件要求',
  'upload.requirement1': '需要包含 SKILL.md',
  'upload.requirement2': '需要 YAML 元数据',
  'upload.requirement3': '禁止可执行文件',
  'upload.requirement4': '禁止路径穿越',
  'upload.cancel': '取消',
  'upload.upload': '上传',
  'upload.uploading': '上传中...',
  'upload.permissions.reviewTitle': '确认 Skill 权限',
  'upload.permissions.added': '本次请求的权限',
  'upload.permissions.unchanged': '已有权限',
  'upload.permissions.none': '该 Skill 未请求额外权限。',
  'upload.permissions.workspaceMetadata': '查看 Workspace 文件信息',
  'upload.permissions.workspaceRead': '读取 Workspace 文件',
  'upload.permissions.workspaceWrite': '写入 Workspace 文件',
  'upload.permissions.back': '返回',
  'upload.permissions.confirm': '确认安装',
  'upload.permissions.riskLevels.medium': '中',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'upload.permissions.risk') return `风险：${String(params?.risk ?? '')}`;
      if (key === 'upload.permissions.networkDomain') return `访问域名：${String(params?.domain ?? '')}`;
      return labels[key] ?? key;
    },
  }),
}));

describe('UploadSkillDialog permission review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('previews requested permissions before sending the install confirmation', async () => {
    vi.mocked(invokeIpc)
      .mockResolvedValueOnce({
        success: true,
        preview: true,
        skillName: 'safe-skill',
        confirmationToken: 'preview-token',
        permissions: {
          filesystem: ['workspace:metadata', 'workspace:read', 'workspace:write'],
          network: ['api.example.com'],
          commands: [],
          secrets: [],
        },
        permissionDiff: {
          added: ['network:api.example.com'],
          unchanged: [
            'filesystem:workspace:metadata',
            'filesystem:workspace:read',
            'filesystem:workspace:write',
          ],
          removed: [],
        },
        validationResult: {
          riskLevel: 'medium',
          findings: [],
          summary: { errors: 0, warnings: 0 },
          stage: 'preview',
        },
      })
      .mockResolvedValueOnce({
        success: true,
        skillName: 'safe-skill',
        validationResult: {
          riskLevel: 'medium',
          findings: [],
          summary: { errors: 0, warnings: 0 },
          stage: 'complete',
        },
      });

    const onUploadComplete = vi.fn();
    render(
      <UploadSkillDialog open onOpenChange={vi.fn()} onUploadComplete={onUploadComplete} />,
    );
    const input = document.querySelector('#skill-upload-input') as HTMLInputElement;
    const file = new File(['zip-content'], 'safe-skill.zip', { type: 'application/zip' });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByTestId('skill-upload-submit-button'));

    expect(await screen.findByText('确认 Skill 权限')).toBeInTheDocument();
    expect(screen.getByText('读取 Workspace 文件')).toBeInTheDocument();
    expect(screen.getByText('写入 Workspace 文件')).toBeInTheDocument();
    expect(screen.getByText('访问域名：api.example.com')).toBeInTheDocument();

    expect(invokeIpc).toHaveBeenCalledTimes(1);
    expect(invokeIpc).toHaveBeenNthCalledWith(1, 'skill:uploadZip', expect.objectContaining({
      fileName: 'safe-skill.zip',
      autoInstall: false,
    }));

    fireEvent.click(screen.getByRole('button', { name: '确认安装' }));

    await waitFor(() => {
      expect(invokeIpc).toHaveBeenCalledTimes(2);
    });
    expect(invokeIpc).toHaveBeenNthCalledWith(2, 'skill:uploadZip', expect.objectContaining({
      fileName: 'safe-skill.zip',
      autoInstall: true,
      confirmationToken: 'preview-token',
    }));
    expect(onUploadComplete).toHaveBeenCalledTimes(1);
  });

  it('completes installation immediately when Main reports no elevated permission review', async () => {
    vi.mocked(invokeIpc).mockResolvedValueOnce({
      success: true,
      skillName: 'basic-skill',
      validationResult: {
        riskLevel: 'low',
        findings: [],
        summary: { errors: 0, warnings: 0 },
        stage: 'complete',
      },
    });

    const onOpenChange = vi.fn();
    const onUploadComplete = vi.fn();
    render(
      <UploadSkillDialog open onOpenChange={onOpenChange} onUploadComplete={onUploadComplete} />,
    );
    const input = document.querySelector('#skill-upload-input') as HTMLInputElement;
    const file = new File(['zip-content'], 'basic-skill.zip', { type: 'application/zip' });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: '上传' }));

    await waitFor(() => {
      expect(onUploadComplete).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('skill-permission-review')).not.toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('distinguishes blocking findings from warning-only script findings', async () => {
    vi.mocked(invokeIpc).mockResolvedValueOnce({
      success: false,
      securityBlocked: true,
      errorCode: 'CONTENT_BLOCKED',
      validationResult: {
        riskLevel: 'high',
        findings: [
          {
            level: 'error',
            category: 'suspicious-url',
            message: 'Suspicious URL in "SKILL.md": Suspicious keyword in URL: "login" — https://example.com/login',
          },
          {
            level: 'warning',
            category: 'file-type',
            message: 'Potentially dangerous script file: "scripts/setup.sh" (extension .sh)',
          },
        ],
        summary: { errors: 1, warnings: 1 },
        stage: 'post-extraction',
      },
    });

    render(
      <UploadSkillDialog open onOpenChange={vi.fn()} onUploadComplete={vi.fn()} />,
    );
    const input = document.querySelector('#skill-upload-input') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [new File(['zip-content'], 'agent-browser.zip', { type: 'application/zip' })],
      },
    });
    fireEvent.click(screen.getByTestId('skill-upload-submit-button'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('SKILL.md（包含高风险链接，已阻止上传）'),
        expect.any(Object),
      );
    });
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('scripts/setup.sh（.sh 脚本文件，仅提醒）'),
      expect.any(Object),
    );
  });
});
