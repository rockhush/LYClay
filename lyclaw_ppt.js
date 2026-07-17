const pptxgen = require("pptxgenjs");

// Color scheme - Orange theme
const COLORS = {
  primary: "FF6B35",
  primaryDark: "E55A2B",
  primaryLight: "FF8C5A",
  secondary: "2C3E50",
  accent: "F39C12",
  white: "FFFFFF",
  lightGray: "F8F9FA",
  mediumGray: "95A5A6",
  darkGray: "34495E"
};

const pres = new pptxgen();
pres.layout = 'LAYOUT_16x9';
pres.author = 'LYClaw Team';
pres.title = 'LYClaw 数字员工 Skill 闭环建设方案';

// ========== SLIDE 1: 封面页 ==========
let slide1 = pres.addSlide();
slide1.background = { color: COLORS.white };

slide1.addShape(pres.shapes.RECTANGLE, {
  x: 0, y: 0, w: 10, h: 0.3,
  fill: { color: COLORS.primary }
});

slide1.addText([
  { text: "LYClaw ", options: { bold: true, color: COLORS.primary, fontSize: 44, fontFace: "Microsoft YaHei" } },
  { text: "数字员工", options: { bold: true, color: COLORS.secondary, fontSize: 44, fontFace: "Microsoft YaHei" } }
], { x: 0.5, y: 1.5, w: 9, h: 1, align: "center" });

slide1.addText("Skill 闭环建设方案", {
  x: 0.5, y: 2.3, w: 9, h: 0.8,
  fontSize: 36, fontFace: "Microsoft YaHei",
  color: COLORS.darkGray, bold: true, align: "center"
});

slide1.addText("构建可持续、可量化、可复制的 AI 能力生态", {
  x: 0.5, y: 3.2, w: 9, h: 0.5,
  fontSize: 18, fontFace: "Microsoft YaHei",
  color: COLORS.mediumGray, align: "center", italic: true
});

// Decorative circle instead of icon
slide1.addShape(pres.shapes.OVAL, {
  x: 4.25, y: 3.8, w: 1.5, h: 1.5,
  fill: { color: COLORS.primary }
});
slide1.addText("🚀", {
  x: 4.5, y: 3.9, w: 1, h: 1,
  fontSize: 48, align: "center", color: "FFFFFF"
});

slide1.addShape(pres.shapes.RECTANGLE, {
  x: 0, y: 5.325, w: 10, h: 0.3,
  fill: { color: COLORS.primary }
});
slide1.addText("LYClaw Platform · 2026", {
  x: 0, y: 5.35, w: 10, h: 0.25,
  fontSize: 10, color: COLORS.white, align: "center", fontFace: "Microsoft YaHei"
});

// ========== SLIDE 2: 目录页 ==========
let slide2 = pres.addSlide();
slide2.background = { color: COLORS.white };

slide2.addText("目录", {
  x: 0.5, y: 0.4, w: 9, h: 0.6,
  fontSize: 32, fontFace: "Microsoft YaHei",
  color: COLORS.primary, bold: true
});

slide2.addShape(pres.shapes.RECTANGLE, {
  x: 0.5, y: 1.05, w: 1, h: 0.05,
  fill: { color: COLORS.primary }
});

const tocItems = [
  { num: "01", title: "总体架构与角色分工" },
  { num: "02", title: "平台层职责" },
  { num: "03", title: "产品/业务线职责" },
  { num: "04", title: "治理层职责" },
  { num: "05", title: "六步闭环流程" },
  { num: "06", title: "Skill 建设全流程" },
  { num: "07", title: "量化价值与收益" },
  { num: "08", title: "评选与激励机制" },
  { num: "09", title: "运营迭代与沉淀" },
  { num: "10", title: "组织与节奏建议" },
  { num: "11", title: "关键交付物清单" }
];

for (let i = 0; i < tocItems.length; i++) {
  const item = tocItems[i];
  const y = 1.3 + (i * 0.42);
  
  // Number circle
  slide2.addShape(pres.shapes.OVAL, {
    x: 0.55, y: y + 0.02, w: 0.35, h: 0.35,
    fill: { color: COLORS.primary }
  });
  slide2.addText(item.num, {
    x: 0.55, y: y + 0.05, w: 0.35, h: 0.3,
    fontSize: 11, fontFace: "Microsoft YaHei",
    color: COLORS.white, bold: true, align: "center"
  });
  
  slide2.addText(item.title, {
    x: 1.0, y: y, w: 7.7, h: 0.35,
    fontSize: 14, fontFace: "Microsoft YaHei",
    color: COLORS.secondary
  });
}

// ========== SLIDE 3: 总体架构 ==========
let slide3 = pres.addSlide();
slide3.background = { color: COLORS.white };

slide3.addText("总体架构与角色分工", {
  x: 0.5, y: 0.4, w: 9, h: 0.6,
  fontSize: 28, fontFace: "Microsoft YaHei",
  color: COLORS.primary, bold: true
});

const pillars = [
  { 
    title: "平台层 (LYClaw)", 
    color: COLORS.primary,
    bgColor: "FFF5F0",
    emoji: "⚙️",
    items: ["技能市场建设与运营", "工具与 SDK 开发", "评审流程与标准制定", "技术赋能与培训"]
  },
  { 
    title: "产品/业务线", 
    color: COLORS.accent,
    bgColor: "FEF9E7",
    emoji: "👥",
    items: ["场景挖掘与需求提出", "日常运营与维护", "业务专家参与评审", "使用反馈与迭代"]
  },
  { 
    title: "治理层 (PMC)", 
    color: COLORS.secondary,
    bgColor: "F5F6F7",
    emoji: "📋",
    items: ["战略方向把控", "重大事项决策", "资源协调与保障", "治理政策制定"]
  }
];

for (let idx = 0; idx < pillars.length; idx++) {
  const pillar = pillars[idx];
  const x = 0.5 + (idx * 3.1);
  
  slide3.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: x, y: 1.3, w: 2.9, h: 3.5,
    fill: { color: pillar.bgColor },
    rectRadius: 0.1
  });
  
  slide3.addText(pillar.emoji, {
    x: x + 1.1, y: 1.5, w: 0.7, h: 0.7,
    fontSize: 36, align: "center"
  });
  
  slide3.addText(pillar.title, {
    x: x + 0.2, y: 2.3, w: 2.5, h: 0.4,
    fontSize: 14, fontFace: "Microsoft YaHei",
    color: pillar.color, bold: true, align: "center"
  });
  
  for (let i = 0; i < pillar.items.length; i++) {
    slide3.addText(pillar.items[i], {
      x: x + 0.3, y: 2.8 + (i * 0.45), w: 2.3, h: 0.35,
      fontSize: 11, fontFace: "Microsoft YaHei",
      color: COLORS.darkGray, bullet: true
    });
  }
}

slide3.addText("三位一体协同机制", {
  x: 0.5, y: 5.1, w: 9, h: 0.3,
  fontSize: 12, fontFace: "Microsoft YaHei",
  color: COLORS.mediumGray, align: "center", italic: true
});

// ========== SLIDE 4: 平台层职责 ==========
let slide4 = pres.addSlide();
slide4.background = { color: COLORS.white };

slide4.addText("平台层职责 (LYClaw)", {
  x: 0.5, y: 0.4, w: 9, h: 0.6,
  fontSize: 28, fontFace: "Microsoft YaHei",
  color: COLORS.primary, bold: true
});

const platformDuties = [
  { title: "基础设施建设", desc: "技能市场、评审系统、数据看板", emoji: "🔧" },
  { title: "标准与流程", desc: "评审标准、操作手册、SLA 保障", emoji: "📋" },
  { title: "赋能与培训", desc: "开发者文档、培训课程、技术支持", emoji: "👥" },
  { title: "运营与激励", desc: "排行榜、评选活动、奖金池运营", emoji: "🏆" }
];

for (let idx = 0; idx < platformDuties.length; idx++) {
  const duty = platformDuties[idx];
  const row = Math.floor(idx / 2);
  const col = idx % 2;
  const x = 0.6 + (col * 4.6);
  const y = 1.3 + (row * 2.0);
  
  slide4.addShape(pres.shapes.RECTANGLE, {
    x: x, y: y, w: 4.3, h: 1.8,
    fill: { color: "F8F9FA" },
    line: { color: COLORS.primary, width: 2 }
  });
  
  slide4.addText(duty.emoji, {
    x: x + 0.3, y: y + 0.3, w: 0.6, h: 0.6,
    fontSize: 32
  });
  
  slide4.addText(duty.title, {
    x: x + 1.1, y: y + 0.35, w: 3.0, h: 0.35,
    fontSize: 16, fontFace: "Microsoft YaHei",
    color: COLORS.secondary, bold: true
  });
  
  slide4.addText(duty.desc, {
    x: x + 1.1, y: y + 0.75, w: 3.0, h: 0.6,
    fontSize: 13, fontFace: "Microsoft YaHei",
    color: COLORS.mediumGray
  });
}

slide4.addText("核心定位：生态建设者 + 服务提供者", {
  x: 0.5, y: 5.1, w: 9, h: 0.4,
  fontSize: 14, fontFace: "Microsoft YaHei",
  color: COLORS.primary, bold: true, align: "center"
});

// ========== SLIDE 5: 产品/业务线职责 ==========
let slide5 = pres.addSlide();
slide5.background = { color: COLORS.white };

slide5.addText("产品/业务线职责", {
  x: 0.5, y: 0.4, w: 9, h: 0.6,
  fontSize: 28, fontFace: "Microsoft YaHei",
  color: COLORS.primary, bold: true
});

const businessDuties = [
  {
    phase: "需求阶段",
    items: ["识别重复性高、规则明确的工作场景", "提供真实业务场景与数据", "参与 ROI 评估"]
  },
  {
    phase: "建设阶段",
    items: ["派驻业务专家参与评审", "协助定义验收标准", "提供测试场景与反馈"]
  },
  {
    phase: "运营阶段",
    items: ["负责本业务线 Skill 日常维护", "收集使用反馈", "推动内部推广"]
  }
];

for (let idx = 0; idx < businessDuties.length; idx++) {
  const phase = businessDuties[idx];
  const x = 0.6 + (idx * 3.1);
  
  slide5.addShape(pres.shapes.RECTANGLE, {
    x: x, y: 1.3, w: 2.9, h: 0.6,
    fill: { color: COLORS.primary }
  });
  slide5.addText(phase.phase, {
    x: x, y: 1.4, w: 2.9, h: 0.4,
    fontSize: 16, fontFace: "Microsoft YaHei",
    color: COLORS.white, bold: true, align: "center"
  });
  
  for (let i = 0; i < phase.items.length; i++) {
    slide5.addText(phase.items[i], {
      x: x + 0.3, y: 2.1 + (i * 0.8), w: 2.3, h: 0.6,
      fontSize: 12, fontFace: "Microsoft YaHei",
      color: COLORS.darkGray, bullet: true
    });
  }
}

slide5.addText("核心价值：从需求方转变为共建方", {
  x: 0.5, y: 4.5, w: 9, h: 0.4,
  fontSize: 14, fontFace: "Microsoft YaHei",
  color: COLORS.accent, bold: true, align: "center"
});

// ========== SLIDE 6: 治理层职责 ==========
let slide6 = pres.addSlide();
slide6.background = { color: COLORS.white };

slide6.addText("治理层职责 (PMC/技术委员会)", {
  x: 0.5, y: 0.4, w: 9, h: 0.6,
  fontSize: 28, fontFace: "Microsoft YaHei",
  color: COLORS.primary, bold: true
});

const governanceItems = [
  { title: "战略决策", content: "• 技能生态长期规划\n• 重大资源投入决策\n• 跨部门协调机制", highlight: true },
  { title: "标准审批", content: "• 评审标准与流程审批\n• 激励机制与奖金池方案\n• SLA 服务水平协议", highlight: false },
  { title: "监督执行", content: "• 定期听取运营汇报\n• 处理升级争议\n• 确保合规与安全", highlight: false },
  { title: "资源保障", content: "• 人力资源协调\n• 预算与奖金池审批\n• 基础设施投入", highlight: false }
];

for (let idx = 0; idx < governanceItems.length; idx++) {
  const item = governanceItems[idx];
  const row = Math.floor(idx / 2);
  const col = idx % 2;
  const x = 0.7 + (col * 4.5);
  const y = 1.4 + (row * 1.9);
  
  const lineWidth = item.highlight ? 3 : 1;
  const lineColor = item.highlight ? COLORS.primary : COLORS.mediumGray;
  
  slide6.addShape(pres.shapes.RECTANGLE, {
    x: x, y: y, w: 4.2, h: 1.7,
    fill: { color: item.highlight ? "FFF5F0" : "F8F9FA" },
    line: { color: lineColor, width: lineWidth }
  });
  
  slide6.addText(item.title, {
    x: x + 0.3, y: y + 0.25, w: 3.6, h: 0.35,
    fontSize: 15, fontFace: "Microsoft YaHei",
    color: item.highlight ? COLORS.primary : COLORS.secondary, bold: true
  });
  
  slide6.addText(item.content, {
    x: x + 0.3, y: y + 0.65, w: 3.6, h: 0.9,
    fontSize: 11, fontFace: "Microsoft YaHei",
    color: COLORS.darkGray
  });
}

slide6.addText("治理原则：战略引领 · 标准先行 · 监督有力 · 资源保障", {
  x: 0.5, y: 5.2, w: 9, h: 0.3,
  fontSize: 12, fontFace: "Microsoft YaHei",
  color: COLORS.mediumGray, align: "center", italic: true
});

// ========== SLIDE 7: 六步闭环流程 ==========
let slide7 = pres.addSlide();
slide7.background = { color: COLORS.white };

slide7.addText("六步闭环流程", {
  x: 0.5, y: 0.4, w: 9, h: 0.6,
  fontSize: 28, fontFace: "Microsoft YaHei",
  color: COLORS.primary, bold: true
});

const steps = [
  { num: 1, title: "Skill 挖掘", emoji: "💡", desc: "场景识别" },
  { num: 2, title: "Skill 建设", emoji: "🔧", desc: "开发实施" },
  { num: 3, title: "Skill 评审", emoji: "✅", desc: "质量把关" },
  { num: 4, title: "量化价值", emoji: "📊", desc: "收益评估" },
  { num: 5, title: "评选激励", emoji: "🏆", desc: "荣誉奖励" },
  { num: 6, title: "运营迭代", emoji: "🔄", desc: "持续优化" }
];

for (let idx = 0; idx < steps.length; idx++) {
  const step = steps[idx];
  const x = 0.5 + (idx * 1.55);
  
  if (idx > 0) {
    slide7.addShape(pres.shapes.LINE, {
      x: x - 0.2, y: 2.5, w: 0.8, h: 0,
      line: { color: COLORS.primary, width: 2, dashType: "dash" }
    });
  }
  
  slide7.addShape(pres.shapes.OVAL, {
    x: x + 0.35, y: 1.5, w: 0.8, h: 0.8,
    fill: { color: COLORS.primary }
  });
  
  slide7.addText(step.emoji, {
    x: x + 0.45, y: 1.55, w: 0.6, h: 0.6,
    fontSize: 28, align: "center"
  });
  
  slide7.addText(String(step.num), {
    x: x + 1.05, y: 1.55, w: 0.4, h: 0.3,
    fontSize: 10, fontFace: "Microsoft YaHei",
    color: COLORS.white, bold: true
  });
  
  slide7.addText(step.title, {
    x: x + 0.1, y: 2.5, w: 1.1, h: 0.3,
    fontSize: 11, fontFace: "Microsoft YaHei",
    color: COLORS.secondary, bold: true, align: "center"
  });
  
  slide7.addText(step.desc, {
    x: x + 0.1, y: 2.8, w: 1.1, h: 0.25,
    fontSize: 9, fontFace: "Microsoft YaHei",
    color: COLORS.mediumGray, align: "center"
  });
}

slide7.addText("持续迭代", {
  x: 0.5, y: 3.3, w: 9, h: 0.3,
  fontSize: 12, fontFace: "Microsoft YaHei",
  color: COLORS.primary, bold: true, align: "center"
});

slide7.addText('形成"挖掘→建设→评审→量化→激励→迭代"的完整闭环', {
  x: 0.5, y: 5.2, w: 9, h: 0.3,
  fontSize: 11, fontFace: "Microsoft YaHei",
  color: COLORS.mediumGray, align: "center", italic: true
});

// ========== SLIDE 8: Step 1 - Skill 挖掘 ==========
let slide8 = pres.addSlide();
slide8.background = { color: COLORS.white };

slide8.addText("Step 1: Skill 挖掘", {
  x: 0.5, y: 0.4, w: 9, h: 0.6,
  fontSize: 28, fontFace: "Microsoft YaHei",
  color: COLORS.primary, bold: true
});

slide8.addShape(pres.shapes.RECTANGLE, {
  x: 0.5, y: 1.05, w: 1.2, h: 0.05,
  fill: { color: COLORS.primary }
});

slide8.addText("输入来源", {
  x: 0.5, y: 1.3, w: 2.5, h: 0.4,
  fontSize: 16, fontFace: "Microsoft YaHei",
  color: COLORS.secondary, bold: true
});

const sources = ["业务痛点调研", "重复性工作识别", "现有流程优化机会", "竞品分析", "行业最佳实践"];

for (let idx = 0; idx < sources.length; idx++) {
  slide8.addText(sources[idx], {
    x: 0.7, y: 1.8 + (idx * 0.5), w: 2.1, h: 0.35,
    fontSize: 12, fontFace: "Microsoft YaHei",
    color: COLORS.darkGray, bullet: true
  });
}

slide8.addShape(pres.shapes.RECTANGLE, {
  x: 3.2, y: 1.3, w: 3.6, h: 3.5,
  fill: { color: "FFF5F0" },
  line: { color: COLORS.primary, width: 2 }
});

slide8.addText("筛选标准", {
  x: 3.4, y: 1.4, w: 3.2, h: 0.4,
  fontSize: 16, fontFace: "Microsoft YaHei",
  color: COLORS.primary, bold: true, align: "center"
});

const criteria = ["✓ 高频场景（月使用>100 次）", "✓ 规则明确（可标准化）", "✓ 价值可量化（ROI 清晰）", "✓ 数据可获取", "✓ 技术可实现"];

for (let idx = 0; idx < criteria.length; idx++) {
  slide8.addText(criteria[idx], {
    x: 3.4, y: 1.9 + (idx * 0.6), w: 3.2, h: 0.45,
    fontSize: 13, fontFace: "Microsoft YaHei",
    color: COLORS.darkGray
  });
}

slide8.addText("输出物", {
  x: 7.0, y: 1.3, w: 2.5, h: 0.4,
  fontSize: 16, fontFace: "Microsoft YaHei",
  color: COLORS.secondary, bold: true
});

const outputs = ["《Skill 需求卡》", "初步 ROI 评估", "场景描述文档", "优先级排序"];

for (let idx = 0; idx < outputs.length; idx++) {
  const bgColor = idx === 0 ? COLORS.primary : COLORS.lightGray;
  slide8.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 7.0, y: 1.8 + (idx * 0.6), w: 2.3, h: 0.45,
    fill: { color: bgColor },
    rectRadius: 0.05
  });
  slide8.addText(outputs[idx], {
    x: 7.1, y: 1.88 + (idx * 0.6), w: 2.1, h: 0.3,
    fontSize: 12, fontFace: "Microsoft YaHei",
    color: idx === 0 ? COLORS.white : COLORS.darkGray,
    bold: idx === 0
  });
}

// ========== SLIDE 9: Step 2 - Skill 建设 ==========
let slide9 = pres.addSlide();
slide9.background = { color: COLORS.white };

slide9.addText("Step 2: Skill 建设", {
  x: 0.5, y: 0.4, w: 9, h: 0.6,
  fontSize: 28, fontFace: "Microsoft YaHei",
  color: COLORS.primary, bold: true
});

const devPhases = [
  {
    phase: "需求分析",
    duration: "3-5 天",
    tasks: ["编写 PRD 文档", "定义输入/输出规范", "确定验收标准"],
    emoji: "📄"
  },
  {
    phase: "设计与开发",
    duration: "5-15 天",
    tasks: ["架构设计", "核心功能实现", "单元测试编写"],
    emoji: "🔧"
  },
  {
    phase: "测试与优化",
    duration: "3-7 天",
    tasks: ["集成测试", "性能优化", "用户体验打磨"],
    emoji: "✅"
  }
];

for (let idx = 0; idx < devPhases.length; idx++) {
  const devPhase = devPhases[idx];
  const x = 0.6 + (idx * 3.1);
  
  slide9.addShape(pres.shapes.RECTANGLE, {
    x: x, y: 1.3, w: 2.9, h: 0.7,
    fill: { color: COLORS.primary }
  });
  
  slide9.addText(devPhase.emoji, {
    x: x + 0.35, y: 1.4, w: 0.45, h: 0.45,
    fontSize: 28
  });
  
  slide9.addText(devPhase.phase, {
    x: x + 0.9, y: 1.5, w: 1.8, h: 0.3,
    fontSize: 14, fontFace: "Microsoft YaHei",
    color: COLORS.white, bold: true
  });
  
  slide9.addText(devPhase.duration, {
    x: x + 0.35, y: 1.85, w: 2.2, h: 0.25,
    fontSize: 10, fontFace: "Microsoft YaHei",
    color: COLORS.white, align: "left"
  });
  
  for (let i = 0; i < devPhase.tasks.length; i++) {
    slide9.addText(devPhase.tasks[i], {
      x: x + 0.35, y: 2.2 + (i * 0.45), w: 2.2, h: 0.35,
      fontSize: 11, fontFace: "Microsoft YaHei",
      color: COLORS.darkGray, bullet: true
    });
  }
}

slide9.addText("关键：敏捷开发 + 持续反馈", {
  x: 0.5, y: 4.8, w: 9, h: 0.4,
  fontSize: 14, fontFace: "Microsoft YaHei",
  color: COLORS.accent, bold: true, align: "center"
});

slide9.addText("推荐技术栈：Python + LYClaw SDK + 业务 API", {
  x: 0.5, y: 5.1, w: 9, h: 0.3,
  fontSize: 11, fontFace: "Microsoft YaHei",
  color: COLORS.mediumGray, align: "center"
});

// ========== SLIDE 10: Step 3 - Skill 评审 ==========
let slide10 = pres.addSlide();
slide10.background = { color: COLORS.white };

slide10.addText("Step 3: Skill 评审", {
  x: 0.5, y: 0.4, w: 9, h: 0.6,
  fontSize: 28, fontFace: "Microsoft YaHei",
  color: COLORS.primary, bold: true
});

slide10.addText("评审流程", {
  x: 0.5, y: 1.2, w: 2, h: 0.4,
  fontSize: 16, fontFace: "Microsoft YaHei",
  color: COLORS.secondary, bold: true
});

const reviewSteps = [
  { step: "提交", desc: "开发者提交评审申请" },
  { step: "初审", desc: "平台技术审查" },
  { step: "业务评审", desc: "业务专家验证" },
  { step: "终审", desc: "治理层审批" },
  { step: "发布", desc: "上架技能市场" }
];

for (let idx = 0; idx < reviewSteps.length; idx++) {
  const item = reviewSteps[idx];
  const circleColor = idx < 3 ? COLORS.primary : COLORS.mediumGray;
  
  slide10.addShape(pres.shapes.OVAL, {
    x: 0.5, y: 1.7 + (idx * 0.7), w: 0.5, h: 0.5,
    fill: { color: circleColor }
  });
  
  slide10.addText(String(idx + 1), {
    x: 0.5, y: 1.8 + (idx * 0.7), w: 0.5, h: 0.3,
    fontSize: 14, fontFace: "Microsoft YaHei",
    color: COLORS.white, bold: true, align: "center"
  });
  
  slide10.addText(item.step + ":" + item.desc, {
    x: 1.2, y: 1.85 + (idx * 0.7), w: 5, h: 0.45,
    fontSize: 12, fontFace: "Microsoft YaHei",
    color: COLORS.darkGray
  });
}

slide10.addShape(pres.shapes.RECTANGLE, {
  x: 6.0, y: 1.2, w: 3.5, h: 3.8,
  fill: { color: "F8F9FA" },
  line: { color: COLORS.primary, width: 2 }
});

slide10.addText("评审维度", {
  x: 6.2, y: 1.35, w: 3.1, h: 0.4,
  fontSize: 15, fontFace: "Microsoft YaHei",
  color: COLORS.primary, bold: true, align: "center"
});

const dimensions = [
  { name: "功能完整性", weight: "25%" },
  { name: "代码质量", weight: "20%" },
  { name: "业务价值", weight: "25%" },
  { name: "用户体验", weight: "15%" },
  { name: "文档完善度", weight: "15%" }
];

for (let idx = 0; idx < dimensions.length; idx++) {
  const dim = dimensions[idx];
  const y = 1.9 + (idx * 0.55);
  
  slide10.addShape(pres.shapes.RECTANGLE, {
    x: 6.2, y: y, w: 3.1, h: 0.35,
    fill: { color: "E8ECEF" }
  });
  
  const fillWidth = 2.8 * parseFloat(dim.weight) / 100;
  slide10.addShape(pres.shapes.RECTANGLE, {
    x: 6.2, y: y, w: fillWidth, h: 0.35,
    fill: { color: COLORS.primary }
  });
  
  slide10.addText(dim.name, {
    x: 6.3, y: y + 0.05, w: 1.5, h: 0.25,
    fontSize: 10, fontFace: "Microsoft YaHei",
    color: COLORS.darkGray
  });
  
  slide10.addText(dim.weight, {
    x: 9.0, y: y + 0.05, w: 0.3, h: 0.25,
    fontSize: 10, fontFace: "Microsoft YaHei",
    color: COLORS.secondary, bold: true, align: "right"
  });
}

// ========== SLIDE 11: Step 4 - 量化价值与收益 ==========
let slide11 = pres.addSlide();
slide11.background = { color: COLORS.white };

slide11.addText("Step 4: 量化价值与收益", {
  x: 0.5, y: 0.4, w: 9, h: 0.6,
  fontSize: 28, fontFace: "Microsoft YaHei",
  color: COLORS.primary, bold: true
});

slide11.addShape(pres.shapes.RECTANGLE, {
  x: 0.5, y: 1.3, w: 9, h: 1.2,
  fill: { color: "FFF5F0" },
  line: { color: COLORS.primary, width: 2 }
});

slide11.addText("ROI 计算公式", {
  x: 0.5, y: 1.45, w: 9, h: 0.35,
  fontSize: 16, fontFace: "Microsoft YaHei",
  color: COLORS.primary, bold: true, align: "center"
});

slide11.addText("ROI = (年收益 - 年成本) / 年成本 × 100%", {
  x: 0.5, y: 1.9, w: 9, h: 0.5,
  fontSize: 20, fontFace: "Microsoft YaHei",
  color: COLORS.secondary, bold: true, align: "center"
});

const valueDims = [
  {
    title: "时间节省",
    emoji: "⏱️",
    metrics: ["单次节省时长 × 年调用次数", "人均效率提升%"]
  },
  {
    title: "成本降低",
    emoji: "📊",
    metrics: ["人力成本节省", "错误减少带来的返工成本降低"]
  },
  {
    title: "质量提升",
    emoji: "✅",
    metrics: ["准确率提升%", "客户满意度提升"]
  }
];

for (let idx = 0; idx < valueDims.length; idx++) {
  const dim = valueDims[idx];
  const x = 0.7 + (idx * 2.9);
  const y = 2.8;
  
  slide11.addShape(pres.shapes.RECTANGLE, {
    x: x, y: y, w: 2.7, h: 2.3,
    fill: { color: "F8F9FA" }
  });
  
  slide11.addText(dim.emoji, {
    x: x + 1.05, y: y + 0.25, w: 0.5, h: 0.5,
    fontSize: 32, align: "center"
  });
  
  slide11.addText(dim.title, {
    x: x + 0.2, y: y + 0.8, w: 2.3, h: 0.3,
    fontSize: 14, fontFace: "Microsoft YaHei",
    color: COLORS.secondary, bold: true, align: "center"
  });
  
  for (let i = 0; i < dim.metrics.length; i++) {
    slide11.addText(dim.metrics[i], {
      x: x + 0.3, y: y + 1.2 + (i * 0.4), w: 2.1, h: 0.35,
      fontSize: 10, fontFace: "Microsoft YaHei",
      color: COLORS.mediumGray, bullet: true
    });
  }
}

slide11.addText("目标：每个 Skill 上线 3 个月内实现 ROI > 200%", {
  x: 0.5, y: 5.2, w: 9, h: 0.3,
  fontSize: 11, fontFace: "Microsoft YaHei",
  color: COLORS.primary, bold: true, align: "center"
});

// ========== SLIDE 12: Step 5 - 评选与激励 ==========
let slide12 = pres.addSlide();
slide12.background = { color: COLORS.white };

slide12.addText("Step 5: 评选与激励", {
  x: 0.5, y: 0.4, w: 9, h: 0.6,
  fontSize: 28, fontFace: "Microsoft YaHei",
  color: COLORS.primary, bold: true
});

const awards = [
  { level: "金牌 Skill", criteria: "Top 5% · ROI>500%", reward: "奖金 ¥5000 + 证书", medal: "🥇", medalColor: "FFD700" },
  { level: "银牌 Skill", criteria: "Top 20% · ROI>300%", reward: "奖金 ¥3000 + 证书", medal: "🥈", medalColor: "C0C0C0" },
  { level: "铜牌 Skill", criteria: "Top 50% · ROI>200%", reward: "奖金 ¥1000 + 证书", medal: "🥉", medalColor: "CD7F32" },
  { level: "最佳新人", criteria: "首次提交即通过评审", reward: "奖金 ¥500 + 荣誉证书", medal: "🌟", medalColor: COLORS.primary }
];

for (let idx = 0; idx < awards.length; idx++) {
  const award = awards[idx];
  const y = 1.3 + (idx * 1.0);
  
  slide12.addShape(pres.shapes.OVAL, {
    x: 0.7, y: y + 0.1, w: 0.6, h: 0.6,
    fill: { color: award.medalColor }
  });
  
  slide12.addText(award.medal, {
    x: 0.7, y: y + 0.15, w: 0.6, h: 0.5,
    fontSize: 24, align: "center"
  });
  
  slide12.addText(award.level, {
    x: 1.5, y: y + 0.15, w: 2, h: 0.3,
    fontSize: 15, fontFace: "Microsoft YaHei",
    color: COLORS.secondary, bold: true
  });
  
  slide12.addText(award.criteria, {
    x: 1.5, y: y + 0.45, w: 2, h: 0.25,
    fontSize: 11, fontFace: "Microsoft YaHei",
    color: COLORS.mediumGray
  });
  
  slide12.addText(award.reward, {
    x: 4.0, y: y + 0.2, w: 3, h: 0.4,
    fontSize: 14, fontFace: "Microsoft YaHei",
    color: COLORS.primary, bold: true
  });
}

slide12.addShape(pres.shapes.RECTANGLE, {
  x: 0.5, y: 4.8, w: 9, h: 0.8,
  fill: { color: "F8F9FA" }
});

slide12.addText("多元激励机制", {
  x: 0.7, y: 4.9, w: 2, h: 0.3,
  fontSize: 13, fontFace: "Microsoft YaHei",
  color: COLORS.secondary, bold: true
});

const mechanisms = ["年度评选", "排行榜", "晋升加分", "培训机会", "对外分享"];
for (let idx = 0; idx < mechanisms.length; idx++) {
  slide12.addText(mechanisms[idx], {
    x: 2.8 + (idx * 1.2), y: 4.95, w: 1.1, h: 0.25,
    fontSize: 11, fontFace: "Microsoft YaHei",
    color: COLORS.darkGray, align: "center"
  });
}

// ========== SLIDE 13: Step 6 - 运营迭代与沉淀 ==========
let slide13 = pres.addSlide();
slide13.background = { color: COLORS.white };

slide13.addText("Step 6: 运营迭代与沉淀", {
  x: 0.5, y: 0.4, w: 9, h: 0.6,
  fontSize: 28, fontFace: "Microsoft YaHei",
  color: COLORS.primary, bold: true
});

slide13.addShape(pres.shapes.OVAL, {
  x: 3.5, y: 1.5, w: 3, h: 3,
  fill: { color: "FFF5F0" },
  line: { color: COLORS.primary, width: 3, dashType: "dash" }
});

const cycleSteps = [
  { text: "收集反馈", x: 5, y: 1.6, emoji: "💬" },
  { text: "数据分析", x: 6.2, y: 2.5, emoji: "📊" },
  { text: "优化改进", x: 5, y: 3.8, emoji: "⚙️" },
  { text: "版本发布", x: 3.2, y: 2.5, emoji: "🚀" }
];

for (let idx = 0; idx < cycleSteps.length; idx++) {
  const step = cycleSteps[idx];
  slide13.addShape(pres.shapes.OVAL, {
    x: step.x, y: step.y, w: 0.9, h: 0.9,
    fill: { color: COLORS.primary }
  });
  slide13.addText(step.emoji, {
    x: step.x + 0.1, y: step.y + 0.25, w: 0.7, h: 0.5,
    fontSize: 20, align: "center"
  });
  slide13.addText(step.text, {
    x: step.x - 0.1, y: step.y + 0.7, w: 1.1, h: 0.6,
    fontSize: 9, fontFace: "Microsoft YaHei",
    color: COLORS.white, align: "center"
  });
}

slide13.addText("持续改进循环", {
  x: 0.5, y: 4.7, w: 9, h: 0.3,
  fontSize: 12, fontFace: "Microsoft YaHei",
  color: COLORS.secondary, bold: true, align: "center"
});

slide13.addShape(pres.shapes.RECTANGLE, {
  x: 0.5, y: 5.0, w: 9, h: 0.7,
  fill: { color: "F8F9FA" }
});

const knowledgeItems = ["知识库沉淀", "最佳实践文档", "案例库建设", "经验复用机制"];
for (let idx = 0; idx < knowledgeItems.length; idx++) {
  slide13.addText(knowledgeItems[idx], {
    x: 1.0 + (idx * 2.0), y: 5.15, w: 1.8, h: 0.4,
    fontSize: 12, fontFace: "Microsoft YaHei",
    color: COLORS.darkGray, align: "center"
  });
}

// ========== SLIDE 14: 组织与节奏建议 ==========
let slide14 = pres.addSlide();
slide14.background = { color: COLORS.white };

slide14.addText("组织与节奏建议（三阶段）", {
  x: 0.5, y: 0.4, w: 9, h: 0.6,
  fontSize: 28, fontFace: "Microsoft YaHei",
  color: COLORS.primary, bold: true
});

const implPhases = [
  {
    phase: "第一阶段",
    subtitle: "试点期（1-3 个月）",
    emoji: "🌱",
    goals: ["完成 3-5 个高价值 Skill 试点", "验证评审流程可行性", "建立基础运营体系"],
    color: "FFE5D0"
  },
  {
    phase: "第二阶段",
    subtitle: "推广期（4-6 个月）",
    emoji: "🚀",
    goals: ["扩展至 15-20 个 Skill", "优化流程与标准", "建立激励机制"],
    color: "FFD0A8"
  },
  {
    phase: "第三阶段",
    subtitle: "规模化期（7-12 个月）",
    emoji: "🏆",
    goals: ["50+ Skill 规模化运营", "形成自驱生态", "对外输出能力"],
    color: "FFB884"
  }
];

for (let idx = 0; idx < implPhases.length; idx++) {
  const implPhase = implPhases[idx];
  const x = 0.6 + (idx * 3.1);
  
  slide14.addShape(pres.shapes.RECTANGLE, {
    x: x, y: 1.3, w: 2.9, h: 3.8,
    fill: { color: implPhase.color },
    line: { color: COLORS.primary, width: 2 }
  });
  
  slide14.addShape(pres.shapes.RECTANGLE, {
    x: x, y: 1.3, w: 2.9, h: 0.6,
    fill: { color: COLORS.primary }
  });
  
  slide14.addText(implPhase.emoji, {
    x: x + 1.15, y: 1.4, w: 0.6, h: 0.5,
    fontSize: 28, align: "center"
  });
  
  slide14.addText(implPhase.phase, {
    x: x + 0.3, y: 1.4, w: 2.3, h: 0.3,
    fontSize: 15, fontFace: "Microsoft YaHei",
    color: COLORS.white, bold: true, align: "right"
  });
  
  slide14.addText(implPhase.subtitle, {
    x: x, y: 1.7, w: 2.9, h: 0.25,
    fontSize: 11, fontFace: "Microsoft YaHei",
    color: COLORS.white, align: "center"
  });
  
  for (let i = 0; i < implPhase.goals.length; i++) {
    slide14.addText(implPhase.goals[i], {
      x: x + 0.3, y: 2.1 + (i * 0.8), w: 2.3, h: 0.65,
      fontSize: 12, fontFace: "Microsoft YaHei",
      color: COLORS.darkGray, bullet: true
    });
  }
}

slide14.addText("节奏：稳扎稳打 · 以小博大 · 持续迭代", {
  x: 0.5, y: 5.3, w: 9, h: 0.3,
  fontSize: 12, fontFace: "Microsoft YaHei",
  color: COLORS.mediumGray, align: "center", italic: true
});

// ========== SLIDE 15: 关键交付物清单 ==========
let slide15 = pres.addSlide();
slide15.background = { color: COLORS.white };

slide15.addText("关键交付物清单", {
  x: 0.5, y: 0.4, w: 9, h: 0.6,
  fontSize: 28, fontFace: "Microsoft YaHei",
  color: COLORS.primary, bold: true
});

const deliverables = [
  {
    category: "流程文档",
    items: ["《Skill 需求卡模板》", "《Skill 评审标准》", "《运营手册》"],
    emoji: "📄"
  },
  {
    category: "开发工具",
    items: ["LYClaw SDK", "开发模板", "测试框架"],
    emoji: "🔧"
  },
  {
    category: "运营资产",
    items: ["技能市场", "数据看板", "案例库"],
    emoji: "📊"
  },
  {
    category: "治理规范",
    items: ["《SLA 服务水平协议》", "《激励政策》", "《安全合规指南》"],
    emoji: "📋"
  }
];

for (let idx = 0; idx < deliverables.length; idx++) {
  const deliv = deliverables[idx];
  const row = Math.floor(idx / 2);
  const col = idx % 2;
  const x = 0.6 + (col * 4.6);
  const y = 1.3 + (row * 2.0);
  
  slide15.addShape(pres.shapes.RECTANGLE, {
    x: x, y: y, w: 4.3, h: 1.8,
    fill: { color: "F8F9FA" },
    line: { color: idx === 0 ? COLORS.primary : COLORS.secondary, width: 2 }
  });
  
  slide15.addText(deliv.emoji, {
    x: x + 0.3, y: y + 0.3, w: 0.6, h: 0.6,
    fontSize: 32, align: "center"
  });
  
  slide15.addText(deliv.category, {
    x: x + 1.1, y: y + 0.35, w: 3.0, h: 0.4,
    fontSize: 16, fontFace: "Microsoft YaHei",
    color: COLORS.secondary, bold: true
  });
  
  for (let i = 0; i < deliv.items.length; i++) {
    slide15.addText(deliv.items[i], {
      x: x + 1.1, y: y + 0.8 + (i * 0.3), w: 3.0, h: 0.25,
      fontSize: 11, fontFace: "Microsoft YaHei",
      color: COLORS.darkGray
    });
  }
}

slide15.addText("确保每个交付物都有明确的责任人和时间节点", {
  x: 0.5, y: 5.2, w: 9, h: 0.3,
  fontSize: 11, fontFace: "Microsoft YaHei",
  color: COLORS.primary, bold: true, align: "center"
});

// Save
pres.writeFile({ fileName: "C:\\Users\\Leon.Long\\.openclaw\\workspace\\LYClaw_Skill 闭环建设方案.pptx" })
  .then(() => console.log("PPT created successfully!"))
  .catch(err => console.error("Error:", err));
