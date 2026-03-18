import express from 'express';
import cors from 'cors';
import { spawn, exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json());

// 记录所有后端的子进程
let activeProcesses = {};

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

// 加载配置文件
function loadConfig() {
    try {
        const configPath = path.join(__dirname, 'ros_config.json');
        const data = fs.readFileSync(configPath, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('无法读取配置文件:', err);
        return { tasks: { mapping: [] } };
    }
}

function getBackendPort() {
    const config = loadConfig();
    const port = config?.ports?.backend;
    const n = Number(port);
    return Number.isFinite(n) && n > 0 ? n : 3000;
}

function getRosSourceCommands(config) {
    const paths = config?.paths || {};
    const sources = [];

    if (paths.ros_setup) {
        sources.push(`[ -f ${shellQuote(paths.ros_setup)} ] && source ${shellQuote(paths.ros_setup)}`);
    }

    if (paths.fishbot_workspace) {
        const fishbotSetup = path.join(paths.fishbot_workspace, 'install/setup.bash');
        sources.push(`[ -f ${shellQuote(fishbotSetup)} ] && source ${shellQuote(fishbotSetup)}`);
    }

    if (Array.isArray(paths.extra_workspaces)) {
        for (const ws of paths.extra_workspaces) {
            if (!ws) continue;
            const setupPath = path.join(ws, 'install/setup.bash');
            sources.push(`[ -f ${shellQuote(setupPath)} ] && source ${shellQuote(setupPath)}`);
        }
    }

    return sources.join('; ');
}

function buildRosCommand(config, commandPart) {
    const sources = getRosSourceCommands(config);
    if (!sources) return commandPart;
    return `${sources}; ${commandPart}`;
}

const port = getBackendPort();

// 运行时配置（前端可读取的可配置项）
app.get('/api/runtime_config', (req, res) => {
    const config = loadConfig();
    res.json({
        topics: config.topics || {}
    });
});

// 通用启动任务接口
app.post('/api/run_task/:taskName', (req, res) => {
    const taskName = req.params.taskName;
    console.log(`收到启动任务请求: ${taskName}`);

    const config = loadConfig();
    const tasks = config.tasks[taskName] || [];

    if (tasks.length === 0) {
        return res.status(404).json({ success: false, error: `任务类别 ${taskName} 未定义或为空` });
    }

    try {
        tasks.forEach((task) => {
            const { id, command, args, delay, description } = task;

            setTimeout(() => {
                if (!activeProcesses[id]) {
                    console.log(`[${id}] 启动: ${description} (${command} ${args.join(' ')})`);
                    const fullCommand = buildRosCommand(config, `${command} ${args.join(' ')}`);

                    const proc = spawn('bash', ['-c', fullCommand], {
                        detached: true,
                        stdio: 'inherit'
                    });

                    proc.on('error', (err) => {
                        console.error(`[${id}] 启动错误:`, err.message);
                        activeProcesses[id] = null;
                    });

                    proc.on('exit', (code) => {
                        console.log(`[${id}] 已退出 (代码: ${code})`);
                        activeProcesses[id] = null;
                    });

                    activeProcesses[id] = proc;
                }
            }, delay || 0);
        });

        res.json({ success: true, message: `任务 [${taskName}] 已按配置启动` });
    } catch (error) {
        console.error(`[${taskName}] 启动失败:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 通用停止任务接口
app.post('/api/stop_task/:taskName', (req, res) => {
    const taskName = req.params.taskName;
    console.log(`收到停止任务请求: ${taskName}`);

    const config = loadConfig();
    const tasks = config.tasks[taskName] || [];

    try {
        tasks.forEach((task) => {
            const id = task.id;
            const proc = activeProcesses[id];
            if (proc && proc.pid) {
                try {
                    // 尝试平滑退出
                    process.kill(-proc.pid, 'SIGTERM');
                    console.log(`[${id}] 已发送停止信号`);
                } catch (e) {
                    if (!e.message.includes('ESRCH')) {
                        console.error(`无法停止 ${id}:`, e.message);
                    }
                }
                activeProcesses[id] = null;

                // 针对特定 ROS 2 launch 任务进行强力清场，防止孤儿节点卡住端口
                if (id === 'nav2' || taskName === 'navigation') {
                    setTimeout(() => {
                        exec('pkill -9 -f "navigation2|nav2|component_container_isolated|amcl|bt_navigator"');
                    }, 500);
                } else if (id === 'mapCartographer' || taskName === 'mapping') {
                    setTimeout(() => {
                        exec('pkill -9 -f "cartographer.launch.py|cartographer_node|cartographer_occupancy_grid"');
                    }, 500);
                } else if (id === 'foxglove' || taskName === 'startup') {
                    setTimeout(() => {
                        exec('pkill -9 -f "foxglove_bridge"');
                    }, 500);
                }
            }
        });

        res.json({ success: true, message: `任务 [${taskName}] 已停止` });
    } catch (error) {
        console.error(`[${taskName}] 停止失败:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 状态查询接口 (针对特定任务类别)
app.get('/api/task_status/:taskName', (req, res) => {
    const taskName = req.params.taskName;
    const config = loadConfig();
    const tasks = config.tasks[taskName] || [];

    const isRunning = tasks.some(task => !!activeProcesses[task.id]);
    res.json({ isRunning });
});

// 兼容旧的接口 (映射到 mapping 任务)
app.post('/api/start_mapping', (req, res) => res.redirect(307, '/api/run_task/mapping'));
app.post('/api/stop_mapping', (req, res) => res.redirect(307, '/api/stop_task/mapping'));
app.get('/api/mapping_status', (req, res) => res.redirect(301, '/api/task_status/mapping'));

// 获取地图列表
app.get('/api/list_maps', (req, res) => {
    const config = loadConfig();
    const mapsDir = config.maps_dir || config.save_map?.save_dir || '/tmp';
    try {
        if (!fs.existsSync(mapsDir)) {
            return res.json({ maps: [] });
        }
        const files = fs.readdirSync(mapsDir)
            .filter(f => f.endsWith('.yaml'))
            .map(f => ({
                name: f.replace('.yaml', ''),
                path: path.join(mapsDir, f.replace('.yaml', ''))
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
        res.json({ maps: files });
    } catch (err) {
        console.error('[list_maps] 读取地图目录失败:', err);
        res.status(500).json({ maps: [], error: err.message });
    }
});

// 启动导航 (支持指定地图路径)
app.post('/api/start_navigation', (req, res) => {
    const { mapPath } = req.body;
    if (!mapPath || mapPath.trim() === '') {
        return res.status(400).json({ success: false, error: '请指定地图路径 (mapPath)' });
    }

    const config = loadConfig();
    const tasks = config.tasks['navigation'] || [];
    if (tasks.length === 0) {
        return res.status(404).json({ success: false, error: '未找到 navigation 任务配置' });
    }

    try {
        tasks.forEach((task) => {
            const { id, command, args, delay, description } = task;
            // 追加地图参数
            const navArgs = [...args, `map:=${mapPath}.yaml`];

            setTimeout(() => {
                if (!activeProcesses[id]) {
                    console.log(`[${id}] 启动导航: ${description}, 地图: ${mapPath}`);
                    const fullCommand = buildRosCommand(config, `${command} ${navArgs.join(' ')}`);

                    const proc = spawn('bash', ['-c', fullCommand], {
                        detached: true,
                        stdio: 'inherit'
                    });

                    proc.on('error', (err) => {
                        console.error(`[${id}] 启动错误:`, err.message);
                        activeProcesses[id] = null;
                    });

                    proc.on('exit', (code) => {
                        console.log(`[${id}] 已退出 (代码: ${code})`);
                        activeProcesses[id] = null;
                    });

                    activeProcesses[id] = proc;
                } else {
                    console.log(`[${id}] 导航已在运行中，忽略重复启动`);
                }
            }, delay || 0);
        });

        res.json({ success: true, message: `导航已启动，地图: ${mapPath}` });
    } catch (error) {
        console.error('[start_navigation] 启动失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 停止导航 / 查询导航状态 (复用通用接口)
app.post('/api/stop_navigation', (req, res) => res.redirect(307, '/api/stop_task/navigation'));
app.get('/api/navigation_status', (req, res) => res.redirect(301, '/api/task_status/navigation'));

// 保存地图接口
app.post('/api/save_map', (req, res) => {
    const { mapName } = req.body;
    if (!mapName || mapName.trim() === '') {
        return res.status(400).json({ success: false, error: '地图名称不能为空' });
    }

    const config = loadConfig();
    const saveMapConfig = config.save_map;
    if (!saveMapConfig || !saveMapConfig.command) {
        return res.status(500).json({ success: false, error: 'ros_config.json 中未配置 save_map 命令' });
    }

    const saveDir = saveMapConfig.save_dir || '/tmp';
    const safeName = mapName.trim().replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_');
    const savePath = `${saveDir}/${safeName}`;
    const args = [...saveMapConfig.args, savePath];
    const fullCommand = buildRosCommand(config, `mkdir -p ${shellQuote(saveDir)} && ${saveMapConfig.command} ${args.join(' ')}`);

    console.log(`[save_map] 正在保存地图到: ${savePath}`);

    const proc = spawn('bash', ['-c', fullCommand], { stdio: 'inherit' });
    proc.on('exit', (code) => {
        if (code === 0) {
            console.log(`[save_map] 保存成功: ${savePath}`);
            res.json({ success: true, message: `地图已保存至 ${savePath}`, path: savePath });
        } else {
            console.error(`[save_map] 保存失败，退出码: ${code}`);
            res.status(500).json({ success: false, error: `保存失败，退出码: ${code}` });
        }
    });
    proc.on('error', (err) => {
        console.error('[save_map] 执行错误:', err.message);
        res.status(500).json({ success: false, error: err.message });
    });
});

// 停止所有活跃进程的函数
function stopAllProcesses() {
    console.log('正在清理所有活跃进程...');
    Object.keys(activeProcesses).forEach((id) => {
        const proc = activeProcesses[id];
        if (proc && proc.pid) {
            try {
                process.kill(-proc.pid);
                console.log(`[${id}] 已停止`);
            } catch (e) {
                if (!e.message.includes('ESRCH')) {
                    console.error(`无法停止 ${id}:`, e.message);
                }
            }
            activeProcesses[id] = null;
        }
    });
}

// 监听进程退出信号
process.on('SIGINT', () => {
    stopAllProcesses();
    process.exit();
});

process.on('SIGTERM', () => {
    stopAllProcesses();
    process.exit();
});

app.listen(port, () => {
    console.log(`ROS 2 运行服务后端已启动并监听在 http://localhost:${port}`);
});
