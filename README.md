# SenseNova Studio · 生图工作台

基于 **SenseNova U1.5 Lite** 的本地 Web 生图工作台。一个 API Key + 一条命令，即可获得带
**文生图 / 图像编辑 / 任务队列 / 画廊管理 / 请求日志** 的图形化界面，无需编写调用代码。

> 纯本地工具：Node.js + Express 后端，零构建单文件前端（Tailwind CDN + 原生 JS），无数据库、无外部依赖服务。

## 功能

- **文生图**：Prompt 输入（支持 JSON 结构化排版指令）、预设常用 Prompt、批量出图（1-9 张排队）、尺寸 / 水印 / 格式 / 润色开关
- **图像编辑**：参考图支持本地上传 / URL 引入 / 从画廊选图，自动转 base64，多参考图组合
- **画廊管理**：生成图片落盘 `data/artifacts/`（图片 + meta.json），网格画廊、Prompt 搜索、一键复制、删除同步清理磁盘
- **任务队列**：`pending → running → done/failed/canceled` 状态机，批量任务自动排队，失败可重试，服务重启自动续跑
- **请求日志**：每次请求的时间 / 结果 / 状态码 / 耗时留痕
- 深浅双主题；服务默认仅监听 `127.0.0.1`，API Key 仅存服务端本地文件、接口回包脱敏

## 部署

### 1. 获取 API Key

在 [商汤大模型平台](https://token.sensenova.cn/) 创建 API Key（需开通 SenseNova U1.5 Lite 模型权限）。

### 2. 安装并启动

```bash
git clone https://github.com/s1sunny/sensenova-studio.git
cd sensenova-studio
npm install
npm start
```

浏览器打开 <http://127.0.0.1:3107>，进入 **设置** 页填入 API Key（或启动前设置环境变量 `SENSNOVA_API_KEY`），
点「测试连通性」通过后即可使用。

### 3. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3107` | 监听端口（优先于设置面板中的端口） |
| `HOST` | `127.0.0.1` | 监听地址 |
| `SENSNOVA_API_KEY` | 空 | 优先于 `data/config.json` 中的 Key |

后台常驻运行：

```bash
nohup node server.js > run.log 2>&1 &
```

### 4. 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` / `PUT` | `/api/config` | 读取 / 更新 API Key（返回脱敏视图） |
| `POST` | `/api/config/test` | Key 连通性测试 |
| `POST` | `/api/generate` | 文生图（同步） |
| `POST` | `/api/edit` | 图像编辑（同步） |
| `POST` | `/api/tasks` | 批量提交队列任务 `{ type, count, params, images }` |
| `GET` | `/api/tasks` | 任务列表（分页 / 状态筛选） |
| `GET` | `/api/tasks/stats` | 任务状态计数 |
| `POST` | `/api/tasks/:id/cancel` | 取消排队任务 |
| `GET` | `/api/artifacts` | 图片列表（分页 / 搜索 / 类型筛选） |
| `GET` | `/api/artifacts/:id/image` | 图片文件 |
| `DELETE` | `/api/artifacts` | 批量删除图片 `{ ids: [] }` |
| `GET` | `/api/request-logs` | 请求日志 |
| `GET` / `PUT` | `/api/settings` | 默认参数与队列设置 |

## 项目结构

```
sensenova-studio/
├── server.js              # Express 入口：路由 / 参数校验 / 落盘
├── src/
│   ├── api.js             # SenseNova API 封装（/v1/images/generations、/v1/images/edits）
│   ├── config.js          # API Key 持久化（data/config.json，回包脱敏）
│   ├── throttle.js        # 请求间隔控制
│   ├── settings.js        # 默认参数与队列设置（data/settings.json）
│   ├── taskQueue.js       # 任务队列：状态机 / 并发调度 / 重启续跑
│   ├── artifacts.js       # 图片落盘与索引（data/artifacts/）
│   └── requestLog.js      # 请求日志（data/request_logs.json）
├── public/index.html      # 单文件前端
└── data/                  # 运行时数据（已在 .gitignore 中排除）
```

## 常见问题

- **提交后一直「排队中」或失败**：查看「请求日志」页错误码。`401/403` = Key 无效或未开通模型权限；`429` = 请求过于频繁，在设置页调大请求间隔；`599` = 本机到 `token.sensenova.cn` 网络不通。
- **图像编辑上传本地图片失败**：请求体上限 50MB，多张高分辨率原图以 base64 提交容易超限，先压缩或减少参考图数量。
- **生成的图存在哪里**：`data/artifacts/<图片ID>/`（`image.png` + `meta.json`）。
- **多实例**：`PORT=3108 npm start` 可起第二实例，各实例建议使用独立部署目录。

## 许可

代码按 [MIT](LICENSE) 开源。本项目非商汤官方产品，SenseNova 模型能力与 API 配额归属商汤官方。

- API 文档：<https://token.sensenova.cn/>
- 模型开源：<https://github.com/OpenSenseNova/SenseNova-U1>
