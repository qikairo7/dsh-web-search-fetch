// Fixed synthetic judgments; live results use separate, explicitly limited proxies.
export const searchCases = [
  { id: 'chinese-question', category: 'chinese', query: '城市暴雨积水时如何安全出行',
    terms: ['暴雨', '积水', '安全'],
    documents: [
      { url: 'https://weather.test/safety', title: '暴雨积水出行安全指南', snippet: '避开积水路段，选择安全路线。', grade: 3 },
      { url: 'https://city.test/traffic', title: '暴雨天气交通安全提示', snippet: '积水路段绕行。', grade: 3 },
      { url: 'https://news.test/rain', title: '城市暴雨积水路段通报', snippet: '道路安全通行信息。', grade: 2 },
      { url: 'https://guide.test/walking', title: '雨天步行安全', snippet: '出行建议。', grade: 1 },
      { url: 'https://shop.test/boots', title: '时尚雨靴促销', snippet: '商品价格。', grade: 0 },
      { url: 'https://travel.test/sun', title: '晴天旅游推荐', snippet: '周末攻略。', grade: 0 },
    ] },
  { id: 'dated-news', category: 'news', query: '2026年10月15日 城市暴雨积水 最新交通通报',
    terms: ['暴雨', '积水', '交通'], since: '2026-10-15', until: '2026-10-16',
    documents: [
      { url: 'https://city.test/latest', title: '暴雨积水交通通报', snippet: '最新道路情况，安全出行。', publishedAt: '2026-10-15', grade: 3 },
      { url: 'https://weather.test/latest', title: '暴雨积水预警', snippet: '今日交通安全提醒。', publishedAt: '2026-10-16', grade: 3 },
      { url: 'https://news.test/latest', title: '暴雨积水影响交通', snippet: '交通部门最新消息。', publishedAt: '2026-10-15', grade: 2 },
      { url: 'https://news.test/archive', title: '暴雨积水交通通报', snippet: '旧闻回顾。', publishedAt: '2025-10-15', grade: 0 },
      { url: 'https://shop.test/news', title: '暴雨用品新品', snippet: '广告。', grade: 0 },
      { url: 'https://other.test/traffic', title: '交通历史展览', snippet: '展馆介绍。', publishedAt: '2026-10-15', grade: 0 },
    ] },
];

export const longArticle = {
  name: '中文长文、表格、代码与来源互补',
  bodies: ['甲', '乙', '丙'].map(id => '# 城市防汛手册\n\n共同导读：暴雨积水期间优先保障人员安全。\n\n'
    + Array.from({ length: 60 }, (_, n) => `## 第 ${n + 1} 节\n\n` + `第 ${n + 1} 节的防汛说明：核查道路通行情况，提前制定出行方案。`.repeat(20)).join('\n\n')
    + `\n\n## 附录${id}\n\n${id}渠道独有的联络流程。\n\n| 地点 | 警戒水位 |\n| --- | --- |\n| ${id}站 | 120 厘米 |\n\n\`\`\`js\nnotify('${id}');\n\`\`\`\n\n[${id}渠道说明](https://source.test/${id})`),
  markers: ['甲', '乙', '丙'].flatMap(id => [`${id}渠道独有的联络流程。`, `| ${id}站 | 120 厘米 |`, `notify('${id}');`, `[${id}渠道说明](https://source.test/${id})`]),
  shared: '共同导读：暴雨积水期间优先保障人员安全。',
};

export function relevance(sources, documents, k = 5) {
  const grades = new Map(documents.map(doc => [doc.url, doc.grade]));
  const seen = new Set();
  const ranked = sources.slice(0, k).map(source => {
    if (seen.has(source.url)) return 0;
    seen.add(source.url);
    return grades.get(source.url) ?? 0;
  });
  const dcg = values => values.reduce((sum, grade, i) => sum + (2 ** grade - 1) / Math.log2(i + 2), 0);
  const ideal = dcg([...grades.values()].sort((a, b) => b - a).slice(0, k));
  return { precisionAt5: ranked.filter(grade => grade > 0).length / k, ndcgAt5: ideal ? dcg(ranked) / ideal : null };
}

export function retention(content, markers) {
  const hits = markers.filter(marker => content.includes(marker)).length;
  return { markerHits: hits, markerTotal: markers.length, markerRecall: hits / markers.length };
}
