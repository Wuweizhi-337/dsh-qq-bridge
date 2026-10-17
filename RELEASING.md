# 发布前检查表

给"以后要发布时的自己"看的。**当前状态：还没发布**（本机私有使用中）。

- 仓库（已注册、还没建）：`https://github.com/Wuweizhi-337/dsh-qq-bridge`
- 包名：`@wuweizhi/dsh-qq-bridge`（作用域只是标识，**不走 npm 发布**）
- 本机**没装 Git**；`github.com` 时通时断（`/signup` 曾返回 403，后来注册成功了）

---

## 0. 建仓库与上传（不需要装 Git）

1. GitHub 右上 `+` → **New repository**
   - Repository name：`dsh-qq-bridge`
   - 选 **Public**
   - **不要**勾 "Add a README file"（我们自带）
2. 进仓库 → **Add file → Upload files** → 把 `dsh-qq-bridge-publish` 里的**这些东西**拖进去：
   ```
   lib/index.js  lib/client.js  lib/memory.js
   scripts/preflight.mjs  scripts/sync-from-local.mjs
   README.md  CHANGELOG.md  RELEASING.md  LICENSE
   package.json  cordis.patch.yml  config.example.json  .gitignore
   ```
   > 拖文件夹会保留子目录结构（`lib/`、`scripts/`）。
   > **别传**：`.tgz`（构建产物）、`config.json` / `memory*.json` / `people/`（运行期数据）。
3. 提交信息写 `dsh-qq-bridge 0.4.5`，然后 Commit。
4. （可选）发个 Release，notes 用 `CHANGELOG.md` 对应那一节。

## 1. 包名相关（改一处要改三处！）

| 位置 | 现在 |
|---|---|
| `package.json` → `name` | `@wuweizhi/dsh-qq-bridge` |
| `cordis.patch.yml` → `name` | `@wuweizhi/dsh-qq-bridge`（`id` 用短名 `qq-bridge`） |
| `lib/client.js` → `__ModuleLoader__.load({ id })` | 必须是完整包名 |

> 客户端 bundle 的 `load id` **必须等于完整包名**，否则加载器报 `loaded without registering`。
> 本地开发副本的包名是不带 scope 的 `dsh-qq-bridge`，所以**别直接 cp**：用
>
> ```bash
> node scripts/sync-from-local.mjs
> ```
>
> 它会把本地 `lib/*.js` 拷过来，并自动把 client 的 id 改成当前包名。
> 要改包名/作用域时，三处一起改，`preflight` 会检查前两处。

## 2. 版本与 CHANGELOG

- 有行为变化 → 改 `package.json` 的 `version`，并在 `CHANGELOG.md` 顶部加一节。
- 现在的号：`0.4.5`。
- 本地开发副本的 `package.json` 版本号也顺手对齐（它 `private: true`，不发布）。
- 仓库装法认的是 git 上的内容，**没有版本推送这一步**；要钉版本就发 Release/tag。

## 3. 自检（必跑，五组检查）

```powershell
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" scripts\preflight.mjs
```

检查：必需文件 → 泄漏扫描（个人路径 / 真实 token）→ 三个 `lib/*.js` 语法 → 真 `import` →
**包名一致性**（client load id、patch name、private、scope 的 publishConfig）。

必须看到 `全部通过，可以打 tag 发布。`（退出码 0）。

## 4. 发布后验证（别跳）

在**干净 profile** 里装一遍（用 tarball 或 git 地址都行）：

```bash
dsh plugin --profile test add git+https://github.com/Wuweizhi-337/dsh-qq-bridge.git
# 或：dsh plugin --profile test add "D:\路径\dsh-qq-bridge-0.4.5.tgz"
```

重启桌面端后逐项看：

- 设置里出现「QQ 桥」；
- 运行状态卡能显示（NapCat 未连是正常的）；
- 「私聊」开关在；「NapCat 连接」里两个可选路径框是**空**的；
- 填上 `napcat.launcher` / `napcat.qrPath` 后，「启动机器人 / 打开二维码」按钮出现；
- 填 token 与 NapCat 地址，重启后能连上并回一句话。

## 5. 备用分发（不想让对方装 Git / 仓库打不开）

本地打包一份 tgz 传过去，对方 `dsh plugin --profile desktop add <路径>.tgz` 即可：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
& $node $pnpm pack        # 在发布目录里执行，产出 wuweizhi-dsh-qq-bridge-<版本>.tgz
```

## 6. 回滚

- 仓库：`git revert` 或直接改回上一版文件再上传一次（没有 Git 时用网页编辑）。
- 本机自己的回滚件保持原样：
  - `lib/index.js.bak-pre-fix`、`lib/client.js.bak-pre-fix`
  - `config.json.bak-pre-fix`、`config.json.bak-page-test`
  - `napcat-ctl.ps1.bak-pre-trigger-fix`

## 7. 备注：npm 那条路（暂时走不通）

- `www.npmjs.com/signup` 与 `/login` 在本机网络返回 **403**；`registry.npmjs.org` 通。
- 旧的 `adduser` 端点（`PUT /-/user/org.couchdb.user:<name>`）还活着（不带 password 会回 400），
  理论上能用命令行建号；但既然改走 GitHub 了，这条先不动。
