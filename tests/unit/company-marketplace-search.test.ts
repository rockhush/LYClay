import { describe, expect, it } from 'vitest';
import {
  matchesMarketplaceQuery,
  tokenizeMarketplaceQuery,
} from '../../electron/utils/company-marketplace-search';

describe('company-marketplace-search', () => {
  it('splits whitespace-separated query tokens', () => {
    expect(tokenizeMarketplaceQuery('报销 excel')).toEqual(['报销', 'excel']);
  });

  it('splits mixed latin and CJK segments', () => {
    expect(tokenizeMarketplaceQuery('excel报销')).toEqual(['excel', '报销']);
  });

  it('splits short continuous CJK into 2-character chunks', () => {
    expect(tokenizeMarketplaceQuery('考勤助手')).toEqual(['考勤', '助手']);
  });

  it('keeps long continuous CJK as one substring token', () => {
    expect(tokenizeMarketplaceQuery('帮我找一个能做钉钉考勤的助手')).toEqual([
      '帮我找一个能做钉钉考勤的助手',
    ]);
  });

  it('matches when all short CJK tokens appear across fields', () => {
    expect(matchesMarketplaceQuery(
      { name: '钉钉考勤', description: '智能助手，支持打卡' },
      '考勤助手',
    )).toBe(true);
  });

  it('does not match when a token is missing', () => {
    expect(matchesMarketplaceQuery(
      { name: '钉钉考勤', description: '打卡管理' },
      '考勤助手',
    )).toBe(false);
  });

  it('matches multi-keyword queries separated by spaces', () => {
    expect(matchesMarketplaceQuery(
      { name: '报销表格助手', description: '支持 excel 导出' },
      '报销 excel',
    )).toBe(true);
  });
});
