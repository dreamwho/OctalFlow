import { parseArgs } from "node:util";
import { migrateLocalData } from "./local-data-migration";

try {
    const { values } = parseArgs({ options: { input: { type: "string" }, "source-id": { type: "string" }, check: { type: "boolean" } } });
    if (!values.input || !values["source-id"]) throw new Error("请提供 --input 和 --source-id");
    const result = await migrateLocalData({ directory: values.input, sourceId: values["source-id"], check: values.check });
    console.log(JSON.stringify(result));
    process.exit(0);
} catch (error) {
    const failure = error as { code?: string; message?: string; table?: string; column?: string; constraint?: string };
    // PostgreSQL and network exceptions can contain connection strings and user data.
    const fields = [failure.code, failure.table, failure.column, failure.constraint].filter((value) => value && /^[a-zA-Z0-9_]+$/.test(value));
    console.error(failure.code ? `迁移失败（${fields.join(" / ")}），事务已回滚。请检查数据库权限和快照完整性。` : failure.message || "迁移失败");
    process.exit(1);
}
