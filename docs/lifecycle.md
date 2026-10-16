# 卸载与回滚

以下步骤适用于 DSH profile 安装。操作前停止目标 profile；同一宿主的其他 profile 无需停止。首次执行时，可先使用独立 `DSH_HOME` 验证。已完成的版本和环境见[隔离验收记录](./verification/profile-lifecycle-20261016.md)；`0.2.14` 的正式 Web profile 升级与重启见[正式安装验证](./verification/formal-profile-v0.2.14-20261016.md)。

## 安装或升级前备份

备份目标 profile 的 `package.json`、已有的锁文件和 `cordis.patch.yml`。另存当前可用版本的安装包或 40 位 Git 提交，以及安装前 `web` 条目的完整配置。配置可能含其他插件的私密信息，备份仅保存在本地。

如果使用了 home 级 `cordis.patch.yml` 或 `--patch` 文件，也应备份其中对本插件和 `web` 的覆盖。普通卸载无需删除共享凭证库；其他 profile 可能仍使用相同凭证引用。

## 卸载

1. 停止目标 profile，避免运行中的进程继续使用已移除的包。
2. 从目标 profile 移除插件：

   ```sh
   dsh plugin --profile <profile> remove dsh-web-search-fetch
   ```

3. 检查目标 profile 的 `cordis.patch.yml`。若设置页保存过配置，移除其中 `id: web-search-fetch` 的整个覆盖项。保留其他条目。DSH 0.2.1-alpha.3 的 CLI 不自动移除此项，遗留时会报告 `patch: entry "web-search-fetch" not found`。
4. 检查 home 级及额外 patch 文件。若手工写过 `searchProvider: aggregated` 或 `fetchProvider: aggregated`，恢复安装前的 `web` 配置。不要删除 `web` 条目中的其他用户设置。仅由本包 bundle 提供的 provider 选择随 bundle 移除而消失。
5. 检查有效配置：

   ```sh
   dsh --profile <profile> --dump-config
   ```

   结果应无本插件条目和遗留覆盖警告。`web` 的 provider 应与安装前一致。原始 Web profile 的默认值为 `deepseek-official` 和 `http`；存在其他搜索插件时，以备份为准。
6. 重新启动目标 profile。确认设置卡片不再出现，并调用原有工具验证恢复效果。`deepseek-official` 搜索仍需要它自己的有效凭证。

若无法确定某个覆盖项归属，先保留备份并停止清理，不要删除整个配置文件。卸载不会清除凭证引用对应的值。

## 回滚到先前版本

1. 停止目标 profile。
2. 安装已保存、版本明确的安装包：

   ```sh
   dsh plugin --profile <profile> add file:./previous-version.tgz --ignore-scripts
   ```

   将路径替换为实际备份。0.2.11 起的固定源码及正式 Release 包包含编译入口，无需安装时执行构建脚本。
3. 恢复与该版本配套的配置备份。若原版本不认识新增字段，使用升级前的配置；不要直接沿用新版全部字段。
4. 运行 `--dump-config`，核对安装版本、provider 与保存的设置。
5. 启动目标 profile，实际调用 `web_search` 和 `web_fetch`。设置卡片可见不代表工具调用成功。

需要完整恢复依赖时，在停止 profile 后恢复配套的 `package.json` 和锁文件，再通过 `dsh plugin --profile <profile> install --frozen-lockfile --ignore-scripts` 安装依赖。备份中的本地包路径也必须仍然可用。

本次实际验证了 `0.2.12 → 0.2.11 → 0.2.12`，以及最终卸载后恢复宿主默认 provider。后续 `0.2.14` 另完成正式 Web profile 升级与宿主重启验证；本轮未重测卸载和回滚。该结果不扩展其他 DSH 版本的兼容声明。
