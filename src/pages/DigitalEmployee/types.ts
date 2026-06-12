export interface ToggleRowItem {
  id: string;
  label: string;
  enabled: boolean;
}

export interface DigitalEmployeeFormData {
  id: string;
  name: string;
  prompt: string;
  keywords: string;
  skills: ToggleRowItem[];
  mcpItems: ToggleRowItem[];
  knowledgeDocs: string[];
}

export const DEFAULT_KEYWORDS = '#发票验真# #预算校验# #异常预警#';
