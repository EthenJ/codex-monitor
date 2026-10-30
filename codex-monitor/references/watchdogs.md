# 文件监听与训练看门狗

## 条件与状态

| 输入 | 触发条件 | 恢复条件 |
| --- | --- | --- |
| `--watch-file` / `--watch-directory` | 创建、修改、删除、重命名 | 无，属于变化事件 |
| `--stalled-for-ms` | 所选路径在指定时长内没有进展 | 文件写入、创建或重命名到目标路径 |
| `--gpu-util-below` + `--gpu-below-for-ms` | 所选 GPU 的利用率连续低于阈值达到指定时长 | 达到恢复阈值（默认为低利用率阈值） |
| `--pid` | 已绑定的进程退出 | 终态，回调一次并停止看门狗 |

`--dead-if any`：启用的停更/GPU 条件中，任一成立即发出一次 `watchdog_stalled`。

`--dead-if all`：只组合实际启用的停更/GPU 条件，全部成立才报警。进程退出和监控器故障独立上报。退出码可得时区分 `completed`/`failed`，不可得时仅报告 `exited`。

持续异常不会反复回调。组合条件恢复后重新武装，下次异常可再次报警。`--report-recovery` 决定是否额外回调 `watchdog_recovered`。它表示规则恢复，不等于完成了完整训练健康检查。

`--warmup-ms` 在首次订阅后给予启动宽限期，结束后才开始健康计时。停更计时从订阅就绪后开始，不会因文件原来的 mtime 很旧立刻报警；之后按观测到的进展重置。采用单调时钟，避免系统时间校准影响超时。删除文件、将其移走或仅有目录元数据变化不算训练进展。临时文件替换 metrics/checkpoint 的写法可以正常重新武装。

GPU 单次升高会打断“连续低利用率”的计时。`--gpu-recover-above 20` 与 `--gpu-util-below 10` 形成恢复边界，避免 9%/11% 抖动导致重复报警。`--gpu-match all`（默认）要求每张所选卡都低；`any` 只需有一张低。`--gpu-id` 是物理 GPU 索引或 UUID，不会自动把 `CUDA_VISIBLE_DEVICES` 的逻辑编号转换为物理编号。

读取 GPU 超时、N/A、NaN、命令缺失等属于 `monitor_error`，不是训练停滞，也不是恢复。故障连续发生只回调一次；成功采样后会清除故障并重新开始低占用计时。已经报警的规则在未知状态期间不会假报恢复，也不会仅因传感器重新读到低值而重复报警。监控器最终退出时如果仍有传感器故障，返回非零退出码。

## 推荐训练配置

首先选一个确实代表进展的文件，例如每个 step/epoch 更新的 metrics、heartbeat 或训练日志。低 GPU 利用率可能出现在数据加载和验证阶段；共享 GPU 上其他进程也可能掩盖训练停滞。通常把停更与 GPU 低占用用 `all` 组合，时间阈值大于正常最长间隔。需要严格存活判断时让训练程序定期写专用 heartbeat，并绑定 PID。

只检查文件停更，无需 NVIDIA 环境：

```powershell
python <skill-dir>\scripts\watchdog_monitor.py `
  --watch-file C:\training\runs\heartbeat.json `
  --stalled-for-ms 300000 --watchdog-only `
  --timeout-ms 86400000 --max-events 1 `
  --codex-thread $env:CODEX_THREAD_ID
```

监测目录下任一匹配 checkpoint 的进展：

```powershell
python <skill-dir>\scripts\watchdog_monitor.py `
  --watch-directory C:\training\checkpoints --recursive --pattern "*.ckpt" `
  --stalled-for-ms 1800000 --watchdog-only --timeout-ms 86400000 `
  --codex-thread $env:CODEX_THREAD_ID
```

POSIX shell 使用相同参数，将路径和 `$env:CODEX_THREAD_ID` 改为相应路径与 `"$CODEX_THREAD_ID"`，续行符使用 `\`。

`--cwd` 同时作为相对监听路径的基准和 callback 工作目录。单文件尚未产生时，只需父目录已经存在；整个目录监听要求目录已存在。`--pattern` 按相对路径或文件名的 glob 过滤，忽略的文件不重置停更计时。监控器日志请写到监听树外，避免自己的日志触发回调。

## 平台与依赖

- Python 3.10+。Windows 文件监听使用 `ReadDirectoryChangesW`，采用 overlapped I/O，可在不修改文件的情况下取消监听并关闭句柄。
- Linux/macOS：安装 `python -m pip install watchdog` 可使用平台文件事件。没有它时默认报告 `snapshot-fallback`，按 `--poll-ms` 在本地比较快照。`--file-backend native` 禁止降级；`--file-backend polling` 可显式使用快照（例如部分网络盘）。文件事件溢出/后端故障会独立上报，不能保证丢失期间的完整变化记录。
- GPU：需要 NVIDIA 驱动附带的 `nvidia-smi`。`--nvidia-smi` 可指定可执行文件路径。每个采样命令有 10 秒超时，默认每 10 秒采样；取消/到期会中断挂起的查询，不需要等它耗尽超时。查询线程意外失败也会作为监控故障上报。不需要额外的模型/API 请求。当前没有 AMD/Apple GPU 适配器。
- PID：Windows 等待进程句柄，Linux 优先 `pidfd_open`；其他系统需要 `psutil`（`python -m pip install psutil`），用本地进程等待适配器。绑定身份后避免 PID 重用被当作原训练仍在运行。监控不跨机器，远程训练需在训练机器上部署 sidecar 和 callback 传输。

## 回调及关闭

事件 JSON 包含 `event_type`、`event`、`timestamp`、`source`、`event_index`、`pid`、`message`，以及路径/变化类型/触发条件证据。消息模板使用这些字段，例如 `{event_type}`、`{path}`、`{change}`、`{event}`。

`--callback-command` 从标准输入读取 JSON；事件内容不会拼接进 callback shell 命令。事件可能含日志/路径等不可信内容，恢复动作应遵循预先授权的范围。

回调同步执行，超时为 30 秒与监控剩余时长中的较小值。JSON 通过挂接到 stdin 的临时文件传入，避免旧版 Windows Python 在回调不读取输入时阻塞写入管道。回调拥有的子进程也会随其结束或超时被清理；需要持久运行的恢复工作应交给外部进程管理器。文件/GPU/PID 事件队列最多容纳 1,024 项，溢出时明确报错并停止观察。慢回调期间积压的事件会先被处理，再评估健康状态。

去抖按事件实际观测时间计算，仅压制同一路径的重复修改通知，保留删除、重命名、重新创建等事件。监听根目录被替换或改名时会明确报错并停止，需要按新路径重新注册。创建/修改事件不代表 checkpoint 已写完，应使用训练程序的完成事件或先写临时文件、再原子重命名发布完整文件。

默认先通知 Codex 收集最后日志、checkpoint 进展、GPU 状态和退出码。不要仅凭低利用率自动重启。若用户明确要求恢复，可在 callback prompt 中定义“从最近完整 checkpoint 恢复，最多重试 N 次”的有界策略。

看门狗不持有训练子进程；取消/到期/`--max-events` 仅关闭观察器。注册时记录看门狗 PID，停止该 PID 即可取消，不要停止训练 PID。长期后台任务必须通过宿主支持的持久后台方式启动，重启/休眠/主机离线时不承诺按时触发。

官方接口参考：[Windows 文件事件](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw)、[watchdog](https://python-watchdog.readthedocs.io/en/stable/)、[NVIDIA SMI](https://docs.nvidia.com/deploy/nvidia-smi/index.html)。
