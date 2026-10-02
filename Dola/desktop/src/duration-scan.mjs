// Dola 会话模型对可见提示词执行 4-15 秒对话策略：超过 10 秒的时长表述
// （时长30秒、约28秒、分段时间轴 27.2-30秒、30s 等）会让模型拒发超档任务。
// 实际时长只能走结构化 ability_param 下发，这里负责把可见文本里的超档表述
// 找出来并支持一键删除；规则与服务端 dola_api/protocol.py 清洗器保持同源。
const UNIT = "(?:秒钟?|s(?:ec(?:onds?)?)?)";
const NUM = "\\d+(?:\\.\\d+)?";
const DASH = "[-–—~到至]";

const SCANNERS = [
  { re: `(?<![\\d.])(${NUM})\\s*${DASH}\\s*(${NUM})\\s*${UNIT}\\s*[:：]?`, ranged: true },
  { re: `(?:视频)?时长\\s*[:：=为是约]?\\s*(?:大约)?\\s*(${NUM})\\s*${UNIT}` },
  { re: `\\bduration\\s*[:=]\\s*(${NUM})\\s*s(?:ec(?:onds?)?)?\\b` },
  { re: `生成(?:一段|一个)?\\s*(${NUM})\\s*${UNIT}\\s*(?:的)?(?:短?视频|片断|片段|微电影)\\s*[:：]?` },
  { re: `(${NUM})\\s*${UNIT}\\s*(?:的)?(?:短?视频|片断|片段|微电影)` },
  { re: `(?<![\\d.])(${NUM})\\s*${DASH}?\\s*${UNIT}(?![\\d.])` },
];

function collectMatches(text) {
  const found = [];
  for (const scanner of SCANNERS) {
    const re = new RegExp(scanner.re, "gi");
    for (let match = re.exec(text); match; match = re.exec(text)) {
      const values = scanner.ranged ? [Number(match[1]), Number(match[2])] : [Number(match[1])];
      found.push({ start: match.index, end: match.index + match[0].length, seconds: Math.max(...values), text: match[0] });
      if (match.index === re.lastIndex) re.lastIndex += 1;
    }
  }
  return found;
}

function resolvedMatches(text) {
  const accepted = [];
  for (const match of collectMatches(text).sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (accepted.some((item) => match.start < item.end && item.start < match.end)) continue;
    accepted.push(match);
  }
  return accepted;
}

export function scanLongDurations(text, threshold = 10) {
  if (!text) return [];
  return resolvedMatches(String(text)).filter((match) => match.seconds > threshold);
}

export function stripLongDurations(text, threshold = 10) {
  const removed = scanLongDurations(text, threshold);
  let value = String(text || "");
  for (const match of [...removed].reverse()) value = value.slice(0, match.start) + value.slice(match.end);
  value = value.replace(/(?:[，,、][\s，,、]*){2,}/g, "，");
  value = value.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ");
  value = value.replace(/^[\s，,、:：]+|[\s，,、:：]+$/g, "");
  return { value, removed };
}
