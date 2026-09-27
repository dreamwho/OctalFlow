import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { canvasApiClient } from "./client.mjs";

function createServer() {
  const server = new McpServer({ name: "dreamyo-canvas", version: "0.1.0" });
  const client = canvasApiClient();
  const result = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

  server.registerTool("create_canvas_from_script", {
    description: "根据剧本或一句话创建画布并执行 Agent 编排。同一次提交或重试使用同一 clientRequestId。",
    inputSchema: z.object({
      clientRequestId: z.string().min(1),
      prompt: z.string().min(1),
      title: z.string().optional(),
      projectId: z.string().optional(),
      selectedNodeIds: z.array(z.string()).optional(),
      assetIds: z.array(z.string()).optional(),
      skillIds: z.array(z.string()).optional(),
      modelIds: z.array(z.string()).optional(),
      preferences: z.record(z.string(), z.unknown()).optional(),
    }),
  }, async (input) => result(await client.createCanvas(input)));

  server.registerTool("get_canvas_run", {
    description: "查询 Run 状态并把节点与连接写回真实画布。进行中的任务可以重复查询。",
    inputSchema: z.object({ runId: z.string().min(1) }),
  }, async ({ runId }) => result(await client.getRun(runId)));

  server.registerTool("get_canvas_project", {
    description: "读取真实画布的节点与连接。",
    inputSchema: z.object({ projectId: z.string().min(1) }),
  }, async ({ projectId }) => result(await client.getProject(projectId)));
  return server;
}

void serveStdio(createServer);
