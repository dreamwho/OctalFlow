import { execSync } from "child_process";

try {
  const res = execSync('node /Users/dream/.agents/skills/vibehub/scripts/vibehub.mjs resolve --query "Responsive Design" --compact', {
    encoding: "utf8",
    timeout: 10000
  });
  console.log("Result:\n", res);
} catch (e) {
  console.error("Error:", e.message);
}
