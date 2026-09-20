-- 一次性恢复脚本：项目改名（octalaicanvas → dreamyo）后，服务器库中同时存在
-- 旧前缀（octalaicanvas_*，历史真实数据）与新前缀（dreamyo_*，升级后新建的空表）。
-- 执行本脚本会：删除新前缀空表 → 把旧前缀表整批改名为新前缀（以历史数据为准）。
--
-- ⚠️ 执行前先备份两份数据：
--   docker exec 1Panel-postgresql-5aS8 pg_dump -U user_nAEKtB -d user_nAEKtB > ~/db_backup_before_prefix_fix.sql
-- 并确认旧表确实有数据（示例）：
--   docker exec 1Panel-postgresql-5aS8 psql -U user_nAEKtB -d user_nAEKtB -c 'select count(*) from octalaicanvas_users;'
--
-- 执行方式（按提示修改容器名/账号/库名）：
--   docker exec -i 1Panel-postgresql-5aS8 psql -U user_nAEKtB -d user_nAEKtB < scripts/legacy-table-prefix-recovery.sql
-- 执行完成后重启应用容器：docker restart dreamyo

DO $$
DECLARE t record;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'octalaicanvas_users') THEN
        FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'dreamyo\_%' LOOP
            EXECUTE format('DROP TABLE public.%I CASCADE', t.tablename);
        END LOOP;
        FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'octalaicanvas\_%' LOOP
            EXECUTE format('ALTER TABLE public.%I RENAME TO %I', t.tablename, 'dreamyo_' || substr(t.tablename, length('octalaicanvas_') + 1));
        END LOOP;
    END IF;
END $$;
