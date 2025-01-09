const express = require('express');
const { WebSocket, WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 8080;
const TARGET_HOST = process.env.EMBY_SERVER || ''; // emby地址

if (!TARGET_HOST) {
    console.error('EMBY_SERVER environment variable is not set');
    process.exit(1);
}

// 日志函数
function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

// 获取默认User-Agent
function getDefaultUserAgent(isMobile = false) {
    if (isMobile) {
        return "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
    } else {
        return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    }
}

// 转换请求头
function transformHeaders(headers) {
    const isMobile = headers['sec-ch-ua-mobile'] === '?1';
    const newHeaders = { ...headers };
    newHeaders['user-agent'] = getDefaultUserAgent(isMobile);
    newHeaders['host'] = new URL(TARGET_HOST).host;
    newHeaders['origin'] = TARGET_HOST;
    return newHeaders;
}

// 处理WebSocket连接
wss.on('connection', (ws, req) => {
    const url = new URL(req.url, TARGET_HOST);
    const targetUrl = `wss://${url.host}${url.pathname}${url.search}`;
    log(`建立WebSocket连接: ${targetUrl}`);

    const serverWs = new WebSocket(targetUrl, {
        headers: transformHeaders(req.headers)
    });

    ws.on('message', (data) => {
        if (serverWs.readyState === WebSocket.OPEN) {
            serverWs.send(data);
        }
    });

    serverWs.on('message', (data) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    });

    ws.on('close', () => {
        if (serverWs.readyState === WebSocket.OPEN) {
            serverWs.close();
        }
    });

    serverWs.on('close', () => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
    });

    ws.on('error', (error) => {
        log(`客户端WebSocket错误: ${error.message}`);
    });

    serverWs.on('error', (error) => {
        log(`服务器WebSocket错误: ${error.message}`);
    });
});

// 处理HTTP请求
app.use(async (req, res) => {
    try {
        // 处理WebSocket升级请求
        if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
            return; // 让WebSocket服务器处理
        }

        const url = new URL(req.url, TARGET_HOST);
        const targetUrl = `${TARGET_HOST}${url.pathname}${url.search}`;
        log(`代理HTTP请求: ${targetUrl}`);

        // 创建请求选项
        const options = {
            method: req.method,
            headers: transformHeaders(req.headers),
            timeout: 30000,
        };

        // 发送代理请求
        const proxyReq = https.request(targetUrl, options);

        // 转发请求体
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            req.pipe(proxyReq);
        } else {
            proxyReq.end();
        }

        // 处理代理响应
        proxyReq.on('response', (proxyRes) => {
            // 设置响应头
            res.writeHead(proxyRes.statusCode, {
                ...proxyRes.headers,
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': '*'
            });

            // 转发响应体
            proxyRes.pipe(res);
        });

        // 错误处理
        proxyReq.on('error', (error) => {
            log(`代理请求错误: ${error.message}`);
            if (!res.headersSent) {
                res.status(502).json({
                    error: 'Proxy Error',
                    message: error.message
                });
            }
        });

    } catch (error) {
        log(`错误: ${error.message}`);
        if (!res.headersSent) {
            res.status(500).json({
                error: 'Internal Server Error',
                message: error.message
            });
        }
    }
});

// 健康检查端点
app.get('/healthz', (req, res) => {
    res.json({ status: 'healthy' });
});

// 启动服务器
server.listen(PORT, '0.0.0.0', () => {
    log(`代理服务器运行在端口 ${PORT}`);
}); 