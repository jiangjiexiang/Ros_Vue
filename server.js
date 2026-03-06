import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

// 记录所有后端的子进程
let processes = {
    bringup: null,
    navDisplay: null,
    mapCartographer: null
};

app.post('/api/start_mapping', (req, res) => {
    console.log('收到开始建图请求');

    try {
        // 1. 底层数据程序
        if (!processes.bringup) {
            console.log('启动: ros2 launch yahboomcar_bringup yahboomcar_bringup_launch.py');
            processes.bringup = spawn('ros2', ['launch', 'yahboomcar_bringup', 'yahboomcar_bringup_launch.py'], { detached: true });
            processes.bringup.on('error', (err) => console.error('bringup error:', err));
        }

        // 2. 建图可视化 (稍微延迟一下等待底层程序)
        setTimeout(() => {
            if (!processes.navDisplay) {
                console.log('启动: ros2 launch yahboomcar_nav display_launch.py');
                processes.navDisplay = spawn('ros2', ['launch', 'yahboomcar_nav', 'display_launch.py'], { detached: true });
                processes.navDisplay.on('error', (err) => console.error('navDisplay error:', err));
            }
        }, 2000);

        // 3. 建图算法 (再延迟一下)
        setTimeout(() => {
            if (!processes.mapCartographer) {
                console.log('启动: ros2 launch yahboomcar_nav map_cartographer_launch.py');
                processes.mapCartographer = spawn('ros2', ['launch', 'yahboomcar_nav', 'map_cartographer_launch.py'], { detached: true });
                processes.mapCartographer.on('error', (err) => console.error('mapCartographer error:', err));
            }
        }, 4000);

        res.json({ success: true, message: '建图节点已按顺序启动' });
    } catch (error) {
        console.error('启动失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/stop_mapping', (req, res) => {
    console.log('收到停止建图请求');

    try {
        // 杀死所有对应的进程树 (-的pid表示kill整个进程组，配合detached: true使用)
        const killProcess = (procName) => {
            const proc = processes[procName];
            if (proc && proc.pid) {
                try {
                    process.kill(-proc.pid);
                    console.log(`已停止 ${procName}`);
                } catch (e) {
                    if (e.message && e.message.includes('ESRCH')) {
                        console.log(`${procName} 进程组已自然退出 (ESRCH)`);
                    } else {
                        console.error(`无法停止 ${procName}:`, e.message);
                    }
                }
                processes[procName] = null;
            }
        };

        killProcess('mapCartographer');
        killProcess('navDisplay');
        killProcess('bringup');

        res.json({ success: true, message: '建图节点已停止' });
    } catch (error) {
        console.error('停止失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/mapping_status', (req, res) => {
    const isRunning = !!(processes.bringup || processes.navDisplay || processes.mapCartographer);
    res.json({ isRunning });
});

app.listen(port, () => {
    console.log(`ROS 2 运行服务后端已启动并监听在 http://localhost:${port}`);
});
