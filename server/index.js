import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const dataDir = path.join(projectRoot, 'data');
const STORE_COLLECTIONS = new Set(['robots', 'missions', 'records', 'alerts']);
const MAX_TASK_LOG_LINES = 200;
const app = express();
const activeProcesses = new Map();
const taskLogs = new Map();
const simulationControlUrl = process.env.SIMULATION_CONTROL_URL || 'http://127.0.0.1:8766';
const defaultCameraTopics = {
    camera_primary: '/camera1/preview/compressed',
    camera_secondary: '/camera2/preview/compressed'
};
const defaultControlConfig = {
    max_linear_speed: 0.5,
    max_angular_speed: 1.0,
    command_rate_hz: 10,
    command_timeout_ms: 600
};
const controlConfigRules = {
    max_linear_speed: { min: 0.1, max: 2, integer: false },
    max_angular_speed: { min: 0.1, max: 3, integer: false },
    command_rate_hz: { min: 1, max: 50, integer: true },
    command_timeout_ms: { min: 200, max: 3000, integer: true }
};
const runtimeTaskNames = ['mapping', 'navigation'];

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ success: false, error: '请求 JSON 格式无效' });
    }
    next(err);
});

function runtimeConfigPath() {
    return process.env.ROS_CONFIG_FILE || path.join(projectRoot, 'config/ros_config.json');
}

function loadConfig() {
    try {
        return JSON.parse(fs.readFileSync(runtimeConfigPath(), 'utf8'));
    } catch (err) {
        console.error('无法读取 ROS 配置:', err.message);
        return { tasks: {} };
    }
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function runtimeTasks(tasks) {
    if (!Array.isArray(tasks)) return [];
    return tasks.map((task) => ({
        description: typeof task?.description === 'string' ? task.description : '',
        command: typeof task?.command === 'string' ? task.command : '',
        args: Array.isArray(task?.args) ? task.args.filter((arg) => typeof arg === 'string') : []
    }));
}

function isValidControlValue(value, rule) {
    return typeof value === 'number' && Number.isFinite(value) &&
        value >= rule.min && value <= rule.max && (!rule.integer || Number.isInteger(value));
}

function runtimeControl(control) {
    const source = isRecord(control) ? control : {};
    return Object.fromEntries(Object.entries(controlConfigRules).map(([field, rule]) => [
        field,
        isValidControlValue(source[field], rule) ? source[field] : defaultControlConfig[field]
    ]));
}

function runtimeConfig(config) {
    const source = isRecord(config) ? config : {};
    const sourceTopics = isRecord(source.topics) ? source.topics : {};
    const topics = Object.fromEntries(Object.entries(sourceTopics)
        .filter(([, value]) => typeof value === 'string'));
    return {
        topics: { ...defaultCameraTopics, ...topics },
        workspace: typeof source.workspace === 'string' && source.workspace ? source.workspace : '..',
        maps_dir: typeof source.maps_dir === 'string' && source.maps_dir ? source.maps_dir : 'maps',
        control: runtimeControl(source.control),
        tasks: {
            mapping: runtimeTasks(source.tasks?.mapping),
            navigation: runtimeTasks(source.tasks?.navigation)
        }
    };
}

function validateRuntimeConfig(body) {
    if (!isRecord(body)) return '请求正文必须是 JSON 对象';
    const allowedFields = new Set(['topics', 'workspace', 'maps_dir', 'control', 'tasks']);
    const unknownFields = Object.keys(body).filter((key) => !allowedFields.has(key));
    if (unknownFields.length) return `包含不支持的配置字段：${unknownFields.join('、')}`;

    for (const field of ['workspace', 'maps_dir']) {
        if (body[field] === undefined) continue;
        if (typeof body[field] !== 'string' || !body[field].trim() || body[field].length > 1024) {
            return `${field} 必须是非空字符串，且长度不能超过 1024 个字符`;
        }
    }

    if (body.topics !== undefined) {
        if (!isRecord(body.topics)) return 'topics 必须是对象';
        if (Object.keys(body.topics).length > 100) return '话题数量不能超过 100 个';
        for (const [name, topic] of Object.entries(body.topics)) {
            if (!name.trim() || name.length > 128) return '话题名称不能为空，且长度不能超过 128 个字符';
            if (typeof topic !== 'string' || !topic.startsWith('/') || topic.length > 1024) {
                return `话题 ${name} 必须以 / 开头，且长度不能超过 1024 个字符`;
            }
        }
    }

    if (body.control !== undefined) {
        if (!isRecord(body.control)) return 'control 必须是对象';
        const unknownControlFields = Object.keys(body.control)
            .filter((key) => !Object.hasOwn(controlConfigRules, key));
        if (unknownControlFields.length) return `control 包含不支持字段：${unknownControlFields.join('、')}`;
        for (const [field, rule] of Object.entries(controlConfigRules)) {
            const value = body.control[field];
            if (value === undefined) continue;
            if (!isValidControlValue(value, rule)) {
                return `${field} 必须是 ${rule.min}～${rule.max} 范围内的${rule.integer ? '整数' : '数值'}`;
            }
        }
    }

    if (body.tasks !== undefined) {
        if (!isRecord(body.tasks)) return 'tasks 必须是对象';
        const unknownTasks = Object.keys(body.tasks).filter((key) => !runtimeTaskNames.includes(key));
        if (unknownTasks.length) return `不支持编辑任务：${unknownTasks.join('、')}`;
        for (const taskName of runtimeTaskNames) {
            if (body.tasks[taskName] === undefined) continue;
            const tasks = body.tasks[taskName];
            if (!Array.isArray(tasks)) return `${taskName} 必须是任务数组`;
            if (tasks.length > 100) return `${taskName} 的任务数量不能超过 100 个`;
            for (let index = 0; index < tasks.length; index++) {
                const task = tasks[index];
                const label = `${taskName} 第 ${index + 1} 个任务`;
                if (!isRecord(task)) return `${label} 必须是对象`;
                const unknownTaskFields = Object.keys(task)
                    .filter((key) => !['description', 'command', 'args'].includes(key));
                if (unknownTaskFields.length) return `${label} 包含不支持字段：${unknownTaskFields.join('、')}`;
                if (task.description !== undefined &&
                    (typeof task.description !== 'string' || task.description.length > 512)) {
                    return `${label} 的 description 必须是长度不超过 512 个字符的字符串`;
                }
                if (typeof task.command !== 'string' || !task.command.trim() || task.command.length > 2048) {
                    return `${label} 的 command 必须是非空字符串，且长度不能超过 2048 个字符`;
                }
                if (!Array.isArray(task.args) || task.args.length > 200 ||
                    task.args.some((arg) => typeof arg !== 'string' || arg.length > 2048)) {
                    return `${label} 的 args 必须是最多 200 项的字符串数组，每项不能超过 2048 个字符`;
                }
            }
        }
    }
    return null;
}

function editableTask(task, previousTask, taskName, index) {
    const result = {
        id: typeof previousTask?.id === 'string' && previousTask.id
            ? previousTask.id
            : `${taskName}-${index + 1}`,
        description: task.description?.trim() || '',
        command: task.command.trim(),
        args: [...task.args]
    };
    if (typeof previousTask?.delay === 'number') result.delay = previousTask.delay;
    return result;
}

function resolveFromProject(directory = '.') {
    return path.isAbsolute(directory) ? directory : path.resolve(projectRoot, directory);
}

function mapsDir(config) {
    return resolveFromProject(config.maps_dir || 'maps');
}

function normalizeMapName(value) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || name.length > 80 || !/^[a-zA-Z0-9_\-\u4e00-\u9fa5]+$/.test(name)) return null;
    return name;
}

function mapFiles(directory, name) {
    return {
        yaml: path.join(directory, `${name}.yaml`),
        image: path.join(directory, `${name}.pgm`)
    };
}

function readMapMetadata(yamlPath) {
    const yaml = fs.readFileSync(yamlPath, 'utf8');
    const resolution = Number(yaml.match(/^resolution:\s*([^\s]+)/m)?.[1]) || 0.05;
    const originText = yaml.match(/^origin:\s*\[([^\]]+)\]/m)?.[1] || '';
    const origin = originText.split(',').map((value) => Number(value.trim()));
    return {
        resolution,
        origin: origin.length === 3 && origin.every(Number.isFinite) ? origin : [0, 0, 0]
    };
}

function readPgm(filename) {
    const data = fs.readFileSync(filename);
    let offset = 0;

    function nextToken() {
        while (offset < data.length) {
            if (data[offset] === 35) {
                while (offset < data.length && data[offset] !== 10) offset++;
            } else if (data[offset] <= 32) {
                offset++;
            } else {
                break;
            }
        }
        const start = offset;
        while (offset < data.length && data[offset] > 32 && data[offset] !== 35) offset++;
        return data.toString('ascii', start, offset);
    }

    const magic = nextToken();
    const width = Number(nextToken());
    const height = Number(nextToken());
    const maxValue = Number(nextToken());
    if (magic !== 'P5' || !Number.isInteger(width) || !Number.isInteger(height) || maxValue !== 255) {
        throw new Error('仅支持 ROS map_saver 生成的 8 位二进制 PGM 地图');
    }
    if (data[offset] === 13 && data[offset + 1] === 10) offset += 2;
    else if (data[offset] <= 32) offset++;

    const pixels = data.subarray(offset);
    if (width <= 0 || height <= 0 || pixels.length !== width * height) {
        throw new Error('PGM 地图尺寸或像素数据无效');
    }
    return { width, height, pixels };
}

function pgmBuffer(width, height, pixels) {
    return Buffer.concat([
        Buffer.from(`P5\n${width} ${height}\n255\n`, 'ascii'),
        pixels
    ]);
}

function listMaps(directory) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
        .filter((file) => file.endsWith('.yaml'))
        .map((file) => {
            const name = path.basename(file, '.yaml');
            const files = mapFiles(directory, name);
            const yamlStat = fs.statSync(files.yaml);
            const hasImage = fs.existsSync(files.image);
            const imageStat = hasImage ? fs.statSync(files.image) : null;
            const modifiedTime = Math.max(yamlStat.mtimeMs, imageStat?.mtimeMs || 0);
            return {
                name,
                path: path.join(directory, name),
                modifiedAt: new Date(modifiedTime).toISOString(),
                size: yamlStat.size + (imageStat?.size || 0),
                hasImage
            };
        })
        .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

function workspaceSetup(config) {
    return resolveFromProject(path.join(config.workspace || '..', 'install', 'setup.bash'));
}

function writeJsonAtomic(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
        fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
        fs.renameSync(tempPath, filePath);
    } catch (err) {
        fs.rmSync(tempPath, { force: true });
        throw err;
    }
}

function appendTaskLog(taskId, stream, chunk) {
    if (!taskId) return;
    const text = chunk.toString('utf8');
    const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
    if (!lines.length) return;
    const list = taskLogs.get(taskId) || [];
    const now = new Date().toISOString();
    for (const line of lines) {
        list.push({ time: now, stream, line });
    }
    if (list.length > MAX_TASK_LOG_LINES) {
        list.splice(0, list.length - MAX_TASK_LOG_LINES);
    }
    taskLogs.set(taskId, list);
}

function runRos(command, args, config, detached = true, taskId = null) {
    const script = [
        'set -e',
        'source /opt/ros/humble/setup.bash',
        'if [[ -f "$1" ]]; then source "$1"; fi',
        'shift',
        'exec "$@"'
    ].join('\n');

    const proc = spawn('bash', ['-c', script, 'ros2-task', workspaceSetup(config), command, ...args], {
        detached,
        stdio: taskId ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    });

    if (taskId) {
        proc.stdout?.on('data', (chunk) => {
            process.stdout.write(chunk);
            appendTaskLog(taskId, 'stdout', chunk);
        });
        proc.stderr?.on('data', (chunk) => {
            process.stderr.write(chunk);
            appendTaskLog(taskId, 'stderr', chunk);
        });
    }

    return proc;
}

function startTask(task, config, extraArgs = []) {
    if (activeProcesses.has(task.id)) return;

    const args = [...(task.args || []), ...extraArgs];
    console.log(`[${task.id}] ${task.description || task.command}`);
    taskLogs.set(task.id, [{
        time: new Date().toISOString(),
        stream: 'system',
        line: `启动任务: ${task.command} ${args.join(' ')}`.trim()
    }]);
    const proc = runRos(task.command, args, config, true, task.id);
    activeProcesses.set(task.id, proc);

    proc.once('error', (err) => {
        console.error(`[${task.id}] 启动失败: ${err.message}`);
        appendTaskLog(task.id, 'stderr', Buffer.from(`启动失败: ${err.message}`));
        activeProcesses.delete(task.id);
    });
    proc.once('exit', (code) => {
        console.log(`[${task.id}] 已退出 (${code})`);
        appendTaskLog(task.id, 'system', Buffer.from(`进程已退出 (code=${code})`));
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

app.get('/api/tasks/active', (req, res) => {
    const logCounts = Object.fromEntries(
        Array.from(taskLogs.entries()).map(([id, logs]) => [id, logs.length])
    );
    res.json({ activeTasks: Array.from(activeProcesses.keys()), logCounts });
});

app.get('/api/tasks/logs/:id', (req, res) => {
    const id = req.params.id;
    res.json({
        id,
        running: activeProcesses.has(id),
        logs: taskLogs.get(id) || []
    });
});

app.get('/api/runtime_config', (req, res) => {
    const rawConfig = loadConfig();
    const normalized = runtimeConfig(rawConfig);
    const workspacePath = resolveFromProject(normalized.workspace);
    const setupPath = workspaceSetup(normalized);
    const mapsDirectory = mapsDir(normalized);
    res.json({
        ...normalized,
        diagnostics: {
            workspaceExists: fs.existsSync(workspacePath),
            setupBashExists: fs.existsSync(setupPath),
            mapsDirExists: fs.existsSync(mapsDirectory)
        }
    });
});

app.put('/api/runtime_config', (req, res) => {
    const validationError = validateRuntimeConfig(req.body);
    if (validationError) return res.status(400).json({ success: false, error: validationError });

    const configPath = runtimeConfigPath();
    let currentConfig;
    try {
        currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!isRecord(currentConfig)) throw new Error('配置根节点不是对象');
    } catch (err) {
        console.error('读取待保存的 ROS 配置失败:', err.message);
        return res.status(500).json({ success: false, error: '读取配置文件失败，未保存任何修改' });
    }

    const updatedConfig = { ...currentConfig };
    if (req.body.workspace !== undefined) updatedConfig.workspace = req.body.workspace.trim();
    if (req.body.maps_dir !== undefined) updatedConfig.maps_dir = req.body.maps_dir.trim();
    if (req.body.topics !== undefined) {
        updatedConfig.topics = { ...defaultCameraTopics, ...req.body.topics };
    }
    if (req.body.control !== undefined) {
        updatedConfig.control = runtimeControl({ ...currentConfig.control, ...req.body.control });
    }
    if (req.body.tasks !== undefined) {
        const currentTasks = isRecord(currentConfig.tasks) ? currentConfig.tasks : {};
        updatedConfig.tasks = { ...currentTasks };
        for (const taskName of runtimeTaskNames) {
            if (req.body.tasks[taskName] === undefined) continue;
            const previousTasks = Array.isArray(currentTasks[taskName]) ? currentTasks[taskName] : [];
            updatedConfig.tasks[taskName] = req.body.tasks[taskName]
                .map((task, index) => editableTask(task, previousTasks[index], taskName, index));
        }
    }

    const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
    try {
        fs.writeFileSync(tempPath, `${JSON.stringify(updatedConfig, null, 4)}\n`, 'utf8');
        fs.renameSync(tempPath, configPath);
        res.json({ success: true, config: runtimeConfig(updatedConfig) });
    } catch (err) {
        fs.rmSync(tempPath, { force: true });
        console.error('保存 ROS 配置失败:', err.message);
        res.status(500).json({ success: false, error: '保存配置失败，请检查配置文件及目录权限' });
    }
});

async function simulationRequest(path, options = {}) {
    const response = await fetch(`${simulationControlUrl}${path}`, {
        ...options,
        signal: AbortSignal.timeout(1500)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `仿真控制服务 HTTP ${response.status}`);
    return data;
}

app.get('/api/simulation/status', async (req, res) => {
    try {
        res.json(await simulationRequest('/status'));
    } catch (err) {
        res.status(503).json({ ready: false, error: '仿真控制服务未连接' });
    }
});

app.post('/api/simulation/velocity', async (req, res) => {
    const { linearX, angularZ } = req.body || {};
    const control = runtimeControl(loadConfig().control);
    if (typeof linearX !== 'number' || !Number.isFinite(linearX) || Math.abs(linearX) > control.max_linear_speed ||
        typeof angularZ !== 'number' || !Number.isFinite(angularZ) || Math.abs(angularZ) > control.max_angular_speed) {
        return res.status(400).json({
            success: false,
            error: `线速度范围为 ±${control.max_linear_speed} m/s，角速度范围为 ±${control.max_angular_speed} rad/s`
        });
    }
    try {
        const data = await simulationRequest('/velocity', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ linearX, angularZ })
        });
        res.json(data);
    } catch (err) {
        res.status(503).json({ success: false, error: '仿真控制服务未连接，请先启动场景' });
    }
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
    try {
        res.json({ maps: listMaps(mapsDir(loadConfig())) });
    } catch (err) {
        res.status(500).json({ maps: [], error: err.message });
    }
});

app.get('/api/maps/:name/content', (req, res) => {
    const directory = mapsDir(loadConfig());
    const name = normalizeMapName(req.params.name);
    if (!name) return res.status(400).json({ success: false, error: '无效的地图名称' });
    const files = mapFiles(directory, name);
    if (!fs.existsSync(files.yaml) || !fs.existsSync(files.image)) {
        return res.status(404).json({ success: false, error: '地图 YAML 或 PGM 文件不存在' });
    }
    try {
        const map = readPgm(files.image);
        const metadata = readMapMetadata(files.yaml);
        res.json({
            success: true,
            name,
            width: map.width,
            height: map.height,
            ...metadata,
            pixels: map.pixels.toString('base64')
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.put('/api/maps/:name/content', (req, res) => {
    const directory = mapsDir(loadConfig());
    const name = normalizeMapName(req.params.name);
    const newName = req.body?.newName === undefined ? name : normalizeMapName(req.body.newName);
    const width = Number(req.body?.width);
    const height = Number(req.body?.height);
    if (!name || !newName || !Number.isInteger(width) || !Number.isInteger(height) ||
        width <= 0 || height <= 0 || width * height > 30000000) {
        return res.status(400).json({ success: false, error: '地图名称或尺寸无效' });
    }
    if (typeof req.body?.pixels !== 'string' || !/^[a-zA-Z0-9+/]+={0,2}$/.test(req.body.pixels)) {
        return res.status(400).json({ success: false, error: '地图像素数据无效' });
    }

    const pixels = Buffer.from(req.body.pixels, 'base64');
    if (pixels.length !== width * height) {
        return res.status(400).json({ success: false, error: '像素数量与地图尺寸不一致' });
    }
    const source = mapFiles(directory, name);
    const target = mapFiles(directory, newName);
    const saveAs = newName !== name;
    if (!fs.existsSync(source.yaml) || !fs.existsSync(source.image)) {
        return res.status(404).json({ success: false, error: '原地图不存在' });
    }
    if (saveAs && (fs.existsSync(target.yaml) || fs.existsSync(target.image))) {
        return res.status(409).json({ success: false, error: '目标场景名称已被使用' });
    }

    const imageTemp = `${target.image}.tmp-${process.pid}`;
    const yamlTemp = `${target.yaml}.tmp-${process.pid}`;
    try {
        if (!saveAs) {
            const backupDir = path.join(directory, '.backups');
            fs.mkdirSync(backupDir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            fs.copyFileSync(source.yaml, path.join(backupDir, `${name}-${stamp}.yaml`));
            fs.copyFileSync(source.image, path.join(backupDir, `${name}-${stamp}.pgm`));
        }

        fs.writeFileSync(imageTemp, pgmBuffer(width, height, pixels));
        if (saveAs) {
            const yaml = fs.readFileSync(source.yaml, 'utf8');
            const imageLine = `image: ${JSON.stringify(`${newName}.pgm`)}`;
            const updatedYaml = /^image:.*$/m.test(yaml)
                ? yaml.replace(/^image:.*$/m, imageLine)
                : `${imageLine}\n${yaml}`;
            fs.writeFileSync(yamlTemp, updatedYaml);
        }
        fs.renameSync(imageTemp, target.image);
        if (saveAs) fs.renameSync(yamlTemp, target.yaml);
        res.json({
            success: true,
            map: { name: newName, path: path.join(directory, newName) },
            maps: listMaps(directory)
        });
    } catch (err) {
        fs.rmSync(imageTemp, { force: true });
        fs.rmSync(yamlTemp, { force: true });
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/rename_map', (req, res) => {
    const directory = mapsDir(loadConfig());
    const oldName = normalizeMapName(req.body?.oldName);
    const newName = normalizeMapName(req.body?.newName);
    if (!oldName || !newName) {
        return res.status(400).json({ success: false, error: '地图名称只能包含字母、数字、中文、下划线和连字符' });
    }
    if (oldName === newName) {
        return res.status(400).json({ success: false, error: '地图名称未变化' });
    }

    const source = mapFiles(directory, oldName);
    const target = mapFiles(directory, newName);
    if (!fs.existsSync(source.yaml)) {
        return res.status(404).json({ success: false, error: '原地图不存在' });
    }
    if (fs.existsSync(target.yaml) || fs.existsSync(target.image)) {
        return res.status(409).json({ success: false, error: '目标名称已被使用' });
    }

    try {
        fs.renameSync(source.yaml, target.yaml);
        if (fs.existsSync(source.image)) fs.renameSync(source.image, target.image);
        const yaml = fs.readFileSync(target.yaml, 'utf8');
        const imageLine = `image: ${JSON.stringify(`${newName}.pgm`)}`;
        const updatedYaml = /^image:.*$/m.test(yaml)
            ? yaml.replace(/^image:.*$/m, imageLine)
            : `${imageLine}\n${yaml}`;
        fs.writeFileSync(target.yaml, updatedYaml);
        res.json({ success: true, maps: listMaps(directory) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/delete_map', (req, res) => {
    const directory = mapsDir(loadConfig());
    const name = normalizeMapName(req.body?.mapName);
    if (!name) return res.status(400).json({ success: false, error: '无效的地图名称' });

    const files = mapFiles(directory, name);
    if (!fs.existsSync(files.yaml)) {
        return res.status(404).json({ success: false, error: '地图不存在' });
    }
    try {
        fs.unlinkSync(files.yaml);
        if (fs.existsSync(files.image)) fs.unlinkSync(files.image);
        res.json({ success: true, maps: listMaps(directory) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/start_navigation', (req, res) => {
    const { mapPath } = req.body || {};
    if (typeof mapPath !== 'string' || !mapPath.trim()) {
        return res.status(400).json({ success: false, error: '请选择地图' });
    }

    const config = loadConfig();
    const tasks = config.tasks?.navigation || [];
    if (tasks.length === 0) {
        return res.status(404).json({ success: false, error: '导航任务未定义或为空，请先在系统配置中配置导航任务' });
    }
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

app.get('/api/:collection', (req, res, next) => {
    const collection = req.params.collection;
    if (!STORE_COLLECTIONS.has(collection)) return next();
    const filePath = path.join(dataDir, `${collection}.json`);
    if (!fs.existsSync(filePath)) {
        return res.json({ hasData: false, items: [] });
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const items = Array.isArray(parsed) ? parsed : [];
        res.json({ hasData: true, items });
    } catch (err) {
        res.status(500).json({ success: false, error: `读取 ${collection} 数据失败: ${err.message}` });
    }
});

app.put('/api/:collection', (req, res, next) => {
    const collection = req.params.collection;
    if (!STORE_COLLECTIONS.has(collection)) return next();
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length > 2000) {
        return res.status(400).json({ success: false, error: 'items 必须是长度不超过 2000 的数组' });
    }
    const filePath = path.join(dataDir, `${collection}.json`);
    try {
        writeJsonAtomic(filePath, items);
        res.json({ success: true, count: items.length });
    } catch (err) {
        res.status(500).json({ success: false, error: `保存 ${collection} 数据失败: ${err.message}` });
    }
});

function shutdown() {
    activeProcesses.forEach((proc, id) => stopTask(id));
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const dist = path.join(projectRoot, 'dist');
if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^(?!\/api(?:\/|$)).*/, (req, res) => {
        res.sendFile(path.join(dist, 'index.html'));
    });
}

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, '0.0.0.0', () => {
    console.log(`后端已启动: http://localhost:${server.address().port}`);
});

const config = loadConfig();
startTasks(config.tasks?.startup || [], config);
