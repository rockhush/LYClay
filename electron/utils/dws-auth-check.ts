/**
 * Check if DWS CLI is authenticated on app startup
 * If not, prompt user to authenticate
 */

import { isDwsCliAuthenticated } from './dws-auth';
import { logger } from './logger';
import { app, dialog } from 'electron';

export async function checkDwsAuthOnStartup(): Promise<void> {
  // Skip if not packaged (dev mode)
  if (!app.isPackaged) {
    logger.info('[DwsAuth] Dev mode, skipping DWS auth check');
    return;
  }

  // Check if DWS CLI is authenticated
  try {
    const isAuthenticated = isDwsCliAuthenticated();
    
    if (!isAuthenticated) {
      logger.info('[DwsAuth] DWS CLI not authenticated');
      
      // Show notification or dialog to user
      // Option 1: Show dialog on first launch
      const response = await dialog.showMessageBox({
        type: 'info',
        title: 'DWS CLI 需要认证',
        message: '检测到 DWS CLI 尚未认证',
        detail: '请在终端执行以下命令完成认证：\n\n  dws auth login --device\n\n或使用扫码登录：\n\n  dws auth login',
        buttons: ['我知道了', '打开文档'],
        defaultId: 0,
      });
      
      if (response.response === 1) {
        // Open documentation
        const { shell } = require('electron');
        await shell.openExternal('https://your-docs-url.com/dws-auth');
      }
    } else {
      logger.info('[DwsAuth] DWS CLI is authenticated ✅');
    }
  } catch (error) {
    logger.warn('[DwsAuth] Failed to check DWS auth status:', error);
  }
}
