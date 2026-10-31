import path from 'node:path';
import { ensureBroker, rpc, serve } from './service.js';
import { atomicJson, stateRoot } from './common.js';
const [mode, directory, threadId] = process.argv.slice(2);
try {
    if (mode === 'bootstrap')
        console.log(JSON.stringify(await rpc(await ensureBroker(), 'status')));
    else if (mode === 'stop-broker')
        console.log(JSON.stringify(await rpc(path.join(stateRoot(), 'broker'), 'shutdown')));
    else if (mode === 'serve' || mode === 'broker') {
        if (!directory || (mode === 'serve' && !threadId))
            throw Error('serve requires directory and thread ID');
        await serve(path.resolve(directory), mode === 'serve' ? threadId : undefined);
    }
    else
        throw Error('Use bootstrap, stop-broker, serve or broker');
}
catch (e) {
    if (directory)
        atomicJson(path.join(directory, 'service-error.json'), { error: String(e) });
    console.error(String(e));
    process.exitCode = 1;
}
