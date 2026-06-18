export interface AiToolItem {
  name: string;
  desc: string;
  tag: string;
  type: string;
  url: string;
}

export const AI_TOOLS: AiToolItem[] = [
  {
    name: 'MSOP报告生成',
    desc: '通过训练 AI 模型，自动提取图纸中的尺寸与公差信息并整理输出 MSOP 报告。提升效率与精确度，大量减少MSOP制作周期',
    tag: '图纸解析,YOLO,OCR',
    type: '工程',
    url: 'http://10.120.52.2:10265/',
  },
];
