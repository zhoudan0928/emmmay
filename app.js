const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const compression = require('compression');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 7860;  // 支持Koyeb的PORT环境变量

// 用于存储视频流的统计信息
const streamStats = new Map();

// 清理超时的统计信息
setInterval(() => {
    const now = Date.now();
    for (const [key, stats] of streamStats.entries()) {
        if (now - stats.lastUpdate > 30000) { // 30秒无更新则清理
            streamStats.delete(key);
        }
    }
}, 30000);

// 用于记录速度的函数
function logSpeed(req, stats, totalBytes, proxyResponseTime, isEnd = false) {
    const now = Date.now();
    const totalTimeToProxy = proxyResponseTime - req.startTime;
    const totalTimeToClient = now - proxyResponseTime;
    
    // 从响应头中获取实际的传输字节数
    const range = req.headers.range || '';
    
    // 计算实际的传输速度
    // HF Space到Emby服务器的下载速度
    const downloadSpeed = totalBytes / (totalTimeToProxy / 1000);
    // 客户端到HF Space的上传速度（实际传输的数据量）
    const uploadSpeed = totalBytes / (totalTimeToClient / 1000);

    // 计算累积平均速度
    const avgDownloadSpeed = stats.totalBytes / (stats.totalTimeToProxy / 1000);
    const avgUploadSpeed = stats.totalBytes / (stats.totalTimeToClient / 1000);
    
    // 记录速度日志
    console.log(`\n[${new Date().toISOString()}] 媒体流请求: ${req.url}`);
    if (range) {
        console.log(`Range: ${range}`);
    }
    console.log(`${isEnd ? '最终' : '当前'}统计:`);
    console.log(`  客户端到HF Space: ${(uploadSpeed / 1024 / 1024).toFixed(2)} MB/s (${(totalBytes / 1024 / 1024).toFixed(2)}MB in ${totalTimeToClient}ms)`);
    console.log(`  HF Space到Emby服务器: ${(downloadSpeed / 1024 / 1024).toFixed(2)} MB/s (${(totalBytes / 1024 / 1024).toFixed(2)}MB in ${totalTimeToProxy}ms)`);
    if (stats.chunks > 0) {
        console.log(`累积统计 (${stats.chunks} 个分片):`);
        console.log(`  平均上传速度: ${(avgUploadSpeed / 1024 / 1024).toFixed(2)} MB/s`);
        console.log(`  平均下载速度: ${(avgDownloadSpeed / 1024 / 1024).toFixed(2)} MB/s`);
        console.log(`  总传输: ${(stats.totalBytes / 1024 / 1024).toFixed(2)}MB`);
    }
    console.log('-------------------');
}

// 启用压缩，但排除视频流
app.use(compression({
    filter: (req, res) => {
        const contentType = res.getHeader('Content-Type') || '';
        return !contentType.includes('video/') && !contentType.includes('audio/') && compression.filter(req, res);
    }
}));

// 从环境变量获取 Emby 服务器地址
const EMBY_SERVER = process.env.EMBY_SERVER || '';

if (!EMBY_SERVER) {
    console.error('EMBY_SERVER environment variable is not set');
    process.exit(1);
}

// 健康检查端点
app.get('/healthz', (req, res) => {
    res.json({ status: 'healthy' });
});

// 获取默认User-Agent
function getDefaultUserAgent(isMobile = false) {
    if (isMobile) {
        return "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
    } else {
        return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    }
}

// 配置代理选项
const proxyOptions = {
    target: EMBY_SERVER,
    changeOrigin: true,
    secure: false,
    ws: true,
    xfwd: true,
    proxyTimeout: 0,    // 禁用超时
    timeout: 0,         // 禁用超时
    onProxyReq: (proxyReq, req) => {
        // 记录请求开始时间
        req.startTime = Date.now();
        req.bytesWritten = 0;
        req.lastLogTime = Date.now();

        const targetHost = new URL(EMBY_SERVER).host;
        const isMobile = req.headers['sec-ch-ua-mobile'] === '?1';

        // 添加必要的请求头
        proxyReq.setHeader('User-Agent', getDefaultUserAgent(isMobile));
        proxyReq.setHeader('Host', targetHost);
        proxyReq.setHeader('Origin', `https://${targetHost}`);
        proxyReq.setHeader('Referer', `https://${targetHost}/`);
        
        // 保留原始请求的一些重要头
        if (req.headers['accept']) {
            proxyReq.setHeader('Accept', req.headers['accept']);
        }
        if (req.headers['accept-language']) {
            proxyReq.setHeader('Accept-Language', req.headers['accept-language']);
        }
        if (req.headers['accept-encoding']) {
            proxyReq.setHeader('Accept-Encoding', req.headers['accept-encoding']);
        }
        
        // 添加其他必要的头
        proxyReq.setHeader('Connection', 'keep-alive');
        proxyReq.setHeader('Sec-Fetch-Dest', req.headers['sec-fetch-dest'] || 'empty');
        proxyReq.setHeader('Sec-Fetch-Mode', req.headers['sec-fetch-mode'] || 'cors');
        proxyReq.setHeader('Sec-Fetch-Site', 'same-origin');
        
        // 对于非API请求，添加浏览器特征头
        if (!req.path.startsWith('/emby')) {
            proxyReq.setHeader('Upgrade-Insecure-Requests', '1');
            proxyReq.setHeader('Sec-Fetch-User', '?1');
        }
    },
    onProxyRes: (proxyRes, req, res) => {
        // 记录代理服务器响应时间
        const proxyResponseTime = Date.now();
        let totalBytes = 0;

        // 删除可能导致问题的响应头
        delete proxyRes.headers['strict-transport-security'];
        delete proxyRes.headers['content-security-policy'];
        
        // 添加 CORS 头
        proxyRes.headers['Access-Control-Allow-Origin'] = '*';
        proxyRes.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
        proxyRes.headers['Access-Control-Allow-Headers'] = '*';

        // 检查是否是视频或音频流
        const contentType = proxyRes.headers['content-type'] || '';
        const isMediaStream = contentType.includes('video/') || contentType.includes('audio/');

        if (isMediaStream) {
            // 获取或创建视频流统计信息
            const streamId = req.url.split('?')[0]; // 使用不带参数的URL作为标识
            if (!streamStats.has(streamId)) {
                streamStats.set(streamId, {
                    totalBytes: 0,
                    chunks: 0,
                    startTime: Date.now(),
                    lastUpdate: Date.now(),
                    totalTimeToProxy: 0,
                    totalTimeToClient: 0
                });
            }
            const stats = streamStats.get(streamId);

            // 只对媒体流进行速度监控
            const originalWrite = res.write;
            const originalEnd = res.end;

            res.write = function(chunk, encoding, callback) {
                const now = Date.now();
                if (chunk) {
                    totalBytes += chunk.length;
                    stats.totalBytes += chunk.length;
                    
                    // 每秒最多更新一次日志
                    if (now - req.lastLogTime >= 1000) {
                        stats.totalTimeToProxy = proxyResponseTime - req.startTime;
                        stats.totalTimeToClient = now - proxyResponseTime;
                        logSpeed(req, stats, totalBytes, proxyResponseTime);
                        req.lastLogTime = now;
                    }
                }
                return originalWrite.call(this, chunk, encoding, callback);
            };

            res.end = function(chunk, encoding, callback) {
                const endTime = Date.now();
                if (chunk) {
                    totalBytes += chunk.length;
                    stats.totalBytes += chunk.length;
                }

                // 更新统计信息
                stats.chunks++;
                stats.lastUpdate = endTime;
                stats.totalTimeToProxy = proxyResponseTime - req.startTime;
                stats.totalTimeToClient = endTime - proxyResponseTime;

                // 记录最终速度
                logSpeed(req, stats, totalBytes, proxyResponseTime, true);

                return originalEnd.call(this, chunk, encoding, callback);
            };

            // 对视频流的特殊处理
            proxyRes.headers['Cache-Control'] = 'public, max-age=3600';
            if (res.socket) {
                res.socket.setNoDelay(true);
            }
        } else {
            // 非媒体流请求，只需要简单地传递数据
            const originalWrite = res.write;
            const originalEnd = res.end;

            res.write = function(chunk, encoding, callback) {
                return originalWrite.call(this, chunk, encoding, callback);
            };

            res.end = function(chunk, encoding, callback) {
                return originalEnd.call(this, chunk, encoding, callback);
            };
        }
    },
    onError: (err, req, res) => {
        console.error('Proxy Error:', err);
        if (!res.headersSent) {
            res.status(502).json({ 
                error: 'Proxy Error', 
                message: 'Failed to connect to Emby server',
                details: err.message 
            });
        }
    }
};

// 设置代理中间件
app.use('/', createProxyMiddleware(proxyOptions));

// 启动服务器
app.listen(port, '0.0.0.0', () => {
    console.log(`Proxy server is running on port ${port}`);
}); 