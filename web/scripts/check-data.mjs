import fs from "fs";
import path from "path";

const dataDir = path.resolve(".data");
const canvas = JSON.parse(fs.readFileSync(path.join(dataDir, "canvas-projects.json"), "utf8"));
console.log("Projects:", canvas.projects.slice(0, 2).map(p => ({ id: p.id, title: p.title, nodesCount: p.nodes?.length, nodes: p.nodes })));
