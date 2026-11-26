import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const dataDir = process.env.ROS_DATA_DIR ? path.resolve(process.env.ROS_DATA_DIR) : path.join(projectRoot, 'data');
const STORE_COLLECTIONS = new Set(['robots', 'missions', 'records', 'alerts']);
const SIMULATION_SCENES = new Set(['indoor', 'warehouse', 'outdoor']);
const MAX_TASK_LOG_LINES = 200;
const MAX_MAP_PIXELS = 16 * 1024 * 1024;
const MAX_SLAM_GRID_SIDE = 2000;
const MAX_SLAM_POINTS = 200000;
const MAX_STORE_ITEMS = 2000;
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_STORE_BYTES = 24 * 1024 * 1024;
const MAX_COMMAND_OUTPUT = 64 * 1024;
const TASK_STOP_TIMEOUT_MS = boundedNumber(process.env.TASK_STOP_TIMEOUT_MS, 5000, 500, 30000);
const COMMAND_TIMEOUT_MS = boundedNumber(process.env.COMMAND_TIMEOUT_MS, 10000, 500, 60000);
const SAVE_MAP_TIMEOUT_MS = boundedNumber(process.env.SAVE_MAP_TIMEOUT_MS, 60000, 1000, 300000);
const app = express();
const activeProcesses = new Map();
const pendingTaskTimers = new Map();
const pendingGroupTimers = new Map();
const taskGroups = new Map();
const taskLogs = new Map();
const managedUtilityProcesses = new Set();
const taskOperationQueues = new Map();
const mapLocks = new Map();
let saveMapRunning = false;
let shuttingDown = false;
const simulationControlUrls = {
    indoor: process.env.SIMULATION_CONTROL_URL_INDOOR || process.env.SIMULATION_CONTROL_URL || 'http://127.0.0.1:8766',
    warehouse: process.env.SIMULATION_CONTROL_URL_WAREHOUSE || 'http://127.0.0.1:8767',
    outdoor: process.env.SIMULATION_CONTROL_URL_OUTDOOR || 'http://127.0.0.1:8769'
};
const defaultCameraTopics = { camera_primary: '/camera1/preview/compressed' };
const defaultControlConfig = {
    max_linear_speed: 5,
    max_angular_speed: 1.0,
    command_rate_hz: 10,
    command_timeout_ms: 600
};
const defaultMappingConfig = { auto_start: false };
const controlConfigRules = {
    max_linear_speed: { min: 0.1, max: 5, integer: false },
    max_angular_speed: { min: 0.1, max: 3, integer: false },
    command_rate_hz: { min: 1, max: 50, integer: true },
    command_timeout_ms: { min: 200, max: 3000, integer: true }
};
const runtimeTaskNames = ['mapping', 'navigation'];

function boundedNumber(value, fallback, min, max) {
    if (value === undefined || value === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasNul(value) {
    return typeof value === 'string' && value.includes('\0');
}

function containsNul(value) {
    if (hasNul(value)) return true;
    if (Array.isArray(value)) return value.some(containsNul);
    if (isRecord(value)) return Object.entries(value).some(([key, item]) => hasNul(key) || containsNul(item));
    return false;
}

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function apiError(res, status, message, extra = {}) {
    return res.status(status).json({ success: false, error: message, ...extra });
}

const host = process.env.HOST || '127.0.0.1';
const apiToken = process.env.API_TOKEN || '';
const loopbackHost = host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
if (!loopbackHost && !apiToken) {
    console.error(`拒绝启动：HOST=${host} 为非 loopback 地址时必须显式设置非空 API_TOKEN。`);
    process.exit(1);
}
if (hasNul(host) || hasNul(apiToken)) {
    console.error('拒绝启动：HOST 和 API_TOKEN 不能包含 NUL 字符。');
    process.exit(1);
}

const defaultCorsOrigins = new Set([
    'http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173',
    'http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'
]);
const configuredCorsOrigins = (process.env.CORS_ORIGINS || '')
    .split(',').map((origin) => origin.trim()).filter(Boolean);
const allowedCorsOrigins = new Set(configuredCorsOrigins.length ? configuredCorsOrigins : defaultCorsOrigins);
const allowAnyCorsOrigin = allowedCorsOrigins.has('*');

function originAllowed(origin) {
    return !origin || allowAnyCorsOrigin || allowedCorsOrigins.has(origin);
}

app.use(cors({
    origin(origin, callback) {
        callback(null, originAllowed(origin) ? origin || true : false);
    }
}));
app.use(express.json({ limit: process.env.REQUEST_BODY_LIMIT || '24mb' }));
app.use('/api', (req, res, next) => {
    const origin = req.get('Origin');
    if (!originAllowed(origin)) return apiError(res, 403, '不允许的前端来源');
    if (!loopbackHost) {
        const authorization = req.get('Authorization') || '';
        const supplied = authorization.startsWith('Bearer ')
            ? authorization.slice(7)
            : req.get('x-api-token') || '';
        const expectedBuffer = Buffer.from(apiToken);
        const suppliedBuffer = Buffer.from(supplied);
        if (expectedBuffer.length !== suppliedBuffer.length ||
            !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) {
            return apiError(res, 401, 'API 令牌无效');
        }
    }
    next();
});

function runtimeConfigPath() {
    return process.env.ROS_CONFIG_FILE || path.join(projectRoot, 'config/ros_config.json');
}

function readJsonFile(filePath, maxBytes) {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('JSON 文件无效或超过大小限制');
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadConfig() {
    const config = readJsonFile(runtimeConfigPath(), MAX_CONFIG_BYTES);
    if (!isRecord(config)) throw new Error('ROS 配置根节点必须是对象');
    if (containsNul(config)) throw new Error('ROS 配置字符串和字段名不能包含 NUL 字符');
    return config;
}

function configuredTasks(config, taskName) {
    const tasks = config.tasks?.[taskName];
    if (tasks === undefined) return [];
    if (!Array.isArray(tasks)) throw new Error(`配置任务 ${taskName} 必须是数组`);
    for (const task of tasks) validateTask(task, taskName);
    return tasks;
}

function validateTask(task, taskName = '任务') {
    if (!isRecord(task) || typeof task.id !== 'string' || !task.id || hasNul(task.id) ||
        typeof task.command !== 'string' || !task.command.trim() || hasNul(task.command) ||
        !Array.isArray(task.args) || task.args.some((arg) => typeof arg !== 'string' || hasNul(arg))) {
        throw new Error(`${taskName} 包含无效任务定义或 NUL 字符`);
    }
    if (task.delay !== undefined && (!Number.isFinite(task.delay) || task.delay < 0 || task.delay > 300000)) {
        throw new Error(`${taskName} 的任务延迟无效`);
    }
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

function runtimeMapping(mapping) {
    return {
        auto_start: isRecord(mapping) && typeof mapping.auto_start === 'boolean'
            ? mapping.auto_start
            : defaultMappingConfig.auto_start
    };
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
        mapping: runtimeMapping(source.mapping),
        tasks: {
            mapping: runtimeTasks(source.tasks?.mapping),
            navigation: runtimeTasks(source.tasks?.navigation)
        }
    };
}

function validateRuntimeConfig(body) {
    if (!isRecord(body)) return '请求正文必须是 JSON 对象';
    const allowedFields = new Set(['topics', 'workspace', 'maps_dir', 'control', 'mapping', 'tasks']);
    const unknownFields = Object.keys(body).filter((key) => !allowedFields.has(key));
    if (unknownFields.length) return `包含不支持的配置字段：${unknownFields.join('、')}`;

    for (const field of ['workspace', 'maps_dir']) {
        if (body[field] === undefined) continue;
        if (typeof body[field] !== 'string' || !body[field].trim() || body[field].length > 1024 || hasNul(body[field])) {
            return `${field} 必须是不含 NUL 的非空字符串，且长度不能超过 1024 个字符`;
        }
    }

    if (body.topics !== undefined) {
        if (!isRecord(body.topics)) return 'topics 必须是对象';
        if (Object.keys(body.topics).length > 100) return '话题数量不能超过 100 个';
        for (const [name, topic] of Object.entries(body.topics)) {
            if (!name.trim() || name.length > 128 || hasNul(name)) return '话题名称不能为空、不含 NUL，且长度不能超过 128 个字符';
            if (typeof topic !== 'string' || !topic.startsWith('/') || topic.length > 1024 || hasNul(topic)) {
                return `话题 ${name} 必须以 / 开头、不含 NUL，且长度不能超过 1024 个字符`;
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

    if (body.mapping !== undefined) {
        if (!isRecord(body.mapping)) return 'mapping 必须是对象';
        const unknownMappingFields = Object.keys(body.mapping).filter((key) => key !== 'auto_start');
        if (unknownMappingFields.length) return `mapping 包含不支持字段：${unknownMappingFields.join('、')}`;
        if (body.mapping.auto_start !== undefined && typeof body.mapping.auto_start !== 'boolean') {
            return 'mapping.auto_start 必须是布尔值';
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
                    (typeof task.description !== 'string' || task.description.length > 512 || hasNul(task.description))) {
                    return `${label} 的 description 必须是不含 NUL 且长度不超过 512 个字符的字符串`;
                }
                if (typeof task.command !== 'string' || !task.command.trim() || task.command.length > 2048 || hasNul(task.command)) {
                    return `${label} 的 command 必须是不含 NUL 的非空字符串，且长度不能超过 2048 个字符`;
                }
                if (!Array.isArray(task.args) || task.args.length > 200 ||
                    task.args.some((arg) => typeof arg !== 'string' || arg.length > 2048 || hasNul(arg))) {
                    return `${label} 的 args 必须是最多 200 项且不含 NUL 的字符串数组，每项不能超过 2048 个字符`;
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
    return path.isAbsolute(directory) ? path.resolve(directory) : path.resolve(projectRoot, directory);
}

function mapsDir(config) {
    return resolveFromProject(config.maps_dir || 'maps');
}

function normalizeMapName(value) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || name.length > 80 || hasNul(name) || !/^[a-zA-Z0-9_\-\u4e00-\u9fa5]+$/.test(name)) return null;
    return name;
}

function mapFiles(directory, name) {
    return {
        yaml: path.join(directory, `${name}.yaml`),
        image: path.join(directory, `${name}.pgm`),
        pcd: path.join(directory, `${name}.pcd`)
    };
}

function readMapMetadata(yamlPath) {
    const stat = fs.statSync(yamlPath);
    if (stat.size > 1024 * 1024) throw new Error('地图 YAML 文件过大');
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
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size > MAX_MAP_PIXELS + 1024) throw httpError(413, 'PGM 地图文件超过大小限制');
    const data = fs.readFileSync(filename);
    let offset = 0;

    function nextToken() {
        while (offset < data.length) {
            if (data[offset] === 35) {
                while (offset < data.length && data[offset] !== 10) offset++;
            } else if (data[offset] <= 32) offset++;
            else break;
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
    if (width <= 0 || height <= 0 || width * height > MAX_MAP_PIXELS) {
        throw httpError(413, `地图像素总数不能超过 ${MAX_MAP_PIXELS}`);
    }
    if (data[offset] === 13 && data[offset + 1] === 10) offset += 2;
    else if (data[offset] <= 32) offset++;
    const pixels = data.subarray(offset);
    if (pixels.length !== width * height) throw new Error('PGM 地图尺寸或像素数据无效');
    return { width, height, pixels };
}

function pgmBuffer(width, height, pixels) {
    return Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`, 'ascii'), pixels]);
}

function listMaps(directory) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
        .filter((file) => file.endsWith('.yaml') && !file.includes('.tmp-'))
        .map((file) => {
            const name = path.basename(file, '.yaml');
            const files = mapFiles(directory, name);
            const yamlStat = fs.statSync(files.yaml);
            const hasImage = fs.existsSync(files.image);
            const imageStat = hasImage ? fs.statSync(files.image) : null;
            const hasPcd = fs.existsSync(files.pcd);
            const pcdStat = hasPcd ? fs.statSync(files.pcd) : null;
            return {
                name,
                path: path.join(directory, name),
                modifiedAt: new Date(Math.max(yamlStat.mtimeMs, imageStat?.mtimeMs || 0, pcdStat?.mtimeMs || 0)).toISOString(),
                size: yamlStat.size + (imageStat?.size || 0) + (pcdStat?.size || 0),
                hasImage,
                hasPcd
            };
        })
        .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

function workspaceSetup(config) {
    return resolveFromProject(path.join(config.workspace || '..', 'install', 'setup.bash'));
}

function temporaryPath(filePath, kind = 'tmp') {
    return `${filePath}.${kind}-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

function mapLockKey(directory, name) {
    return `${path.resolve(directory)}:${name}`;
}

async function acquireMapLock(key) {
    let lock = mapLocks.get(key);
    if (!lock) {
        lock = { locked: false, waiters: [] };
        mapLocks.set(key, lock);
    }
    if (lock.locked) await new Promise((resolve) => lock.waiters.push(resolve));
    lock.locked = true;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const next = lock.waiters.shift();
        if (next) next();
        else {
            lock.locked = false;
            if (mapLocks.get(key) === lock) mapLocks.delete(key);
        }
    };
}

async function withMapLocks(keys, operation) {
    const releases = [];
    try {
        for (const key of [...new Set(keys)].sort()) releases.push(await acquireMapLock(key));
        return await operation();
    } finally {
        for (const release of releases.reverse()) release();
    }
}

function writeJsonAtomic(filePath, data, spaces = 2) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = temporaryPath(filePath);
    try {
        fs.writeFileSync(tempPath, `${JSON.stringify(data, null, spaces)}\n`, 'utf8');
        fs.renameSync(tempPath, filePath);
    } catch (error) {
        fs.rmSync(tempPath, { force: true });
        throw error;
    }
}

function commitFileSet(entries) {
    const prepared = entries.map((entry) => ({
        ...entry,
        existed: fs.existsSync(entry.path),
        backup: temporaryPath(entry.path, 'backup')
    }));
    const committed = [];
    let succeeded = false;
    try {
        for (const entry of prepared) {
            if (entry.existed) fs.copyFileSync(entry.path, entry.backup);
        }
        for (const entry of prepared) {
            if (entry.delete) fs.rmSync(entry.path, { force: true });
            else fs.renameSync(entry.temp, entry.path);
            committed.push(entry);
        }
        succeeded = true;
    } catch (error) {
        for (const entry of committed.reverse()) {
            try {
                if (entry.existed) fs.renameSync(entry.backup, entry.path);
                else fs.rmSync(entry.path, { force: true });
            } catch (rollbackError) {
                console.error(`回滚 ${entry.path} 失败: ${rollbackError.message}`);
            }
        }
        throw error;
    } finally {
        for (const entry of prepared) {
            if (entry.temp) fs.rmSync(entry.temp, { force: true });
            if (entry.existed && fs.existsSync(entry.backup)) {
                if (!succeeded && committed.includes(entry) && !fs.existsSync(entry.path)) {
                    try { fs.renameSync(entry.backup, entry.path); } catch {}
                } else fs.rmSync(entry.backup, { force: true });
            }
        }
    }
}

function appendTaskLog(taskId, stream, chunk) {
    if (!taskId) return;
    const lines = chunk.toString('utf8').split(/\r?\n/).filter((line) => line.length > 0);
    if (!lines.length) return;
    const list = taskLogs.get(taskId) || [];
    const now = new Date().toISOString();
    for (const line of lines) list.push({ time: now, stream, line });
    if (list.length > MAX_TASK_LOG_LINES) list.splice(0, list.length - MAX_TASK_LOG_LINES);
    taskLogs.set(taskId, list);
}

function runRos(command, args, config, detached = true, taskId = null, environment = {}, captureOutput = false) {
    if (typeof command !== 'string' || !command || hasNul(command) ||
        !Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || hasNul(arg))) {
        throw new Error('进程命令或参数包含无效字符串/NUL 字符');
    }
    const script = [
        'set -e',
        'source /opt/ros/humble/setup.bash',
        'if [[ -f "$1" ]]; then source "$1"; fi',
        'shift',
        'exec "$@"'
    ].join('\n');
    const env = { ...process.env };
    for (const [name, value] of Object.entries(environment || {})) {
        if (value === null || value === undefined) delete env[name];
        else env[name] = String(value);
    }
    const proc = spawn('bash', ['-c', script, 'ros2-task', workspaceSetup(config), command, ...args], {
        detached,
        stdio: taskId || captureOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        env
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

function registerTaskGroup(id, groupName) {
    if (!groupName) return;
    if (!taskGroups.has(groupName)) taskGroups.set(groupName, new Set());
    taskGroups.get(groupName).add(id);
}

function serializeTaskOperation(key, operation) {
    const previous = taskOperationQueues.get(key) || Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    const tracked = result.finally(() => {
        if (taskOperationQueues.get(key) === tracked) taskOperationQueues.delete(key);
    });
    taskOperationQueues.set(key, tracked);
    return tracked;
}

function sceneOperationKey(scene) {
    return `scene:${scene}`;
}

function taskNameOperationKey(taskName) {
    if (taskName.startsWith('simulation_')) return sceneOperationKey(taskName.slice('simulation_'.length));
    if (taskName === 'mapping') return sceneOperationKey('');
    if (taskName === 'navigation') return 'navigation';
    return `task:${taskName}`;
}

async function startTask(task, config, extraArgs = [], groupName = null) {
    validateTask(task, groupName || '任务');
    if (activeProcesses.has(task.id) || pendingTaskTimers.has(task.id)) {
        throw httpError(409, `任务 ${task.id} 已在运行或等待启动`);
    }
    registerTaskGroup(task.id, groupName);
    const args = [...task.args, ...extraArgs];
    console.log(`[${task.id}] ${task.description || task.command}`);
    taskLogs.set(task.id, [{ time: new Date().toISOString(), stream: 'system', line: `启动任务: ${task.command} ${args.join(' ')}`.trim() }]);
    let proc;
    try {
        proc = runRos(task.command, args, config, true, task.id, task.env);
    } catch (error) {
        appendTaskLog(task.id, 'stderr', Buffer.from(`启动失败: ${error.message}`));
        throw error;
    }
    proc.taskGroup = groupName;
    activeProcesses.set(task.id, proc);
    proc.on('error', (error) => {
        console.error(`[${task.id}] 启动/进程失败: ${error.message}`);
        appendTaskLog(task.id, 'stderr', Buffer.from(`进程失败: ${error.message}`));
        if (activeProcesses.get(task.id) === proc) activeProcesses.delete(task.id);
    });
    proc.once('exit', (code, signal) => {
        console.log(`[${task.id}] 已退出 (${code ?? signal})`);
        appendTaskLog(task.id, 'system', Buffer.from(`进程已退出 (code=${code}, signal=${signal})`));
        if (activeProcesses.get(task.id) === proc) activeProcesses.delete(task.id);
    });
    try {
        proc.startSettlement = new Promise((resolve, reject) => {
            const cleanup = () => {
                proc.removeListener('spawn', onSpawn);
                proc.removeListener('error', onError);
                proc.removeListener('exit', onEarlyExit);
            };
            const onSpawn = () => {
                cleanup();
                if (typeof proc.pid === 'number' && proc.pid > 0) resolve();
                else reject(new Error(`任务 ${task.id} 启动后没有有效 PID`));
            };
            const onError = (error) => {
                cleanup();
                reject(new Error(`任务 ${task.id} 启动失败: ${error.message}`));
            };
            const onEarlyExit = (code, signal) => {
                cleanup();
                reject(new Error(`任务 ${task.id} 启动期间退出 (code=${code}, signal=${signal})`));
            };
            proc.once('spawn', onSpawn);
            proc.once('error', onError);
            proc.once('exit', onEarlyExit);
        });
        await proc.startSettlement;
    } catch (error) {
        if (activeProcesses.get(task.id) === proc) activeProcesses.delete(task.id);
        appendTaskLog(task.id, 'stderr', Buffer.from(error.message));
        throw error;
    }
}

function cancelPendingTask(id) {
    const timer = pendingTaskTimers.get(id);
    if (timer) {
        clearTimeout(timer);
        pendingTaskTimers.delete(id);
    }
}

function cancelPendingGroup(groupKey) {
    const timer = pendingGroupTimers.get(groupKey);
    if (timer) {
        clearTimeout(timer);
        pendingGroupTimers.delete(groupKey);
    }
}

function timerCallback(callback) {
    return () => {
        try {
            Promise.resolve(callback()).catch((error) => console.error(`定时任务执行失败: ${error.message}`));
        } catch (error) {
            console.error(`定时任务执行失败: ${error.message}`);
        }
    };
}

function isTaskActiveOrPending(id) {
    return activeProcesses.has(id) || pendingTaskTimers.has(id);
}

async function startTasks(tasks, config, extraArgs = [], groupName = null) {
    if (!Array.isArray(tasks)) throw new Error('任务配置必须是数组');
    for (const task of tasks) {
        validateTask(task, groupName || '任务');
        registerTaskGroup(task.id, groupName);
        const delay = Number(task.delay) || 0;
        if (delay <= 0) {
            await startTask(task, config, extraArgs, groupName);
            continue;
        }
        const timer = setTimeout(timerCallback(async () => {
            pendingTaskTimers.delete(task.id);
            await startTask(task, config, extraArgs, groupName);
        }), delay);
        timer.taskGroup = groupName;
        pendingTaskTimers.set(task.id, timer);
    }
}

async function stopTask(id, timeoutMs = TASK_STOP_TIMEOUT_MS) {
    cancelPendingTask(id);
    let proc = activeProcesses.get(id);
    if (proc && !proc.pid && proc.startSettlement) {
        try { await proc.startSettlement; } catch { return; }
        const current = activeProcesses.get(id);
        if (current !== proc) return;
    }
    proc = activeProcesses.get(id);
    if (!proc) return;
    if (!proc.pid) {
        if (activeProcesses.get(id) === proc) activeProcesses.delete(id);
        return;
    }
    if (proc.exitCode !== null || proc.signalCode !== null) {
        if (activeProcesses.get(id) === proc) activeProcesses.delete(id);
        return;
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        let forceTimer;
        let failureTimer;
        const cleanup = () => {
            clearTimeout(forceTimer);
            clearTimeout(failureTimer);
            proc.removeListener('exit', onExit);
            proc.removeListener('error', onError);
        };
        const finish = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (activeProcesses.get(id) === proc) activeProcesses.delete(id);
            if (error) reject(error);
            else resolve();
        };
        const onExit = () => finish();
        const onError = (error) => {
            if (proc.exitCode !== null || proc.signalCode !== null || !proc.pid) finish();
            else finish(new Error(`[${id}] 进程错误: ${error.message}`));
        };
        proc.once('exit', onExit);
        proc.once('error', onError);
        try {
            process.kill(-proc.pid, 'SIGTERM');
        } catch (error) {
            if (error.code !== 'ESRCH') {
                finish(new Error(`[${id}] 停止失败: ${error.message}`));
                return;
            }
        }
        forceTimer = setTimeout(timerCallback(() => {
            if (settled) return;
            try { process.kill(-proc.pid, 'SIGKILL'); } catch (error) {
                if (error.code !== 'ESRCH') {
                    finish(new Error(`[${id}] 强制停止失败: ${error.message}`));
                    return;
                }
            }
            failureTimer = setTimeout(timerCallback(() => finish(new Error(`[${id}] 等待进程退出超时`))), 2000);
        }), timeoutMs);
    });
}

async function stopTasks(tasks = [], groupName = null) {
    const ids = new Set(Array.isArray(tasks) ? tasks.map((task) => task.id).filter(Boolean) : []);
    for (const id of taskGroups.get(groupName) || []) ids.add(id);
    for (const [id, proc] of activeProcesses) {
        if (proc.taskGroup === groupName && groupName) ids.add(id);
    }
    for (const [id, timer] of pendingTaskTimers) {
        if (timer.taskGroup === groupName && groupName) ids.add(id);
    }
    const results = await Promise.allSettled(Array.from(ids, (id) => stopTask(id)));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) throw new Error(failures.map((result) => result.reason.message).join('；'));
}

function signalUtilityProcess(proc, signal) {
    if (!proc?.pid) return;
    try {
        if (proc.taskGroup || proc.pid) process.kill(-proc.pid, signal);
    } catch (error) {
        if (error.code !== 'ESRCH') console.error(`停止子进程失败: ${error.message}`);
    }
}

async function runManagedCommand(command, args, config, options = {}) {
    const { timeoutMs = COMMAND_TIMEOUT_MS, environment = {}, label = command } = options;
    let proc;
    try {
        proc = runRos(command, args, config, true, null, environment, true);
    } catch (error) {
        throw httpError(500, `${label} 启动失败: ${error.message}`);
    }
    managedUtilityProcesses.add(proc);
    let output = '';
    const capture = (chunk) => {
        if (output.length < MAX_COMMAND_OUTPUT) output += chunk.toString('utf8').slice(0, MAX_COMMAND_OUTPUT - output.length);
    };
    proc.stdout?.on('data', capture);
    proc.stderr?.on('data', capture);
    try {
        await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (error) reject(error);
                else resolve();
            };
            const timer = setTimeout(timerCallback(() => {
                signalUtilityProcess(proc, 'SIGKILL');
                finish(httpError(504, `${label} 执行超时`));
            }), timeoutMs);
            proc.once('error', (error) => finish(httpError(500, `${label} 启动失败: ${error.message}`)));
            proc.once('exit', (code, signal) => {
                if (code === 0) finish();
                else finish(httpError(502, `${label} 失败 (code=${code ?? 'null'}, signal=${signal || 'none'}): ${output.trim().slice(-2000)}`));
            });
        });
        return output.trim();
    } finally {
        managedUtilityProcesses.delete(proc);
    }
}

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', activeTasks: Array.from(new Set([...activeProcesses.keys(), ...pendingTaskTimers.keys()])) });
});

app.get('/api/tasks/active', (req, res) => {
    const logCounts = Object.fromEntries(Array.from(taskLogs.entries()).map(([id, logs]) => [id, logs.length]));
    res.json({
        activeTasks: Array.from(new Set([...activeProcesses.keys(), ...pendingTaskTimers.keys()])),
        logCounts
    });
});

app.get('/api/tasks/logs/:id', (req, res) => {
    const id = req.params.id;
    res.json({ id, running: isTaskActiveOrPending(id), logs: taskLogs.get(id) || [] });
});

app.get('/api/runtime_config', (req, res) => {
    const normalized = runtimeConfig(loadConfig());
    res.json({
        ...normalized,
        diagnostics: {
            workspaceExists: fs.existsSync(resolveFromProject(normalized.workspace)),
            setupBashExists: fs.existsSync(workspaceSetup(normalized)),
            mapsDirExists: fs.existsSync(mapsDir(normalized))
        }
    });
});

app.put('/api/runtime_config', (req, res) => {
    const validationError = validateRuntimeConfig(req.body);
    if (validationError) return apiError(res, 400, validationError);
    const configPath = runtimeConfigPath();
    let currentConfig;
    try {
        currentConfig = readJsonFile(configPath, MAX_CONFIG_BYTES);
        if (!isRecord(currentConfig)) throw new Error('配置根节点不是对象');
    } catch (error) {
        console.error('读取待保存的 ROS 配置失败:', error.message);
        return apiError(res, 500, '读取配置文件失败，未保存任何修改');
    }
    const updatedConfig = { ...currentConfig };
    if (req.body.workspace !== undefined) updatedConfig.workspace = req.body.workspace.trim();
    if (req.body.maps_dir !== undefined) updatedConfig.maps_dir = req.body.maps_dir.trim();
    if (req.body.topics !== undefined) updatedConfig.topics = { ...defaultCameraTopics, ...req.body.topics };
    if (req.body.control !== undefined) updatedConfig.control = runtimeControl({ ...currentConfig.control, ...req.body.control });
    if (req.body.mapping !== undefined) updatedConfig.mapping = runtimeMapping({ ...currentConfig.mapping, ...req.body.mapping });
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
    if (containsNul(updatedConfig)) return apiError(res, 400, '配置字符串和字段名不能包含 NUL 字符');
    try {
        writeJsonAtomic(configPath, updatedConfig, 4);
        res.json({ success: true, config: runtimeConfig(updatedConfig) });
    } catch (error) {
        console.error('保存 ROS 配置失败:', error.message);
        apiError(res, 500, '保存配置失败，请检查配置文件及目录权限');
    }
});

function simulationScene(req) {
    const value = req.query.scene ?? req.body?.scene ?? 'indoor';
    return typeof value === 'string' && SIMULATION_SCENES.has(value) ? value : null;
}

async function simulationRequest(scene, requestPath, options = {}) {
    const response = await fetch(`${simulationControlUrls[scene]}${requestPath}`, {
        ...options,
        signal: AbortSignal.timeout(1500)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `仿真控制服务 HTTP ${response.status}`);
    return data;
}

app.get('/api/simulation/status', async (req, res) => {
    const scene = simulationScene(req);
    if (!scene) return apiError(res, 400, '未知的仿真场景', { ready: false });
    try {
        res.json(await simulationRequest(scene, '/status'));
    } catch {
        apiError(res, 503, '仿真控制服务未连接', { ready: false, scene });
    }
});

app.post('/api/simulation/velocity', async (req, res) => {
    const scene = simulationScene(req);
    if (!scene) return apiError(res, 400, '未知的仿真场景');
    const { linearX, angularZ } = req.body || {};
    const control = runtimeControl(loadConfig().control);
    if (typeof linearX !== 'number' || !Number.isFinite(linearX) || Math.abs(linearX) > control.max_linear_speed ||
        typeof angularZ !== 'number' || !Number.isFinite(angularZ) || Math.abs(angularZ) > control.max_angular_speed) {
        return apiError(res, 400, `线速度范围为 ±${control.max_linear_speed} m/s，角速度范围为 ±${control.max_angular_speed} rad/s`);
    }
    try {
        res.json(await simulationRequest(scene, '/velocity', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ linearX, angularZ })
        }));
    } catch {
        apiError(res, 503, '仿真控制服务未连接，请先启动场景', { scene });
    }
});

function normalizeSceneKey(scene) {
    return typeof scene === 'string' ? scene.trim().replace(/^\/+|\/+$/g, '') : '';
}

function requestScene(req) {
    return normalizeSceneKey(req.body?.scene ?? req.query?.scene ?? '');
}

function validSceneOrReal(scene) {
    return scene === '' || SIMULATION_SCENES.has(scene);
}

function isFastlioTask(task) {
    return task.id.endsWith('_fastlio') || task.id.includes('fastlio');
}

function sceneStartupTasks(taskName, tasks, config) {
    if (!taskName.startsWith('simulation_')) return tasks;
    return tasks.filter((task) => runtimeMapping(config.mapping).auto_start || !isFastlioTask(task));
}

app.post('/api/run_task/:taskName', async (req, res) => {
    const taskName = req.params.taskName;
    if (taskName.startsWith('simulation_') && !SIMULATION_SCENES.has(taskName.slice('simulation_'.length))) {
        return apiError(res, 400, '未知的仿真场景');
    }
    await serializeTaskOperation(taskNameOperationKey(taskName), async () => {
        const config = loadConfig();
        const tasks = sceneStartupTasks(taskName, configuredTasks(config, taskName), config);
        if (tasks.length === 0) return apiError(res, 404, '任务未定义或为空');
        await stopTasks([], taskName);
        await startTasks(tasks, config, [], taskName);
        res.json({ success: true });
    });
});

app.post('/api/stop_task/:taskName', async (req, res) => {
    const taskName = req.params.taskName;
    if (taskName.startsWith('simulation_') && !SIMULATION_SCENES.has(taskName.slice('simulation_'.length))) {
        return apiError(res, 400, '未知的仿真场景');
    }
    await serializeTaskOperation(taskNameOperationKey(taskName), async () => {
        const config = loadConfig();
        await stopTasks(configuredTasks(config, taskName), taskName);
        if (taskName.startsWith('simulation_')) {
            const scene = taskName.slice('simulation_'.length);
            cancelPendingGroup(`localization:${scene}`);
            cancelPendingGroup(`mapping:${scene}`);
            await stopTasks(resolveLocalizationTasks(config, scene), `localization:${scene}`);
            await stopTasks(resolveMappingTasks(config, scene), `mapping:${scene}`);
        }
        res.json({ success: true });
    });
});

app.get('/api/task_status/:taskName', (req, res) => {
    const taskName = req.params.taskName;
    if (taskName.startsWith('simulation_') && !SIMULATION_SCENES.has(taskName.slice('simulation_'.length))) {
        return apiError(res, 400, '未知的仿真场景');
    }
    const config = loadConfig();
    const tasks = sceneStartupTasks(taskName, configuredTasks(config, taskName), config);
    const groupIds = taskGroups.get(taskName) || new Set();
    const isRunning = tasks.some((task) => isTaskActiveOrPending(task.id)) ||
        Array.from(groupIds).some((id) => isTaskActiveOrPending(id));
    res.json({ isRunning });
});

function resolveMappingTasks(config, scene) {
    const clean = normalizeSceneKey(scene);
    if (clean === '') return configuredTasks(config, 'mapping');
    if (!SIMULATION_SCENES.has(clean)) return null;
    return configuredTasks(config, `simulation_${clean}`)
        .filter(isFastlioTask)
        .map((task) => ({ ...task, delay: 0 }));
}

function nav2Installed(config) {
    return [
        '/opt/ros/humble/share/nav2_bt_navigator',
        path.join(resolveFromProject(config.workspace || '..'), 'install', 'nav2_bt_navigator')
    ].some((dir) => fs.existsSync(dir));
}

function resolveLocalizationTasks(config, scene, mapYamlPath = '') {
    const clean = normalizeSceneKey(scene);
    if (!validSceneOrReal(clean)) return null;
    const isSim = clean !== '';
    const taskId = isSim ? `simulation_${clean}_nav2` : 'robot_nav2';
    const args = [
        'launch', path.join(projectRoot, 'simulation', 'nav2_launch.py'),
        `map:=${mapYamlPath}`,
        `params_file:=${path.join(projectRoot, 'config', 'nav2_params.yaml')}`,
        `auto_initial_pose:=${isSim ? 'true' : 'false'}`
    ];
    if (isSim) args.push(`namespace:=${clean}`);
    return [{
        id: taskId,
        description: isSim ? `${clean} Nav2 2D 定位与巡检导航` : 'Nav2 2D 定位与巡检导航',
        command: 'ros2',
        args,
        env: isSim ? { ROS_DOMAIN_ID: '88', ROS_LOCALHOST_ONLY: '1', FASTRTPS_DEFAULT_PROFILES_FILE: null } : { ROS_DOMAIN_ID: '88' },
        delay: 0
    }];
}

function pathInside(directory, candidate) {
    const relative = path.relative(directory, candidate);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function localizationMapPath(config, value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 1024 || hasNul(value)) return null;
    const directory = path.resolve(mapsDir(config));
    const trimmed = value.trim();
    const extension = path.extname(trimmed).toLowerCase();
    if (extension && !['.yaml', '.yml', '.pgm'].includes(extension)) return null;
    const withoutExtension = extension ? trimmed.slice(0, -extension.length) : trimmed;
    const selected = path.isAbsolute(withoutExtension)
        ? path.resolve(withoutExtension)
        : path.resolve(directory, withoutExtension);
    const yamlPath = `${selected}.yaml`;
    const pgmPath = `${selected}.pgm`;
    try {
        if (!pathInside(directory, yamlPath) || !pathInside(directory, pgmPath)) return null;
        const realDirectory = fs.realpathSync(directory);
        const realYaml = fs.realpathSync(yamlPath);
        const realPgm = fs.realpathSync(pgmPath);
        if (!pathInside(realDirectory, realYaml) || !pathInside(realDirectory, realPgm) ||
            !fs.statSync(realYaml).isFile() || !fs.statSync(realPgm).isFile()) return null;
        return realYaml;
    } catch {
        return null;
    }
}

app.post('/api/start_localization', async (req, res) => {
    const config = loadConfig();
    const scene = requestScene(req);
    if (!validSceneOrReal(scene)) return apiError(res, 400, '未知的仿真场景');
    if (!nav2Installed(config)) {
        return apiError(res, 503, '未检测到 ROS 2 Nav2 功能包，请先执行: sudo apt update && sudo apt install -y ros-humble-navigation2 ros-humble-nav2-bringup');
    }
    const mapPath = localizationMapPath(config, req.body?.mapPath);
    if (!mapPath) return apiError(res, 400, '请选择地图目录中存在的 2D 地图（需包含 .yaml 与 .pgm，且不能越出地图目录）');
    const tasks = resolveLocalizationTasks(config, scene, mapPath);
    await serializeTaskOperation(sceneOperationKey(scene), async () => {
        cancelPendingGroup(`mapping:${scene}`);
        cancelPendingGroup(`localization:${scene}`);
        await stopTasks(resolveMappingTasks(config, scene), `mapping:${scene}`);
        await stopTasks(tasks, `localization:${scene}`);
        await startTasks(tasks, config, [], `localization:${scene}`);
        const hasPcd = fs.existsSync(mapPath.replace(/\.yaml$/, '.pcd'));
        res.json({
            success: true,
            mapPath,
            engine: 'nav2',
            degraded: !hasPcd,
            warning: hasPcd ? null : '地图缺少 PCD，3D 定位不可用，当前仅以 2D 降级模式运行'
        });
    });
});

app.post('/api/stop_localization', async (req, res) => {
    const config = loadConfig();
    const scene = requestScene(req);
    if (!validSceneOrReal(scene)) return apiError(res, 400, '未知的仿真场景');
    await serializeTaskOperation(sceneOperationKey(scene), async () => {
        cancelPendingGroup(`localization:${scene}`);
        await stopTasks(resolveLocalizationTasks(config, scene), `localization:${scene}`);
        res.json({ success: true });
    });
});

app.get('/api/localization_status', (req, res) => {
    const config = loadConfig();
    const scene = requestScene(req);
    if (!validSceneOrReal(scene)) return apiError(res, 400, '未知的仿真场景');
    const tasks = resolveLocalizationTasks(config, scene);
    const groupIds = taskGroups.get(`localization:${scene}`) || new Set();
    res.json({
        isRunning: pendingGroupTimers.has(`localization:${scene}`) ||
            [...tasks.map((task) => task.id), ...groupIds].some((id) => isTaskActiveOrPending(id))
    });
});

app.post('/api/start_mapping', async (req, res) => {
    const config = loadConfig();
    const scene = requestScene(req);
    const tasks = resolveMappingTasks(config, scene);
    if (!tasks) return apiError(res, 400, '未知的仿真场景');
    if (tasks.length === 0) return apiError(res, 404, '建图任务未定义或为空');
    await serializeTaskOperation(sceneOperationKey(scene), async () => {
        cancelPendingGroup(`localization:${scene}`);
        cancelPendingGroup(`mapping:${scene}`);
        await stopTasks(resolveLocalizationTasks(config, scene), `localization:${scene}`);
        await stopTasks(tasks, `mapping:${scene}`);
        await startTasks(tasks, config, [], `mapping:${scene}`);
        res.json({ success: true });
    });
});

app.post('/api/stop_mapping', async (req, res) => {
    const config = loadConfig();
    const scene = requestScene(req);
    const tasks = resolveMappingTasks(config, scene);
    if (!tasks) return apiError(res, 400, '未知的仿真场景');
    await serializeTaskOperation(sceneOperationKey(scene), async () => {
        cancelPendingGroup(`mapping:${scene}`);
        await stopTasks(tasks, `mapping:${scene}`);
        res.json({ success: true });
    });
});

app.post('/api/restart_mapping', async (req, res) => {
    const config = loadConfig();
    const scene = requestScene(req);
    const tasks = resolveMappingTasks(config, scene);
    if (!tasks) return apiError(res, 400, '未知的仿真场景');
    if (tasks.length === 0) return apiError(res, 404, '建图任务未定义或为空');
    await serializeTaskOperation(sceneOperationKey(scene), async () => {
        cancelPendingGroup(`localization:${scene}`);
        cancelPendingGroup(`mapping:${scene}`);
        await stopTasks(resolveLocalizationTasks(config, scene), `localization:${scene}`);
        await stopTasks(tasks, `mapping:${scene}`);
        await startTasks(tasks, config, [], `mapping:${scene}`);
        res.json({ success: true });
    });
});

app.get('/api/mapping_status', (req, res) => {
    const scene = requestScene(req);
    const tasks = resolveMappingTasks(loadConfig(), scene);
    if (!tasks) return apiError(res, 400, '未知的仿真场景');
    const groupIds = taskGroups.get(`mapping:${scene}`) || new Set();
    res.json({
        isRunning: pendingGroupTimers.has(`mapping:${scene}`) ||
            [...tasks.map((task) => task.id), ...groupIds].some((id) => isTaskActiveOrPending(id))
    });
});

app.post('/api/stop_navigation', (req, res) => res.redirect(307, '/api/stop_task/navigation'));
app.get('/api/navigation_status', (req, res) => res.redirect(308, '/api/task_status/navigation'));

app.get('/api/list_maps', (req, res) => {
    try {
        res.json({ maps: listMaps(mapsDir(loadConfig())) });
    } catch (error) {
        apiError(res, 500, error.message, { maps: [] });
    }
});

app.get('/api/maps/:name/content', (req, res) => {
    const directory = mapsDir(loadConfig());
    const name = normalizeMapName(req.params.name);
    if (!name) return apiError(res, 400, '无效的地图名称');
    const files = mapFiles(directory, name);
    if (!fs.existsSync(files.yaml) || !fs.existsSync(files.image)) return apiError(res, 404, '地图 YAML 或 PGM 文件不存在');
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
});

app.put('/api/maps/:name/content', async (req, res) => {
    const directory = mapsDir(loadConfig());
    const name = normalizeMapName(req.params.name);
    const newName = req.body?.newName === undefined ? name : normalizeMapName(req.body.newName);
    const width = Number(req.body?.width);
    const height = Number(req.body?.height);
    if (!name || !newName || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        return apiError(res, 400, '地图名称或尺寸无效');
    }
    if (width * height > MAX_MAP_PIXELS) return apiError(res, 413, `地图像素总数不能超过 ${MAX_MAP_PIXELS}`);
    if (typeof req.body?.pixels !== 'string' || !/^[a-zA-Z0-9+/]+={0,2}$/.test(req.body.pixels)) {
        return apiError(res, 400, '地图像素数据无效');
    }
    const pixels = Buffer.from(req.body.pixels, 'base64');
    if (pixels.length !== width * height) return apiError(res, 400, '像素数量与地图尺寸不一致');
    const source = mapFiles(directory, name);
    const target = mapFiles(directory, newName);
    const saveAs = newName !== name;
    const imageTemp = temporaryPath(target.image);
    const yamlTemp = temporaryPath(target.yaml);
    const pcdTemp = temporaryPath(target.pcd);
    try {
        await withMapLocks([mapLockKey(directory, name), mapLockKey(directory, newName)], async () => {
            if (!fs.existsSync(source.yaml) || !fs.existsSync(source.image)) throw httpError(404, '原地图不存在');
            if (saveAs && [target.yaml, target.image, target.pcd].some((file) => fs.existsSync(file))) {
                throw httpError(409, '目标场景名称已被使用');
            }
            if (!saveAs) {
                const backupDir = path.join(directory, '.backups');
                fs.mkdirSync(backupDir, { recursive: true });
                const stamp = new Date().toISOString().replace(/[:.]/g, '-');
                fs.copyFileSync(source.yaml, path.join(backupDir, `${name}-${stamp}.yaml`));
                fs.copyFileSync(source.image, path.join(backupDir, `${name}-${stamp}.pgm`));
            }
            fs.writeFileSync(imageTemp, pgmBuffer(width, height, pixels));
            const entries = [{ path: target.image, temp: imageTemp }];
            if (saveAs) {
                const yaml = fs.readFileSync(source.yaml, 'utf8');
                const imageLine = `image: ${JSON.stringify(`${newName}.pgm`)}`;
                const updatedYaml = /^image:.*$/m.test(yaml) ? yaml.replace(/^image:.*$/m, imageLine) : `${imageLine}\n${yaml}`;
                fs.writeFileSync(yamlTemp, updatedYaml);
                entries.push({ path: target.yaml, temp: yamlTemp });
                if (fs.existsSync(source.pcd)) {
                    fs.copyFileSync(source.pcd, pcdTemp);
                    entries.push({ path: target.pcd, temp: pcdTemp });
                }
            }
            commitFileSet(entries);
        });
    } catch (error) {
        for (const temp of [imageTemp, yamlTemp, pcdTemp]) fs.rmSync(temp, { force: true });
        if (error.status === 404 || error.status === 409) return apiError(res, error.status, error.message);
        console.error(`保存地图 ${name} 失败: ${error.message}`);
        return apiError(res, 500, `保存地图失败，已回滚: ${error.message}`);
    }
    res.json({ success: true, map: { name: newName, path: path.join(directory, newName) }, maps: listMaps(directory) });
});

app.post('/api/rename_map', async (req, res) => {
    const directory = mapsDir(loadConfig());
    const oldName = normalizeMapName(req.body?.oldName);
    const newName = normalizeMapName(req.body?.newName);
    if (!oldName || !newName) return apiError(res, 400, '地图名称只能包含字母、数字、中文、下划线和连字符');
    if (oldName === newName) return apiError(res, 400, '地图名称未变化');
    const source = mapFiles(directory, oldName);
    const target = mapFiles(directory, newName);
    const yamlTemp = temporaryPath(target.yaml);
    const imageTemp = temporaryPath(target.image);
    const pcdTemp = temporaryPath(target.pcd);
    const sourceBackups = [];
    let targetsCommitted = false;
    let hasImage = false;
    let hasPcd = false;
    try {
        await withMapLocks([mapLockKey(directory, oldName), mapLockKey(directory, newName)], async () => {
            if (!fs.existsSync(source.yaml)) throw httpError(404, '原地图不存在');
            if ([target.yaml, target.image, target.pcd].some((file) => fs.existsSync(file))) throw httpError(409, '目标名称已被使用');
            hasImage = fs.existsSync(source.image);
            hasPcd = fs.existsSync(source.pcd);
            const yaml = fs.readFileSync(source.yaml, 'utf8');
            const imageLine = `image: ${JSON.stringify(`${newName}.pgm`)}`;
            const updatedYaml = /^image:.*$/m.test(yaml) ? yaml.replace(/^image:.*$/m, imageLine) : `${imageLine}\n${yaml}`;
            fs.writeFileSync(yamlTemp, updatedYaml);
            if (hasImage) fs.copyFileSync(source.image, imageTemp);
            if (hasPcd) fs.copyFileSync(source.pcd, pcdTemp);
            for (const sourcePath of [source.yaml, ...(hasImage ? [source.image] : []), ...(hasPcd ? [source.pcd] : [])]) {
                const backup = temporaryPath(sourcePath, 'rename-backup');
                fs.copyFileSync(sourcePath, backup);
                sourceBackups.push({ sourcePath, backup });
            }
            const entries = [
                { path: target.yaml, temp: yamlTemp },
                ...(hasImage ? [{ path: target.image, temp: imageTemp }] : []),
                ...(hasPcd ? [{ path: target.pcd, temp: pcdTemp }] : [])
            ];
            commitFileSet(entries);
            targetsCommitted = true;
            fs.unlinkSync(source.yaml);
            if (hasImage) fs.unlinkSync(source.image);
            if (hasPcd) fs.unlinkSync(source.pcd);
            for (const entry of sourceBackups) fs.rmSync(entry.backup, { force: true });
        });
    } catch (error) {
        if (targetsCommitted) {
            for (const file of [target.yaml, target.image, target.pcd]) fs.rmSync(file, { force: true });
        }
        for (const entry of sourceBackups) {
            try {
                if (!fs.existsSync(entry.sourcePath)) fs.renameSync(entry.backup, entry.sourcePath);
                else fs.rmSync(entry.backup, { force: true });
            } catch (rollbackError) {
                console.error(`恢复重命名源文件失败: ${rollbackError.message}`);
            }
        }
        for (const temp of [yamlTemp, imageTemp, pcdTemp]) fs.rmSync(temp, { force: true });
        if (error.status === 404 || error.status === 409) return apiError(res, error.status, error.message);
        console.error(`重命名地图失败: ${error.message}`);
        return apiError(res, 500, `重命名失败，已回滚: ${error.message}`);
    }
    res.json({ success: true, maps: listMaps(directory) });
});

app.post('/api/delete_map', async (req, res) => {
    const directory = mapsDir(loadConfig());
    const name = normalizeMapName(req.body?.mapName);
    if (!name) return apiError(res, 400, '无效的地图名称');
    const files = mapFiles(directory, name);
    const moved = [];
    try {
        await withMapLocks([mapLockKey(directory, name)], async () => {
            if (!fs.existsSync(files.yaml)) throw httpError(404, '地图不存在');
            for (const sourcePath of [files.yaml, files.image, files.pcd].filter((file) => fs.existsSync(file))) {
                const trashPath = temporaryPath(sourcePath, 'deleting');
                try {
                    fs.renameSync(sourcePath, trashPath);
                    moved.push({ sourcePath, trashPath });
                } catch (error) {
                    for (const entry of moved.reverse()) {
                        try { fs.renameSync(entry.trashPath, entry.sourcePath); } catch (rollbackError) {
                            console.error(`恢复待删除地图失败: ${rollbackError.message}`);
                        }
                    }
                    throw error;
                }
            }
        });
    } catch (error) {
        if (error.status === 404) return apiError(res, 404, error.message);
        return apiError(res, 500, `删除失败，已回滚: ${error.message}`);
    }
    for (const entry of moved) {
        try { fs.rmSync(entry.trashPath, { force: true }); } catch (error) { console.error(`清理删除临时文件失败: ${error.message}`); }
    }
    res.json({ success: true, maps: listMaps(directory) });
});

app.post('/api/start_navigation', async (req, res) => {
    const config = loadConfig();
    const selectedMap = localizationMapPath(config, req.body?.mapPath);
    if (!selectedMap) return apiError(res, 400, '地图必须位于 maps_dir 内，使用规范名称或 .yaml/.pgm 扩展名，且 YAML/PGM 均存在');
    const tasks = configuredTasks(config, 'navigation');
    if (tasks.length === 0) return apiError(res, 404, '导航任务未定义或为空，请先在系统配置中配置导航任务');
    await serializeTaskOperation('navigation', async () => {
        await stopTasks(tasks, 'navigation');
        await startTasks(tasks, config, [`map:=${selectedMap}`], 'navigation');
        const hasPcd = fs.existsSync(selectedMap.replace(/\.yaml$/, '.pcd'));
        res.json({
            success: true,
            degraded: !hasPcd,
            warning: hasPcd ? null : '地图缺少 PCD，3D 定位不可用，当前仅以 2D 降级模式运行'
        });
    });
});

app.post('/api/save_map', async (req, res) => {
    const name = normalizeMapName(req.body?.mapName);
    if (!name) return apiError(res, 400, '地图名称无效，只能包含字母、数字、中文、下划线和连字符');
    if (saveMapRunning) return apiError(res, 409, '已有地图保存命令正在执行，请稍后重试');
    const config = loadConfig();
    if (!isRecord(config.save_map) || typeof config.save_map.command !== 'string' ||
        !Array.isArray(config.save_map.args) || config.save_map.args.some((arg) => typeof arg !== 'string')) {
        return apiError(res, 500, 'save_map 配置无效');
    }
    const directory = mapsDir(config);
    const files = mapFiles(directory, name);
    const savePath = path.join(directory, name);
    const temporaryPrefix = temporaryPath(path.join(directory, `.${name}`), 'map-saver');
    const generatedYaml = `${temporaryPrefix}.yaml`;
    const generatedPgm = `${temporaryPrefix}.pgm`;
    const generatedPcd = `${temporaryPrefix}.pcd`;
    const yamlTemp = temporaryPath(files.yaml);
    saveMapRunning = true;
    try {
        await withMapLocks([mapLockKey(directory, name)], async () => {
            fs.mkdirSync(directory, { recursive: true });
            await runManagedCommand(config.save_map.command, [...config.save_map.args, temporaryPrefix], config, {
                timeoutMs: SAVE_MAP_TIMEOUT_MS,
                label: '保存地图'
            });
            if (!fs.statSync(generatedYaml).isFile() || !fs.statSync(generatedPgm).isFile()) {
                throw new Error('map_saver 未生成完整 YAML/PGM，原地图未修改');
            }
            const yaml = fs.readFileSync(generatedYaml, 'utf8');
            const imageLine = `image: ${JSON.stringify(`${name}.pgm`)}`;
            const updatedYaml = /^image:.*$/m.test(yaml) ? yaml.replace(/^image:.*$/m, imageLine) : `${imageLine}\n${yaml}`;
            fs.writeFileSync(yamlTemp, updatedYaml, 'utf8');
            const hasGeneratedPcd = fs.existsSync(generatedPcd) && fs.statSync(generatedPcd).isFile();
            const entries = [
                { path: files.image, temp: generatedPgm },
                { path: files.yaml, temp: yamlTemp }
            ];
            if (hasGeneratedPcd) entries.push({ path: files.pcd, temp: generatedPcd });
            else if (fs.existsSync(files.pcd)) entries.push({ path: files.pcd, delete: true });
            commitFileSet(entries);
        });
        const degraded = !fs.existsSync(files.pcd);
        res.json({
            success: true,
            path: savePath,
            degraded,
            warning: degraded ? '本次保存未生成 PCD，不会保留同名旧 PCD；定位将以 2D 降级模式运行' : null
        });
    } catch (error) {
        apiError(res, error.status || 500, `${error.message}；原地图已保留`);
    } finally {
        for (const file of [generatedYaml, generatedPgm, generatedPcd, yamlTemp]) fs.rmSync(file, { force: true });
        saveMapRunning = false;
    }
});

app.post('/api/save_slam_map', async (req, res) => {
    const { mapName, points, resolution = 0.05, minObstacleZ = 0.14, maxObstacleZ = 2.2 } = req.body || {};
    const name = normalizeMapName(mapName);
    if (!name) return apiError(res, 400, '地图名称无效，只能包含字母、数字、中文、下划线和连字符');
    if (!Array.isArray(points) || points.length < 9 || points.length % 3 !== 0) {
        return apiError(res, 400, 'points 必须是长度至少为 9 且为 3 的倍数的数值数组');
    }
    const count = points.length / 3;
    if (count > MAX_SLAM_POINTS) return apiError(res, 413, `点云点数不能超过 ${MAX_SLAM_POINTS}`);
    for (let index = 0; index < points.length; index++) {
        if (typeof points[index] !== 'number' || !Number.isFinite(points[index])) {
            return apiError(res, 400, `点云坐标索引 ${index} 不是有限数值，未生成任何地图文件`);
        }
    }
    if (typeof resolution !== 'number' || !Number.isFinite(resolution) || resolution < 0.02 || resolution > 0.5) {
        return apiError(res, 400, 'resolution 必须是 0.02～0.5 的有限数值');
    }
    if (typeof minObstacleZ !== 'number' || !Number.isFinite(minObstacleZ) ||
        typeof maxObstacleZ !== 'number' || !Number.isFinite(maxObstacleZ) ||
        minObstacleZ < -100 || maxObstacleZ > 100 || maxObstacleZ <= minObstacleZ) {
        return apiError(res, 400, '障碍物高度范围无效');
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let index = 0; index < count; index++) {
        const x = points[index * 3];
        const y = points[index * 3 + 1];
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
    }
    const pad = 0.5;
    minX -= pad;
    minY -= pad;
    maxX += pad;
    maxY += pad;
    const rawWidth = Math.max(10, Math.ceil((maxX - minX) / resolution));
    const rawHeight = Math.max(10, Math.ceil((maxY - minY) / resolution));
    if (rawWidth > MAX_SLAM_GRID_SIDE || rawHeight > MAX_SLAM_GRID_SIDE) {
        return apiError(res, 400, `地图网格 ${rawWidth}×${rawHeight} 超过 ${MAX_SLAM_GRID_SIDE} 边长限制，请增大 resolution 后重试`);
    }
    const width = rawWidth;
    const height = rawHeight;
    const gridCells = width * height;
    if (gridCells > MAX_SLAM_GRID_SIDE * MAX_SLAM_GRID_SIDE) return apiError(res, 413, '地图网格内存超过限制');

    const grid = Buffer.alloc(gridCells, 205);
    const obstacleCounts = new Uint16Array(gridCells);
    const zBins = new Uint32Array(40);
    let lowZCount = 0;
    for (let index = 0; index < count; index++) {
        const z = points[index * 3 + 2];
        if (z < -1 || z >= 1) continue;
        const bin = Math.min(39, Math.max(0, Math.floor((z + 1) / 0.05)));
        zBins[bin] += 1;
        lowZCount += 1;
    }
    let floorZ = 0;
    if (lowZCount >= 50) {
        let bestBin = 0;
        for (let bin = 1; bin < zBins.length; bin++) {
            if (zBins[bin] > zBins[bestBin]) bestBin = bin;
        }
        floorZ = -1 + (bestBin + 0.5) * 0.05;
    }
    const effMinObstacleZ = Math.max(minObstacleZ, floorZ + 0.25);
    const effMaxObstacleZ = Math.max(effMinObstacleZ + 0.5, floorZ + maxObstacleZ);

    for (let index = 0; index < count; index++) {
        const x = points[index * 3];
        const y = points[index * 3 + 1];
        const z = points[index * 3 + 2];
        const gx = Math.floor((x - minX) / resolution);
        const gy = Math.floor((y - minY) / resolution);
        if (gx < 0 || gx >= width || gy < 0 || gy >= height) continue;
        const gridIndex = (height - 1 - gy) * width + gx;
        if (z >= effMinObstacleZ && z <= effMaxObstacleZ) {
            if (obstacleCounts[gridIndex] < 65535) obstacleCounts[gridIndex] += 1;
        } else if (z >= floorZ - 0.2 && z < effMinObstacleZ - 0.05) grid[gridIndex] = 254;
    }
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const gridIndex = row * width + col;
            if (obstacleCounts[gridIndex] === 0) continue;
            let neighborhoodHits = obstacleCounts[gridIndex];
            if (neighborhoodHits < 2) {
                for (let dr = -1; dr <= 1 && neighborhoodHits < 2; dr++) {
                    const nr = row + dr;
                    if (nr < 0 || nr >= height) continue;
                    for (let dc = -1; dc <= 1; dc++) {
                        if (dr === 0 && dc === 0) continue;
                        const nc = col + dc;
                        if (nc < 0 || nc >= width) continue;
                        neighborhoodHits += obstacleCounts[nr * width + nc];
                        if (neighborhoodHits >= 2) break;
                    }
                }
            }
            if (neighborhoodHits >= 2) grid[gridIndex] = 0;
        }
    }

    const pcdLines = [
        '# .PCD v0.7 - Point Cloud Data file format', 'VERSION 0.7', 'FIELDS x y z',
        'SIZE 4 4 4', 'TYPE F F F', 'COUNT 1 1 1', `WIDTH ${count}`, 'HEIGHT 1',
        'VIEWPOINT 0 0 0 1 0 0 0', `POINTS ${count}`, 'DATA ascii'
    ];
    let pcdSize = pcdLines.join('\n').length + 1;
    for (let index = 0; index < count; index++) {
        const line = `${points[index * 3].toFixed(4)} ${points[index * 3 + 1].toFixed(4)} ${points[index * 3 + 2].toFixed(4)}`;
        pcdSize += Buffer.byteLength(line) + 1;
        if (pcdSize > 32 * 1024 * 1024) return apiError(res, 413, 'PCD 输出超过 32 MiB 内存限制');
        pcdLines.push(line);
    }
    const yamlBody = [
        `image: ${name}.pgm`, 'mode: trinary', `resolution: ${resolution}`,
        `origin: [${minX.toFixed(4)}, ${minY.toFixed(4)}, 0.0]`, 'negate: 0',
        'occupied_thresh: 0.65', 'free_thresh: 0.25', ''
    ].join('\n');
    const directory = mapsDir(loadConfig());
    const pgmPath = path.join(directory, `${name}.pgm`);
    const yamlPath = path.join(directory, `${name}.yaml`);
    const pcdPath = path.join(directory, `${name}.pcd`);
    const entries = [
        { path: pgmPath, temp: temporaryPath(pgmPath) },
        { path: yamlPath, temp: temporaryPath(yamlPath) },
        { path: pcdPath, temp: temporaryPath(pcdPath) }
    ];
    try {
        await withMapLocks([mapLockKey(directory, name)], async () => {
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(entries[0].temp, pgmBuffer(width, height, grid));
            fs.writeFileSync(entries[1].temp, yamlBody, 'utf8');
            fs.writeFileSync(entries[2].temp, `${pcdLines.join('\n')}\n`, 'utf8');
            commitFileSet(entries);
        });
        res.json({ success: true, name, pgmPath, yamlPath, pcdPath, pointCount: count, width, height });
    } catch (error) {
        for (const entry of entries) fs.rmSync(entry.temp, { force: true });
        console.error(`保存 SLAM 地图失败: ${error.message}`);
        apiError(res, 500, `保存失败，已回滚所有地图文件: ${error.message}`);
    }
});

function navigationCommandEnvironment(scene) {
    return scene
        ? { ROS_DOMAIN_ID: '88', ROS_LOCALHOST_ONLY: '1', FASTRTPS_DEFAULT_PROFILES_FILE: null }
        : { ROS_DOMAIN_ID: '88' };
}

async function runRosWithRetry(args, config, options) {
    const deadline = Date.now() + 20000;
    let lastError;
    while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        try {
            return await runManagedCommand('ros2', args, config, {
                ...options,
                timeoutMs: Math.min(options.timeoutMs || COMMAND_TIMEOUT_MS, Math.max(500, remaining))
            });
        } catch (error) {
            lastError = error;
            if (error.status === 500 || Date.now() >= deadline) break;
            await new Promise((resolve) => setTimeout(resolve, Math.min(500, deadline - Date.now())));
        }
    }
    throw lastError;
}

function rosParameterValue(output, label) {
    const match = output.match(/values?\s+(?:is|are):\s*([^\r\n]+)/i);
    if (!match) throw httpError(502, `${label} 返回了无法识别的参数值`);
    return match[1].trim();
}

async function getRosParameter(node, parameter, config, environment) {
    const label = `${node} ${parameter} 参数读取`;
    const output = await runRosWithRetry(['param', 'get', node, parameter], config, { environment, label });
    return rosParameterValue(output, label);
}

async function setRosParameter(node, parameter, value, config, environment) {
    await runRosWithRetry(['param', 'set', node, parameter, value], config, {
        environment,
        label: `${node} ${parameter} 参数设置`
    });
}

function formatDouble(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error('速度参数必须是有限数值');
    return number.toFixed(6);
}

function formatDoubleVector(values) {
    return `[${values.map(formatDouble).join(',')}]`;
}

function parseVelocityVector(value, parameter) {
    const arrayText = String(value).match(/\[[^\]]*\]/)?.[0];
    let parsed;
    try { parsed = JSON.parse(arrayText); } catch {
        throw httpError(502, `${parameter} 参数格式无效`);
    }
    if (!Array.isArray(parsed) || parsed.length !== 3 ||
        parsed.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
        throw httpError(502, `${parameter} 必须是三个有限数值`);
    }
    return parsed;
}

async function readSpeedSnapshot(controllerNode, smootherNode, config, environment) {
    const linear = Number(await getRosParameter(controllerNode, 'FollowPath.desired_linear_vel', config, environment));
    const angular = Number(await getRosParameter(controllerNode, 'FollowPath.rotate_to_heading_angular_vel', config, environment));
    const maxVelocity = parseVelocityVector(
        await getRosParameter(smootherNode, 'max_velocity', config, environment), 'max_velocity'
    );
    const minVelocity = parseVelocityVector(
        await getRosParameter(smootherNode, 'min_velocity', config, environment), 'min_velocity'
    );
    if (!Number.isFinite(linear) || !Number.isFinite(angular)) throw httpError(502, 'RPP 原速度参数不是有限数值');
    return { linear, angular, maxVelocity, minVelocity };
}

function speedSnapshotsEqual(left, right) {
    const equal = (a, b) => Math.abs(a - b) <= 1e-9;
    return equal(left.linear, right.linear) && equal(left.angular, right.angular) &&
        ['maxVelocity', 'minVelocity'].every((key) => left[key].every((value, index) => equal(value, right[key][index])));
}

async function restoreSpeedSnapshot(controllerNode, smootherNode, snapshot, config, environment) {
    const writes = await Promise.allSettled([
        setRosParameter(controllerNode, 'FollowPath.desired_linear_vel', formatDouble(snapshot.linear), config, environment),
        setRosParameter(controllerNode, 'FollowPath.rotate_to_heading_angular_vel', formatDouble(snapshot.angular), config, environment),
        setRosParameter(smootherNode, 'max_velocity', formatDoubleVector(snapshot.maxVelocity), config, environment),
        setRosParameter(smootherNode, 'min_velocity', formatDoubleVector(snapshot.minVelocity), config, environment)
    ]);
    let actual = null;
    let readError = null;
    try {
        actual = await readSpeedSnapshot(controllerNode, smootherNode, config, environment);
    } catch (error) {
        readError = error.message;
    }
    const writeErrors = writes.filter((result) => result.status === 'rejected').map((result) => result.reason.message);
    const restored = writeErrors.length === 0 && actual && speedSnapshotsEqual(snapshot, actual);
    return { restored: Boolean(restored), writeErrors, readError, actual };
}

app.post('/api/navigation/speed_limits', async (req, res) => {
    const { scene, maxLinearSpeed, maxAngularSpeed } = req.body || {};
    if (typeof scene !== 'string' || (scene !== '' && !SIMULATION_SCENES.has(scene))) {
        return apiError(res, 400, 'scene 必须是空字符串（实机）或 indoor、warehouse、outdoor 之一');
    }
    if (typeof maxLinearSpeed !== 'number' || !Number.isFinite(maxLinearSpeed) || maxLinearSpeed < 0.01 || maxLinearSpeed > 5) {
        return apiError(res, 400, 'maxLinearSpeed 必须是 0.01～5 m/s 的有限数值');
    }
    if (typeof maxAngularSpeed !== 'number' || !Number.isFinite(maxAngularSpeed) || maxAngularSpeed < 0.01 || maxAngularSpeed > 3) {
        return apiError(res, 400, 'maxAngularSpeed 必须是 0.01～3 rad/s 的有限数值');
    }
    const config = loadConfig();
    const controllerNode = scene ? `/${scene}/controller_server` : '/controller_server';
    const smootherNode = scene ? `/${scene}/velocity_smoother` : '/velocity_smoother';
    const environment = navigationCommandEnvironment(scene);
    try {
        const snapshot = await readSpeedSnapshot(controllerNode, smootherNode, config, environment);
        try {
            await setRosParameter(controllerNode, 'FollowPath.desired_linear_vel', formatDouble(maxLinearSpeed), config, environment);
            await setRosParameter(controllerNode, 'FollowPath.rotate_to_heading_angular_vel', formatDouble(maxAngularSpeed), config, environment);
            await setRosParameter(smootherNode, 'max_velocity', formatDoubleVector([maxLinearSpeed, 0, maxAngularSpeed]), config, environment);
            await setRosParameter(smootherNode, 'min_velocity', formatDoubleVector([-maxLinearSpeed, 0, -maxAngularSpeed]), config, environment);
        } catch (error) {
            const rollback = await restoreSpeedSnapshot(controllerNode, smootherNode, snapshot, config, environment);
            error.rollback = rollback;
            if (!rollback.restored) {
                const rollbackError = httpError(500, `速度参数设置结果未知，完整回滚或回读校验失败: ${error.message}`);
                rollbackError.rollback = rollback;
                throw rollbackError;
            }
            error.message = `${error.message}；四个速度参数已回滚并重读确认`;
            throw error;
        }
        res.json({ success: true, scene, controllerNode, smootherNode, maxLinearSpeed, maxAngularSpeed });
    } catch (error) {
        console.error(`设置 Nav2 速度限制失败: ${error.message}`);
        apiError(res, error.status || 502, error.message, error.rollback ? { rollback: error.rollback } : {});
    }
});

function cancelNavigationNamespace(scene, namespace) {
    if (namespace === undefined) return scene;
    if (typeof namespace !== 'string' || namespace.length > 128 || hasNul(namespace)) return null;
    const clean = namespace.replace(/^\//, '');
    if (clean === '') return scene === '' ? '' : null;
    if (!/^[a-zA-Z0-9_]+(?:\/[a-zA-Z0-9_]+)*$/.test(clean)) return null;
    if (scene && clean !== scene) return null;
    return clean;
}

function cancelGoalReturnCode(output) {
    const match = output.match(/\breturn_code\s*(?:=|:)\s*(-?\d+)\b/i);
    if (!match) throw httpError(502, 'CancelGoal 响应缺少可识别的 return_code');
    return Number(match[1]);
}

app.post('/api/cancel_navigation', async (req, res) => {
    const { scene, namespace } = req.body || {};
    if (typeof scene !== 'string' || (scene !== '' && !SIMULATION_SCENES.has(scene))) {
        return apiError(res, 400, 'scene 必须是空字符串（实机）或 indoor、warehouse、outdoor 之一');
    }
    const cleanNamespace = cancelNavigationNamespace(scene, namespace);
    if (cleanNamespace === null) return apiError(res, 400, 'namespace 无效或与仿真 scene 不一致');
    const service = `${cleanNamespace ? `/${cleanNamespace}` : ''}/navigate_to_pose/_action/cancel_goal`;
    try {
        const output = await runManagedCommand('ros2', [
            'service', 'call', service, 'action_msgs/srv/CancelGoal', '{}'
        ], loadConfig(), {
            environment: navigationCommandEnvironment(scene),
            label: `${service} 取消导航`
        });
        const returnCode = cancelGoalReturnCode(output);
        if (returnCode !== 0) {
            return apiError(res, 409, `取消导航被服务拒绝，return_code=${returnCode}`, {
                returnCode,
                result: output
            });
        }
        res.json({ success: true, scene, namespace: cleanNamespace, service, returnCode, result: output });
    } catch (error) {
        apiError(res, error.status || 502, error.message);
    }
});

function readCollection(collection) {
    const filePath = path.join(dataDir, `${collection}.json`);
    if (!fs.existsSync(filePath)) return { hasData: false, items: [], version: 0, filePath };
    const parsed = readJsonFile(filePath, MAX_STORE_BYTES);
    if (Array.isArray(parsed)) return { hasData: true, items: parsed, version: 0, filePath };
    if (!isRecord(parsed) || !Array.isArray(parsed.items) ||
        !Number.isSafeInteger(parsed.version) || parsed.version < 0) {
        throw new Error(`${collection} 数据文件必须是旧数组或 {items,version} 对象，不能按空集合处理`);
    }
    return { hasData: true, items: parsed.items, version: parsed.version, filePath };
}

app.get('/api/:collection', (req, res, next) => {
    const collection = req.params.collection;
    if (!STORE_COLLECTIONS.has(collection)) return next();
    try {
        const { hasData, items, version } = readCollection(collection);
        res.json({ hasData, items, version });
    } catch (error) {
        apiError(res, 500, `读取 ${collection} 数据失败: ${error.message}`);
    }
});

app.put('/api/:collection', (req, res, next) => {
    const collection = req.params.collection;
    if (!STORE_COLLECTIONS.has(collection)) return next();
    const items = req.body?.items;
    const requestedVersion = req.body?.version;
    if (!Array.isArray(items) || items.length > MAX_STORE_ITEMS) {
        return apiError(res, 400, `items 必须是长度不超过 ${MAX_STORE_ITEMS} 的数组`);
    }
    if (requestedVersion !== undefined && (!Number.isInteger(requestedVersion) || requestedVersion < 0)) {
        return apiError(res, 400, 'version 必须是非负整数');
    }
    try {
        const current = readCollection(collection);
        if (requestedVersion !== undefined && requestedVersion !== current.version) {
            return apiError(res, 409, '数据已被其他客户端修改，请基于最新版本重试', {
                items: current.items,
                version: current.version
            });
        }
        const version = current.version + 1;
        writeJsonAtomic(current.filePath, { items, version });
        res.json({ success: true, count: items.length, version });
    } catch (error) {
        apiError(res, 500, `保存 ${collection} 数据失败: ${error.message}`);
    }
});

app.use('/api', (req, res) => apiError(res, 404, 'API 接口不存在'));
app.use('/api', (error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error?.type === 'entity.too.large' || error?.status === 413) {
        return apiError(res, 413, '请求 JSON 或资源内容超过大小限制');
    }
    if (error?.type === 'entity.parse.failed') return apiError(res, 400, '请求 JSON 格式无效');
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    if (status >= 500) console.error(`API ${req.method} ${req.originalUrl} 失败:`, error);
    apiError(res, status, status === 500 ? `服务器处理失败: ${error.message}` : error.message);
});

async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    pendingGroupTimers.forEach((timer) => clearTimeout(timer));
    pendingGroupTimers.clear();
    pendingTaskTimers.forEach((timer) => clearTimeout(timer));
    pendingTaskTimers.clear();
    for (const proc of managedUtilityProcesses) signalUtilityProcess(proc, 'SIGTERM');
    const ids = Array.from(new Set([...activeProcesses.keys(), ...pendingTaskTimers.keys()]));
    try {
        await stopTasks(ids.map((id) => ({ id })));
    } catch (error) {
        console.error(`关闭任务失败: ${error.message}`);
    }
    for (const proc of managedUtilityProcesses) signalUtilityProcess(proc, 'SIGKILL');
    process.exit(0);
}

process.on('SIGINT', () => { shutdown().catch((error) => { console.error(error); process.exit(1); }); });
process.on('SIGTERM', () => { shutdown().catch((error) => { console.error(error); process.exit(1); }); });

const dist = path.join(projectRoot, 'dist');
if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^(?!\/api(?:\/|$)).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`拒绝启动：PORT=${process.env.PORT} 无效。`);
    process.exit(1);
}
const server = app.listen(port, host, () => {
    console.log(`后端已启动: http://${host}:${server.address().port}`);
});
server.on('error', (error) => console.error(`后端监听失败: ${error.message}`));

try {
    const config = loadConfig();
    startTasks(configuredTasks(config, 'startup'), config, [], 'startup')
        .catch((error) => console.error(`启动任务失败: ${error.message}`));
} catch (error) {
    console.error(`启动任务未执行，ROS 配置无效: ${error.message}`);
}
