# 开发与构建

## 结构

```text
archives.py               定期快照与离线HTML导出
rich_content.py           格式化正文白名单清理
static/enhancements.js    格式工具、未保存保护、存档面板
app.py                    HTTP 服务、SQLite、重复规则、提醒和授权
static/index.html         原生前端结构
static/app.js             列表、月历、分类、状态与密码交互
static/detail-editor.js   图文编辑与图片查看器
static/style.css          响应式界面
test_app.py               后端回归测试（独立临时数据库）
tools/seed_demo.py         生成虚构展示数据，拒绝覆盖已有数据库
tools/build_windows.ps1   构建 Windows x64 发行包
.github/workflows/        自动化测试与手动发行构建
```

应用运行无第三方 Python 依赖。Node.js 只用于可选的前端语法检查和代码格式化；构建工具属于开发依赖。

## 启动和检查

```powershell
python app.py
python -m unittest -v
node --check static/app.js
node --check static/detail-editor.js
node --check static/enhancements.js
```

开发时可设置 `$env:SHIJI_DATA = 'C:\path\to\test-data'`。请使用独立端口和数据目录，勿将测试服务器指向真实记录。

后端测试覆盖增删改、按次完成、日期范围边界、重复截止、提醒去重、并发修改冲突、类别持久化、密码验证、授权范围与固定 15 分钟过期。

前端手动回归建议：三种状态配色；类别展开与筛选；历史日期新建；输入法 Enter；图片插入、删除、撤销与翻页；授权到期时关闭图片与编辑器；窄屏和键盘焦点。

## Windows 可执行文件

在 Windows x64 上使用 Python 3.12：

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements-build.txt
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build_windows.ps1 -Version 1.1.1
```

输出为 `release/Shiji-v1.1.1-windows-x64.zip`。包中包含 `Shiji.exe`、停止脚本、局域网启动脚本、说明及许可证。使用 PyInstaller one-file 打包；静态资源进入程序包，用户数据写入 `%LOCALAPPDATA%\Shiji`，不会写入临时解包目录。

发行包不包含任何示例数据库、密码、连接密钥或用户记录。目前未进行代码签名。

## 示例截图

`tools/seed_demo.py` 只会向全新的目标目录写入虚构数据。示例开关不设置真实密码，图片由脚本绘制，无用户截图或内部资料。截图应由实际运行的界面生成，不要将真实数据库和附件放入仓库。

## 发布

先更新版本记录、运行测试并检查待提交文件，再推送版本标签。手动工作流可构建 Windows 包作为 Actions artifact，维护者验证后附到 Release。公开源码与二进制应对应同一提交，并提供 SHA-256 校验文件。
