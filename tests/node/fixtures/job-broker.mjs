import { ownCurrentProcess } from '../../../codex-monitor/runtime/windows.js';
import { serve } from '../../../codex-monitor/runtime/service.js';
// An external launcher can itself remain inside an enclosing job, independently
// of the MCP host. That job deliberately denies further breakaway requests.
ownCurrentProcess();
await serve(process.argv[2]);
