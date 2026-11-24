import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const app = express();
const activeProcesses = new Map();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

function loadConfig() {
    try {
        const configPath = process.env.ROS_CONFIG_FILE || path.join(projectRoot, 'config/ros_config.json');
        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
        console.error('无法读取 ROS 配置:', err.message);
        return { tasks: {} };
    }
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

const dist = path.join(projectRoot, 'dist');
if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^(?!\/api(?:\/|$)).*/, (req, res) => {
        res.sendFile(path.join(dist, 'index.html'));
    });
}

app.listen(3000, '0.0.0.0', () => {
    console.log('后端已启动: http://localhost:3000');
});

const config = loadConfig();
startTasks(config.tasks?.startup || [], config);
