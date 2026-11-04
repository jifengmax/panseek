/**
 * 首页展示的热门搜索词。可按自己的站内数据替换，也支持环境变量 HOT_WORDS 覆盖（逗号分隔）。
 */
const DEFAULT_HOT = [
  '流浪地球',
  '三体',
  '繁花',
  '奥本海默',
  '肖申克的救赎',
  '老友记',
  '甄嬛传',
  '进击的巨人',
  '鬼灭之刃',
  '灌篮高手',
  '周杰伦',
  'Taylor Swift',
  'Photoshop',
  'Office 2021',
  'Python 教程',
  '考研数学',
  '三体 电子书',
  'Kindle 书库',
  '赛博朋克2077',
  '黑神话悟空',
  '4K 壁纸',
  'PPT 模板',
  '剪映 教程',
  '国家地理',
];

export const HOT_WORDS = (() => {
  const env = String(process.env.HOT_WORDS || '').trim();
  if (!env) return DEFAULT_HOT;
  const list = env
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list.slice(0, 40) : DEFAULT_HOT;
})();
