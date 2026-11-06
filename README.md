# qq-notify-action

在 GitHub Actions CI 中向 QQ 群发送通知消息或文件。

- 零依赖，直接调用 QQ Bot REST API（Node 18+ 原生 fetch）
- 支持纯文本、Markdown、文件（图片/视频/音频/任意文件）
- 主动消息，无需等待用户触发

## 前置条件

1. 已在 [QQ 开放平台](https://q.qq.com/) 创建机器人并获得 **AppID** 和 **AppSecret**（即 ClientSecret）。
2. 机器人已被邀请加入目标群，并获得该群的 **群聊 OpenID**（通过机器人收到的群消息事件中获取）。
3. **主动消息权限已开通**（QQ 开放平台 → 机器人 → 开发设置 → 消息权限 → 主动推送消息）。
   未开通时所有发送会报错：`{"code":40034105,"message":"主动消息失败, 无权限"}`

## 获取凭据（辅助脚本）

如果还没有 AppID / AppSecret 和群 OpenID，可以用项目内置的脚本一键获取：

```bash
git clone https://github.com/H3CoF6/qq-notify-action.git
cd qq-notify-action
npm install
npm run get-credentials
```

流程：
1. 终端显示二维码，用手机 QQ 扫码授权
2. 登录成功后直接打印 **AppID** 和 **AppSecret**
3. 脚本继续监听 WebSocket，在机器人所在的群里随便发一条消息
4. 终端打印出该群的 **群 OpenID**

示例输出：

```
========== 登录成功 ==========
  AppID    : 1905391417
  AppSecret: tT3eFrT6jN2hN3kR9sbL5qbNAxlZOD3u

以上信息已写入 credentials.json（请勿提交到 Git）

等待群消息以获取群 OpenID...
（在机器人所在的群里随便发一条消息）

========== 收到群消息 ==========
  群 OpenID    : 25081C3EA3E3700F9482D327DDD2B4B1
  发送者 OpenID : CF366190C58DCA070B798BB77AEE719B
================================
已获取所需信息，可 Ctrl+C 退出
```

把以上三个值填入仓库 Secrets 即可。

## 配置 Secrets

在目标仓库 → Settings → Secrets and variables → Actions → New repository secret，添加以下三个：

| Secret 名称        | 说明                  |
| ------------------ | --------------------- |
| `QQ_APPID`         | QQ Bot 的 AppID       |
| `QQ_SECRET`        | QQ Bot 的 AppSecret   |
| `QQ_GROUP_OPENID`  | 目标群聊的 OpenID     |

## 使用方法

### 发送文本消息（纯文本）

```yaml
- uses: H3CoF6/qq-notify-action@main
  with:
    appid: ${{ secrets.QQ_APPID }}
    secret: ${{ secrets.QQ_SECRET }}
    group_openid: ${{ secrets.QQ_GROUP_OPENID }}
    message: '构建完成 ✅'
    markdown: 'false'
```

### 发送 Markdown 消息（默认）

```yaml
- uses: H3CoF6/qq-notify-action@main
  with:
    appid: ${{ secrets.QQ_APPID }}
    secret: ${{ secrets.QQ_SECRET }}
    group_openid: ${{ secrets.QQ_GROUP_OPENID }}
    message: |
      ## 构建成功 ✅
      - **仓库**: ${{ github.repository }}
      - **分支**: ${{ github.ref_name }}
      - **触发**: ${{ github.actor }}
      - **Commit**: ${{ github.sha }}
```

> `markdown` 默认为 `true`，机器人需具备 Markdown 发送权限。如遇发送失败可改为 `false`。

### 直接发送本地文件（≤20MB，推荐用于 CI 产物）

```yaml
- uses: H3CoF6/qq-notify-action@main
  with:
    appid: ${{ secrets.QQ_APPID }}
    secret: ${{ secrets.QQ_SECRET }}
    group_openid: ${{ secrets.QQ_GROUP_OPENID }}
    file_path: './dist/app.zip'   # 相对于 GITHUB_WORKSPACE
    file_type: 'file'
    file_name: 'app-v1.0.0.zip'  # 可选，默认用文件名
```

文件通过 base64 直接上传到 QQ Bot API，无需外部 CDN。上限 **20MB**。

### 发送文件（通过公开 URL）

```yaml
- uses: H3CoF6/qq-notify-action@main
  with:
    appid: ${{ secrets.QQ_APPID }}
    secret: ${{ secrets.QQ_SECRET }}
    group_openid: ${{ secrets.QQ_GROUP_OPENID }}
    file_url: 'https://example.com/app.zip'
    file_type: 'file'
    file_name: 'app-v1.0.0.zip'
```

> **注意**：QQ Bot 的大陆服务器**无法访问 GitHub release CDN**（`release-assets.githubusercontent.com`）。
> 对于 GitHub CI，建议：
> - **首选**：用 `file_path` 直接上传本地文件（≤20MB）
> - 如需 URL 方式：将文件托管到 Cloudflare R2、阿里云 OSS 等大陆可达的 CDN 后再传 URL

`file_type` 可选值：

| 值       | 说明         |
| -------- | ------------ |
| `file`   | 任意文件（默认） |
| `image`  | 图片         |
| `video`  | 视频         |
| `audio`  | 语音         |

### 同时发送消息 + 本地文件

```yaml
- uses: H3CoF6/qq-notify-action@main
  with:
    appid: ${{ secrets.QQ_APPID }}
    secret: ${{ secrets.QQ_SECRET }}
    group_openid: ${{ secrets.QQ_GROUP_OPENID }}
    message: |
      ## 新版本发布 🚀
      **版本**: ${{ github.ref_name }}
      附件见下方文件
    file_path: './dist/release.zip'
    file_type: 'file'
```

## 完整 CI 示例

### 构建失败/成功通知

```yaml
name: CI

on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build
        id: build
        run: npm ci && npm run build

      - name: Notify QQ on success
        if: success()
        uses: H3CoF6/qq-notify-action@main
        with:
          appid: ${{ secrets.QQ_APPID }}
          secret: ${{ secrets.QQ_SECRET }}
          group_openid: ${{ secrets.QQ_GROUP_OPENID }}
          message: |
            ## ✅ 构建成功
            - **仓库**: `${{ github.repository }}`
            - **分支**: `${{ github.ref_name }}`
            - **提交**: `${{ github.sha }}`
            - **作者**: ${{ github.actor }}

      - name: Notify QQ on failure
        if: failure()
        uses: H3CoF6/qq-notify-action@main
        with:
          appid: ${{ secrets.QQ_APPID }}
          secret: ${{ secrets.QQ_SECRET }}
          group_openid: ${{ secrets.QQ_GROUP_OPENID }}
          message: |
            ## ❌ 构建失败
            - **仓库**: `${{ github.repository }}`
            - **分支**: `${{ github.ref_name }}`
            - **提交**: `${{ github.sha }}`
            - 请检查 [Actions 日志](${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }})
```

### 发布版本并发送产物

```yaml
name: Release

on:
  push:
    tags: ['v*']

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build artifact
        run: npm ci && npm run build && zip -r dist.zip dist/

      - name: Upload to GitHub Release
        id: release
        uses: softprops/action-gh-release@v2
        with:
          files: dist.zip

    - name: Notify QQ
        uses: H3CoF6/qq-notify-action@main
        with:
          appid: ${{ secrets.QQ_APPID }}
          secret: ${{ secrets.QQ_SECRET }}
          group_openid: ${{ secrets.QQ_GROUP_OPENID }}
          message: |
            ## 🚀 新版本 ${{ github.ref_name }} 已发布
            - **仓库**: `${{ github.repository }}`
            - **发布者**: ${{ github.actor }}
          file_path: dist.zip       # 直传本地文件，无需 CDN
          file_type: file
          file_name: dist-${{ github.ref_name }}.zip
```

## 输入参数说明

| 参数           | 必填 | 默认值   | 说明                                      |
| -------------- | ---- | -------- | ----------------------------------------- |
| `appid`        | ✅   |          | QQ Bot AppID                              |
| `secret`       | ✅   |          | QQ Bot AppSecret（ClientSecret）          |
| `group_openid` | ✅   |          | 目标群聊 OpenID                           |
| `message`      |      | `''`     | 要发送的文本/Markdown 内容                |
| `markdown`     |      | `true`   | 是否启用 Markdown 渲染                    |
| `file_url`     |      | `''`     | 文件的公开 URL                            |
| `file_type`    |      | `file`   | 文件类型：`image` / `video` / `audio` / `file` |
| `file_name`    |      | `''`     | 文件显示名（可选）                        |
| `keyboard`     |      | `''`     | 内联键盘（链接按钮），见下                |

`message` 和 `file_url` 至少需要提供一个。

### 内联键盘（`keyboard`）

两种写法，任选其一。

**简写**：一行一组按钮，行内用逗号分隔，按钮写成 `标签=URL`（`|` 也可以）：

```yaml
- uses: H3CoF6/qq-notify-action@<sha>
  with:
    message: '## v1.0.0 发布'
    keyboard: |
      win=https://example.com/app.exe, web-win=https://example.com/web-win.zip
      linux-x64=https://example.com/app.AppImage, web-linux=https://example.com/web-linux.tar.gz
```

**JSON**：直接贴平台结构 `{"content":{"rows":[{"buttons":[...]}]}}`，原样透传。

限制与行为：

- **最多 5 行**（QQ 平台硬限制，超了报 `40034029`）。列数没有严格限制，单行 5–6 个可以发。
- 按钮动作固定为「跳转链接」（`action.type: 0`）。
- 有 `message` 时键盘挂在正文消息上；没有正文时挂到第一个附件上。
- 按钮标签别太长，长了会被平台截断。

## 运行环境要求

GitHub 托管 runner 均已满足（ubuntu-latest / windows-latest / macos-latest 均预装 Node.js 20+）。

## License

MIT
