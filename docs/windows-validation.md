# Windows 验证清单

适用于本次 Ubuntu 适配修改后的源码。请在 **Windows 原生 PowerShell 5.1 或 PowerShell 7** 中执行，不要在 WSL 中执行；WSL 通过不能证明 Win32 文件事件和 Job Object 正常。先完成第 1～4 节，再根据硬件执行第 5 节，最后做第 6 节的交互取消检查。

截至本清单编写时，本轮修改已在 Ubuntu 验证，**新增 Windows 专用测试尚未在真实 Windows 执行**。历史版本的 59 项 Windows 测试通过记录不代表本轮已通过。当前默认测试发现数应为 **114**；此数字用于核对源码是否完整，不应替代逐项检查失败和跳过原因。

## 1. 同步完整源码并记录环境

在仓库根目录打开 PowerShell。使用 Git 时拉取包含本轮修改的最新 `main`，并确认下面的新文件存在。手工同步时包含 `codex-monitor/`、`tests/`、`tools/`、`docs/`、`README.md`、`pyproject.toml` 和 `.github/`，尤其不能遗漏本轮新增的 `test_ubuntu_gpu.py`、`test_live_gpu.py`、`test_boundary_review.py`、`test_windows.py`。复制旧 commit 不包含这些修改。不要从 Ubuntu 复制 `.venv/`、`.tmp-*/` 或 `__pycache__/`。

也可以直接使用随本次验证提供的 `codex-monitor-windows-validation.zip`，解压到新目录。包内是当前工作区的源码，含新文件，不含虚拟环境或 `.git`，`VALIDATION-SOURCE.json` 记录来源 commit、工作区状态和源码指纹：

```powershell
Expand-Archive -LiteralPath .\codex-monitor-windows-validation.zip -DestinationPath .\windows-check
Set-Location .\windows-check\codex-monitor-windows-validation
```

以下变量会在后续章节继续使用。每次验证建立一个新的日志目录，避免覆盖上一轮记录；不需要激活虚拟环境或修改 PowerShell 执行策略。

```powershell
$repo = (Get-Location).Path
$runId = Get-Date -Format 'yyyyMMdd-HHmmss'
$checkRoot = Join-Path $repo ('.tmp-windows-validation-' + $runId)
$logs = Join-Path $checkRoot 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

if (Test-Path '.git') {
    git rev-parse HEAD | Out-File (Join-Path $logs 'revision.txt')
    git status --short | Out-File (Join-Path $logs 'worktree.txt')
} elseif (Test-Path 'VALIDATION-SOURCE.json') {
    Copy-Item 'VALIDATION-SOURCE.json' (Join-Path $logs 'archive-source.json')
} else {
    '手工复制的源码，无 Git 元数据；以 source-sha256.json 为准' |
        Out-File (Join-Path $logs 'revision.txt')
}
$PSVersionTable | Out-String | Out-File (Join-Path $logs 'powershell.txt')
Get-CimInstance Win32_OperatingSystem |
    Select-Object Caption, Version, BuildNumber, OSArchitecture |
    Format-List | Out-File (Join-Path $logs 'windows.txt')
py -0p
```

如果没有 `py` 启动器，可以用本机 Python 的完整路径代替下面的 `py -3.12`。使用 64 位 Python 3.10 或更新版本；建议至少验证常用版本及 3.10、3.12、3.14 中另外一个版本。缺失的版本记为“未测试”。

```powershell
$envDir = Join-Path $checkRoot 'py312'
py -3.12 -m venv $envDir
if ($LASTEXITCODE -ne 0) { throw '创建虚拟环境失败，请检查 Python 版本和路径' }
$pythonExe = Join-Path $envDir 'Scripts\python.exe'

& $pythonExe -c "import sys,platform,struct; print(sys.executable); print(sys.version); print(platform.platform()); print('bits=',struct.calcsize('P')*8)" *> (Join-Path $logs 'python312.txt')
```

记录源码内容指纹。这里统一 CRLF/LF 后计算 SHA-256，因此可以在 Windows 与 Ubuntu 比较同一份文本源码；Git commit 相同但工作区内容不同也能发现。

```powershell
@'
import hashlib,json,pathlib
root=pathlib.Path.cwd()
paths=[root/'README.md',root/'pyproject.toml']
for folder in ('codex-monitor','tests','tools','docs','.github'):
    paths.extend(p for p in (root/folder).rglob('*') if p.is_file() and p.suffix in {'.py','.md','.yml','.yaml','.toml','.ps1'})
print(json.dumps({p.relative_to(root).as_posix():hashlib.sha256(p.read_bytes().replace(b'\r\n',b'\n')).hexdigest() for p in sorted(set(paths))},indent=2))
'@ | & $pythonExe - > (Join-Path $logs 'source-sha256.json')
```

## 2. 完整自动测试：先无依赖，再安装可选依赖

先使用刚创建的干净环境，不安装 `watchdog`、`psutil`。Windows 的原生监听和 PID 等待应能独立工作。

```powershell
Remove-Item Env:CODEX_MONITOR_TEST_GPU -ErrorAction SilentlyContinue
& $pythonExe -W error::ResourceWarning -m unittest discover -s tests -v *> (Join-Path $logs 'suite312-minimal.log')
$suiteExit = $LASTEXITCODE
Get-Content (Join-Path $logs 'suite312-minimal.log') -Tail 12
"exit=$suiteExit" | Out-File (Join-Path $logs 'suite312-minimal.exit.txt')
```

预期：退出码 **0**，`Ran 114 tests`、`OK (skipped=18)`，即 **96 项通过、18 项跳过**。18 项为 4 项需显式启用的真实 GPU 测试，以及 14 项 POSIX/Linux 专用测试。Windows 原生文件/PID/Job 测试不能跳过。若源码后续增减测试，以实际发现数和跳过原因复核。

再安装可选依赖，验证同一份源码不会因安装依赖改变 Windows 默认后端：

```powershell
& $pythonExe -m pip install -e '.[platform]' *> (Join-Path $logs 'install312.log')
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，查看 install312.log' }
& $pythonExe -m pip freeze > (Join-Path $logs 'packages312.txt')
& $pythonExe -m pip check *> (Join-Path $logs 'pip-check312.log')
$pipExit = $LASTEXITCODE
& $pythonExe tools/validate_skill.py codex-monitor *> (Join-Path $logs 'skill312.log')
$skillExit = $LASTEXITCODE
& $pythonExe codex-monitor/scripts/monitor_callback.py --help *> (Join-Path $logs 'command-help312.txt')
$commandHelpExit = $LASTEXITCODE
& $pythonExe codex-monitor/scripts/watchdog_monitor.py --help *> (Join-Path $logs 'watchdog-help312.txt')
$watchdogHelpExit = $LASTEXITCODE
"pip=$pipExit skill=$skillExit commandHelp=$commandHelpExit watchdogHelp=$watchdogHelpExit" |
    Out-File (Join-Path $logs 'checks312.exit.txt')

& $pythonExe -W error::ResourceWarning -m unittest discover -s tests -v *> (Join-Path $logs 'suite312-platform.log')
$suiteExit = $LASTEXITCODE
Get-Content (Join-Path $logs 'suite312-platform.log') -Tail 12
"exit=$suiteExit" | Out-File (Join-Path $logs 'suite312-platform.exit.txt')
```

预期：所有检查退出码 0；安装后仍是 96 项通过、18 项跳过。不能只看最后的 `OK`：检查日志中是否有 `ResourceWarning`、`Exception ignored`、线程 traceback 或异常跳过。遇到失败保留第一次日志，不要靠反复重跑后的某一次成功判定通过。

其他 Python 版本重复第 1 节创建环境和本节命令，把 `py -3.12`、环境名和日志文件名一起改为对应版本，避免覆盖证据。目录名含中文或空格时也应通过；建议至少在一个这样的仓库路径下运行一次完整套件。

## 3. Windows 特有行为需要重点确认

第 2 节已包含下列自动检查。失败时可以单独重跑并保存日志：

```powershell
& $pythonExe -W error::ResourceWarning -m unittest discover -s tests -p test_windows.py -v *> (Join-Path $logs 'windows-native.log')
$nativeExit = $LASTEXITCODE
Get-Content (Join-Path $logs 'windows-native.log')
"exit=$nativeExit" | Out-File (Join-Path $logs 'windows-native.exit.txt')
```

预期：**3 项全部通过，无跳过**。

| 检查 | 预期 |
| --- | --- |
| `test_pending_directory_read_releases_handles` | 后端为 `ReadDirectoryChangesW`；无文件变化时连续启动/取消 20 次，监听线程都退出，句柄数量不持续增长。 |
| `test_observed_pid_returns_actual_windows_exit_code` | 等待一个真实测试进程退出，准确报告退出码 7，注册监听时不改变进程状态。 |
| `test_forced_monitor_exit_cleans_callback_tree_and_preserves_observed_pid` | 强制结束监控器后，Job 内的 callback 和后代不能继续写入标记；独立的被观察进程仍存活。测试仅创建和结束自己的临时进程。 |

完整套件还必须通过：中文文件创建/修改/重命名/删除、根目录替换报错、原子文件替换、UTF-8 与坏字节输出、回调 stdin JSON、未读取大输入的超时、大输出有界、回调正常结束/超时后的后代清理、NUL 输入失败诊断，以及 `.cmd`/`.bat` 不能作为原生 Codex argv 接收器。

Windows 使用 [Job Object](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) 管理所创建的进程组。强制终止不执行 Python `finally`，不要求有 `stopped` 日志；它与下一节的 Ctrl+C 正常取消是不同检查。

## 4. 手工确认文件事件和 Ctrl+C

创建独立测试目录。日志放在监听树外。下面两个 PowerShell 窗口都在仓库根目录运行。

窗口 A：

```powershell
$watchRoot = Join-Path $checkRoot '监听目录 with spaces'
New-Item -ItemType Directory -Force -Path $watchRoot | Out-Null
$watchRoot   # 将这一完整路径复制到窗口 B
& $pythonExe codex-monitor/scripts/watchdog_monitor.py `
    --watch-directory $watchRoot --recursive --pattern '*.ckpt' `
    --file-backend native --timeout-ms 120000 --debounce-ms 300 `
    --codex-thread windows-check --dry-run |
    Tee-Object -FilePath (Join-Path $logs 'native-files.jsonl')
```

确认日志出现 `backend: ReadDirectoryChangesW` 和 `started` 后，窗口 B 将下面路径改为 A 输出的实际值：

```powershell
$watchRoot = '将这里替换为窗口 A 输出的完整路径'
$first = Join-Path $watchRoot '模型 epoch1.ckpt'
Set-Content -LiteralPath $first -Value 'step1' -Encoding UTF8
Start-Sleep -Milliseconds 800
Add-Content -LiteralPath $first -Value 'step2' -Encoding UTF8
Start-Sleep -Milliseconds 800
Rename-Item -LiteralPath $first -NewName '模型 epoch2.ckpt'
Start-Sleep -Milliseconds 800
Remove-Item -LiteralPath (Join-Path $watchRoot '模型 epoch2.ckpt')
Set-Content -LiteralPath (Join-Path $watchRoot 'ignored.txt') -Value 'ignored'
```

预期：能够看到创建、修改、重命名、删除对应事件；`ignored.txt` 没有回调。重命名可能输出 `renamed_old` 和 `renamed_new` 两条；底层也可能合并通知，不要求固定总条数。`--dry-run` 不会发送消息。

在窗口 A 按 Ctrl+C。预期数秒内退出，输出 `stopped` 且 `reason: cancelled`。然后将同一命令的 `--file-backend native` 改为 `polling` 并添加 `--poll-ms 100` 再试；预期后端 `snapshot-fallback`，重命名可表现为旧路径删除和新路径创建。原生通知依赖文件系统与缓存行为，参见 [ReadDirectoryChangesW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw)。

## 5. NVIDIA GPU：真实采样和异常路径

没有 NVIDIA 卡或驱动时，将本节硬件部分标为“未测试”；第 2 节的模拟 GPU 测试仍须通过。先保存驱动原始输出，避免把驱动不支持误判为代码通过：

```powershell
Get-Command nvidia-smi -ErrorAction SilentlyContinue | Format-List Source |
    Out-File (Join-Path $logs 'nvidia-command.txt')
nvidia-smi *> (Join-Path $logs 'nvidia-smi.txt')
$inventoryArgs = @('--query-gpu=index,uuid,pci.bus_id,utilization.gpu', '--format=csv,noheader,nounits')
nvidia-smi @inventoryArgs *> (Join-Path $logs 'gpu-inventory.txt')
$gpuQueryExit = $LASTEXITCODE
Get-Content (Join-Path $logs 'gpu-inventory.txt')
"exit=$gpuQueryExit" | Out-File (Join-Path $logs 'gpu-inventory.exit.txt')
```

预期每行四列，最后一列为 0～100 的有限数字，退出码 0。`N/A`、命令缺失、驱动报错属于传感器不可用，不能当作 0% 或测试通过。若程序不在 PATH，可在当前验证窗口把其所在目录加入 PATH，或手工 CLI 使用 `--nvidia-smi '完整路径\nvidia-smi.exe'`。不要修改驱动模式来让测试通过。

执行硬件测试（短时只读采样，不创建 GPU 负载）：

```powershell
$previousGpuTest = $env:CODEX_MONITOR_TEST_GPU
try {
    $env:CODEX_MONITOR_TEST_GPU = '1'
    & $pythonExe -W error::ResourceWarning -m unittest discover -s tests -p test_live_gpu.py -v *> (Join-Path $logs 'live-gpu.log')
    $liveExit = $LASTEXITCODE
} finally {
    if ($null -eq $previousGpuTest) {
        Remove-Item Env:CODEX_MONITOR_TEST_GPU -ErrorAction SilentlyContinue
    } else {
        $env:CODEX_MONITOR_TEST_GPU = $previousGpuTest
    }
}
Get-Content (Join-Path $logs 'live-gpu.log')
"exit=$liveExit" | Out-File (Join-Path $logs 'live-gpu.exit.txt')
```

预期 4 项通过。若所有卡在整个观察窗口始终 100%，低占用 callback 检查可能跳过，应记为“真实触发未验证”，等自然空闲时再验证；不能把这个跳过记为真实回调通过。需要确认：物理索引、完整 UUID、PCI 地址分别能选择同一张卡；多卡 `all` 返回所有卡；部分无效选择不能悄悄忽略缺失卡。不同驱动可能直接拒绝请求，也可能返回部分结果后被监控器拒绝，两种都应按故障处理。[NVIDIA SMI 文档](https://docs.nvidia.com/deploy/nvidia-smi/index.html)说明了这些选择器和不支持指标的表示。

再做两个无需改变驱动的异常检查：

```powershell
$missingProvider = Join-Path $checkRoot 'does-not-exist-nvidia-smi.exe'
& $pythonExe codex-monitor/scripts/watchdog_monitor.py `
    --gpu-util-below 10 --gpu-sample-ms 100 --timeout-ms 1000 `
    --nvidia-smi $missingProvider --codex-thread windows-check --dry-run `
    *> (Join-Path $logs 'gpu-provider-missing.jsonl')
$missingExit = $LASTEXITCODE

# 把 0 改为 gpu-inventory.txt 中确实存在的物理索引。
& $pythonExe codex-monitor/scripts/watchdog_monitor.py `
    --gpu-id '0,999999' --gpu-util-below 10 --gpu-sample-ms 100 `
    --timeout-ms 1500 --codex-thread windows-check --dry-run `
    *> (Join-Path $logs 'gpu-partial-selection.jsonl')
$partialExit = $LASTEXITCODE
"missing=$missingExit partial=$partialExit" | Out-File (Join-Path $logs 'gpu-errors.exit.txt')
```

预期两个退出码都为 **1**。每次连续故障只发一个 `type: event, event_type: monitor_error`；不可出现 `watchdog_stalled` 或 `watchdog_recovered`，最后 `unavailable_sensors` 包含 `gpu`。`callback` 记录里也有同名 `event_type`，统计事件时要限定 `type: event`。

低占用持续时间、`all`/`any`、恢复阈值、传感器断续和 0%/100% 边界已由确定性测试覆盖。若要验证真实恢复，使用你自行启动并可结束的短任务，让 GPU 自然经过低→高→低，保存原始采样和事件时间；不要停止已有训练或用驱动重置模拟故障。注意这里的利用率是整张物理 GPU 的计算利用率，不是显存百分比，也不是某个 PID 的专属利用率。

## 6. 观察已有 PID，验证取消不会结束它

下面只启动一个本次验证专用的等待进程。先在已定义 `$checkRoot` 和 `$pythonExe` 的窗口 A 执行：

```powershell
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$sleeperFile = Join-Path $checkRoot 'observed_process.py'
[System.IO.File]::WriteAllText($sleeperFile, "import time`ntime.sleep(180)`n", $utf8NoBom)
$sleeperArgs = '"' + $sleeperFile + '"'
$observedTest = Start-Process -FilePath $pythonExe -ArgumentList $sleeperArgs -PassThru
$observedTest.Id
$pythonExe
$logs
Get-Process -Id $observedTest.Id
```

窗口 B 在仓库根目录运行，将三个占位值改为 A 输出的实际值；Python 和日志路径都必须是完整路径：

```powershell
$pythonExe = '替换为窗口 A 的 python.exe 完整路径'
$logs = '替换为窗口 A 的日志完整路径'
$testPid = 12345  # 替换为窗口 A 刚创建的测试进程 ID
& $pythonExe codex-monitor/scripts/watchdog_monitor.py `
    --pid $testPid --timeout-ms 120000 `
    --codex-thread windows-check --dry-run |
    Tee-Object -FilePath (Join-Path $logs 'pid-cancel.jsonl')
```

看到 `started` 后在 B 按 Ctrl+C，预期输出 `reason: cancelled`。立即回窗口 A 检查，测试进程应仍存活；最后结束这个由自己创建的测试进程。请在其 180 秒等待时间内完成，避免把自然退出误判为监控器结束了它。

```powershell
Get-Process -Id $observedTest.Id
Stop-Process -Id $observedTest.Id -ErrorAction SilentlyContinue
```

只对 `$observedTest.Id` 做上述清理，不要替换成真实训练 PID。

## 7. 可选：真实 Codex 唤醒

前述测试验证本地 callback 传递，不证明一个真实空闲 Codex 会话会继续执行。要单独验证唤醒，请用专门测试会话，并记录其 UUID、CLI 版本、监控器日志以及测试会话实际收到消息并开始执行的时间。不要用生产训练会话做这个检查。

用当前仓库 `watchdog_monitor.py` 的文件停更规则触发一次即可：`--stalled-for-ms 2000 --watchdog-only --max-events 1 --timeout-ms 10000`，将 `--codex-thread` 改为该测试会话 UUID，去掉 `--dry-run`，消息模板要求它只回复测试标记。如果用 `--codex-bin`，应指向原生 `codex.exe`，不要指向 `.cmd`/`.bat`。`ok: true` 或 CLI 退出码 0 只是传输侧证据；还需看到目标会话真实继续执行。未执行此步骤就保留“端到端唤醒未验证”。

## 8. 回传结果和验收标准

至少保留整个 `$logs` 目录，以及下表。打包日志即可，无需打包虚拟环境。

| 项目 | 结果填写 |
| --- | --- |
| Windows 版本、Build、PowerShell、终端类型 | |
| 源码 revision、工作区状态、source-sha256.json | |
| Python 版本和位数 | |
| 无依赖完整套件：发现/通过/跳过/失败/退出码 | |
| 安装可选依赖后完整套件 | |
| Windows 专用 3 项：句柄、退出码、Job 清理 | |
| 中文/空格路径、原生/轮询事件、Ctrl+C | |
| GPU 型号、驱动版本、原始 query 输出 | |
| 真实 GPU 4 项及每个跳过原因 | |
| 缺失 provider、部分无效选择：均退出 1 | |
| 真实 Codex 会话唤醒：通过／未测试 | |

判定通过要求：适用测试无失败、无未解释的 warning/线程异常；Windows 专用测试全部执行；缺失 GPU 等负路径准确报错；自己的测试子进程按预期退出，被观察进程不被监控器结束。硬件、网络共享目录、符号链接权限、远程桌面/服务宿主、真实驱动故障等未执行的场景分别记“未测试”，不要由普通 NTFS 桌面测试推断其通过。

本项目对 Windows 普通文件事件使用 `ReadDirectoryChangesW`，对 GPU 使用 `nvidia-smi`。若只在网络盘失败，保存路径类型和报错，并额外验证显式 `--file-backend polling`；不要静默切换后声称原生后端通过。
