# Node 插件 Windows 复测清单

适用于 `develop` 的 Node v0.3 预览版；`main` 是部署分支。旧的 [Python Windows 报告](windows-validation.md) 不能证明新版 Node 插件通过。本轮修改已在 Ubuntu 的 Node 22.22.0 / 24.17.0 验证，下面的 Windows 项目仍待实机执行。

## 1. 完整测试

在原生 Windows PowerShell 中执行，WSL 结果不能替代 Windows Job Object 验证。先保留已有本地改动，再同步包含本轮修复的 `develop`。需要 Node 22.22+、npm，以及本机 Codex CLI；本轮原生协议测试使用 Codex 0.166.0。

```powershell
git fetch origin
git switch develop
git pull --ff-only origin develop
git rev-parse HEAD
git status --short
node --version
npm --version
codex --version

npm ci
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败' }
npm run build
if ($LASTEXITCODE -ne 0) { throw '编译失败' }

$logDir = Join-Path $env:TEMP ('codex-monitor-node-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $logDir | Out-Null
$testFiles = @(Get-ChildItem tests/node/*.test.mjs | ForEach-Object { $_.FullName })
$env:CODEX_MONITOR_TEST_NATIVE = '1'
$env:CODEX_MONITOR_TEST_GPU = '0'
node --test --test-timeout=25000 @testFiles 2>&1 | Tee-Object (Join-Path $logDir 'node-native.log')
if ($LASTEXITCODE -ne 0) { throw '测试失败，请保留完整日志' }
```

当前应发现 **74 项：70 通过、4 项跳过**；跳过的是一项真实 GPU 测试和三项 POSIX 模拟 GPU provider 测试。两个 Windows 专用 Job Object 测试必须执行。原生 App Server 测试使用临时 Codex 配置和本地模拟服务，不使用账号或付费模型。分别在常用 Node 24 和最低支持的 22.22.0 上复测；记录实际版本，不把未执行的平台记为通过。

## 2. 本轮重点

- RPC：中文/emoji 在 HTTP 数据块之间截断后仍保持原文；错误认证、坏 JSON、恰好 65,536 字节与超限请求均正确处理，服务继续可用。
- 命令：快速输出两个不同的匹配行，都保留在传感器事件中；防抖窗口内连续重复的同一行只产生一次匹配事件。命令结束仍产生退出事件。
- 文件：`native` 和 `polling` 均验证；防抖窗口内的每次实际写入都重置训练停滞时间，删除不重置；递归、过滤和启动前已有文件行为正确。
- 路径：文件不能作为 `cwd`，目录不能作为 `watch_file`；原有符号链接/根目录替换检查继续生效。另将完整源码放到含中文和空格的目录，再执行上述测试。
- 生命周期：并发注册复用服务；命令超时/取消/输出超限和启动失败能清理；Windows 严格 Job 关闭后观察器继续存活，外部 broker 启动子观察器不要求第二次 breakaway。观察现有 PID 后停止监控，原进程仍应存活。
- 会话恢复：503、响应流断开、手动中断、goal 修改/预算边界和不确定提交回归测试必须通过。

## 3. NVIDIA 实机

有 NVIDIA 显卡和可用驱动时执行：

```powershell
nvidia-smi --query-gpu=index,name,uuid,pci.bus_id,driver_version,utilization.gpu --format=csv
$env:CODEX_MONITOR_TEST_GPU = '1'
# 如果不在 PATH，设置实际路径：
# $env:CODEX_MONITOR_NVIDIA_SMI = 'C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe'
node --test --test-timeout=25000 @testFiles 2>&1 | Tee-Object (Join-Path $logDir 'node-gpu.log')
if ($LASTEXITCODE -ne 0) { throw 'GPU/完整测试失败' }
```

应为 **74 项：71 通过，三项 POSIX 模拟 provider 测试跳过**。该硬件测试只读取指标，检查索引/UUID/PCI/多卡选择、无效 UUID 和有限期限内连续采样；不制造负载或停止现有训练。没有 NVIDIA 硬件时保留 GPU 跳过，并记录原因。

在可控制的独立训练任务中，再人工观察一次持续低利用率触发和恢复，核对 dwell、warmup、`all`/`any` 和 hysteresis。自动实机测试不证明这些硬件转换场景通过，也不证明驱动失效、远程共享路径或分布式训练适配。

也可以先使用 [GPU 验证指南](gpu-validation.md) 中的只读阈值转换探针；该命令已在 Ubuntu 验证，Windows 仍需实测。

## 4. 发布包与记录

```powershell
$packageDir = Join-Path $logDir 'plugin'
npm run package -- $packageDir
if ($LASTEXITCODE -ne 0) { throw '打包失败' }
Push-Location $packageDir
try {
    npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw '生产依赖安装失败' }
} finally { Pop-Location }
```

检查包含 `codex-monitor/runtime/server.js`、插件/技能元数据、lock file 和运行时依赖；不包含 `src/`、`tests/`、Python helpers 或 TypeScript 开发依赖。原有 MCP SDK 集成用例验证七个工具的发现和启动/断线重连/停止；Ubuntu 本轮另在独立发布包上执行了同样的冒烟检查。Windows 发布包的实际插件安装、桌面客户端加载与真实会话投递仍需单独记录，不能用源码测试代替。

保存 commit、工作区差异、Node/npm/Codex/Windows/驱动版本、完整日志和跳过原因。测试结束核对临时 broker、观察器和命令后代已退出；保留由用户主动注册的其他监控，不按进程名称批量结束。
