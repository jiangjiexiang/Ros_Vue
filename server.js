import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const activeProcesses = new Map();

app.use(cors());
app.use(express.json());

function loadConfig() {
    try {
        const configPath = process.env.ROS_CONFIG_FILE || path.join(__dirname, 'ros_config.json');
        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
        console.error('无法读取 ROS 配置:', err.message);
        return { tasks: {} };
    }
}

function resolveFromProject(directory = '.') {
    return path.isAbsolute(directory) ? directory : path.resolve(__dirname, directory);
}

function mapsDir(config) {
    return resolveFromProject(config.maps_dir || 'maps');
}

function workspaceSetup(config) {
    return resolveFromProject(path.join(config.workspace || '..', 'install', 'setup.bash'));
}

function runRos(command, args, config, detached = true) {
    const script = [
        'set -e',
        'source /opt/ros/humble/setup.bash',
        'if [[ -f "$1" ]]; then source "$1"; fi',
        'shift',
        'exec "$@"'
    ].join('\n');

    return spawn('bash', ['-c', script, 'ros2-task', workspaceSetup(config), command, ...args], {
        detached,
        stdio: 'inherit'
    });
}

function startTask(task, config, extraArgs = []) {
    if (activeProcesses.has(task.id)) return;

    const args = [...(task.args || []), ...extraArgs];
    console.log(`[${task.id}] ${task.description || task.command}`);
    const proc = runRos(task.command, args, config);
    activeProcesses.set(task.id, proc);

    proc.once('error', (err) => {
        console.error(`[${task.id}] 启动失败: ${err.message}`);
        activeProcesses.delete(task.id);
    });
    proc.once('exit', (code) => {
        console.log(`[${task.id}] 已退出 (${code})`);
        activeProcesses.delete(task.id);
    });
}

function startTasks(tasks, config, extraArgs = []) {
    tasks.forEach((task) => {
        setTimeout(() => startTask(task, config, extraArgs), Number(task.delay) || 0);
    });
}

function stopTask(id) {
    const proc = activeProcesses.get(id);
    if (!proc?.pid) return;
    try {
        process.kill(-proc.pid, 'SIGTERM');
    } catch (err) {
        if (err.code !== 'ESRCH') console.error(`[${id}] 停止失败: ${err.message}`);
        activeProcesses.delete(id);
    }
}

function stopTasks(tasks) {
    tasks.forEach((task) => stopTask(task.id));
}

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', activeTasks: Array.from(activeProcesses.keys()) });
});

app.get('/api/runtime_config', (req, res) => {
    res.json({ topics: loadConfig().topics || {} });
});

app.post('/api/run_task/:taskName', (req, res) => {
    const config = loadConfig();
    const tasks = config.tasks?.[req.params.taskName] || [];
    if (tasks.length === 0) {
        return res.status(404).json({ success: false, error: '任务未定义或为空' });
    }
    startTasks(tasks, config);
    res.json({ success: true });
});

app.post('/api/stop_task/:taskName', (req, res) => {
    const config = loadConfig();
    stopTasks(config.tasks?.[req.params.taskName] || []);
    res.json({ success: true });
});

app.get('/api/task_status/:taskName', (req, res) => {
    const tasks = loadConfig().tasks?.[req.params.taskName] || [];
    res.json({ isRunning: tasks.some((task) => activeProcesses.has(task.id)) });
});

app.post('/api/start_mapping', (req, res) => res.redirect(307, '/api/run_task/mapping'));
app.post('/api/stop_mapping', (req, res) => res.redirect(307, '/api/stop_task/mapping'));
app.get('/api/mapping_status', (req, res) => res.redirect(301, '/api/task_status/mapping'));
app.post('/api/stop_navigation', (req, res) => res.redirect(307, '/api/stop_task/navigation'));
app.get('/api/navigation_status', (req, res) => res.redirect(301, '/api/task_status/navigation'));

app.get('/api/list_maps', (req, res) => {
    const directory = mapsDir(loadConfig());
    try {
        const maps = fs.existsSync(directory) ? fs.readdirSync(directory)
            .filter((file) => file.endsWith('.yaml'))
            .map((file) => ({
                name: path.basename(file, '.yaml'),
                path: path.join(directory, path.basename(file, '.yaml'))
            }))
            .sort((a, b) => a.name.localeCompare(b.name)) : [];
        res.json({ maps });
    } catch (err) {
        res.status(500).json({ maps: [], error: err.message });
    }
});

app.post('/api/start_navigation', (req, res) => {
    const { mapPath } = req.body || {};
    if (typeof mapPath !== 'string' || !mapPath.trim()) {
        return res.status(400).json({ success: false, error: '请选择地图' });
    }

    const config = loadConfig();
    const tasks = config.tasks?.navigation || [];
    const selectedMap = path.isAbsolute(mapPath)
        ? path.normalize(mapPath)
        : path.resolve(mapsDir(config), mapPath);

    startTasks(tasks, config, [`map:=${selectedMap}.yaml`]);
    res.json({ success: true });
});

app.post('/api/save_map', (req, res) => {
    const { mapName } = req.body || {};
    if (typeof mapName !== 'string' || !mapName.trim()) {
        return res.status(400).json({ success: false, error: '地图名称不能为空' });
    }

    const config = loadConfig();
    const directory = mapsDir(config);
    const name = mapName.trim().replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_').slice(0, 80);
    const savePath = path.join(directory, name);
    const saveMap = config.save_map;

    try {
        fs.mkdirSync(directory, { recursive: true });
        const proc = runRos(saveMap.command, [...saveMap.args, savePath], config, false);
        let responded = false;

        proc.once('error', (err) => {
            if (responded) return;
            responded = true;
            res.status(500).json({ success: false, error: err.message });
        });
        proc.once('exit', (code) => {
            if (responded) return;
            responded = true;
            if (code === 0) {
                res.json({ success: true, path: savePath });
            } else {
                res.status(500).json({ success: false, error: `保存失败，退出码: ${code}` });
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

function shutdown() {
    activeProcesses.forEach((proc, id) => stopTask(id));
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const dist = path.join(__dirname, 'dist');
if (fs.existsSync(dist)) app.use(express.static(dist));

app.listen(3000, '0.0.0.0', () => {
    console.log('后端已启动: http://localhost:3000');
});

const config = loadConfig();
startTasks(config.tasks?.startup || [], config);
