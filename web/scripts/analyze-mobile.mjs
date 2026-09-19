import path from "path";
import { execSync } from "child_process";

const mobileImg = path.resolve(".regress-data/home-redesign-mobile.png");
const script = path.resolve("/Users/dream/.zcode/skills/claude-vision/vision.js");
const prompt = "这是移动端（390x844）页面截图。请重点观察提示词输入框（Composer）及其底部的控制选项区域（比例、时长、Skill、模型、素材）以及右侧生成按钮（立即生成）的整体尺寸、比例、对齐、圆角、排版、视觉效果和潜在问题（如是否有截断、溢出、换行重叠、留白不当等）。请详细客观分析。";

try {
  const stdout = execSync(`node "${script}" "${mobileImg}" "${prompt}"`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  });
  console.log(stdout);
} catch (e) {
  console.error(e);
}
